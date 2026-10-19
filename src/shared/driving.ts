import RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import { CAR, DT, GRAPPLE, PLAYER } from './config';
import type { SimEvent, StepMode } from './events';
import type { Vec3Tuple } from './map';
import { clipVelocity, PLAYER_COLLISION_GROUPS, VEHICLE_MOVE_GROUPS } from './physics';
import type { PlayerSim } from './player';
import { VEHICLE_BLAST } from './projectile';
import type { GameSim } from './sim';
import type { PlayerInput } from './types';
import { updateCar, updateHeli, type VehicleSim } from './vehicle';

// Vehicles in the world: moving them through it with collision, running people over, getting in
// and out, taking damage and blowing up. (Their handling is in vehicle.ts.) Stepped by GameSim.

/** How long after being run over before the same car can hit you again. */
const RAM_COOLDOWN = 0.5;
const _desired = new Vector3();
const _toTarget = new Vector3();
const _muzzle = new Vector3();
const _vq = new Quaternion();
const _rayOrigin = new Vector3();
const _rayDir = new Vector3();
const _ray = new RAPIER.Ray(_rayOrigin, _rayDir);
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

export class Driving {
  /** Moves vehicles through the world: like a player's, with bigger steps and snapping to ramps. */
  readonly controller: RAPIER.KinematicCharacterController;

  constructor(private readonly sim: GameSim) {
    this.controller = sim.world.createCharacterController(0.05);
    this.controller.enableAutostep(0.5, 0.5, false); // curbs and the lips of ramps
    this.controller.setMaxSlopeClimbAngle((40 * Math.PI) / 180);
    this.controller.enableSnapToGround(0.4); // stay on a ramp going down instead of skipping off it
    this.controller.setApplyImpulsesToDynamicBodies(true); // shove crates aside
  }

  /** One tick of a vehicle: its handling, then a move through the world with collision. */
  stepVehicle(v: VehicleSim, input: PlayerInput | null, events: SimEvent[], mode: StepMode) {
    v.prevPos.copy(v.pos);
    v.prevYaw = v.yaw;
    if (!v.alive) {
      if (mode === 'authority') {
        v.respawnIn = Math.max(0, v.respawnIn - DT);
        if (v.respawnIn === 0) v.reset();
      }
      return;
    }
    const wasGrounded = v.grounded;
    const fallSpeed = -v.vel.y;
    if (v.kind === 'car') updateCar(v, input, DT);
    else updateHeli(v, input, DT);

    // Same as players: `pos` is the truth, and a replay runs without stepping the world.
    // Two passes: along the ground (with any climb), then down. In one pass, a move that's both
    // forward and a little downward (gravity, every tick) sometimes comes back from the character
    // controller with no forward part at all: the floor it's resting on is hit first and the slide
    // along it is lost, and the buggy stops dead mid-drive.
    v.place();
    _desired.copy(v.vel).multiplyScalar(DT);
    const fall = Math.min(_desired.y, 0);
    _desired.y = Math.max(_desired.y, 0);
    this.controller.computeColliderMovement(v.collider, _desired, undefined, VEHICLE_MOVE_GROUPS);
    const moved = this.controller.computedMovement();
    v.vel.x = clipVelocity(v.vel.x, _desired.x, moved.x);
    v.vel.z = clipVelocity(v.vel.z, _desired.z, moved.z);
    v.pos.x += moved.x;
    v.pos.y += moved.y;
    v.pos.z += moved.z;
    let rose = moved.y;
    v.place();
    // (Only when it's actually coming down: an empty second pass would snap a climbing helicopter
    // straight back to the ground.)
    if (fall < 0) {
      _desired.set(0, fall, 0);
      this.controller.computeColliderMovement(v.collider, _desired, undefined, VEHICLE_MOVE_GROUPS);
      const dropped = this.controller.computedMovement().y;
      v.pos.y += dropped;
      rose += dropped;
      v.place();
    }
    v.vel.y = clipVelocity(v.vel.y, v.vel.y * DT, rose);
    v.grounded = this.controller.computedGrounded();
    if (v.kind === 'car') this.tiltCar(v);

    if (mode !== 'authority') return;
    if (v.grounded && !wasGrounded && fallSpeed > v.config.crashSpeed) {
      this.damageVehicle(v, (fallSpeed - v.config.crashSpeed) * 15, null, events);
    }
    if (v.alive && v.kind === 'car') this.ramPlayers(v, events);
    if (v.alive && v.pos.y < this.sim.map.killY) this.destroyVehicle(v, events);
  }

  /** Leans the buggy's body to match the ground under its corners (for looks: the collider stays level). */
  private tiltCar(v: VehicleSim) {
    if (!v.grounded) return; // mid-air it keeps the tilt it left the ground with
    const [w, , l] = v.config.size;
    const front = this.groundBelow(v, 0, -l / 2 + 0.4);
    const back = this.groundBelow(v, 0, l / 2 - 0.4);
    const left = this.groundBelow(v, -w / 2 + 0.3, 0);
    const right = this.groundBelow(v, w / 2 - 0.3, 0);
    const pitch = front !== null && back !== null ? Math.atan2(front - back, l - 0.8) : 0;
    const roll = left !== null && right !== null ? Math.atan2(right - left, w - 0.6) : 0;
    v.pitch += (pitch - v.pitch) * 0.3;
    v.roll += (roll - v.roll) * 0.3;
  }

