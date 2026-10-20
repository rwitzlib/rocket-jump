import RAPIER from '@dimforge/rapier3d-compat';
import { Euler, Quaternion, Vector3 } from 'three';
import { COMBAT, CRATE, CTF, DT, GRAPPLE, GRAVITY, GRENADE, HELI, HYPERSONIC, ITEMS, LOADOUT, PICKUP, PLAYER, RACE, ROCKET, SEEKERS, VEHICLE_DAMAGE, VEHICLES, WEAPONS, type GameMode, type SeekerConfig, INSTAGIB } from './config';
import { Driving } from './driving';
import type { SimEvent, StepMode } from './events';
import { Flight } from './flight';
import { capsuleNormal, rayCapsule, REWIND_TICKS } from './hits';
import type { MapDef, SpawnDef } from './map';
import { isTeamMode, noPickups, teamSpawns, type RaceCourse } from './modes';
import { aimDirection, applyGrapple, updateVelocity, type GrappleState, type Hook } from './movement';
import { clipVelocity, PLAYER_COLLISION_GROUPS, raySphere, VEHICLE_COLLIDER_GROUPS } from './physics';
import { PlayerSim } from './player';
import { BLAST_CAUSE, isSeeker, lockedOn, lockReady, type Blast, type DeathCause, type MissilePhase, type Projectile, type ProjectileKind } from './projectile';
import { ModeRules, type Flag, type Item } from './rules';
import { EMPTY_INPUT, type PlayerInput, type SeekerId, type WeaponId } from './types';
import { VehicleSim } from './vehicle';

// The authoritative game simulation. It has no rendering or DOM code, so the same class can run
// in the browser (single-player / client prediction) or in Node (the multiplayer server).
// Call `await RAPIER.init()` once before constructing it.
//
// GameSim holds the world and runs the tick: players (movement, the grapple, weapons, seeker
// locks), mystery boxes, and combat (blasts, damage, kills). Its parts live alongside it:
// projectile flight (flight.ts), vehicles in the world (driving.ts), and the per-mode rules for
// items, flags and races (rules.ts). The player and projectile types are in player.ts and
// projectile.ts, and what a tick reports in events.ts; they're re-exported here.

export type { SimEvent, StepMode, FlagAction } from './events';
export { PlayerSim, type PlayerState, type HookState } from './player';
export { isArmed, isSeeker, lockedOn, lockReady, type DeathCause, type MissilePhase, type Projectile, type ProjectileKind } from './projectile';
export type { Flag, Item } from './rules';

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

/** A mystery box. Server-side state, mirrored to clients from snapshots. */
export interface Pickup {
  pos: Vector3;
  respawnIn: number; // 0 while it's there to take
}

const _desired = new Vector3();
const _dir = new Vector3();
const _crate = new Vector3();
const _discard: SimEvent[] = [];
const _q = new Quaternion();
const _center = new Vector3();
const _toTarget = new Vector3();
const _aimOrigin = new Vector3();
const _aimDir = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _want = new Vector3();
const _down = new Vector3();
/** Meters of clear air under a victim (from its center) for a hit to count as an airshot. */
const MIDAIR_HEIGHT = 3;

export type AimKind = 'none' | 'world' | 'player' | 'crate' | 'rocket' | 'vehicle';

/** Result of aimHit, reused between calls (GameSim.aim). */
const _aim = { kind: 'none' as AimKind, dist: 0, playerId: '', crateIndex: -1, vehicleIndex: -1, center: new Vector3(), rocket: null as Projectile | null };
/** How far the crosshair ray reaches when working out what a shot from a vehicle is aimed at. */
const AIM_RANGE = 300;
const _vq = new Quaternion();
const _target = new Vector3();

// Reused for every ray cast so per-tick queries don't create garbage (GC pauses show up as hitches).
// Rapier's Ray just holds references to these vectors.
const _rayOrigin = new Vector3();
const _rayDir = new Vector3();
const _ray = new RAPIER.Ray(_rayOrigin, _rayDir);

const VEHICLE_EDGE_RADIUS = 0.25;

/** respawnIn for someone knocked out of an elimination round: past any round, until the server ends it. */
export const OUT_OF_ROUND = 1e6;

