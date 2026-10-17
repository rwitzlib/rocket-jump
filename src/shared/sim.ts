import RAPIER from '@dimforge/rapier3d-compat';
import { Euler, Quaternion, Vector3 } from 'three';
import { COMBAT, CRATE, DT, GRAPPLE, GRAVITY, PLAYER, ROCKET } from './config';
import type { MapDef, SpawnDef, Vec3Tuple } from './map';
import { aimDirection, applyGrapple, updateVelocity, type GrappleState } from './movement';
import { EMPTY_INPUT, type PlayerInput } from './types';

// The authoritative game simulation. It has no rendering or DOM code, so the same class can run
// in the browser (single-player / client prediction) or in Node (the multiplayer server).
// Call `await RAPIER.init()` once before constructing it.

/**
 * How a player step treats side effects.
 * - authority: the real simulation (server, single-player).
 * - predict: a client guessing its own player (and its own rockets) ahead of the server. Feedback
 *   events still fire. Respawns and crates are left to the server.
 * - replay: re-running inputs that were already predicted, after a server correction. Silent.
 */
export type StepMode = 'authority' | 'predict' | 'replay';

/** Everything about a player that affects how the next input plays out. Plain data, so it can go over the wire. */
export interface PlayerState {
  pos: Vec3Tuple;
  vel: Vec3Tuple;
  grounded: boolean;
  grapple: { anchor: Vec3Tuple; normal: Vec3Tuple; length: number } | null;
  fireCooldown: number;
  wasGrappleHeld: boolean;
  yaw: number;
  pitch: number;
  health: number;
  alive: boolean;
  respawnIn: number; // seconds, while dead
  protectedFor: number; // seconds of spawn protection left
}

export type DeathCause = 'rocket' | 'fall';

// Players are in their own collision group and ignore each other. Movement stays predictable on
// the client, which only knows where other players were ~100ms ago. Rockets still hit players.
const PLAYER_GROUP = 0x0002;
const PLAYER_COLLISION_GROUPS = (PLAYER_GROUP << 16) | (0xffff & ~PLAYER_GROUP);

const tuple = (v: Vector3): Vec3Tuple => [v.x, v.y, v.z];

export class PlayerSim {
  readonly pos = new Vector3();
  readonly prevPos = new Vector3();
  readonly vel = new Vector3();
  grounded = false;
  grapple: GrappleState | null = null;
  fireCooldown = 0;
  wasGrappleHeld = false;
  yaw = 0;
  pitch = 0;
  /** Seq of the input being simulated (0 offline). Tags fired rockets so a client can match its predictions. */
  seq = 0;

  health: number = COMBAT.maxHealth;
  alive = true;
  respawnIn = 0;
  protectedFor = 0;
  sinceDamaged = Infinity; // seconds, for regen
  lastAttacker: string | null = null; // who to credit if this player dies soon after being hit by them
  sinceAttacked = Infinity; // seconds since lastAttacker's hit
  kills = 0;
  deaths = 0;

  constructor(
    readonly id: string,
    readonly body: RAPIER.RigidBody,
    readonly collider: RAPIER.Collider,
  ) {}

  eye(out: Vector3): Vector3 {
    return out.set(this.pos.x, this.pos.y + PLAYER.eyeOffset, this.pos.z);
  }

  capture(): PlayerState {
    const g = this.grapple;
    return {
      pos: tuple(this.pos),
      vel: tuple(this.vel),
      grounded: this.grounded,
      grapple: g && { anchor: tuple(g.anchor), normal: tuple(g.normal), length: g.length },
      fireCooldown: this.fireCooldown,
      wasGrappleHeld: this.wasGrappleHeld,
      yaw: this.yaw,
      pitch: this.pitch,
      health: this.health,
      alive: this.alive,
      respawnIn: this.respawnIn,
      protectedFor: this.protectedFor,
    };
  }

