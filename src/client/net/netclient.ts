import RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import { TICK_RATE, DT, NET } from '../../shared/config';
import {
  fromWireEvent,
  type ClientMessage,
  type InputFrame,
  type MatchState,
  type ProjectileState,
  type ScoreEntry,
  type ServerMessage,
  type SnapshotMessage,
  type WireEvent,
} from '../../shared/protocol';
import { freeze } from '../../shared/server';
import type { GameSim, PlayerSim, Projectile, SimEvent } from '../../shared/sim';
import type { PlayerInput, WeaponId } from '../../shared/types';
import type { VehicleSim } from '../../shared/vehicle';

// The client half of the netcode.
// - The local player and its projectiles are predicted: every input is simulated immediately, and when
//   the server's answer for an input arrives we rewind to the server's state and replay the newer
//   inputs. Rocket jumps launch on the tick you fire, the same as offline.
// - Everything else (other players, projectiles, crates, explosions) is shown `interpDelay` ticks in
//   the past, interpolated between two snapshots, so it moves smoothly despite network jitter.

const INTERP_DELAY = 2 * NET.snapshotInterval + 2; // ticks: two snapshots plus some jitter headroom
const MAX_PENDING = 120; // 2 s of unacknowledged input; beyond that the server isn't listening anyway
const CORRECTION_RATE = 12; // 1/s: how fast the camera eases out a prediction error
const SNAP_DISTANCE = 4; // errors bigger than this (respawns, teleports) are applied instantly

/** A remote player as currently displayed (interpolated). */
export interface RemotePlayer {
  id: string;
  pos: Vector3;
  yaw: number;
  pitch: number;
  anchor: Vector3 | null;
  alive: boolean;
  protected: boolean;
  grounded: boolean;
  primary: WeaponId;
  vehicle: number; // -1 on foot
  seat: number;
  hidden: boolean; // inside a vehicle's body, so their model isn't drawn
}

export class NetStats {
  pending = 0; // inputs sent but not yet acknowledged
  lastError = 0; // meters the last snapshot moved the local player
  corrections = 0; // snapshots that moved the local player more than 1 mm
  outOfOrder = 0; // snapshots that arrived after a newer one
  underruns = 0; // frames where rendering ran past the newest snapshot
  serverTick = 0;
  renderDelayMs = 0;
  serverInput = { queued: 0, starved: 0, dropped: 0 };
}

const _old = new Vector3();
const _oldStep = new Vector3();
const _qa = new Quaternion();
const _qb = new Quaternion();
const _v = new Vector3();

