import RAPIER from '@dimforge/rapier3d-compat';
import { Euler, Quaternion, Vector3 } from 'three';
import { COMBAT, CRATE, DT, GRAPPLE, GRAVITY, PLAYER, ROCKET } from './config';
import type { MapDef, SpawnDef, Vec3Tuple } from './map';
import { capsuleNormal, PositionHistory, rayCapsule, REWIND_TICKS } from './hits';
import { aimDirection, applyGrapple, updateVelocity, type GrappleState, type Hook } from './movement';
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
  grapple: { anchor: Vec3Tuple; normal: Vec3Tuple; length: number; hook: HookState | null } | null;
  fireCooldown: number;
  grappleCooldown: number;
  grappleUsed: boolean;
  yaw: number;
  pitch: number;
  health: number;
  alive: boolean;
  respawnIn: number; // seconds, while dead
  protectedFor: number; // seconds of spawn protection left
}

export type DeathCause = 'rocket' | 'fall';

export type HookState =
  | { kind: 'player'; id: string; offset: Vec3Tuple }
  | { kind: 'crate'; index: number; local: Vec3Tuple; localNormal: Vec3Tuple }
  | { kind: 'rocket'; ownerId: string; shot: number };

function hookToState(h: Hook | null): HookState | null {
  if (!h) return null;
  if (h.kind === 'player') return { kind: 'player', id: h.id, offset: tuple(h.offset) };
  if (h.kind === 'crate') return { kind: 'crate', index: h.index, local: tuple(h.local), localNormal: tuple(h.localNormal) };
  return { ...h };
}

function hookFromState(h: HookState | null): Hook | null {
  if (!h) return null;
  if (h.kind === 'player') return { kind: 'player', id: h.id, offset: new Vector3(...h.offset) };
  if (h.kind === 'crate') return { kind: 'crate', index: h.index, local: new Vector3(...h.local), localNormal: new Vector3(...h.localNormal) };
  return { ...h };
}

// Players are in their own collision group and ignore each other. Movement stays predictable on
// the client, which only knows where other players were ~100ms ago. Rockets still hit players.
const PLAYER_GROUP = 0x0002;
const PLAYER_COLLISION_GROUPS = (PLAYER_GROUP << 16) | (0xffff & ~PLAYER_GROUP);

const tuple = (v: Vector3): Vec3Tuple => [v.x, v.y, v.z];
/**
 * The character controller calls you grounded whenever anything touches your capsule from below,
 * including a crate's top edge brushing your rounded bottom as you jump past it. That let a held
 * jump fire again off every ledge on the way up. We also require something under your feet (see
 * `hasFooting`) and that you aren't moving up faster than this.
 */
const MAX_GROUNDED_RISE = 1;
/** Footing rays start at the capsule center, here and this far out each way: support within ~30° of straight down. */
const FOOTING_SPREAD = PLAYER.radius * 0.5;
const FOOTING_DEPTH = PLAYER.halfHeight + PLAYER.radius + 0.3; // reaches the ground under you on slopes up to the climb limit
const FOOTING_OFFSETS = [
  [0, 0],
  [FOOTING_SPREAD, 0],
  [-FOOTING_SPREAD, 0],
  [0, FOOTING_SPREAD],
  [0, -FOOTING_SPREAD],
];