export class GameSim {
  readonly world: RAPIER.World;
  readonly players = new Map<string, PlayerSim>();
  readonly projectiles: Projectile[] = [];
  readonly crates: RAPIER.RigidBody[] = [];
  readonly pickups: Pickup[];
  /** The per-mode rules, and their state: items, flags, the race course, team scores. */
  readonly rules: ModeRules;
  readonly items: Item[];
  /** Red's then blue's, in capture the flag (the same two exist in every mode, unused). */
  readonly flags: Flag[];
  readonly course: RaceCourse;
  /** Captures in capture the flag, kills in team deathmatch. */
  readonly teamScores: number[];
  readonly flight = new Flight(this);
  readonly driving: Driving;
  /** What the last aimHit found. */
  readonly aim = _aim;
  /**
   * On a client only the one we're driving is simulated here; the netcode places the rest from
   * snapshots, like crates.
   */
  readonly vehicles: VehicleSim[] = [];
  tick = 0;
  /**
   * Client only: where other players are being drawn (alive ones), set by the netcode. A client's
   * sim has no colliders for them, so hooks and predicted rockets test against these instead.
   */
  remotePositions: ReadonlyMap<string, Vector3> | null = null;
  /** Client only: other players' projectiles, where they're being drawn. `projectiles` holds just our own there. */
  remoteProjectiles: readonly Projectile[] | null = null;
  /** Client only: other players' teams, so seekers don't lock onto teammates. */
  remoteTeams: ReadonlyMap<string, number> | null = null;

  private readonly crateIndex = new Map<number, number>(); // rigid-body handle -> index in `crates`
  private readonly vehicleIndex = new Map<number, number>(); // rigid-body handle -> index in `vehicles`
  private readonly controller: RAPIER.KinematicCharacterController;
  private nextRocketId = 1;
  private spawnIndex = 0;
  private pendingEvents: SimEvent[] = [];

  constructor(
    readonly map: MapDef,
    public mode: GameMode = 'ffa',
  ) {
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = DT;
    this.pickups = map.pickups.map((pos) => ({ pos: new Vector3(...pos), respawnIn: 0 }));
    this.rules = new ModeRules(this);
    this.items = this.rules.items;
    this.flags = this.rules.flags;
    this.course = this.rules.course;
    this.teamScores = this.rules.teamScores;

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

    this.driving = new Driving(this);

    (map.vehicles ?? []).forEach((def, index) => {
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
      const [w, h, l] = VEHICLES[def.kind].size;
      // Rounded edges, same outer size: a sharp-edged box dragged along the floor by the character
      // controller catches its bottom edges on the ground and stops dead, worst when driving diagonally.
      const r = VEHICLE_EDGE_RADIUS;
      const collider = this.world.createCollider(
        RAPIER.ColliderDesc.roundCuboid(w / 2 - r, h / 2 - r, l / 2 - r, r).setCollisionGroups(VEHICLE_COLLIDER_GROUPS),
        body,
      );
      const v = new VehicleSim(index, def, body, collider);
      v.reset();
      this.vehicleIndex.set(body.handle, index);
      this.vehicles.push(v);
    });
  }