const lerpAngle = (a: number, b: number, t: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

export class NetClient {
  readonly me: PlayerSim;
  readonly remotes = new Map<string, RemotePlayer>();
  /** Added to the camera so prediction errors are eased out over a few frames instead of snapping. */
  readonly visualOffset = new Vector3();
  readonly stats = new NetStats();
  /** Projectiles to draw this frame: our predicted ones (sim.projectiles) plus everyone else's, interpolated. */
  readonly renderProjectiles: Projectile[] = [];
  /** Latest kills/deaths for everyone. Not interpolated: the scoreboard just shows the newest. */
  scores: ScoreEntry[] = [];
  /** The match as of the newest snapshot. */
  match: MatchState | null = null;

  private seq: number;
  private pending: InputFrame[] = [];
  private snapshots: SnapshotMessage[] = [];
  private latestTick = -1;
  private latestAt = 0;
  private renderTick = -1;
  private lastEventTick = -1;
  private timeline: WireEvent[] = []; // remote events waiting for the render clock to reach them
  private immediate: SimEvent[] = []; // events about us, shown as soon as they arrive
  private projectileCache = new Map<number, Projectile>();
  private exploded = new Set<number>(); // shots of ours whose explosion has been shown
  private crateCache: number[][] = [];
  private readonly alivePositions = new Map<string, Vector3>(); // what the sim hit-tests hooks and our rockets against
  private readonly remoteProjectiles: Projectile[] = []; // everyone else's projectiles as drawn: what the sim can hook

  constructor(
    readonly sim: GameSim,
    readonly id: string,
    private readonly send: (msg: ClientMessage) => void,
    /** Input numbering carries on across map changes: the server remembers the last one it saw. */
    startSeq = 0,
  ) {
    this.seq = startSeq;
    this.me = sim.addPlayer(id);
    sim.remotePositions = this.alivePositions;
    sim.remoteProjectiles = this.remoteProjectiles;
    // Crates are simulated by the server. Here they're just obstacles placed from snapshots.
    for (const crate of sim.crates) crate.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
  }

  /** Call once per fixed tick with the local input: sends it and predicts its result. */
  get lastSeq() {
    return this.seq;
  }

  predict(input: PlayerInput): SimEvent[] {
    // Between matches the server only lets everyone look around; predict the same.
    if (this.match?.phase === 'intermission') input = freeze(input);
    // Tells the server what we were looking at, so it judges our hooks and rockets against that.
    if (this.renderTick >= 0) input.view = Math.round(this.renderTick * 100) / 100;
    this.pending.push({ seq: ++this.seq, input });
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    this.stats.pending = this.pending.length;
    this.send({ type: 'input', frames: this.pending.slice(-NET.inputRedundancy) });
    this.me.seq = this.seq;
    const events = this.sim.predict(this.me, input).filter((e) => this.firstSighting(e));
    if (this.exploded.size > 64) {
      for (const shot of this.exploded) if (shot < this.seq - MAX_PENDING) this.exploded.delete(shot);
    }
    return events;
  }

  /**
   * One of our explosions can come up more than once: predicted, then re-predicted after a correction
   * revived the rocket, then reported by the server. Its explosion and knockback feedback play once.
   */
  private firstSighting(e: SimEvent): boolean {
    if (e.type === 'knockback' && e.sourceId === this.id) return !this.exploded.has(e.shot);
    if (e.type === 'explosion' && e.ownerId === this.id) {
      if (this.exploded.has(e.shot)) return false;
      this.exploded.add(e.shot);
    }
    return true;
  }

  receive(msg: ServerMessage) {
    if (msg.type !== 'snapshot') return;
    if (msg.tick <= this.latestTick) {
      this.stats.outOfOrder++;
      return;
    }
    this.latestTick = msg.tick;
    this.latestAt = performance.now();
    this.snapshots.push(msg);
    this.stats.serverTick = msg.tick;
    this.stats.serverInput = msg.input;
    this.scores = msg.scores;
    this.match = msg.match;
    msg.pickups.forEach((respawnIn, i) => {
      if (this.sim.pickups[i]) this.sim.pickups[i].respawnIn = respawnIn;
    });
    this.reconcile(msg);

    for (const e of msg.events) {
      if (e.tick <= this.lastEventTick) continue;
      const ours = ('playerId' in e && e.playerId === this.id) || ('ownerId' in e && e.ownerId === this.id);
      if (!ours) {
        this.timeline.push(e);
        continue;
      }
      // Our jumps, shots, grapples and grenade bounces were already played by prediction, and usually
      // our explosions too. What's left (a rocket that hit something we couldn't predict, another
      // player's knockback, damage, death, a respawn, a pickup) shows right away, in step with the
      // state correction it comes with.
      const sim = fromWireEvent(e);
      const unpredicted =
        e.type === 'explosion' ||
        e.type === 'knockback' ||
        e.type === 'respawn' ||
        e.type === 'damaged' ||
        e.type === 'killed' ||
        e.type === 'pickup' ||
        e.type === 'entered' ||
        e.type === 'exited' ||
        e.type === 'rammed';
      if (unpredicted && this.firstSighting(sim)) {
        this.immediate.push(sim);
      }
    }
    this.lastEventTick = msg.tick;
  }

  /** Rewind the local player to the server's state, then replay every input the server hasn't seen yet. */
  private reconcile(msg: SnapshotMessage) {
    if (!msg.you) return;
    const me = this.me;
    _old.copy(me.pos);
    _oldStep.subVectors(me.pos, me.prevPos);

    me.restore(msg.you);
    // Driving: the vehicle is ours to predict too, so it rewinds and replays along with us.
    const driving = this.driving();
    if (driving) driving.restore(msg.vehicles[driving.index]);
    this.restoreProjectiles(msg);
    while (this.pending.length && this.pending[0].seq <= msg.ack) this.pending.shift();
    for (const frame of this.pending) {
      me.seq = frame.seq;
      this.sim.replay(me, frame.input);
    }
    me.seq = this.seq;
    if (!this.pending.length) me.prevPos.copy(me.pos).sub(_oldStep);

    if (driving && !this.pending.length) driving.prevPos.copy(driving.pos).sub(_oldStep);
    const error = _old.distanceTo(me.pos);
    this.stats.lastError = error;
    if (error > 0.001) this.stats.corrections++;
    this.visualOffset.add(_old.sub(me.pos));
    if (this.visualOffset.length() > SNAP_DISTANCE) this.visualOffset.set(0, 0, 0);
  }

  /** Our projectiles as the server has them. Ones fired by inputs it hasn't seen yet come back during the replay. */
  private restoreProjectiles(msg: SnapshotMessage) {
    const projectiles = this.sim.projectiles;
    projectiles.length = 0;
    for (const r of msg.projectiles) {
      if (r.ownerId !== this.id) continue;
      const pos = new Vector3(...r.pos);
      projectiles.push({ id: -r.shot, kind: r.kind, ownerId: r.ownerId, shot: r.shot, pos, prevPos: pos.clone(), vel: new Vector3(...r.vel), life: r.life, traveled: r.traveled, lag: 0, struck: null, target: r.target, phase: r.phase, apex: r.apex, from: r.from, power: r.power });
    }
  }

  /** Call once per rendered frame. Moves the render clock and places remote entities. Returns events now due. */
  update(dt: number, now: number): SimEvent[] {
    const events = this.immediate;
    this.immediate = [];
    this.visualOffset.multiplyScalar(Math.exp(-dt * CORRECTION_RATE));
    this.renderProjectiles.length = 0;
    this.renderProjectiles.push(...this.sim.projectiles);
    if (this.latestTick < 0) return events;

    // Render clock: run at real time, and drift gently toward "newest snapshot minus the delay".
    const serverNow = this.latestTick + ((now - this.latestAt) / 1000) * TICK_RATE;
    const target = serverNow - INTERP_DELAY;
    if (this.renderTick < 0 || Math.abs(target - this.renderTick) > 20) this.renderTick = target;
    else this.renderTick += dt * TICK_RATE + (target - this.renderTick) * Math.min(1, dt * 2);
    this.stats.renderDelayMs = ((serverNow - this.renderTick) / TICK_RATE) * 1000;

    const snaps = this.snapshots;
    while (snaps.length > 2 && snaps[1].tick <= this.renderTick) snaps.shift();
    let a = snaps[0];
    let b = snaps[1] ?? a;
    if (this.renderTick < a.tick) b = a;
    else if (this.renderTick > b.tick) {
      this.stats.underruns++;
      a = b;
    }
    const t = b.tick > a.tick ? Math.min(1, Math.max(0, (this.renderTick - a.tick) / (b.tick - a.tick))) : 1;

    this.interpolatePlayers(a, b, t);
    this.interpolateProjectiles(a, b, t);
    this.interpolateCrates(a, b, t);
    this.interpolateVehicles(a, b, t);

    while (this.timeline.length && this.timeline[0].tick <= this.renderTick) {
      events.push(fromWireEvent(this.timeline.shift()!));
    }
    return events;
  }

  private interpolatePlayers(a: SnapshotMessage, b: SnapshotMessage, t: number) {
    for (const pb of b.players) {
      const pa = a.players.find((p) => p.id === pb.id) ?? pb;
      let r = this.remotes.get(pb.id);
      if (!r) {
        r = { id: pb.id, pos: new Vector3(), yaw: 0, pitch: 0, anchor: null, alive: true, protected: false, grounded: true, primary: pb.primary, vehicle: -1, seat: -1, hidden: false };
        this.remotes.set(pb.id, r);
      }
      // Dying or respawning is a teleport: show one end or the other, never a slide between them.
      if (pa.alive !== pb.alive) r.pos.set(...(t < 0.5 ? pa.pos : pb.pos));
      else r.pos.set(...pa.pos).lerp(_v.set(...pb.pos), t);
      r.yaw = lerpAngle(pa.yaw, pb.yaw, t);
      r.pitch = pa.pitch + (pb.pitch - pa.pitch) * t;
      r.alive = t < 0.5 ? pa.alive : pb.alive;
      r.protected = t < 0.5 ? pa.protected : pb.protected;
      r.grounded = t < 0.5 ? pa.grounded : pb.grounded;
      r.primary = t < 0.5 ? pa.primary : pb.primary;
      r.vehicle = t < 0.5 ? pa.vehicle : pb.vehicle;
      r.seat = t < 0.5 ? pa.seat : pb.seat;
      r.hidden = r.vehicle >= 0 && !!this.sim.vehicles[r.vehicle]?.config.seats[r.seat]?.hidden;
      // Anchors move when hooked into a player or crate, so blend them when both ends have one.
      if (pa.anchor && pb.anchor) (r.anchor ??= new Vector3()).set(...pa.anchor).lerp(_v.set(...pb.anchor), t);
      else {
        const anchor = t < 0.5 ? pa.anchor : pb.anchor;
        if (anchor) (r.anchor ??= new Vector3()).set(...anchor);
        else r.anchor = null;
      }
    }
    for (const id of this.remotes.keys()) {
      if (!b.players.some((p) => p.id === id)) this.remotes.delete(id);
    }
    // Hit tests skip anyone riding in our vehicle, as the server's do.
    this.alivePositions.clear();
    const ours = this.me.vehicle;
    for (const r of this.remotes.values()) if (r.alive && (ours < 0 || r.vehicle !== ours)) this.alivePositions.set(r.id, r.pos);
  }

  private interpolateProjectiles(a: SnapshotMessage, b: SnapshotMessage, t: number) {
    this.remoteProjectiles.length = 0;
    for (const rb of b.projectiles) {
      if (rb.ownerId === this.id) continue; // drawn from prediction instead
      const ra = a.projectiles.find((r) => r.id === rb.id);
      const r = this.projectileFor(rb);
      if (ra) {
        r.pos.set(...ra.pos).lerp(_v.set(...rb.pos), t);
        r.vel.set(...ra.vel).lerp(_v.set(...rb.vel), t);
        r.traveled = ra.traveled + (rb.traveled - ra.traveled) * t;
      } else {
        // Fired between the two snapshots: back it up along its path to where it was at render time.
        r.vel.set(...rb.vel);
        r.pos.set(...rb.pos).addScaledVector(r.vel, -DT * (b.tick - a.tick) * (1 - t));
        r.traveled = rb.traveled;
      }
      r.life = rb.life;
      r.target = rb.target; // a missile can lose its target mid-flight
      r.phase = rb.phase;
      r.prevPos.copy(r.pos);
      this.renderProjectiles.push(r);
      this.remoteProjectiles.push(r);
    }
    for (const id of this.projectileCache.keys()) {
      if (!b.projectiles.some((r) => r.id === id)) this.projectileCache.delete(id);
    }
  }

  private projectileFor(s: ProjectileState): Projectile {
    let r = this.projectileCache.get(s.id);
    if (!r) {
      r = { id: s.id, kind: s.kind, ownerId: s.ownerId, shot: s.shot, pos: new Vector3(), prevPos: new Vector3(), vel: new Vector3(...s.vel), life: s.life, traveled: s.traveled, lag: 0, struck: null, target: s.target, phase: s.phase, apex: s.apex, from: s.from, power: s.power };
      this.projectileCache.set(s.id, r);
    }
    return r;
  }

  /** The vehicle we're driving, which we predict, or null. */
  driving(): VehicleSim | null {
    return this.me.vehicle >= 0 && this.me.seat === 0 ? (this.sim.vehicles[this.me.vehicle] ?? null) : null;
  }

  /** Every vehicle but the one we drive, placed where it was at render time. */
  private interpolateVehicles(a: SnapshotMessage, b: SnapshotMessage, t: number) {
    const driving = this.driving();
    this.sim.vehicles.forEach((v, i) => {
      const va = a.vehicles[i];
      const vb = b.vehicles[i];
      if (!va || !vb || v === driving) return;
      v.restore(t < 0.5 ? va : vb);
      // Respawning is a teleport: no slide back to the pad.
      if (va.alive === vb.alive) {
        v.pos.set(...va.pos).lerp(_v.set(...vb.pos), t);
        v.yaw = lerpAngle(va.yaw, vb.yaw, t);
        v.pitch = va.pitch + (vb.pitch - va.pitch) * t;
        v.roll = va.roll + (vb.roll - va.roll) * t;
      }
      v.prevPos.copy(v.pos);
      v.prevYaw = v.yaw;
      v.place();
    });
  }

  private interpolateCrates(a: SnapshotMessage, b: SnapshotMessage, t: number) {
    this.sim.crates.forEach((body, i) => {
      const ca = a.crates[i];
      const cb = b.crates[i];
      if (!ca || !cb) return;
      const x = ca[0] + (cb[0] - ca[0]) * t;
      const y = ca[1] + (cb[1] - ca[1]) * t;
      const z = ca[2] + (cb[2] - ca[2]) * t;
      _qa.set(ca[3], ca[4], ca[5], ca[6]).slerp(_qb.set(cb[3], cb[4], cb[5], cb[6]), t);
      // Only touch bodies that moved, so resting crates stay asleep and the crate view skips them.
      const last = this.crateCache[i];
      if (last && last[0] === x && last[1] === y && last[2] === z && last[3] === _qa.x && last[4] === _qa.y && last[5] === _qa.z) return;
      this.crateCache[i] = [x, y, z, _qa.x, _qa.y, _qa.z];
      body.setTranslation({ x, y, z }, true);
      body.setRotation(_qa, true);
    });
  }
}