export class PlayerSim {
  readonly pos = new Vector3();
  readonly prevPos = new Vector3();
  readonly vel = new Vector3();
  grounded = false;
  grapple: GrappleState | null = null;
  fireCooldown = 0;
  grappleCooldown = 0;
  grappleUsed = false; // this press of the grapple button already fired; cleared on release
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
  /** Recent positions, server-side, for lag-compensated hit tests. */
  readonly history = new PositionHistory();

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
      grapple: g && { anchor: tuple(g.anchor), normal: tuple(g.normal), length: g.length, hook: hookToState(g.hook) },
      fireCooldown: this.fireCooldown,
      grappleCooldown: this.grappleCooldown,
      grappleUsed: this.grappleUsed,
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
    this.grapple = g && {
      anchor: new Vector3(...g.anchor),
      normal: new Vector3(...g.normal),
      length: g.length,
      hook: hookFromState(g.hook),
    };
    this.fireCooldown = s.fireCooldown;
    this.grappleCooldown = s.grappleCooldown;
    this.grappleUsed = s.grappleUsed;
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
  lag: number; // ticks to rewind other players by when testing hits: how far behind the shooter was seeing
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
const _q = new Quaternion();
const _center = new Vector3();
const _toTarget = new Vector3();
const _aimOrigin = new Vector3();
const _aimDir = new Vector3();

type AimKind = 'none' | 'world' | 'player' | 'crate' | 'rocket';

/** Result of aimHit, reused between calls. */
const _aim = { kind: 'none' as AimKind, dist: 0, playerId: '', crateIndex: -1, center: new Vector3(), rocket: null as Rocket | null };

/** Distance along a ray (unit `dir`) to where it enters a sphere, or null if it misses or the hit is past `maxDist`. */
function raySphere(origin: Vector3, dir: Vector3, center: Vector3, radius: number, maxDist: number): number | null {
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const oz = origin.z - center.z;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  if (c <= 0) return 0; // starting inside it
  const disc = b * b - c;
  if (b > 0 || disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t <= maxDist ? t : null;
}

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
  /**
   * Client only: where other players are being drawn (alive ones), set by the netcode. A client's
   * sim has no colliders for them, so hooks and predicted rockets test against these instead.
   */
  remotePositions: ReadonlyMap<string, Vector3> | null = null;
  /** Client only: other players' rockets, where they're being drawn. `rockets` holds just our own there. */
  remoteRockets: readonly Rocket[] | null = null;

  private readonly crateIndex = new Map<number, number>(); // rigid-body handle -> index in `crates`
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
      this.crateIndex.set(body.handle, this.crates.length);
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
    p.history.clear();
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

  /** True if there's something to stand on under a capsule centered here, not just an edge brushing its side. */
  private hasFooting(center: Vector3): boolean {
    _rayDir.set(0, -1, 0);
    for (const [dx, dz] of FOOTING_OFFSETS) {
      _rayOrigin.set(center.x + dx, center.y, center.z + dz);
      if (this.world.castRay(_ray, FOOTING_DEPTH, true, undefined, PLAYER_COLLISION_GROUPS)) return true;
    }
    return false;
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

  /** Where this player's grapple would attach if fired now, or null if nothing is in range. */
  grappleTarget(p: PlayerSim, out: Vector3, outNormal?: Vector3, view?: number): Vector3 | null {
    const origin = p.eye(_aimOrigin);
    const dir = aimDirection(p.yaw, p.pitch, _aimDir);
    const kind = this.aimHit(origin, dir, GRAPPLE.range, p.id, view, outNormal);
    this.aimRockets(p.id, origin, dir, kind === 'none' ? GRAPPLE.range : _aim.dist, view);
    if (_aim.rocket) {
      // The hook sits on the rocket, pointing back along the rope.
      outNormal?.copy(dir).negate();
      return out.copy(_aim.rocket.pos);
    }
    if (kind === 'none') return null;
    return out.copy(origin).addScaledVector(dir, _aim.dist);
  }

  /**
   * Sets `_aim.rocket` (and kind 'rocket') to the nearest rocket a grapple ray passes close enough
   * to hook within `maxDist`, or null. On the server other players' rockets are backed up along
   * their flight to where the shooter saw them, so what you hooked on screen is what you hook here.
   */
  private aimRockets(playerId: string, origin: Vector3, dir: Vector3, maxDist: number, view: number | undefined) {
    _aim.rocket = null;
    const rewind = this.remoteRockets || view === undefined ? 0 : Math.min(Math.max(this.tick - view, 0), REWIND_TICKS);
    const test = (r: Rocket) => {
      const own = r.ownerId === playerId;
      if (own && !GRAPPLE.hookOwnRockets) return;
      // Our own rockets are seen where they are (predicted), not a lag behind.
      _center.copy(r.pos);
      if (!own) _center.addScaledVector(r.dir, -ROCKET.speed * DT * rewind);
      const t = raySphere(origin, dir, _center, ROCKET.hookRadius, maxDist);
      if (t === null) return;
      maxDist = t;
      _aim.kind = 'rocket';
      _aim.dist = t;
      _aim.rocket = r;
    };
    this.rockets.forEach(test);
    this.remoteRockets?.forEach(test);
  }

  private findRocket(ownerId: string, shot: number): Rocket | undefined {
    const match = (r: Rocket) => r.ownerId === ownerId && r.shot === shot;
    return this.rockets.find(match) ?? this.remoteRockets?.find(match);
  }

  /**
   * Casts a ray against the level, crates and other players (except `excludeId`), nearest first.
   * The details land in `_aim`.
   */
  private aimHit(origin: Vector3, dir: Vector3, maxDist: number, excludeId: string, view: number | undefined, outNormal?: Vector3): AimKind {
    _rayOrigin.copy(origin);
    _rayDir.copy(dir);
    // Players are filtered out by collision group here: they're tested below, at the right time.
    const hit = this.world.castRayAndGetNormal(_ray, maxDist, true, undefined, PLAYER_COLLISION_GROUPS);
    _aim.kind = 'none';
    if (hit) {
      _aim.dist = hit.timeOfImpact;
      const body = hit.collider.parent();
      const crate = body ? this.crateIndex.get(body.handle) : undefined;
      _aim.kind = crate === undefined ? 'world' : 'crate';
      _aim.crateIndex = crate ?? -1;
      outNormal?.set(hit.normal.x, hit.normal.y, hit.normal.z);
    }
    this.forEachTarget(excludeId, view, (id, center) => {
      const t = rayCapsule(origin, dir, center, _aim.kind === 'none' ? maxDist : _aim.dist);
      if (t === null) return;
      _aim.kind = 'player';
      _aim.dist = t;
      _aim.playerId = id;
      _aim.center.copy(center);
    });
    // (Re-read through a cast: TypeScript can't see that the callback above may have changed it.)
    const kind = _aim.kind as AimKind;
    if (kind === 'player' && outNormal) {
      capsuleNormal(_toTarget.copy(origin).addScaledVector(dir, _aim.dist), _aim.center, outNormal);
    }
    return kind;
  }

  /**
   * Every other living player, at the position hit tests should use: on a client, where it draws
   * them; on the server, rewound to `view` (the tick the shooter was seeing), capped at REWIND_TICKS.
   */
  private forEachTarget(excludeId: string, view: number | undefined, fn: (id: string, center: Vector3) => void) {
    if (this.remotePositions) {
      for (const [id, pos] of this.remotePositions) if (id !== excludeId) fn(id, pos);
      return;
    }
    const rewind = view === undefined ? null : Math.min(Math.max(view, this.tick - REWIND_TICKS), this.tick);
    for (const o of this.players.values()) {
      if (o.id === excludeId || !o.alive) continue;
      if (rewind === null || !o.history.sample(rewind, _center)) _center.copy(o.pos);
      fn(o.id, _center);
    }
  }

  /** Moves a grapple's anchor along with whatever it's hooked into. False if that's gone (died, left). */
  private followHook(g: GrappleState): boolean {
    const h = g.hook;
    if (!h) return true;
    if (h.kind === 'player') {
      let pos: Vector3 | undefined;
      if (this.remotePositions) pos = this.remotePositions.get(h.id);
      else {
        const target = this.players.get(h.id);
        if (target?.alive) pos = target.pos;
      }
      if (!pos) return false;
      g.anchor.copy(pos).add(h.offset);
      return true;
    }
    if (h.kind === 'rocket') {
      // Once it explodes (or fizzles) the rope has nothing left to hold.
      const rocket = this.findRocket(h.ownerId, h.shot);
      if (!rocket) return false;
      g.anchor.copy(rocket.pos);
      return true;
    }
    const crate = this.crates[h.index];
    const r = crate.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    const t = crate.translation();
    g.anchor.copy(h.local).applyQuaternion(_q).add(_center.set(t.x, t.y, t.z));
    g.normal.copy(h.localNormal).applyQuaternion(_q);
    return true;
  }

  /** The other end of a rope's pull, on whatever it's hooked into. Server only. */
  private pullHooked(p: PlayerSim, h: Hook) {
    if (h.kind === 'rocket') return; // rockets fly straight no matter what's hanging off them
    if (h.kind === 'player') {
      // Tug of war: they get dragged toward us too.
      const target = this.players.get(h.id);
      if (!target) return;
      const dist = _toTarget.subVectors(p.pos, target.pos).length();
      if (dist <= GRAPPLE.minLength) return;
      _toTarget.divideScalar(dist);
      if (target.vel.dot(_toTarget) < GRAPPLE.maxPullSpeed) {
        target.vel.addScaledVector(_toTarget, GRAPPLE.pullAccel * GRAPPLE.playerTug * DT);
      }
      return;
    }
    // A fixed force, so the crate's mass (and whatever is stacked on or wedged against it) decides how far it moves.
    const crate = this.crates[h.index];
    const t = crate.translation();
    const dist = _toTarget.subVectors(p.pos, _center.set(t.x, t.y, t.z)).length();
    if (dist <= GRAPPLE.minLength + 0.5) return;
    _toTarget.divideScalar(dist);
    const v = crate.linvel();
    if (v.x * _toTarget.x + v.y * _toTarget.y + v.z * _toTarget.z >= GRAPPLE.maxPullSpeed) return;
    crate.applyImpulse(_toTarget.multiplyScalar(GRAPPLE.crateReelForce * DT), true);
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
    for (const p of this.players.values()) if (p.alive) p.history.record(this.tick, p.pos);
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
      // Only the server brings players back. Holding grapple through the respawn doesn't fire it
      // on the first tick alive.
      p.grappleUsed = input.grapple;
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

    // Grapple: fires on press, or the moment its cooldown ends if the button is still held.
    // Releases on let go.
    p.grappleCooldown = Math.max(0, p.grappleCooldown - DT);
    if (!input.grapple) p.grappleUsed = false;
    if (input.grapple && !p.grappleUsed && !p.grapple && p.grappleCooldown === 0) {
      p.grappleUsed = true;
      const normal = new Vector3();
      const anchor = this.grappleTarget(p, new Vector3(), normal, input.view);
      if (!anchor) {
        events.push({ type: 'grappleMiss', playerId: p.id });
        p.grappleCooldown = GRAPPLE.cooldown;
      }
      if (anchor) {
        let hook: Hook | null = null;
        if (_aim.kind === 'rocket') {
          hook = { kind: 'rocket', ownerId: _aim.rocket!.ownerId, shot: _aim.rocket!.shot };
        } else if (_aim.kind === 'player') {
          // Offset from where they were when hit; from now on the anchor follows where they are.
          hook = { kind: 'player', id: _aim.playerId, offset: anchor.clone().sub(_aim.center) };
        } else if (_aim.kind === 'crate') {
          const crate = this.crates[_aim.crateIndex];
          const r = crate.rotation();
          _q.set(r.x, r.y, r.z, r.w).invert();
          const t = crate.translation();
          hook = {
            kind: 'crate',
            index: _aim.crateIndex,
            local: anchor.clone().sub(_center.set(t.x, t.y, t.z)).applyQuaternion(_q),
            localNormal: normal.clone().applyQuaternion(_q),
          };
        }
        p.grapple = { anchor, normal, length: p.pos.distanceTo(anchor), hook };
        if (p.grounded) {
          p.vel.y = Math.max(p.vel.y, GRAPPLE.attachHop);
          p.grounded = false;
        }
        events.push({ type: 'grapple', playerId: p.id, attached: true });
      }
    } else if (!input.grapple && p.grapple) {
      p.grapple = null;
      p.grappleCooldown = GRAPPLE.cooldown;
      events.push({ type: 'grapple', playerId: p.id, attached: false });
    }

    if (updateVelocity(p.vel, input, p.grounded, DT)) events.push({ type: 'jumped', playerId: p.id });
    const wasGrounded = p.grounded;
    const fallSpeed = -p.vel.y;
    if (p.grapple && !this.followHook(p.grapple)) {
      p.grapple = null;
      p.grappleCooldown = GRAPPLE.cooldown;
      events.push({ type: 'grapple', playerId: p.id, attached: false });
    }
    if (p.grapple) {
      const hook = p.grapple.hook;
      applyGrapple(p.pos, p.vel, p.grapple, DT, hook?.kind === 'crate' ? GRAPPLE.cratePull : 1);
      if (hook && mode === 'authority') this.pullHooked(p, hook);
    }

    // Move through the world with collision, then drop whatever velocity was blocked.
    _desired.copy(p.vel).multiplyScalar(DT);
    this.controller.computeColliderMovement(p.collider, _desired, undefined, PLAYER_COLLISION_GROUPS);
    const moved = this.controller.computedMovement();
    const touching = this.controller.computedGrounded() && p.vel.y <= MAX_GROUNDED_RISE;
    p.vel.x = clipVelocity(p.vel.x, _desired.x, moved.x);
    p.vel.y = clipVelocity(p.vel.y, _desired.y, moved.y);
    p.vel.z = clipVelocity(p.vel.z, _desired.z, moved.z);
    p.pos.x += moved.x;
    p.pos.y += moved.y;
    p.pos.z += moved.z;
    p.body.setNextKinematicTranslation(p.pos);
    p.grounded = touching && this.hasFooting(p.pos);
    if (p.grounded && !wasGrounded && fallSpeed > 2) {
      events.push({ type: 'landed', playerId: p.id, impactSpeed: fallSpeed });
    }

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
        lag: mode === 'authority' && input.view !== undefined ? Math.min(Math.max(this.tick - input.view, 0), REWIND_TICKS) : 0,
      });
      events.push({ type: 'fired', playerId: p.id });
    }
  }

  private stepRockets(events: SimEvent[], mode: StepMode) {
    const travel = ROCKET.speed * DT;
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      r.prevPos.copy(r.pos);
      const normal = new Vector3();
      // Other players are rewound by the shooter's lag, so a rocket that hits someone on the
      // shooter's screen hits them here too.
      const kind = this.aimHit(r.pos, r.dir, travel, r.ownerId, r.lag ? this.tick - r.lag : undefined, normal);
      if (kind === 'player') {
        r.pos.addScaledVector(r.dir, Math.max(0, _aim.dist - 0.1));
        this.explode(r, normal, false, events, mode, { id: _aim.playerId, center: _aim.center.clone() });
        this.rockets.splice(i, 1);
        continue;
      }
      if (kind !== 'none') {
        r.pos.addScaledVector(r.dir, _aim.dist - 0.1);
      } else {
        r.pos.addScaledVector(r.dir, travel);
        r.life -= DT;
        if (r.life > 0) continue;
        normal.copy(r.dir).negate();
      }
      this.explode(r, normal, true, events, mode);
      this.rockets.splice(i, 1);
    }
  }

  /** `direct`: the player the rocket hit, at the (possibly rewound) position it hit them at. */
  private explode(
    r: Rocket,
    normal: Vector3,
    surface: boolean,
    events: SimEvent[],
    mode: StepMode,
    direct?: { id: string; center: Vector3 },
  ) {
    const at = r.pos;
    const radius = ROCKET.blastRadius;

    for (const p of this.players.values()) {
      if (!p.alive) continue;
      // Judge a direct hit where it landed, not where the target has moved on to since.
      const center = direct?.id === p.id ? direct.center : p.pos;
      const dist = center.distanceTo(at);
      if (dist >= radius) continue;
      const falloff = 1 - dist / radius;
      if (dist < 1e-3) _dir.set(0, 1, 0);
      else _dir.subVectors(center, at).divideScalar(dist);
      const boost = p.id === r.ownerId ? ROCKET.selfKnockback : 1;
      p.vel.addScaledVector(_dir, ROCKET.knockback * boost * falloff);
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