  addPlayer(id: string, team = -1): PlayerSim {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.capsule(PLAYER.halfHeight, PLAYER.radius).setCollisionGroups(PLAYER_COLLISION_GROUPS),
      body,
    );
    const player = new PlayerSim(id, body, collider);
    player.team = team;
    this.players.set(id, player);
    this.respawn(player);
    return player;
  }

  removePlayer(id: string) {
    const p = this.players.get(id);
    if (!p) return;
    if (p.flag >= 0) this.rules.dropFlag(p, this.pendingEvents);
    if (p.vehicle >= 0) this.vehicles[p.vehicle].seats[p.seat] = null;
    this.world.removeRigidBody(p.body); // also removes its collider
    this.players.delete(id);
  }

  /** A clean slate for a new match on the same map: scores zeroed, everyone respawned, the map as it started. */
  resetForMatch(mode = this.mode) {
    this.mode = mode;
    for (const p of this.players.values()) if (p.vehicle >= 0) this.driving.leaveSeat(p);
    this.projectiles.length = 0;
    for (const v of this.vehicles) v.reset();
    for (const box of this.pickups) box.respawnIn = 0;
    for (const item of this.items) item.respawnIn = 0;
    for (const f of this.flags) this.rules.returnFlag(f);
    this.teamScores.fill(0);
    this.rules.resetHill();
    for (const p of this.players.values()) {
      p.kills = 0;
      p.deaths = 0;
      p.captures = 0;
      p.points = 0;
      p.bestLap = 0;
      p.flag = -1;
      this.respawn(p);
    }
  }

  /** Elimination: a new round, everyone back on their feet and the map as it started. */
  newRound() {
    for (const p of this.players.values()) if (p.vehicle >= 0) this.driving.leaveSeat(p);
    this.projectiles.length = 0;
    for (const box of this.pickups) box.respawnIn = 0;
    for (const item of this.items) item.respawnIn = 0;
    for (const p of this.players.values()) this.respawn(p);
  }

  /** Elimination: someone joining mid-round sits it out, as if knocked out already. */
  bench(p: PlayerSim) {
    p.alive = false;
    p.health = 0;
    p.respawnIn = OUT_OF_ROUND;
    p.collider.setEnabled(false);
  }

  get teams(): boolean {
    return isTeamMode(this.mode);
  }

  /** A player's team: -1 outside team modes. On a client, other players' come from the netcode. */
  teamOf(id: string): number {
    if (!this.teams) return -1;
    return this.players.get(id)?.team ?? this.remoteTeams?.get(id) ?? -1;
  }

  /** On the same team (and not the same player): no damage, no seeker locks. */
  allies(a: string, b: string): boolean {
    if (a === b || !this.teams) return false;
    const t = this.teamOf(a);
    return t >= 0 && t === this.teamOf(b);
  }

  respawn(p: PlayerSim) {
    // (Only a living carrier still has a flag here, moved to the other team, say: it drops where they stood.)
    if (p.flag >= 0) this.rules.dropFlag(p, this.pendingEvents);
    const spawn = this.mode === 'race' ? this.course.start : this.pickSpawn(p);
    p.armor = 0;
    p.overdrive = 0;
    p.checkpoint = 0;
    p.lapTime = -1;
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
    p.primary = this.mode === 'instagib' ? 'hypersonic' : LOADOUT.primary;
    p.secondary = LOADOUT.secondary;
    p.drum = GRENADE.drum;
    p.reloading = false;
    p.lockTarget = null;
    p.lockProgress = 0;
    p.body.setTranslation(p.pos, true);
    p.body.setNextKinematicTranslation(p.pos);
    this.pendingEvents.push({ type: 'respawn', playerId: p.id, yaw: spawn.yaw });
  }

  /**
   * The spawn point farthest from any living opponent (teammates don't count). Ties (e.g. an empty
   * map) rotate through the list. In capture the flag you spawn on your own half.
   */
  private pickSpawn(p: PlayerSim): SpawnDef {
    const spawns = this.mode === 'ctf' && p.team >= 0 ? teamSpawns(this.map, p.team) : this.map.spawns;
    const start = this.spawnIndex++;
    let best = spawns[start % spawns.length];
    let bestDist = -1;
    for (let i = 0; i < spawns.length; i++) {
      const s = spawns[(start + i) % spawns.length];
      let nearest = Infinity;
      for (const o of this.players.values()) {
        if (o === p || !o.alive || (this.teams && o.team === p.team)) continue;
        nearest = Math.min(nearest, Math.hypot(o.pos.x - s.pos[0], o.pos.y - s.pos[1], o.pos.z - s.pos[2]));
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

  /** How far a ray gets through the static level, up to `max`: keeps a third-person camera out of walls. */
  clearDistance(from: Vector3, dir: Vector3, max: number): number {
    _rayOrigin.copy(from);
    _rayDir.copy(dir);
    const flags = RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC;
    const hit = this.world.castRay(_ray, max, true, flags);
    return hit ? Math.max(0.5, hit.timeOfImpact - 0.3) : max;
  }

  /**
   * Distance along a ray to the static level (walls, floors, ramps), or null if nothing is within
   * `max`. `outNormal` gets the surface's normal at the hit. For purely visual things that should
   * bump into the level, like a knocked-out player's body.
   */
  castLevel(from: Vector3, dir: Vector3, max: number, outNormal: Vector3): number | null {
    _rayOrigin.copy(from);
    _rayDir.copy(dir);
    const flags = RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC;
    const hit = this.world.castRayAndGetNormal(_ray, max, true, flags);
    if (!hit) return null;
    outNormal.set(hit.normal.x, hit.normal.y, hit.normal.z);
    return hit.timeOfImpact;
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
  aimHit(
    origin: Vector3,
    dir: Vector3,
    maxDist: number,
    excludeId: string,
    view: number | undefined,
    outNormal?: Vector3,
    excludeVehicle = -1,
  ): AimKind {
    _rayOrigin.copy(origin);
    _rayDir.copy(dir);
    // Players are filtered out by collision group here: they're tested below, at the right time.
    const own = excludeVehicle >= 0 ? this.vehicles[excludeVehicle].body : undefined;
    const hit = this.world.castRayAndGetNormal(_ray, maxDist, true, undefined, PLAYER_COLLISION_GROUPS, undefined, own);
    _aim.kind = 'none';
    if (hit) {
      _aim.dist = hit.timeOfImpact;
      const body = hit.collider.parent();
      const crate = body ? this.crateIndex.get(body.handle) : undefined;
      const vehicle = body ? this.vehicleIndex.get(body.handle) : undefined;
      _aim.kind = crate !== undefined ? 'crate' : vehicle !== undefined ? 'vehicle' : 'world';
      _aim.crateIndex = crate ?? -1;
      _aim.vehicleIndex = vehicle ?? -1;
      outNormal?.set(hit.normal.x, hit.normal.y, hit.normal.z);
    }
    this.forEachTarget(excludeId, view, excludeVehicle, (id, center) => {
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
  private forEachTarget(excludeId: string, view: number | undefined, excludeVehicle: number, fn: (id: string, center: Vector3) => void) {
    if (this.mode === 'race') return; // racers are ghosts to each other
    if (this.remotePositions) {
      // (The netcode leaves anyone riding with us out of remotePositions.)
      for (const [id, pos] of this.remotePositions) if (id !== excludeId) fn(id, pos);
      return;
    }
    const rewind = view === undefined ? null : Math.min(Math.max(view, this.tick - REWIND_TICKS), this.tick);
    for (const o of this.players.values()) {
      if (o.id === excludeId || !o.alive || (excludeVehicle >= 0 && o.vehicle === excludeVehicle)) continue;
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
    if (h.kind === 'vehicle') {
      const v = this.vehicles[h.index];
      if (!v?.alive) return false;
      g.anchor.copy(h.local).applyQuaternion(v.rotation(_vq)).add(v.pos);
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
    if (h.kind === 'rocket' || h.kind === 'vehicle') return; // too heavy (or too fast) to be reeled in
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

  /** One authoritative tick for every player, vehicle, rocket and crate. */
  step(inputs: ReadonlyMap<string, PlayerInput>): SimEvent[] {
    const events = this.takePendingEvents();
    for (const p of this.players.values()) {
      this.stepPlayer(p, inputs.get(p.id) ?? EMPTY_INPUT, events, 'authority');
    }
    // Driven vehicles moved with their drivers, so a client can predict the one it drives. The
    // rest coast, fall, or wait to respawn.
    for (const v of this.vehicles) if (!v.alive || !v.driver) this.driving.stepVehicle(v, null, events, 'authority');
    // Passengers stepped before their driver are a tick behind the vehicle: put everyone back in their seat.
    for (const p of this.players.values()) {
      if (p.vehicle < 0) continue;
      this.vehicles[p.vehicle].seatPosition(p.seat, p.pos);
      p.collider.setTranslation(p.pos);
      p.body.setNextKinematicTranslation(p.pos);
    }
    if (!noPickups(this.mode)) {
      this.stepPickups(events);
      this.rules.stepItems(events);
    }
    if (this.mode === 'ctf') this.rules.stepFlags(events);
    if (this.mode === 'koth') this.rules.stepHill(events);
    this.flight.stepProjectiles(events, 'authority');
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
    this.flight.stepProjectiles(events, 'predict');
    this.world.step();
    return events;
  }

  /**
   * Re-runs one already-predicted tick for this player and its projectiles after a server correction.
   * No physics step and no events, so replaying a handful of ticks per snapshot is cheap.
   */
  replay(p: PlayerSim, input: PlayerInput) {
    this.stepPlayer(p, input, _discard, 'replay');
    this.flight.stepProjectiles(_discard, 'replay');
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
      // Overhealth from health packs drains back down to full; below full, regeneration.
      if (p.health > COMBAT.maxHealth) p.health = Math.max(COMBAT.maxHealth, p.health - ITEMS.health.decay * DT);
      // (Elimination rounds have no regeneration: every hit counts until the round is over.)
      else if (p.sinceDamaged > COMBAT.regenDelay && this.mode !== 'elim') p.health = Math.min(COMBAT.maxHealth, p.health + COMBAT.regenRate * DT);
      p.rammedFor = Math.max(0, p.rammedFor - DT);
      // E gets you into the nearest vehicle with a free seat, or out of the one you're in. Only the
      // server decides: a client finds out from its next snapshot. In a race it's the restart key.
      if (input.use && !p.useHeld) {
        if (this.mode === 'race') {
          p.useHeld = true;
          this.respawn(p);
          events.push(...this.takePendingEvents());
          return;
        }
        if (p.vehicle >= 0) this.driving.exitVehicle(p, events);
        else this.driving.enterVehicle(p, events);
      }
      p.useHeld = input.use;
    }
    p.overdrive = Math.max(0, p.overdrive - DT);
    if (p.lapTime >= 0) p.lapTime += DT;
    p.yaw = input.yaw;
    p.pitch = input.pitch;
    if (p.vehicle >= 0) {
      this.stepSeated(p, input, events, mode);
      return;
    }
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
        } else if (_aim.kind === 'vehicle') {
          const v = this.vehicles[_aim.vehicleIndex];
          hook = { kind: 'vehicle', index: v.index, local: anchor.clone().sub(v.pos).applyQuaternion(v.rotation(_vq).invert()) };
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
    // A flag carrier can't go faster than this, so one rocket jump doesn't cross the map.
    if (p.flag >= 0) {
      const speed = p.vel.length();
      if (speed > CTF.carrierSpeedCap) p.vel.multiplyScalar(CTF.carrierSpeedCap / speed);
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
    if (this.mode === 'race' && mode === 'authority') this.rules.stepRace(p, events);

    this.stepWeapons(p, input, events, mode);
  }

  /** A tick in a vehicle: the driver drives it, and everyone rides along in their seat. */
  private stepSeated(p: PlayerSim, input: PlayerInput, events: SimEvent[], mode: StepMode) {
    const v = this.vehicles[p.vehicle];
    const seat = v.config.seats[p.seat];
    p.grappleUsed = input.grapple; // holding it while getting out doesn't fire it
    if (seat.role === 'driver') this.driving.stepVehicle(v, input, events, mode);
    if (p.vehicle < 0 || !p.alive) return; // it blew up under them
    v.seatPosition(p.seat, p.pos);
    p.vel.copy(v.vel);
    p.grounded = true;
    p.collider.setTranslation(p.pos);
    p.body.setNextKinematicTranslation(p.pos);
    if (seat.role === 'gunner') this.stepWeapons(p, input, events, mode);
    else if (v.kind === 'heli') this.heliWeapons(p, v, input, events, mode);
    else {
      // Both hands on the wheel.
      p.lockTarget = null;
      p.lockProgress = 0;
    }
  }

  /** The primary weapon: cooldowns and reloads, seeker locks, and firing. */
  private stepWeapons(p: PlayerSim, input: PlayerInput, events: SimEvent[], mode: StepMode) {
    p.fireCooldown = Math.max(0, p.fireCooldown - DT);
    if (p.reloading && p.fireCooldown === 0) {
      p.reloading = false;
      p.drum = GRENADE.drum;
    }
    this.updateLock(p, input.view);
    const kind = p.primary;
    // Seekers only fire with a lock.
    if (input.fire && p.fireCooldown === 0 && kind !== 'grapple' && (!isSeeker(kind) || lockedOn(p))) {
      const pos = p.eye(new Vector3());
      const vel = this.aimFrom(p, pos, input.view, new Vector3());
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
      this.launch(p, kind, pos, vel, life, mode, input, { target: isSeeker(kind) ? p.lockTarget : null, phase, apex });
      // The lock is spent: the next missile needs a fresh one.
      p.lockTarget = null;
      p.lockProgress = 0;
      events.push({ type: 'fired', playerId: p.id, weapon: kind });
    }
  }

  /**
   * A helicopter pilot's guns: rocket pods (alternating sides) while fire is held, and a heat
   * seeker on the secondary button once it has a lock, like a Stinger's.
   */
  private heliWeapons(p: PlayerSim, v: VehicleSim, input: PlayerInput, events: SimEvent[], mode: StepMode) {
    v.fireCooldown = Math.max(0, v.fireCooldown - DT);
    v.missileCooldown = Math.max(0, v.missileCooldown - DT);
    this.updateLock(p, input.view);
    // One projectile per tick at most: predicted ones are identified by the input that fired them.
    if (input.grapple && v.missileCooldown === 0 && lockReady('stinger', p)) {
      v.missileCooldown = HELI.missileCooldown;
      const pos = v.toWorld([0, -1.4, -1.5], new Vector3());
      const vel = this.aimFrom(p, pos, input.view, new Vector3()).multiplyScalar(SEEKERS.stinger.launchSpeed);
      this.launch(p, 'stinger', pos, vel, SEEKERS.stinger.lifetime, mode, input, { target: p.lockTarget });
      p.lockTarget = null;
      p.lockProgress = 0;
      events.push({ type: 'fired', playerId: p.id, weapon: 'stinger' });
    } else if (input.fire && v.fireCooldown === 0) {
      v.fireCooldown = HELI.podCooldown;
      const pos = v.toWorld([v.podSide * 1.7, -0.7, -1.4], new Vector3());
      v.podSide = -v.podSide;
      const vel = this.aimFrom(p, pos, input.view, new Vector3()).multiplyScalar(HELI.podSpeed);
      this.launch(p, 'rocket', pos, vel, HELI.podLifetime, mode, input, { power: HELI.podPower });
      events.push({ type: 'fired', playerId: p.id, weapon: 'rocket' });
    }
  }

  private launch(
    p: PlayerSim,
    kind: ProjectileKind,
    pos: Vector3,
    vel: Vector3,
    life: number,
    mode: StepMode,
    input: PlayerInput,
    extra: { target?: string | null; phase?: MissilePhase; apex?: number; power?: number } = {},
  ) {
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
      target: extra.target ?? null,
      phase: extra.phase ?? 'terminal',
      apex: extra.apex ?? 0,
      from: p.vehicle,
      power: extra.power ?? 1,
    });
  }

  /**
   * Where the crosshair ray starts: the eye on foot. In a vehicle the camera is behind you, so it's
   * the pivot the third-person camera orbits: the crosshair's line passes through it.
   */
  aimOrigin(p: PlayerSim, out: Vector3): Vector3 {
    if (p.vehicle < 0) return p.eye(out);
    const v = this.vehicles[p.vehicle];
    return v.seatPosition(p.seat, out).setY(out.y + v.config.seats[p.seat].pivot);
  }

  /**
   * Unit direction to fire in from `muzzle`. On foot that's the view direction. In a vehicle the
   * muzzle is off the crosshair's line, so it aims at whatever the crosshair ray hits.
   */
  private aimFrom(p: PlayerSim, muzzle: Vector3, view: number | undefined, out: Vector3): Vector3 {
    aimDirection(p.yaw, p.pitch, out);
    if (p.vehicle < 0) return out;
    const origin = this.aimOrigin(p, _aimOrigin);
    const kind = this.aimHit(origin, out, AIM_RANGE, p.id, view, undefined, p.vehicle);
    _target.copy(origin).addScaledVector(out, kind === 'none' ? AIM_RANGE : _aim.dist);
    return out.subVectors(_target, muzzle).normalize();
  }

  /** The seeker a player is locking with: their launcher, or a helicopter's missiles while flying one. */
  lockWeapon(p: PlayerSim): SeekerId | null {
    if (p.vehicle >= 0) {
      const v = this.vehicles[p.vehicle];
      if (v.config.seats[p.seat].role === 'driver') return v.kind === 'heli' ? 'stinger' : null;
    }
    return isSeeker(p.primary) ? p.primary : null;
  }

  /** Seconds until the weapon `lockWeapon` names can fire again. */
  lockCooldown(p: PlayerSim): number {
    if (p.vehicle >= 0 && p.seat === 0) return this.vehicles[p.vehicle].missileCooldown;
    return p.fireCooldown;
  }

  /**
   * Seeker lock-on, once the launcher is loaded. The player nearest the crosshair inside the
   * weapon's lock box (and in sight) becomes the target; holding them there fills the lock. Losing them drains it, faster, and a
   * new target only takes over once it's empty. Other players are judged where the shooter saw them.
   */
  private updateLock(p: PlayerSim, view: number | undefined) {
    // Nothing locks while the launcher is reloading, so a lock always takes its full time after a shot.
    const weapon = this.lockWeapon(p);
    if (!weapon || this.lockCooldown(p) > 0) {
      p.lockTarget = null;
      p.lockProgress = 0;
      return;
    }
    const seeker = SEEKERS[weapon];
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
    const eye = this.aimOrigin(p, _aimOrigin);
    const forward = aimDirection(p.yaw, p.pitch, _aimDir);
    _right.set(Math.cos(p.yaw), 0, -Math.sin(p.yaw));
    _up.crossVectors(_right, forward);
    const maxX = Math.tan(seeker.lockBox[0]);
    const maxY = Math.tan(seeker.lockBox[1]);
    let best: string | null = null;
    let bestScore = Infinity;
    this.forEachTarget(p.id, view, p.vehicle, (id, center) => {
      if (this.allies(p.id, id)) return;
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
  playerPosition(id: string): Vector3 | undefined {
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
        if (!p.alive || !this.rules.touches(p, box.pos, reach - PLAYER.radius)) continue;
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

  /** Knockback and damage for everything in reach of a blast. `ownerId` is '' for one nobody set off. */
  blast(
    at: Vector3,
    blast: Blast,
    ownerId: string,
    shot: number,
    power: number,
    events: SimEvent[],
    mode: StepMode,
    direct?: { id: string; center: Vector3 },
    directVehicle = -1,
  ) {
    const radius = blast.radius;
    // Overdrive: the shooter's blasts hit other players harder.
    const boosted = (this.players.get(ownerId)?.overdrive ?? 0) > 0;

    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (this.mode === 'race' && p.id !== ownerId) continue; // racers only blast themselves along
      // Judge a direct hit where it landed, not where the target has moved on to since.
      const center = direct?.id === p.id ? direct.center : p.pos;
      const dist = center.distanceTo(at);
      const reach = p.id === ownerId ? (blast.selfRadius ?? radius) : radius;
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
      const self = p.id === ownerId;
      const boost = self ? blast.selfKnockback : boosted ? ITEMS.overdrive.knockback : 1;
      p.vel.addScaledVector(_dir, blast.knockback * boost * falloff * power);
      p.grounded = false;
      events.push({ type: 'knockback', playerId: p.id, strength: falloff, sourceId: ownerId, shot });
      // Health is server-only: clients show what the server says, a round trip later.
      if (mode === 'authority' && (!self || COMBAT.selfDamage)) {
        const amount = blast.damage * falloff * power * (boosted && !self ? ITEMS.overdrive.damage : 1);
        this.damage(p, Math.round(amount), ownerId || p.id, events, BLAST_CAUSE.get(blast) ?? 'vehicle');
      }
    }

    for (const v of this.vehicles) {
      if (!v.alive || this.mode === 'race') continue;
      // Distance to its surface, roughly: from its center, less the radius of a ball that fits inside.
      const centerDist = v.pos.distanceTo(at);
      const dist = Math.max(0, centerDist - Math.min(...v.config.size) / 2);
      const hit = v.index === directVehicle;
      if (!hit && dist >= radius) continue;
      const falloff = hit ? 1 : 1 - dist / radius;
      if (centerDist < 1e-3) _dir.set(0, 1, 0);
      else _dir.subVectors(v.pos, at).divideScalar(centerDist);
      v.vel.addScaledVector(_dir, blast.knockback * falloff * power * v.config.knockback);
      // Shots from its own riders don't damage it.
      if (mode === 'authority' && !v.seats.includes(ownerId)) {
        this.driving.damageVehicle(v, blast.damage * falloff * power * VEHICLE_DAMAGE, ownerId || null, events);
      }
    }

    // On a client the crates are only server-placed obstacles.
    if (mode === 'authority') this.pushCrates(at, blast, power);
  }

  damage(p: PlayerSim, amount: number, sourceId: string, events: SimEvent[], cause: DeathCause) {
    if (amount <= 0 || p.protectedFor > 0 || this.mode === 'race' || this.allies(sourceId, p.id)) return;
    // Instagib: a Hypersonic hit that lands at all kills (armor or not).
    if (this.mode === 'instagib' && cause === 'hypersonic' && sourceId !== p.id && amount >= INSTAGIB.killDamage) {
      amount = 1e4;
      p.armor = 0;
    }
    // Finishing yourself off right after someone hit you still counts as their kill.
    const killer = sourceId === p.id ? this.recentAttacker(p) : sourceId;
    // Armor soaks up part of every hit while it lasts.
    if (p.armor > 0) {
      const soaked = Math.min(p.armor, amount * ITEMS.armor.absorb);
      p.armor -= soaked;
      amount = Math.round(amount - soaked);
      if (amount <= 0) return;
    }
    // Reported as what was actually taken: a 200 damage hit on someone with 30 health did 30.
    const taken = Math.min(amount, Math.ceil(Math.max(p.health, 0)));
    p.health -= amount;
    p.sinceDamaged = 0;
    if (sourceId !== p.id) {
      p.lastAttacker = sourceId;
      p.sinceAttacked = 0;
    }
    const midair = sourceId !== p.id && this.isMidair(p, cause);
    events.push({ type: 'damaged', playerId: p.id, sourceId, amount: taken, midair });
    if (p.health <= 0) this.kill(p, killer, cause, events, midair);
  }

  private recentAttacker(p: PlayerSim): string | null {
    return p.sinceAttacked < COMBAT.killCredit ? p.lastAttacker : null;
  }

  /** Hit by a weapon while well clear of the ground and not riding anything: the airshot every rocket game rewards. */
  private isMidair(p: PlayerSim, cause: DeathCause): boolean {
    if (p.grounded || p.vehicle >= 0 || cause === 'fall' || cause === 'ram' || cause === 'vehicle') return false;
    _down.set(0, -1, 0);
    return this.clearDistance(p.pos, _down, MIDAIR_HEIGHT + 1) >= MIDAIR_HEIGHT;
  }

  kill(p: PlayerSim, killerId: string | null, cause: DeathCause, events: SimEvent[], midair = false) {
    if (p.vehicle >= 0) this.driving.leaveSeat(p);
    if (p.flag >= 0) this.rules.dropFlag(p, events);
    const killer = killerId ? this.players.get(killerId) : undefined;
    const distance = killer ? killer.pos.distanceTo(p.pos) : 0;
    p.alive = false;
    p.health = 0;
    p.armor = 0;
    p.overdrive = 0;
    // In elimination you're out until the next round (the server brings everyone back then).
    p.respawnIn = this.mode === 'race' ? RACE.respawnDelay : this.mode === 'elim' ? OUT_OF_ROUND : COMBAT.respawnDelay;
    p.vel.set(0, 0, 0);
    p.grapple = null;
    p.collider.setEnabled(false); // rockets fly through the dead
    if (this.mode !== 'race') p.deaths++;
    if (killer) {
      killer.kills++;
      if (this.mode === 'tdm' && killer.team >= 0 && killer.team !== p.team) this.teamScores[killer.team]++;
    }
    events.push({ type: 'killed', playerId: p.id, killerId, cause, midair, distance, killerHealth: killer ? Math.max(0, Math.ceil(killer.health)) : 0 });
  }

  private pushCrates(at: Vector3, blast: Blast, power: number) {
    const radius = blast.radius;
    for (const crate of this.crates) {
      const t = crate.translation();
      _crate.set(t.x, t.y, t.z);
      const dist = _crate.distanceTo(at);
      if (dist >= radius) continue;
      const falloff = 1 - dist / radius;
      if (dist < 1e-3) _dir.set(0, 1, 0);
      else _dir.subVectors(_crate, at).divideScalar(dist);
      _dir.multiplyScalar(blast.crateKnockback * falloff * power * crate.mass());
      crate.applyImpulse(_dir, true);
    }
  }

}
