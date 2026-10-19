import RAPIER from '@dimforge/rapier3d-compat';
import { Euler, Quaternion, Vector3 } from 'three';
import { COMBAT, CRATE, DT, GRAPPLE, GRAVITY, GRENADE, HYPERSONIC, LOADOUT, PICKUP, PLAYER, ROCKET, SEEKERS, WEAPONS, type SeekerConfig } from './config';
import type { MapDef, SpawnDef, Vec3Tuple } from './map';
import { capsuleNormal, PositionHistory, rayCapsule, REWIND_TICKS } from './hits';
import { aimDirection, applyGrapple, updateVelocity, type GrappleState, type Hook } from './movement';
import { EMPTY_INPUT, type PlayerInput, type SeekerId, type WeaponId } from './types';

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
  drum: number; // grenades left in the grenade launcher
  reloading: boolean; // the drum is being refilled; fireCooldown counts it down
  grappleCooldown: number;
  grappleUsed: boolean;
  lockTarget: string | null; // who a seeker launcher is locking onto
  lockProgress: number; // seconds they've been held in the lock box; locked at the weapon's lockTime
  yaw: number;
  pitch: number;
  health: number;
  alive: boolean;
  respawnIn: number; // seconds, while dead
  protectedFor: number; // seconds of spawn protection left
  primary: WeaponId;
  secondary: WeaponId;
}

export type DeathCause = ProjectileKind | 'fall';

export const isSeeker = (w: WeaponId): w is SeekerId => w in SEEKERS;

/** True once a seeker launcher has held its target long enough to fire. */
export function lockedOn(p: { primary: WeaponId; lockTarget: string | null; lockProgress: number }): boolean {
  return isSeeker(p.primary) && p.lockTarget !== null && p.lockProgress >= SEEKERS[p.primary].lockTime;
}

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
  drum: number = GRENADE.drum;
  reloading = false;
  grappleCooldown = 0;
  grappleUsed = false; // this press of the grapple button already fired; cleared on release
  lockTarget: string | null = null;
  lockProgress = 0;
  yaw = 0;
  pitch = 0;
  /** Seq of the input being simulated (0 offline). Tags fired rockets so a client can match its predictions. */
  seq = 0;
  primary: WeaponId = LOADOUT.primary;
  secondary: WeaponId = LOADOUT.secondary;

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
      drum: this.drum,
      reloading: this.reloading,
      grappleCooldown: this.grappleCooldown,
      grappleUsed: this.grappleUsed,
      lockTarget: this.lockTarget,
      lockProgress: this.lockProgress,
      yaw: this.yaw,
      pitch: this.pitch,
      health: this.health,
      alive: this.alive,
      respawnIn: this.respawnIn,
      protectedFor: this.protectedFor,
      primary: this.primary,
      secondary: this.secondary,
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
    this.drum = s.drum;
    this.reloading = s.reloading;
    this.grappleCooldown = s.grappleCooldown;
    this.grappleUsed = s.grappleUsed;
    this.lockTarget = s.lockTarget;
    this.lockProgress = s.lockProgress;
    this.yaw = s.yaw;
    this.pitch = s.pitch;
    this.health = s.health;
    this.respawnIn = s.respawnIn;
    this.protectedFor = s.protectedFor;
    this.primary = s.primary;
    this.secondary = s.secondary;
    if (s.alive !== this.alive) {
      this.alive = s.alive;
      this.collider.setEnabled(s.alive);
    }
    this.collider.setTranslation(this.pos);
    this.body.setNextKinematicTranslation(this.pos);
  }
}

export type MissilePhase = 'climb' | 'turn' | 'terminal';

/** Every primary weapon fires a projectile of the same name. */
export type ProjectileKind = Exclude<WeaponId, 'grapple'>;

/**
 * Rockets fly straight at a constant speed and explode on anything. Grenades fall and bounce off
 * surfaces; once armed they explode on any player they touch, otherwise when the fuse runs out.
 */
