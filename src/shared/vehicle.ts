import type RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import { CAR, GRAVITY, HELI, VEHICLES, type VehicleConfig } from './config';
import type { Vec3Tuple, VehicleDef } from './map';
import type { PlayerInput, VehicleKind } from './types';

// Vehicles: a buggy and a helicopter. Like players they're moved by a kinematic character
// controller (a box instead of a capsule) with hand-written arcade handling, not rigid-body
// physics, so a client can predict the one it's driving and replay it after a server correction.
// The functions here only change velocity and heading; GameSim moves them through the world.

/** Everything about a vehicle that the next tick depends on, plus what drawing it needs. Plain data for the wire. */
export interface VehicleState {
  pos: Vec3Tuple;
  vel: Vec3Tuple;
  yaw: number;
  pitch: number; // visual tilt: nose up is positive
  roll: number; // visual tilt: right side up is positive
  grounded: boolean;
  health: number;
  alive: boolean;
  respawnIn: number;
  seats: (string | null)[]; // player id in each seat; seat 0 drives
  fireCooldown: number; // rocket pods
  missileCooldown: number;
  podSide: number; // which pod fires next: 1 right, -1 left
  throttle: number; // the driver's input, for wheels and rotors
  steer: number;
}

const _q = new Quaternion();
const UP = new Vector3(0, 1, 0);

export class VehicleSim {
  readonly config: VehicleConfig;
  readonly kind: VehicleKind;
  readonly pos = new Vector3();
  readonly prevPos = new Vector3();
  readonly vel = new Vector3();
  yaw = 0;
  prevYaw = 0;
  pitch = 0;
  roll = 0;
  grounded = false;
  health: number;
  alive = true;
  respawnIn = 0;
  readonly seats: (string | null)[];
  fireCooldown = 0;
  missileCooldown = 0;
  podSide = 1;
  throttle = 0;
  steer = 0;
  /** Server only: who last damaged it, credited with the kills if it blows up with people inside. */
  lastAttacker: string | null = null;

  constructor(
    readonly index: number,
    readonly def: VehicleDef,
    readonly body: RAPIER.RigidBody,
    readonly collider: RAPIER.Collider,
  ) {
    this.kind = def.kind;
    this.config = VEHICLES[def.kind];
    this.health = this.config.health;
    this.seats = this.config.seats.map(() => null);
  }

  get driver(): string | null {
    return this.seats[0];
  }

  /** The yaw-only rotation the collider uses (tilt is just for looks). */
  rotation(out: Quaternion): Quaternion {
    return out.setFromAxisAngle(UP, this.yaw);
  }

  /** A point in the vehicle's frame (-Z forward), in the world. */
  toWorld(local: Vec3Tuple, out: Vector3): Vector3 {
    return out.set(...local).applyQuaternion(this.rotation(_q)).add(this.pos);
  }

  seatPosition(seat: number, out: Vector3): Vector3 {
    return this.toWorld(this.config.seats[seat].offset, out);
  }

  /** Back on its pad, repaired and empty. */
  reset() {
    this.pos.set(...this.def.pos);
    this.prevPos.copy(this.pos);
    this.vel.set(0, 0, 0);
    this.yaw = this.prevYaw = this.def.yaw;
    this.pitch = this.roll = 0;
    this.grounded = false;
    this.health = this.config.health;
    this.alive = true;
    this.respawnIn = 0;
    this.seats.fill(null);
    this.fireCooldown = this.missileCooldown = 0;
    this.throttle = this.steer = 0;
    this.lastAttacker = null;
    this.collider.setEnabled(true);
    this.place();
    this.body.setTranslation(this.pos, true);
    this.body.setRotation(this.rotation(_q), true);
  }

  /** Moves the collider to `pos`/`yaw` now, and the body there at the next physics step. */
  place() {
    this.rotation(_q);
    this.collider.setTranslation(this.pos);
    this.collider.setRotation(_q);
    this.body.setNextKinematicTranslation(this.pos);
    this.body.setNextKinematicRotation(_q);
  }

  capture(): VehicleState {
    return {
      pos: [this.pos.x, this.pos.y, this.pos.z],
      vel: [this.vel.x, this.vel.y, this.vel.z],
      yaw: this.yaw,
      pitch: this.pitch,
      roll: this.roll,
      grounded: this.grounded,
      health: this.health,
      alive: this.alive,
      respawnIn: this.respawnIn,
      seats: [...this.seats],
      fireCooldown: this.fireCooldown,
      missileCooldown: this.missileCooldown,
      podSide: this.podSide,
      throttle: this.throttle,
      steer: this.steer,
    };
  }