  /** Overwrites this player with a captured state and moves its collider there immediately. */
  restore(s: PlayerState) {
    this.pos.set(...s.pos);
    this.prevPos.copy(this.pos);
    this.vel.set(...s.vel);
    this.grounded = s.grounded;
    const g = s.grapple;
    this.grapple = g && { anchor: new Vector3(...g.anchor), normal: new Vector3(...g.normal), length: g.length };
    this.fireCooldown = s.fireCooldown;
    this.wasGrappleHeld = s.wasGrappleHeld;
    this.yaw = s.yaw;
    this.pitch = s.pitch;
    this.health = s.health;
    this.respawnIn = s.respawnIn;
    this.protectedFor = s.protectedFor;
    if (s.alive !== this.alive) {
      this.alive = s.alive;
      this.collider.setEnabled(s.alive);
    }
    this.collider.setTranslation(this.pos);
    this.body.setNextKinematicTranslation(this.pos);
  }
}

export interface Rocket {
  id: number; // server-assigned; predicted rockets use -shot until the server's copy replaces them
  ownerId: string;
  shot: number; // seq of the owner's input that fired it
  pos: Vector3;
  prevPos: Vector3;
  dir: Vector3;
  life: number;
}

export type SimEvent =
  | { type: 'fired'; playerId: string }
  | { type: 'explosion'; pos: Vector3; normal: Vector3; surface: boolean; ownerId: string; shot: number } // surface = false for mid-air
  | { type: 'grapple'; playerId: string; attached: boolean }
  | { type: 'grappleMiss'; playerId: string }
  | { type: 'jumped'; playerId: string }
  | { type: 'landed'; playerId: string; impactSpeed: number }
  | { type: 'knockback'; playerId: string; strength: number; sourceId: string; shot: number } // strength 0..1
  | { type: 'respawn'; playerId: string; yaw: number }
  | { type: 'damaged'; playerId: string; sourceId: string; amount: number }
  | { type: 'killed'; playerId: string; killerId: string | null; cause: DeathCause }; // killerId null: suicide

const _desired = new Vector3();
const _dir = new Vector3();
const _crate = new Vector3();
const _discard: SimEvent[] = [];

// Reused for every ray cast so per-tick queries don't create garbage (GC pauses show up as hitches).
// Rapier's Ray just holds references to these vectors.
const _rayOrigin = new Vector3();
const _rayDir = new Vector3();
const _ray = new RAPIER.Ray(_rayOrigin, _rayDir);

// Removes velocity the collision pass refused to let us travel (walls, floors, ceilings).
function clipVelocity(v: number, desired: number, actual: number): number {
  if (Math.abs(desired) < 1e-6) return v;
  const ratio = actual / desired;
  return ratio < 0.99 ? v * Math.max(0, ratio) : v;
}

export class GameSim {
  readonly world: RAPIER.World;
  readonly players = new Map<string, PlayerSim>();
  readonly rockets: Rocket[] = [];
  readonly crates: RAPIER.RigidBody[] = [];
  tick = 0;

  private readonly controller: RAPIER.KinematicCharacterController;
  private nextRocketId = 1;
  private spawnIndex = 0;
  private pendingEvents: SimEvent[] = [];

  constructor(readonly map: MapDef) {
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = DT;

    const q = new Quaternion();
    for (const box of map.boxes) {
      q.setFromEuler(new Euler(...(box.rot ?? [0, 0, 0])));
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(box.size[0] / 2, box.size[1] / 2, box.size[2] / 2)
          .setTranslation(...box.pos)
          .setRotation(q),
      );
    }