export interface Projectile {
  id: number; // server-assigned; predicted ones use -shot until the server's copy replaces them
  kind: ProjectileKind;
  ownerId: string;
  shot: number; // seq of the owner's input that fired it
  pos: Vector3;
  prevPos: Vector3;
  vel: Vector3;
  life: number;
  traveled: number; // meters flown: a grenade arms (explodes on players) at GRENADE.armDistance
  lag: number; // ticks to rewind other players by when testing hits: how far behind the shooter was seeing
  struck: string | null; // the last player an unarmed grenade bounced off, so one hit only hurts once
  target: string | null; // the player a seeker missile is steering for
  /**
   * A seeker's flight: a javelin climbs, turns over at the top, then makes its terminal dive. Only
   * in the terminal phase can the target slip out of its seeker cone. Everything else is terminal.
   */
  phase: MissilePhase;
  apex: number; // the height a javelin climbs to before turning over
}

export const isArmed = (p: Projectile) => p.kind !== 'grenade' || p.traveled >= GRENADE.armDistance;

/** A mystery box. Server-side state, mirrored to clients from snapshots. */
export interface Pickup {
  pos: Vector3;
  respawnIn: number; // 0 while it's there to take
}

function seekerBlast(s: SeekerConfig): Blast {
  return { radius: s.blastRadius, knockback: s.knockback, selfKnockback: s.selfKnockback, crateKnockback: s.crateKnockback, damage: s.damage };
}

interface Blast {
  radius: number;
  knockback: number;
  selfKnockback: number;
  crateKnockback: number;
  damage: number;
  directFull?: boolean; // the player it hits directly takes full damage and knockback, however far from their center
  lift?: number; // minimum upward component of the knockback direction
  selfRadius?: number; // how far the blast reaches the player who fired it, if not `radius`
}

const BLASTS: Record<ProjectileKind, Blast> = {
  rocket: { radius: ROCKET.blastRadius, knockback: ROCKET.knockback, selfKnockback: ROCKET.selfKnockback, crateKnockback: ROCKET.crateKnockback, damage: COMBAT.rocketDamage },
  grenade: { radius: GRENADE.blastRadius, knockback: GRENADE.knockback, selfKnockback: GRENADE.selfKnockback, crateKnockback: GRENADE.crateKnockback, damage: GRENADE.damage },
  javelin: seekerBlast(SEEKERS.javelin),
  stinger: seekerBlast(SEEKERS.stinger),
  hypersonic: {
    radius: HYPERSONIC.blastRadius,
    knockback: HYPERSONIC.knockback,
    selfKnockback: HYPERSONIC.selfKnockback,
    crateKnockback: HYPERSONIC.crateKnockback,
    damage: HYPERSONIC.damage,
    directFull: true,
    lift: HYPERSONIC.lift,
    selfRadius: HYPERSONIC.selfRadius,
  },
};

export type SimEvent =
  | { type: 'fired'; playerId: string; weapon: WeaponId }
  | { type: 'explosion'; pos: Vector3; normal: Vector3; surface: boolean; ownerId: string; shot: number; radius: number } // surface = false for mid-air
  | { type: 'bounce'; pos: Vector3; normal: Vector3; ownerId: string; shot: number; speed: number } // a grenade hitting something before it arms
  | { type: 'pickup'; playerId: string; weapon: WeaponId; box: number }
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
const _step = new Vector3();
const _segment = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _want = new Vector3();
/** How steeply a javelin aims to come down on its target. */
const DIVE_ANGLE = 0.95; // about 55°

type AimKind = 'none' | 'world' | 'player' | 'crate' | 'rocket';

