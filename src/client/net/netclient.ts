import RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import { ROCKET, TICK_RATE, DT, NET } from '../../shared/config';
import {
  fromWireEvent,
  type ClientMessage,
  type InputFrame,
  type RocketState,
  type ServerMessage,
  type SnapshotMessage,
  type WireEvent,
} from '../../shared/protocol';
import type { GameSim, PlayerSim, Rocket, SimEvent } from '../../shared/sim';
import type { PlayerInput } from '../../shared/types';

// The client half of the netcode.
// - The local player is predicted: every input is simulated immediately, and when the server's
//   answer for an input arrives we rewind to the server's state and replay the newer inputs.
// - Everything else (other players, rockets, crates, explosions) is shown `interpDelay` ticks in
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

  private seq = 0;
  private pending: InputFrame[] = [];
  private snapshots: SnapshotMessage[] = [];
  private latestTick = -1;
  private latestAt = 0;
  private renderTick = -1;
  private lastEventTick = -1;
  private timeline: WireEvent[] = []; // remote events waiting for the render clock to reach them
  private immediate: SimEvent[] = []; // events about us, shown as soon as they arrive
  private rocketCache = new Map<number, Rocket>();
  private crateCache: number[][] = [];

  constructor(
    readonly sim: GameSim,
    readonly id: string,
    private readonly send: (msg: ClientMessage) => void,
  ) {
    this.me = sim.addPlayer(id);
    // Crates are simulated by the server. Here they're just obstacles placed from snapshots.
    for (const crate of sim.crates) crate.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
  }

  /** Call once per fixed tick with the local input: sends it and predicts its result. */
  predict(input: PlayerInput): SimEvent[] {
    this.pending.push({ seq: ++this.seq, input });
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    this.stats.pending = this.pending.length;
    this.send({ type: 'input', frames: this.pending.slice(-NET.inputRedundancy) });
    return this.sim.predict(this.me, input);
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
    this.reconcile(msg);

    for (const e of msg.events) {
      if (e.tick <= this.lastEventTick) continue;
      if ('playerId' in e && e.playerId === this.id) {
        // Our own jumps, shots and grapples were already played by prediction.
        if (e.type === 'knockback' || e.type === 'respawn') this.immediate.push(fromWireEvent(e));
      } else this.timeline.push(e);
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
    while (this.pending.length && this.pending[0].seq <= msg.ack) this.pending.shift();
    for (const frame of this.pending) this.sim.replay(me, frame.input);
    if (!this.pending.length) me.prevPos.copy(me.pos).sub(_oldStep);

    const error = _old.distanceTo(me.pos);
    this.stats.lastError = error;
    if (error > 0.001) this.stats.corrections++;
    this.visualOffset.add(_old.sub(me.pos));
    if (this.visualOffset.length() > SNAP_DISTANCE) this.visualOffset.set(0, 0, 0);
  }

  /** Call once per rendered frame. Moves the render clock and places remote entities. Returns events now due. */
  update(dt: number, now: number): SimEvent[] {
    const events = this.immediate;
    this.immediate = [];
    this.visualOffset.multiplyScalar(Math.exp(-dt * CORRECTION_RATE));
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
    this.interpolateRockets(a, b, t);
    this.interpolateCrates(a, b, t);

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
        r = { id: pb.id, pos: new Vector3(), yaw: 0, pitch: 0, anchor: null };
        this.remotes.set(pb.id, r);
      }
      r.pos.set(...pa.pos).lerp(_v.set(...pb.pos), t);
      r.yaw = lerpAngle(pa.yaw, pb.yaw, t);
      r.pitch = pa.pitch + (pb.pitch - pa.pitch) * t;
      const anchor = t < 0.5 ? pa.anchor : pb.anchor;
      if (anchor) (r.anchor ??= new Vector3()).set(...anchor);
      else r.anchor = null;
    }
    for (const id of this.remotes.keys()) {
      if (!b.players.some((p) => p.id === id)) this.remotes.delete(id);
    }
  }

  // Rockets live in sim.rockets so the existing effects and audio code can draw them unchanged.
  private interpolateRockets(a: SnapshotMessage, b: SnapshotMessage, t: number) {
    const out = this.sim.rockets;
    out.length = 0;
    for (const rb of b.rockets) {
      const ra = a.rockets.find((r) => r.id === rb.id);
      const r = this.rocketFor(rb);
      if (ra) r.pos.set(...ra.pos).lerp(_v.set(...rb.pos), t);
      // Fired between the two snapshots: back it up along its path to where it was at render time.
      else r.pos.set(...rb.pos).addScaledVector(r.dir, -ROCKET.speed * DT * (b.tick - a.tick) * (1 - t));
      r.prevPos.copy(r.pos);
      out.push(r);
    }
    for (const id of this.rocketCache.keys()) {
      if (!b.rockets.some((r) => r.id === id)) this.rocketCache.delete(id);
    }
  }

  private rocketFor(s: RocketState): Rocket {
    let r = this.rocketCache.get(s.id);
    if (!r) {
      r = { id: s.id, ownerId: s.ownerId, pos: new Vector3(), prevPos: new Vector3(), dir: new Vector3(...s.dir), life: 0 };
      this.rocketCache.set(s.id, r);
    }
    return r;
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
