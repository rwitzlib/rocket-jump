import RAPIER from '@dimforge/rapier3d-compat';
import { Euler, Quaternion, Vector3 } from 'three';
import { CRATE, DT, GRAPPLE, GRAVITY, PLAYER, ROCKET } from './config';
import type { MapDef } from './map';
import { aimDirection, applyGrapple, updateVelocity, type GrappleState } from './movement';
import { EMPTY_INPUT, type PlayerInput } from './types';

// The authoritative game simulation. It has no rendering or DOM code, so the same class can run
// in the browser (single-player / client prediction) or in Node (the multiplayer server).
// Call `await RAPIER.init()` once before constructing it.

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

  constructor(
    readonly id: string,
    readonly body: RAPIER.RigidBody,
    readonly collider: RAPIER.Collider,
  ) {}

  eye(out: Vector3): Vector3 {
    return out.set(this.pos.x, this.pos.y + PLAYER.eyeOffset, this.pos.z);
  }
}

export interface Rocket {
  id: number;
  ownerId: string;
  pos: Vector3;
  prevPos: Vector3;
  dir: Vector3;
  life: number;
}

export type SimEvent =
  | { type: 'fired'; playerId: string }
  | { type: 'explosion'; pos: Vector3 }
  | { type: 'grapple'; playerId: string; attached: boolean }
  | { type: 'respawn'; playerId: string; yaw: number };

const _aim = new Vector3();
const _eye = new Vector3();
const _desired = new Vector3();
const _dir = new Vector3();
const _crate = new Vector3();

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
    const collider = this.world.createCollider(RAPIER.ColliderDesc.capsule(PLAYER.halfHeight, PLAYER.radius), body);
    const player = new PlayerSim(id, body, collider);
    this.players.set(id, player);
    this.respawn(player);
    return player;
  }

  respawn(p: PlayerSim) {
    const spawn = this.map.spawns[this.spawnIndex++ % this.map.spawns.length];
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

  /** Where this player's grapple would attach if fired now (static geometry only), or null if out of range. */
  grappleTarget(p: PlayerSim, out: Vector3): Vector3 | null {
    aimDirection(p.yaw, p.pitch, _aim);
    const ray = new RAPIER.Ray(p.eye(_eye), _aim);
    const flags = RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC;
    const hit = this.world.castRay(ray, GRAPPLE.range, true, flags);
    if (!hit) return null;
    const pt = ray.pointAt(hit.timeOfImpact);
    return out.set(pt.x, pt.y, pt.z);
  }

  step(inputs: ReadonlyMap<string, PlayerInput>): SimEvent[] {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    for (const p of this.players.values()) {
      this.stepPlayer(p, inputs.get(p.id) ?? EMPTY_INPUT, events);
    }
    this.stepRockets(events);
    this.world.step();
    this.tick++;
    return events;
  }

  private stepPlayer(p: PlayerSim, input: PlayerInput, events: SimEvent[]) {
    p.prevPos.copy(p.pos);
    p.yaw = input.yaw;
    p.pitch = input.pitch;

    // Grapple: attach on press, release on let go.
    if (input.grapple && !p.wasGrappleHeld) {
      const anchor = this.grappleTarget(p, new Vector3());
      if (anchor) {
        p.grapple = { anchor, length: p.pos.distanceTo(anchor) };
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

    updateVelocity(p.vel, input, p.grounded, DT);
    if (p.grapple) applyGrapple(p.pos, p.vel, p.grapple, DT);

    // Move through the world with collision, then drop whatever velocity was blocked.
    _desired.copy(p.vel).multiplyScalar(DT);
    this.controller.computeColliderMovement(p.collider, _desired);
    const moved = this.controller.computedMovement();
    p.grounded = this.controller.computedGrounded();
    p.vel.x = clipVelocity(p.vel.x, _desired.x, moved.x);
    p.vel.y = clipVelocity(p.vel.y, _desired.y, moved.y);
    p.vel.z = clipVelocity(p.vel.z, _desired.z, moved.z);
    p.pos.x += moved.x;
    p.pos.y += moved.y;
    p.pos.z += moved.z;
    p.body.setNextKinematicTranslation(p.pos);

    if (p.pos.y < this.map.killY) {
      this.respawn(p);
      events.push(...this.pendingEvents);
      this.pendingEvents = [];
      return;
    }

    p.fireCooldown = Math.max(0, p.fireCooldown - DT);
    if (input.fire && p.fireCooldown === 0) {
      p.fireCooldown = ROCKET.cooldown;
      const pos = p.eye(new Vector3());
      this.rockets.push({
        id: this.nextRocketId++,
        ownerId: p.id,
        pos,
        prevPos: pos.clone(),
        dir: aimDirection(p.yaw, p.pitch, new Vector3()),
        life: ROCKET.lifetime,
      });
      events.push({ type: 'fired', playerId: p.id });
    }
  }

  private stepRockets(events: SimEvent[]) {
    const travel = ROCKET.speed * DT;
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      r.prevPos.copy(r.pos);
      const owner = this.players.get(r.ownerId);
      const ray = new RAPIER.Ray(r.pos, r.dir);
      const hit = this.world.castRay(ray, travel, true, undefined, undefined, undefined, owner?.body);

      if (hit) {
        const pt = ray.pointAt(hit.timeOfImpact);
        r.pos.set(pt.x, pt.y, pt.z).addScaledVector(r.dir, -0.1);
      } else {
        r.pos.addScaledVector(r.dir, travel);
        r.life -= DT;
        if (r.life > 0) continue;
      }
      this.explode(r.pos, events);
      this.rockets.splice(i, 1);
    }
  }

  private explode(at: Vector3, events: SimEvent[]) {
    const radius = ROCKET.blastRadius;

    for (const p of this.players.values()) {
      const dist = p.pos.distanceTo(at);
      if (dist >= radius) continue;
      const falloff = 1 - dist / radius;
      if (dist < 1e-3) _dir.set(0, 1, 0);
      else _dir.subVectors(p.pos, at).divideScalar(dist);
      p.vel.addScaledVector(_dir, ROCKET.knockback * falloff);
      p.grounded = false;
    }

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

    events.push({ type: 'explosion', pos: at.clone() });
  }
}