/** Result of aimHit, reused between calls. */
const _aim = { kind: 'none' as AimKind, dist: 0, playerId: '', crateIndex: -1, center: new Vector3(), rocket: null as Projectile | null };

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
  readonly projectiles: Projectile[] = [];
  readonly crates: RAPIER.RigidBody[] = [];
  readonly pickups: Pickup[];
  tick = 0;
  /**
   * Client only: where other players are being drawn (alive ones), set by the netcode. A client's
   * sim has no colliders for them, so hooks and predicted rockets test against these instead.
   */
  remotePositions: ReadonlyMap<string, Vector3> | null = null;
  /** Client only: other players' projectiles, where they're being drawn. `projectiles` holds just our own there. */
  remoteProjectiles: readonly Projectile[] | null = null;

  private readonly crateIndex = new Map<number, number>(); // rigid-body handle -> index in `crates`
  private readonly controller: RAPIER.KinematicCharacterController;
  private nextRocketId = 1;
  private spawnIndex = 0;
  private pendingEvents: SimEvent[] = [];

  constructor(readonly map: MapDef) {
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = DT;
    this.pickups = map.pickups.map((pos) => ({ pos: new Vector3(...pos), respawnIn: 0 }));

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
    p.primary = LOADOUT.primary;
    p.secondary = LOADOUT.secondary;
    p.drum = GRENADE.drum;
    p.reloading = false;
    p.lockTarget = null;
    p.lockProgress = 0;
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
    const rewind = this.remoteProjectiles || view === undefined ? 0 : Math.min(Math.max(this.tick - view, 0), REWIND_TICKS);
    const test = (r: Projectile) => {
      if (r.kind !== 'rocket') return;
      const own = r.ownerId === playerId;
      if (own && !GRAPPLE.hookOwnRockets) return;
      // Our own rockets are seen where they are (predicted), not a lag behind.
      _center.copy(r.pos);
      if (!own) _center.addScaledVector(r.vel, -DT * rewind);
      const t = raySphere(origin, dir, _center, ROCKET.hookRadius, maxDist);
      if (t === null) return;
      maxDist = t;
      _aim.kind = 'rocket';
      _aim.dist = t;
      _aim.rocket = r;
    };
    this.projectiles.forEach(test);
    this.remoteProjectiles?.forEach(test);
  }

  private findRocket(ownerId: string, shot: number): Projectile | undefined {
    const match = (r: Projectile) => r.kind === 'rocket' && r.ownerId === ownerId && r.shot === shot;
    return this.projectiles.find(match) ?? this.remoteProjectiles?.find(match);
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
    this.stepPickups(events);
    this.stepProjectiles(events, 'authority');
    this.world.step();
    this.tick++;
    for (const p of this.players.values()) if (p.alive) p.history.record(this.tick, p.pos);
    return events;
  }

  /**
   * Client prediction: one tick for just this player and the projectiles in this sim (its own).
   * Other players, their projectiles, the crates and the mystery boxes come from the server.
   */
  predict(p: PlayerSim, input: PlayerInput): SimEvent[] {
    const events = this.takePendingEvents();
    this.stepPlayer(p, input, events, 'predict');
    this.stepProjectiles(events, 'predict');
    this.world.step();
    return events;
  }

  /**
   * Re-runs one already-predicted tick for this player and its projectiles after a server correction.
   * No physics step and no events, so replaying a handful of ticks per snapshot is cheap.
   */
  replay(p: PlayerSim, input: PlayerInput) {
    this.stepPlayer(p, input, _discard, 'replay');
    this.stepProjectiles(_discard, 'replay');
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
    // The grapple is the only secondary weapon so far: without it the button does nothing.
    // A two-handed primary leaves no hand free for it.
    const grappleHeld = input.grapple && p.secondary === 'grapple' && !WEAPONS[p.primary].twoHanded;
    p.grappleCooldown = Math.max(0, p.grappleCooldown - DT);
    if (!grappleHeld) p.grappleUsed = false;
    if (grappleHeld && !p.grappleUsed && !p.grapple && p.grappleCooldown === 0) {
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
    } else if (!grappleHeld && p.grapple) {
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
    if (p.reloading && p.fireCooldown === 0) {
      p.reloading = false;
      p.drum = GRENADE.drum;
    }
    this.updateLock(p, input.view);
    const kind = p.primary;
    // Seekers only fire with a lock.
    if (input.fire && p.fireCooldown === 0 && kind !== 'grapple' && (!isSeeker(kind) || lockedOn(p))) {
      const vel = aimDirection(p.yaw, p.pitch, new Vector3());
      let life: number;
      if (kind === 'grenade') {
        p.fireCooldown = GRENADE.cooldown;
        if (--p.drum === 0) {
          p.reloading = true;
          p.fireCooldown = GRENADE.reload;
        }
        vel.multiplyScalar(GRENADE.speed);
        life = GRENADE.lifetime;
      } else if (kind === 'rocket') {
        p.fireCooldown = ROCKET.cooldown;
        vel.multiplyScalar(ROCKET.speed);
        life = ROCKET.lifetime;
      } else if (kind === 'hypersonic') {
        p.fireCooldown = HYPERSONIC.cooldown;
        vel.multiplyScalar(HYPERSONIC.speed);
        life = HYPERSONIC.lifetime;
      } else {
        const seeker = SEEKERS[kind];
        p.fireCooldown = seeker.cooldown;
        if (seeker.climb) vel.y += 0.4; // a javelin leaves the tube nose-up, already starting its climb
        vel.normalize().multiplyScalar(seeker.launchSpeed);
        life = seeker.lifetime;
      }
      const pos = p.eye(new Vector3());
      // A javelin's climb tops out above the higher of it and its target: lower for close targets,
      // so it still has room to turn over and dive.
      let phase: MissilePhase = 'terminal';
      let apex = 0;
      const climb = isSeeker(kind) ? SEEKERS[kind].climb : undefined;
      const aimed = p.lockTarget ? this.playerPosition(p.lockTarget) : undefined;
      if (climb && aimed) {
        const horizontal = Math.hypot(aimed.x - pos.x, aimed.z - pos.z);
        phase = 'climb';
        apex = Math.max(pos.y, aimed.y) + Math.min(Math.max(horizontal * 0.7, 6), climb);
      }
      this.projectiles.push({
        // A predicted projectile's id must survive replays so its mesh and trail stay put: derive it from the input.
        id: mode === 'authority' ? this.nextRocketId++ : -p.seq,
        kind,
        ownerId: p.id,
        shot: p.seq,
        pos,
        prevPos: pos.clone(),
        vel,
        life,
        traveled: 0,
        lag: mode === 'authority' && input.view !== undefined ? Math.min(Math.max(this.tick - input.view, 0), REWIND_TICKS) : 0,
        struck: null,
        target: isSeeker(kind) ? p.lockTarget : null,
        phase,
        apex,
      });
      // The lock is spent: the next missile needs a fresh one.
      p.lockTarget = null;
      p.lockProgress = 0;
      events.push({ type: 'fired', playerId: p.id, weapon: kind });
    }
  }

  /**
   * Seeker lock-on, once the launcher is loaded. The player nearest the crosshair inside the
   * weapon's lock box (and in sight) becomes the target; holding them there fills the lock. Losing them drains it, faster, and a
   * new target only takes over once it's empty. Other players are judged where the shooter saw them.
   */
  private updateLock(p: PlayerSim, view: number | undefined) {
    // Nothing locks while the launcher is reloading, so a lock always takes its full time after a shot.
    if (!isSeeker(p.primary) || p.fireCooldown > 0) {
      p.lockTarget = null;
      p.lockProgress = 0;
      return;
    }
    const seeker = SEEKERS[p.primary];
    if (p.lockTarget && !this.playerPosition(p.lockTarget)) {
      p.lockTarget = null; // died or left
      p.lockProgress = 0;
    }
    const candidate = this.lockCandidate(p, seeker, view);
    if (candidate !== null && candidate === p.lockTarget) {
      p.lockProgress = Math.min(seeker.lockTime, p.lockProgress + DT);
    } else if (p.lockTarget && p.lockProgress > 0) {
      p.lockProgress = Math.max(0, p.lockProgress - DT * seeker.lockDecay);
      if (p.lockProgress === 0) p.lockTarget = null;
    } else {
      p.lockTarget = candidate;
      p.lockProgress = 0;
    }
  }

  /** The player to lock onto: the current target while they're still in the box, else the one nearest the crosshair. */
  private lockCandidate(p: PlayerSim, seeker: SeekerConfig, view: number | undefined): string | null {
    const eye = p.eye(_aimOrigin);
    const forward = aimDirection(p.yaw, p.pitch, _aimDir);
    _right.set(Math.cos(p.yaw), 0, -Math.sin(p.yaw));
    _up.crossVectors(_right, forward);
    const maxX = Math.tan(seeker.lockBox[0]);
    const maxY = Math.tan(seeker.lockBox[1]);
    let best: string | null = null;
    let bestScore = Infinity;
    this.forEachTarget(p.id, view, (id, center) => {
      _toTarget.subVectors(center, eye);
      const z = _toTarget.dot(forward);
      if (z <= 0 || _toTarget.length() > seeker.lockRange) return;
      const x = _toTarget.dot(_right) / z / maxX;
      const y = _toTarget.dot(_up) / z / maxY;
      if (Math.abs(x) > 1 || Math.abs(y) > 1 || !this.canSee(eye, _want.copy(center))) return;
      const score = id === p.lockTarget ? -1 : x * x + y * y;
      if (score < bestScore) {
        best = id;
        bestScore = score;
      }
    });
    return best;
  }

  /** Where a living player is now (on a client, where it's drawing them), or undefined. */
  private playerPosition(id: string): Vector3 | undefined {
    if (this.remotePositions) return this.remotePositions.get(id);
    const p = this.players.get(id);
    return p?.alive ? p.pos : undefined;
  }

  /** Mystery boxes, server only: walking into one swaps a weapon for one you aren't carrying. */
  private stepPickups(events: SimEvent[]) {
    const reach = PICKUP.size / 2 + PICKUP.reach + PLAYER.radius;
    this.pickups.forEach((box, index) => {
      if (box.respawnIn > 0) {
        box.respawnIn = Math.max(0, box.respawnIn - DT);
        return;
      }
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        // Distance from the box to the core segment of the player's capsule.
        const dy = Math.min(Math.max(box.pos.y - p.pos.y, -PLAYER.halfHeight), PLAYER.halfHeight);
        if (_segment.set(p.pos.x, p.pos.y + dy, p.pos.z).distanceTo(box.pos) > reach) continue;
        const weapon = this.swapWeapon(p);
        if (!weapon) continue;
        box.respawnIn = PICKUP.respawn;
        events.push({ type: 'pickup', playerId: p.id, weapon, box: index });
        return;
      }
    });
  }

  /** Gives a player a random weapon they aren't carrying, in that weapon's slot. Null if there's none. */
  private swapWeapon(p: PlayerSim): WeaponId | null {
    const options = (Object.keys(WEAPONS) as WeaponId[]).filter((w) => w !== p.primary && w !== p.secondary);
    if (!options.length) return null;
    const weapon = options[Math.floor(Math.random() * options.length)];
    if (WEAPONS[weapon].slot === 'primary') {
      p.primary = weapon;
      p.lockTarget = null;
      p.lockProgress = 0;
      p.drum = GRENADE.drum; // a fresh weapon comes loaded
      if (p.reloading) p.fireCooldown = 0;
      p.reloading = false;
    } else {
      p.secondary = weapon;
      p.grapple = null;
    }
    return weapon;
  }

  private stepProjectiles(events: SimEvent[], mode: StepMode) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const r = this.projectiles[i];
      r.prevPos.copy(r.pos);
      const exploded =
        r.kind === 'grenade'
          ? this.stepGrenade(r, events, mode)
          : r.kind === 'rocket' || r.kind === 'hypersonic'
            ? this.stepRocket(r, events, mode)
            : this.stepMissile(r, r.kind, events, mode);
      if (exploded) this.projectiles.splice(i, 1);
    }
  }

  /**
   * Seeker missiles: the motor brings them up to speed, then they steer for their target at a
   * limited turn rate. A javelin first climbs steeply toward its target until it reaches its apex
   * (or gets so close it has to come down now), turns over, then dives. On the final approach a
   * target that gets outside the seeker cone is lost, and the missile flies straight on, as it does
   * when its target dies. True once it has exploded.
   */
  private stepMissile(m: Projectile, kind: SeekerId, events: SimEvent[], mode: StepMode): boolean {
    const seeker = SEEKERS[kind];
    const dir = _step.copy(m.vel).normalize();
    const speed = Math.min(seeker.speed, m.vel.length() + seeker.boost * DT);
    const target = m.target ? this.playerPosition(m.target) : undefined;
    if (target) {
      if (m.phase === 'climb') {
        const dx = target.x - m.pos.x;
        const dz = target.z - m.pos.z;
        const horizontal = Math.hypot(dx, dz);
        // Turn over at the apex, or sooner if the target is close: arcing over takes some distance,
        // and the dive should still come down steeply rather than overshoot.
        const radius = speed / (seeker.turnOverRate ?? seeker.turnRate);
        const arc = radius * (Math.sin(seeker.climbAngle ?? 1) + Math.sin(DIVE_ANGLE));
        const dive = Math.max(0, m.pos.y - target.y) / Math.tan(DIVE_ANGLE);
        if (m.pos.y >= m.apex || horizontal < arc + dive) m.phase = 'turn';
        else {
          // Nose up at the climb angle, heading for the target.
          const c = Math.cos(seeker.climbAngle ?? 1);
          if (horizontal > 1e-3) _want.set((dx / horizontal) * c, Math.sin(seeker.climbAngle ?? 1), (dz / horizontal) * c);
          else _want.set(0, 1, 0);
        }
      }
      if (m.phase !== 'climb') _want.copy(target).sub(m.pos).normalize();
      const angle = Math.acos(Math.min(1, Math.max(-1, dir.dot(_want))));
      if (m.phase === 'turn' && angle < seeker.gimbal) m.phase = 'terminal';
      else if (m.phase === 'terminal' && angle > seeker.gimbal) m.target = null; // shaken off
      const maxTurn = (m.phase === 'turn' ? (seeker.turnOverRate ?? seeker.turnRate) : seeker.turnRate) * DT;
      if (m.target && angle > 1e-4) dir.lerp(_want, Math.min(1, maxTurn / angle)).normalize();
    }
    m.vel.copy(dir).multiplyScalar(speed);
    return this.stepRocket(m, events, mode);
  }

  /** Straight line at its current speed until it hits something. True once it has exploded. */
  private stepRocket(r: Projectile, events: SimEvent[], mode: StepMode): boolean {
    const travel = r.vel.length() * DT;
    const dir = _step.copy(r.vel).normalize();
    const normal = new Vector3();
    // Other players are rewound by the shooter's lag, so a rocket that hits someone on the
    // shooter's screen hits them here too.
    const kind = this.aimHit(r.pos, dir, travel, r.ownerId, r.lag ? this.tick - r.lag : undefined, normal);
    if (kind === 'player') {
      r.pos.addScaledVector(dir, Math.max(0, _aim.dist - 0.1));
      this.explode(r, normal, false, events, mode, { id: _aim.playerId, center: _aim.center.clone() });
      return true;
    }
    if (kind !== 'none') {
      r.pos.addScaledVector(dir, _aim.dist - 0.1);
    } else {
      r.pos.addScaledVector(dir, travel);
      r.traveled += travel;
      r.life -= DT;
      if (r.life > 0) return false;
      normal.copy(dir).negate();
    }
    this.explode(r, normal, true, events, mode);
    return true;
  }

  /**
   * Gravity, then a sweep along this tick's motion. Grenades bounce off surfaces, so they can be
   * banked around corners. A player they touch sets them off once they've flown GRENADE.armDistance;
   * closer than that they bounce off the player too, hurting them. Otherwise the fuse sets them off.
   * True once it has exploded.
   */
  private stepGrenade(g: Projectile, events: SimEvent[], mode: StepMode): boolean {
    g.vel.y -= GRAVITY * DT;
    g.life -= DT;
    const speed = g.vel.length();
    const travel = speed * DT;
    if (travel < 1e-6) return this.fuse(g, events, mode);
    const dir = _step.copy(g.vel).divideScalar(speed);
    const normal = new Vector3();
    // The ray reaches a radius past the center's new spot, so the grenade's surface stops at walls.
    const kind = this.aimHit(g.pos, dir, travel + GRENADE.radius, g.ownerId, g.lag ? this.tick - g.lag : undefined, normal);
    if (kind === 'none') {
      g.pos.addScaledVector(dir, travel);
      g.traveled += travel;
      return this.fuse(g, events, mode);
    }

    const dist = Math.max(0, _aim.dist - GRENADE.radius);
    g.pos.addScaledVector(dir, dist);
    g.traveled += dist;
    const player = kind === 'player' ? { id: _aim.playerId, center: _aim.center.clone() } : undefined;
    if (player && isArmed(g)) {
      this.explode(g, normal, false, events, mode, player);
      return true;
    }

    // Not armed yet: a player hit point blank takes a knock and some damage, once.
    if (player && player.id !== g.struck) {
      g.struck = player.id;
      const target = this.players.get(player.id);
      if (target) {
        target.vel.addScaledVector(dir, GRENADE.impactKnockback);
        target.grounded = false;
        if (mode === 'authority') this.damage(target, GRENADE.impactDamage, g.ownerId, events, 'grenade');
      }
    }
    // Bounce off the surface or player: lose some of the speed into it, and a little along it.
    const into = -g.vel.dot(normal);
    if (into > 0) {
      g.vel.addScaledVector(normal, into).multiplyScalar(GRENADE.friction).addScaledVector(normal, into * GRENADE.restitution);
      if (into > 2) events.push({ type: 'bounce', pos: g.pos.clone(), normal, ownerId: g.ownerId, shot: g.shot, speed: into });
    }
    g.pos.addScaledVector(normal, 0.01); // off the surface, so next tick's ray doesn't start inside it
    return this.fuse(g, events, mode);
  }

  /** A grenade whose fuse has run out explodes where it is. True if it did. */
  private fuse(g: Projectile, events: SimEvent[], mode: StepMode): boolean {
    if (g.life > 0) return false;
    this.explode(g, new Vector3(0, 1, 0), false, events, mode);
    return true;
  }

  /** `direct`: the player the projectile hit, at the (possibly rewound) position it hit them at. */
  private explode(
    r: Projectile,
    normal: Vector3,
    surface: boolean,
    events: SimEvent[],
    mode: StepMode,
    direct?: { id: string; center: Vector3 },
  ) {
    const at = r.pos;
    const blast = BLASTS[r.kind];
    const radius = blast.radius;

    for (const p of this.players.values()) {
      if (!p.alive) continue;
      // Judge a direct hit where it landed, not where the target has moved on to since.
      const center = direct?.id === p.id ? direct.center : p.pos;
      const dist = center.distanceTo(at);
      const reach = p.id === r.ownerId ? (blast.selfRadius ?? radius) : radius;
      if (dist >= reach) continue;
      const falloff = blast.directFull && direct?.id === p.id ? 1 : 1 - dist / reach;
      if (dist < 1e-3) _dir.set(0, 1, 0);
      else _dir.subVectors(center, at).divideScalar(dist);
      if (blast.lift && _dir.y < blast.lift) {
        // Keep the horizontal heading, tilted up to the minimum lift.
        const flat = Math.hypot(_dir.x, _dir.z);
        const scale = flat > 1e-6 ? Math.sqrt(1 - blast.lift * blast.lift) / flat : 0;
        _dir.set(_dir.x * scale, blast.lift, _dir.z * scale);
      }
      const boost = p.id === r.ownerId ? blast.selfKnockback : 1;
      p.vel.addScaledVector(_dir, blast.knockback * boost * falloff);
      p.grounded = false;
      events.push({ type: 'knockback', playerId: p.id, strength: falloff, sourceId: r.ownerId, shot: r.shot });
      // Health is server-only: clients show what the server says, a round trip later.
      if (mode === 'authority' && (p.id !== r.ownerId || COMBAT.selfDamage)) {
        this.damage(p, Math.round(blast.damage * falloff), r.ownerId, events, r.kind);
      }
    }

    // On a client the crates are only server-placed obstacles.
    if (mode === 'authority') this.pushCrates(at, blast);
    events.push({ type: 'explosion', pos: at.clone(), normal, surface, ownerId: r.ownerId, shot: r.shot, radius });
  }

  private damage(p: PlayerSim, amount: number, sourceId: string, events: SimEvent[], cause: DeathCause) {
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
    if (p.health <= 0) this.kill(p, killer, cause, events);
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

  private pushCrates(at: Vector3, blast: Blast) {
    const radius = blast.radius;
    for (const crate of this.crates) {
      const t = crate.translation();
      _crate.set(t.x, t.y, t.z);
      const dist = _crate.distanceTo(at);
      if (dist >= radius) continue;
      const falloff = 1 - dist / radius;
      if (dist < 1e-3) _dir.set(0, 1, 0);
      else _dir.subVectors(_crate, at).divideScalar(dist);
      _dir.multiplyScalar(blast.crateKnockback * falloff * crate.mass());
      crate.applyImpulse(_dir, true);
    }
  }
}
