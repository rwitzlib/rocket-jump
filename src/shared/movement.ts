import { Vector3 } from 'three';
import { GRAPPLE, GRAVITY, MOVE } from './config';
import type { PlayerInput } from './types';

const wish = new Vector3();
const toAnchor = new Vector3();

export function aimDirection(yaw: number, pitch: number, out: Vector3): Vector3 {
  const cp = Math.cos(pitch);
  return out.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}

function accelerate(vel: Vector3, dir: Vector3, wishSpeed: number, accel: number, dt: number, cap = wishSpeed) {
  const current = vel.dot(dir);
  const add = cap - current;
  if (add <= 0) return;
  vel.addScaledVector(dir, Math.min(accel * wishSpeed * dt, add));
}

function applyFriction(vel: Vector3, dt: number) {
  const speed = Math.hypot(vel.x, vel.z);
  if (speed < 0.05) {
    vel.x = 0;
    vel.z = 0;
    return;
  }
  const drop = Math.max(speed, MOVE.stopSpeed) * MOVE.friction * dt;
  const scale = Math.max(speed - drop, 0) / speed;
  vel.x *= scale;
  vel.z *= scale;
}

/** Applies input, friction and gravity to a player's velocity for one tick. Returns true if the player jumped. */
export function updateVelocity(vel: Vector3, input: PlayerInput, grounded: boolean, dt: number): boolean {
  const sy = Math.sin(input.yaw);
  const cy = Math.cos(input.yaw);
  wish.set(-sy * input.forward + cy * input.right, 0, -cy * input.forward - sy * input.right);
  const len = wish.length();
  if (len > 1e-4) wish.divideScalar(len);
  const wishSpeed = MOVE.maxSpeed * Math.min(len, 1);

  // Jumping skips friction on that tick, so holding jump lets you bunny-hop without losing speed.
  if (grounded && input.jump) {
    vel.y = Math.max(vel.y, 0) + MOVE.jumpSpeed;
    accelerate(vel, wish, wishSpeed, MOVE.airAccel, dt, Math.min(wishSpeed, MOVE.airWishCap));
  } else if (grounded) {
    applyFriction(vel, dt);
    accelerate(vel, wish, wishSpeed, MOVE.groundAccel, dt);
  } else {
    // The strafe-jump term is for turning: pressed roughly sideways to your motion it adds a little
    // speed each tick. Pressed against your motion it would brake almost instantly, so it stops
    // helping there and only the (weaker) air control below slows you down.
    if (vel.dot(wish) > -MOVE.airWishCap) accelerate(vel, wish, wishSpeed, MOVE.airAccel, dt, Math.min(wishSpeed, MOVE.airWishCap));
    // Air control: WASD steers and brakes in the air, more weakly than on the ground. It only pushes
    // toward the wish direction until you're moving airControlSpeed that way, so holding W never caps
    // a rocket jump that's already faster.
    accelerate(vel, wish, MOVE.airControlSpeed * Math.min(len, 1), MOVE.airControl, dt);
  }

  vel.y -= GRAVITY * dt;
  return grounded && input.jump;
}

/** What a grapple is hooked into when it isn't static level geometry. The anchor follows it. */
export type Hook =
  | { kind: 'player'; id: string; offset: Vector3 } // offset from the player's center
  | { kind: 'crate'; index: number; local: Vector3; localNormal: Vector3 } // in the crate's own frame
  | { kind: 'rocket'; ownerId: string; shot: number } // owner + shot identify a rocket on both server and client
  | { kind: 'vehicle'; index: number; local: Vector3 }; // in the vehicle's frame, turning with its heading

export interface GrappleState {
  anchor: Vector3;
  normal: Vector3; // surface normal at the anchor, used to orient the hook
  length: number;
  hook: Hook | null; // null: static geometry
}

/**
 * Grapple = constant pull toward the anchor + a rope that only ever shortens.
 * The rope removes outward velocity, which turns sideways momentum into swinging.
 */
export function applyGrapple(pos: Vector3, vel: Vector3, g: GrappleState, dt: number, pullScale = 1) {
  toAnchor.subVectors(g.anchor, pos);
  const dist = toAnchor.length();
  if (dist < 1e-3) return;
  toAnchor.divideScalar(dist);

  g.length = Math.min(g.length, Math.max(dist, GRAPPLE.minLength));

  if (dist > GRAPPLE.minLength && vel.dot(toAnchor) < GRAPPLE.maxPullSpeed) {
    vel.addScaledVector(toAnchor, GRAPPLE.pullAccel * pullScale * dt);
  }

  if (dist > g.length) {
    const radial = vel.dot(toAnchor);
    if (radial < 0) vel.addScaledVector(toAnchor, -radial);
    vel.addScaledVector(toAnchor, (dist - g.length) * GRAPPLE.stiffness * dt);
  }
}
