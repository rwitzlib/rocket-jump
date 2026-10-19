import type * as THREE from 'three';

// "Game feel" layer on top of the raw camera: trauma-based shake, speed FOV, and a landing dip.
// Everything here is cosmetic and local; none of it touches the simulation.

const MAX_SHAKE_ANGLE = 0.06; // radians at full trauma
const MAX_SHAKE_OFFSET = 0.12; // meters at full trauma
const FOV_BOOST = 14; // extra degrees at high speed
const SPRING_STEP = 1 / 120; // seconds

export class CameraFX {
  private trauma = 0;
  private time = 0;
  private fov: number;
  private dip = 0;
  private dipVel = 0;

  constructor(public baseFov: number) {
    this.fov = baseFov;
  }

  /** Adds screen shake. 0..1, stacks and caps at 1. */
  shake(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Kicks the camera down, e.g. on landing. */
  impact(meters: number) {
    this.dipVel -= meters * 18;
  }

  /** Call after the base camera transform is set; returns the FOV to use this frame. */
  apply(camera: THREE.PerspectiveCamera, dt: number, speed: number): number {
    this.time += dt;
    this.trauma = Math.max(0, this.trauma - dt * 1.4);

    // Damped spring back to zero for the landing dip, in small steps: this stiff a spring
    // integrated in one step blows up on a long frame (a hitch, or coming back to the tab).
    for (let left = dt; left > 0; left -= SPRING_STEP) {
      const h = Math.min(left, SPRING_STEP);
      this.dipVel += (-this.dip * 220 - this.dipVel * 22) * h;
      this.dip += this.dipVel * h;
    }
    camera.position.y += this.dip;

    // Shake uses trauma² so small hits stay subtle. Layered sines are a cheap stand-in for noise.
    const s = this.trauma * this.trauma;
    if (s > 0) {
      const t = this.time * 32;
      camera.rotation.x += MAX_SHAKE_ANGLE * s * (Math.sin(t * 1.1) + Math.sin(t * 2.3 + 1)) * 0.5;
      camera.rotation.y += MAX_SHAKE_ANGLE * s * (Math.sin(t * 1.3 + 2) + Math.sin(t * 2.9 + 3)) * 0.5;
      camera.rotation.z += MAX_SHAKE_ANGLE * s * (Math.sin(t * 1.7 + 4) + Math.sin(t * 3.1 + 5)) * 0.5;
      camera.position.x += MAX_SHAKE_OFFSET * s * Math.sin(t * 1.9 + 6) * 0.5;
      camera.position.y += MAX_SHAKE_OFFSET * s * Math.sin(t * 2.1 + 7) * 0.5;
    }

    const target = this.baseFov + FOV_BOOST * Math.min(Math.max((speed - 9) / 25, 0), 1);
    this.fov += (target - this.fov) * Math.min(1, dt * 6);
    if (Math.abs(camera.fov - this.fov) > 0.01) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
    return this.fov;
  }
}