    const h = CRATE.size / 2;
    for (const pos of map.crates) {
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(...pos));
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(h, h, h).setDensity(CRATE.density), body);
      this.crates.push(body);
    }

    this.controller = this.world.createCharacterController(0.02);
    this.controller.enableAutostep(0.45, 0.2, false);
    this.controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    this.controller.disableSnapToGround(); // snapping would glue you to the floor when a rocket launches you
    this.controller.setApplyImpulsesToDynamicBodies(true);
  }

  addPlayer(id: string): PlayerSim {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.capsule(PLAYER.halfHeight, PLAYER.radius).setCollisionGroups(PLAYER_COLLISION_GROUPS),
      body,
    );
    const player = new PlayerSim(id, body, collider);
    this.players.set(id, player);
    this.respawn(player);
    return player;
  }

  removePlayer(id: string) {
    const p = this.players.get(id);
    if (!p) return;
    this.world.removeRigidBody(p.body); // also removes its collider
    this.players.delete(id);
  }

  respawn(p: PlayerSim) {
    const spawn = this.pickSpawn(p);
    p.health = COMBAT.maxHealth;
    p.alive = true;
    p.respawnIn = 0;
    p.protectedFor = COMBAT.spawnProtection;
    p.sinceDamaged = Infinity;
    p.lastAttacker = null;
    p.sinceAttacked = Infinity;
    p.collider.setEnabled(true);
    p.pos.set(...spawn.pos);
    p.yaw = spawn.yaw;
    p.pitch = 0;
    p.prevPos.copy(p.pos);
    p.vel.set(0, 0, 0);
    p.grapple = null;
    p.body.setTranslation(p.pos, true);
    p.body.setNextKinematicTranslation(p.pos);
    this.pendingEvents.push({ type: 'respawn', playerId: p.id, yaw: spawn.yaw });
  }

  /** The spawn point farthest from any living opponent. Ties (e.g. an empty map) rotate through the list. */
  private pickSpawn(p: PlayerSim): SpawnDef {
    const spawns = this.map.spawns;
    const start = this.spawnIndex++;
    let best = spawns[start % spawns.length];
    let bestDist = -1;
    for (let i = 0; i < spawns.length; i++) {
      const s = spawns[(start + i) % spawns.length];
      let nearest = Infinity;
      for (const o of this.players.values()) {
        if (o !== p && o.alive) nearest = Math.min(nearest, Math.hypot(o.pos.x - s.pos[0], o.pos.y - s.pos[1], o.pos.z - s.pos[2]));
      }
      if (nearest > bestDist) {
        best = s;
        bestDist = nearest;
      }
    }
    return best;
  }

  /** True if nothing static (walls, floor, tower) blocks the straight line between two points. */
  canSee(from: Vector3, to: Vector3): boolean {
    _rayOrigin.copy(from);
    const dist = _rayDir.subVectors(to, from).length();
    if (dist < 1e-3) return true;
    _rayDir.divideScalar(dist);
    const flags = RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC;
    return this.world.castRay(_ray, dist, true, flags) === null;
  }

  /** Where this player's grapple would attach if fired now (static geometry only), or null if out of range. */
  grappleTarget(p: PlayerSim, out: Vector3, outNormal?: Vector3): Vector3 | null {
    aimDirection(p.yaw, p.pitch, _rayDir);
    p.eye(_rayOrigin);
    const flags = RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC;
    const hit = this.world.castRayAndGetNormal(_ray, GRAPPLE.range, true, flags);
    if (!hit) return null;
    outNormal?.set(hit.normal.x, hit.normal.y, hit.normal.z);
    return out.copy(_rayOrigin).addScaledVector(_rayDir, hit.timeOfImpact);
  }

  /** One authoritative tick for every player, rocket and crate. */
  step(inputs: ReadonlyMap<string, PlayerInput>): SimEvent[] {
    const events = this.takePendingEvents();
    for (const p of this.players.values()) {
      this.stepPlayer(p, inputs.get(p.id) ?? EMPTY_INPUT, events, 'authority');
    }
    this.stepRockets(events, 'authority');
    this.world.step();
    this.tick++;
    return events;
  }

  /**
   * Client prediction: one tick for just this player and the rockets in this sim (its own). Other
   * players, their rockets and the crates come from the server.
   */
  predict(p: PlayerSim, input: PlayerInput): SimEvent[] {
    const events = this.takePendingEvents();
    this.stepPlayer(p, input, events, 'predict');
    this.stepRockets(events, 'predict');
    this.world.step();
    return events;
  }

  /**
   * Re-runs one already-predicted tick for this player and its rockets after a server correction.
   * No physics step and no events, so replaying a handful of ticks per snapshot is cheap.
   */
  replay(p: PlayerSim, input: PlayerInput) {
    this.stepPlayer(p, input, _discard, 'replay');
    this.stepRockets(_discard, 'replay');
    _discard.length = 0;
  }

  private takePendingEvents(): SimEvent[] {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }

  private stepPlayer(p: PlayerSim, input: PlayerInput, events: SimEvent[], mode: StepMode) {
    p.prevPos.copy(p.pos);
    if (!p.alive) {
      // Only the server brings players back. Tracking held grapple means holding it through the
      // respawn doesn't fire it on the first tick alive.
      p.wasGrappleHeld = input.grapple;
      p.respawnIn = Math.max(0, p.respawnIn - DT);
      if (mode === 'authority' && p.respawnIn === 0) {
        this.respawn(p);
        events.push(...this.takePendingEvents());
      }
      return;
    }
    if (mode === 'authority') {
      p.sinceDamaged += DT;
      p.sinceAttacked += DT;
      p.protectedFor = Math.max(0, p.protectedFor - DT);
      if (p.sinceDamaged > COMBAT.regenDelay) p.health = Math.min(COMBAT.maxHealth, p.health + COMBAT.regenRate * DT);
    }
    p.yaw = input.yaw;
    p.pitch = input.pitch;
    // `pos` is the source of truth. Normally the collider is already there (world.step moved it),
    // but a replay runs several ticks without stepping the world.
    p.collider.setTranslation(p.pos);

    // Grapple: attach on press, release on let go.
    if (input.grapple && !p.wasGrappleHeld) {
      const normal = new Vector3();
      const anchor = this.grappleTarget(p, new Vector3(), normal);
      if (!anchor) events.push({ type: 'grappleMiss', playerId: p.id });
      if (anchor) {
        p.grapple = { anchor, normal, length: p.pos.distanceTo(anchor) };
        if (p.grounded) {
          p.vel.y = Math.max(p.vel.y, GRAPPLE.attachHop);
          p.grounded = false;
        }
        events.push({ type: 'grapple', playerId: p.id, attached: true });
      }
    } else if (!input.grapple && p.grapple) {
      p.grapple = null;
      events.push({ type: 'grapple', playerId: p.id, attached: false });
    }
    p.wasGrappleHeld = input.grapple;

    if (updateVelocity(p.vel, input, p.grounded, DT)) events.push({ type: 'jumped', playerId: p.id });
    const wasGrounded = p.grounded;
    const fallSpeed = -p.vel.y;
    if (p.grapple) applyGrapple(p.pos, p.vel, p.grapple, DT);

    // Move through the world with collision, then drop whatever velocity was blocked.
    _desired.copy(p.vel).multiplyScalar(DT);
    this.controller.computeColliderMovement(p.collider, _desired, undefined, PLAYER_COLLISION_GROUPS);
    const moved = this.controller.computedMovement();
    p.grounded = this.controller.computedGrounded();
    if (p.grounded && !wasGrounded && fallSpeed > 2) {
      events.push({ type: 'landed', playerId: p.id, impactSpeed: fallSpeed });
    }
    p.vel.x = clipVelocity(p.vel.x, _desired.x, moved.x);
    p.vel.y = clipVelocity(p.vel.y, _desired.y, moved.y);
    p.vel.z = clipVelocity(p.vel.z, _desired.z, moved.z);
    p.pos.x += moved.x;
    p.pos.y += moved.y;
    p.pos.z += moved.z;
    p.body.setNextKinematicTranslation(p.pos);

    if (p.pos.y < this.map.killY && mode === 'authority') {
      this.kill(p, this.recentAttacker(p), 'fall', events);
      return;
    }

    p.fireCooldown = Math.max(0, p.fireCooldown - DT);
    if (input.fire && p.fireCooldown === 0) {
      p.fireCooldown = ROCKET.cooldown;
      const pos = p.eye(new Vector3());
      this.rockets.push({
        // A predicted rocket's id must survive replays so its mesh and trail stay put: derive it from the input.
        id: mode === 'authority' ? this.nextRocketId++ : -p.seq,
        ownerId: p.id,
        shot: p.seq,
        pos,
        prevPos: pos.clone(),
        dir: aimDirection(p.yaw, p.pitch, new Vector3()),
        life: ROCKET.lifetime,
      });
      events.push({ type: 'fired', playerId: p.id });
    }
  }

  private stepRockets(events: SimEvent[], mode: StepMode) {
    const travel = ROCKET.speed * DT;
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      r.prevPos.copy(r.pos);
      const owner = this.players.get(r.ownerId);
      _rayOrigin.copy(r.pos);
      _rayDir.copy(r.dir);
      const hit = this.world.castRayAndGetNormal(_ray, travel, true, undefined, undefined, undefined, owner?.body);

      const normal = new Vector3();
      if (hit) {
        r.pos.addScaledVector(r.dir, hit.timeOfImpact - 0.1);
        normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
      } else {
        r.pos.addScaledVector(r.dir, travel);
        r.life -= DT;
        if (r.life > 0) continue;
        normal.copy(r.dir).negate();
      }
      this.explode(r, normal, !!hit, events, mode);
      this.rockets.splice(i, 1);
    }
  }

  private explode(r: Rocket, normal: Vector3, surface: boolean, events: SimEvent[], mode: StepMode) {
    const at = r.pos;
    const radius = ROCKET.blastRadius;

    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const dist = p.pos.distanceTo(at);
      if (dist >= radius) continue;
      const falloff = 1 - dist / radius;
      if (dist < 1e-3) _dir.set(0, 1, 0);
      else _dir.subVectors(p.pos, at).divideScalar(dist);
      p.vel.addScaledVector(_dir, ROCKET.knockback * falloff);
      p.grounded = false;
      events.push({ type: 'knockback', playerId: p.id, strength: falloff, sourceId: r.ownerId, shot: r.shot });
      // Health is server-only: clients show what the server says, a round trip later.
      if (mode === 'authority' && (p.id !== r.ownerId || COMBAT.selfDamage)) {
        this.damage(p, Math.round(COMBAT.rocketDamage * falloff), r.ownerId, events);
      }
    }

    // On a client the crates are only server-placed obstacles.
    if (mode === 'authority') this.pushCrates(at);
    events.push({ type: 'explosion', pos: at.clone(), normal, surface, ownerId: r.ownerId, shot: r.shot });
  }

  private damage(p: PlayerSim, amount: number, sourceId: string, events: SimEvent[]) {
    if (amount <= 0 || p.protectedFor > 0) return;
    // Finishing yourself off right after someone hit you still counts as their kill.
    const killer = sourceId === p.id ? this.recentAttacker(p) : sourceId;
    p.health -= amount;
    p.sinceDamaged = 0;
    if (sourceId !== p.id) {
      p.lastAttacker = sourceId;
      p.sinceAttacked = 0;
    }
    events.push({ type: 'damaged', playerId: p.id, sourceId, amount });
    if (p.health <= 0) this.kill(p, killer, 'rocket', events);
  }

  private recentAttacker(p: PlayerSim): string | null {
    return p.sinceAttacked < COMBAT.killCredit ? p.lastAttacker : null;
  }

  private kill(p: PlayerSim, killerId: string | null, cause: DeathCause, events: SimEvent[]) {
    p.alive = false;
    p.health = 0;
    p.respawnIn = COMBAT.respawnDelay;
    p.vel.set(0, 0, 0);
    p.grapple = null;
    p.collider.setEnabled(false); // rockets fly through the dead
    p.deaths++;
    const killer = killerId ? this.players.get(killerId) : undefined;
    if (killer) killer.kills++;
    events.push({ type: 'killed', playerId: p.id, killerId, cause });
  }

  private pushCrates(at: Vector3) {
    const radius = ROCKET.blastRadius;
    for (const crate of this.crates) {
      const t = crate.translation();
      _crate.set(t.x, t.y, t.z);
      const dist = _crate.distanceTo(at);
      if (dist >= radius) continue;
      const falloff = 1 - dist / radius;
      if (dist < 1e-3) _dir.set(0, 1, 0);
      else _dir.subVectors(_crate, at).divideScalar(dist);
      _dir.multiplyScalar(ROCKET.crateKnockback * falloff * crate.mass());
      crate.applyImpulse(_dir, true);
    }
  }
}
