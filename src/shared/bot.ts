import { DT } from './config';
import type { PlayerSim } from './sim';
import type { PlayerInput } from './types';

// A dumb server-side player, so there's something moving to look at when testing netcode alone.
// It circles the tower bunny-hopping, rocket jumps now and then, and grapples upward.

const ORBIT_RADIUS = 28;

export class Bot {
  private t = Math.random() * 100;
  private readonly orbitSpeed = (0.15 + Math.random() * 0.1) * (Math.random() < 0.5 ? -1 : 1);
  private nextRocketJump = 2 + Math.random() * 2;
  private nextGrapple = 5 + Math.random() * 3;
  private grappleFor = 0;

  think(p: PlayerSim): PlayerInput {
    this.t += DT;

    // Head for a point that slides around a circle, strafing side to side like an air-strafer.
    const a = this.t * this.orbitSpeed;
    const dx = Math.cos(a) * ORBIT_RADIUS - p.pos.x;
    const dz = Math.sin(a) * ORBIT_RADIUS - p.pos.z;
    const yaw = Math.atan2(-dx, -dz);

    const input: PlayerInput = {
      forward: 1,
      right: Math.sin(this.t * 2.5),
      jump: true,
      fire: false,
      grapple: false,
      yaw,
      pitch: 0,
    };

    this.nextRocketJump -= DT;
    if (this.nextRocketJump <= 0 && p.grounded) {
      input.pitch = -1.35; // at the feet
      input.fire = true;
      this.nextRocketJump = 3 + Math.random() * 3;
    }

    this.nextGrapple -= DT;
    if (this.nextGrapple <= 0) {
      this.grappleFor = 1 + Math.random();
      this.nextGrapple = 6 + Math.random() * 4;
    }
    if (this.grappleFor > 0) {
      this.grappleFor -= DT;
      input.pitch = 0.7;
      input.grapple = true;
    }
    return input;
  }
}