  restore(s: VehicleState) {
    this.pos.set(...s.pos);
    this.prevPos.copy(this.pos);
    this.vel.set(...s.vel);
    this.yaw = this.prevYaw = s.yaw;
    this.pitch = s.pitch;
    this.roll = s.roll;
    this.grounded = s.grounded;
    this.health = s.health;
    this.respawnIn = s.respawnIn;
    s.seats.forEach((id, i) => (this.seats[i] = id));
    this.fireCooldown = s.fireCooldown;
    this.missileCooldown = s.missileCooldown;
    this.podSide = s.podSide;
    this.throttle = s.throttle;
    this.steer = s.steer;
    if (s.alive !== this.alive) {
      this.alive = s.alive;
      this.collider.setEnabled(s.alive);
    }
    this.place();
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * The buggy, for one tick. W/S is throttle (and brake, then reverse), A/D steers. Steering only
 * works with the wheels on the ground and gets weaker at walking pace; sideways sliding is
 * gripped away quickly, so it corners but can still be knocked into a skid. `input` is null with
 * nobody driving: it rolls to a stop.
 */
export function updateCar(v: VehicleSim, input: PlayerInput | null, dt: number) {
  v.throttle = input ? input.forward : 0;
  v.steer = input ? input.right : 0;
  if (v.grounded) {
    let fx = -Math.sin(v.yaw);
    let fz = -Math.cos(v.yaw);
    const speed = v.vel.x * fx + v.vel.z * fz;
    // Right turns clockwise seen from above, which is decreasing yaw. Reversing steers like a real car.
    v.yaw = wrapAngle(v.yaw - v.steer * CAR.turnRate * clamp(speed / CAR.fullTurnSpeed, -1, 1) * dt);
    fx = -Math.sin(v.yaw);
    fz = -Math.cos(v.yaw);

    // Split the velocity along the new heading: the part along it is what the engine works on,
    // the rest is a slide that the tires grip away.
    let along = v.vel.x * fx + v.vel.z * fz;
    const grip = Math.exp(-CAR.grip * dt);
    const sideX = (v.vel.x - fx * along) * grip;
    const sideZ = (v.vel.z - fz * along) * grip;
    const t = v.throttle;
    if (t > 0) {
      if (along < 0) along = Math.min(0, along + CAR.brake * t * dt);
      else if (along < CAR.maxSpeed) along = Math.min(CAR.maxSpeed, along + CAR.accel * t * dt);
    } else if (t < 0) {
      if (along > 0) along = Math.max(0, along + CAR.brake * t * dt);
      else if (along > -CAR.reverseSpeed) along = Math.max(-CAR.reverseSpeed, along + CAR.accel * t * dt);
    } else {
      along -= Math.sign(along) * Math.min(Math.abs(along), CAR.coast * dt);
    }
    v.vel.x = fx * along + sideX;
    v.vel.z = fz * along + sideZ;
  }
  v.vel.y -= GRAVITY * dt;
}

const _wish = new Vector3();
const _before = new Vector3();

/**
 * The helicopter, for one tick. With a pilot it hovers: WASD pushes it around relative to where
 * you're looking, Space climbs, C descends, and the nose turns to follow your view. It leans into
 * its acceleration (for looks only). Without a pilot (or once destroyed) it drops.
 */
export function updateHeli(v: VehicleSim, input: PlayerInput | null, dt: number) {
  _before.copy(v.vel);
  if (!input) {
    v.throttle = v.steer = 0;
    v.vel.y -= GRAVITY * dt;
    const drag = Math.exp(-(v.grounded ? 6 : 0.3) * dt);
    v.vel.x *= drag;
    v.vel.z *= drag;
  } else {
    const turn = wrapAngle(input.yaw - v.yaw);
    v.yaw = wrapAngle(v.yaw + clamp(turn, -HELI.turnRate * dt, HELI.turnRate * dt));

    const sy = Math.sin(input.yaw);
    const cy = Math.cos(input.yaw);
    _wish.set(-sy * input.forward + cy * input.right, 0, -cy * input.forward - sy * input.right);
    const len = _wish.length();
    if (len > 1) _wish.divideScalar(len);
    v.throttle = input.forward;
    v.steer = input.right;
    if (len > 1e-4) {
      // Head for the wished velocity, no faster than the acceleration allows.
      const dx = _wish.x * HELI.maxSpeed - v.vel.x;
      const dz = _wish.z * HELI.maxSpeed - v.vel.z;
      const dist = Math.hypot(dx, dz);
      const step = Math.min(dist, HELI.accel * dt);
      if (dist > 1e-6) {
        v.vel.x += (dx / dist) * step;
        v.vel.z += (dz / dist) * step;
      }
    } else {
      const drag = Math.exp(-HELI.drag * dt);
      v.vel.x *= drag;
      v.vel.z *= drag;
    }
    const climb = (input.jump ? 1 : 0) - (input.down ? 1 : 0);
    let wantY = climb * HELI.climbSpeed;
    if (v.pos.y > HELI.ceiling && wantY > 0) wantY = 0;
    v.vel.y += clamp(wantY - v.vel.y, -HELI.climbAccel * dt, HELI.climbAccel * dt);
  }

  // Lean into the acceleration: nose down to speed up, bank into a sideways push.
  const ax = (v.vel.x - _before.x) / dt;
  const az = (v.vel.z - _before.z) / dt;
  const forward = ax * -Math.sin(v.yaw) + az * -Math.cos(v.yaw);
  const right = ax * Math.cos(v.yaw) - az * Math.sin(v.yaw);
  const ease = 1 - Math.exp(-dt * 4);
  const flying = input && !v.grounded;
  v.pitch += ((flying ? clamp(-forward * HELI.tilt, -0.4, 0.4) : 0) - v.pitch) * ease;
  v.roll += ((flying ? clamp(-right * HELI.tilt, -0.4, 0.4) : 0) - v.roll) * ease;
}