  /** Height of the ground under a point in the vehicle's frame, or null if there's none close. */
  private groundBelow(v: VehicleSim, x: number, z: number): number | null {
    v.toWorld([x, 0, z], _rayOrigin);
    _rayDir.set(0, -1, 0);
    const hit = this.sim.world.castRay(_ray, v.config.size[1] / 2 + 1.5, true, undefined, VEHICLE_MOVE_GROUPS, v.collider);
    return hit ? _rayOrigin.y - hit.timeOfImpact : null;
  }

  /** A buggy going fast enough runs over anyone it reaches: launched along its path and hurt by its speed. */
  private ramPlayers(v: VehicleSim, events: SimEvent[]) {
    const speed = Math.hypot(v.vel.x, v.vel.z);
    if (speed < CAR.ramSpeed) return;
    const [w, h, l] = v.config.size;
    v.rotation(_vq).invert();
    for (const p of this.sim.players.values()) {
      if (!p.alive || p.vehicle >= 0 || p.rammedFor > 0) continue;
      // Into the car's frame. Anyone standing on the roof is riding it, not in its way.
      _toTarget.subVectors(p.pos, v.pos).applyQuaternion(_vq);
      if (Math.abs(_toTarget.x) > w / 2 + PLAYER.radius || Math.abs(_toTarget.z) > l / 2 + PLAYER.radius) continue;
      if (Math.abs(_toTarget.y) > h / 2 + PLAYER.halfHeight) continue;
      p.rammedFor = RAM_COOLDOWN;
      p.vel.set(v.vel.x * CAR.ramKnockback, Math.max(p.vel.y, 0) + CAR.ramLift, v.vel.z * CAR.ramKnockback);
      p.grounded = false;
      events.push({ type: 'rammed', playerId: p.id, vehicle: v.index, speed });
      this.sim.damage(p, Math.round((speed - CAR.ramSpeed) * CAR.ramDamage), v.driver ?? p.id, events, 'ram');
    }
  }

  /** Gets in the nearest vehicle with a free seat, driving if nobody is. */
  enterVehicle(p: PlayerSim, events: SimEvent[]) {
    if (this.sim.mode === 'race') return;
    let best: VehicleSim | null = null;
    let bestDist = Infinity;
    for (const v of this.sim.vehicles) {
      if (!v.alive || !v.seats.includes(null)) continue;
      const dist = v.pos.distanceTo(p.pos);
      if (dist < v.config.enterRange && dist < bestDist) {
        best = v;
        bestDist = dist;
      }
    }
    if (!best) return;
    const seat = best.seats.indexOf(null);
    best.seats[seat] = p.id;
    p.vehicle = best.index;
    p.seat = seat;
    if (p.grapple) {
      p.grapple = null;
      p.grappleCooldown = GRAPPLE.cooldown;
      events.push({ type: 'grapple', playerId: p.id, attached: false });
    }
    p.lockTarget = null;
    p.lockProgress = 0;
    events.push({ type: 'entered', playerId: p.id, vehicle: best.index, seat });
  }

  /** Steps out beside your seat, or by another seat, or onto the roof: wherever there's room. Keeps the vehicle's momentum. */
  exitVehicle(p: PlayerSim, events: SimEvent[]) {
    const v = this.sim.vehicles[p.vehicle];
    const spots: Vec3Tuple[] = [v.config.seats[p.seat].exit, ...v.config.seats.map((s) => s.exit), [0, v.config.size[1] / 2 + 1.2, 0]];
    for (const spot of spots) {
      v.toWorld(spot, _muzzle);
      if (!this.sim.world.intersectionWithShape(_muzzle, IDENTITY, p.collider.shape, undefined, PLAYER_COLLISION_GROUPS, p.collider)) break;
    }
    this.leaveSeat(p);
    p.pos.copy(_muzzle);
    p.prevPos.copy(p.pos);
    p.vel.copy(v.vel);
    p.grounded = false;
    p.collider.setTranslation(p.pos);
    p.body.setNextKinematicTranslation(p.pos);
    events.push({ type: 'exited', playerId: p.id, vehicle: v.index });
  }

  leaveSeat(p: PlayerSim) {
    this.sim.vehicles[p.vehicle].seats[p.seat] = null;
    p.vehicle = -1;
    p.seat = -1;
  }

  damageVehicle(v: VehicleSim, amount: number, sourceId: string | null, events: SimEvent[]) {
    if (!v.alive || amount <= 0) return;
    v.health -= amount;
    if (sourceId) {
      v.lastAttacker = sourceId;
      events.push({ type: 'vehicleHit', vehicle: v.index, sourceId, amount });
    }
    if (v.health <= 0) this.destroyVehicle(v, events);
  }

  /** Blows a vehicle up: whoever is inside dies, credited to whoever last damaged it, and the blast catches anyone nearby. */
  destroyVehicle(v: VehicleSim, events: SimEvent[]) {
    v.alive = false;
    v.health = 0;
    v.respawnIn = v.config.respawn;
    v.collider.setEnabled(false);
    const killer = v.lastAttacker;
    for (const id of v.seats) {
      const p = id ? this.sim.players.get(id) : undefined;
      if (p) this.sim.kill(p, killer === p.id ? null : killer, 'vehicle', events);
    }
    v.seats.fill(null);
    this.sim.blast(v.pos, VEHICLE_BLAST, killer ?? '', 0, 1, events, 'authority');
    events.push({ type: 'vehicleDestroyed', vehicle: v.index, pos: v.pos.clone(), normal: new Vector3(0, 1, 0) });
  }
}
