import type { PlayerInput } from '../shared/types';

const SENSITIVITY = 0.0022;
const MAX_PITCH = Math.PI / 2 - 0.01;

/** Keyboard + pointer-locked mouse, sampled once per simulation tick. */
export class Input {
  yaw = 0;
  pitch = 0;
  locked = false;
  onLockChange: (locked: boolean) => void = () => {};

  private keys = new Set<string>();
  private buttons = new Set<number>();

  constructor(private readonly target: HTMLElement) {
    document.addEventListener('keydown', (e) => {
      if (this.locked && e.code === 'Space') e.preventDefault();
      this.keys.add(e.code);
    });
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.clear());

    target.addEventListener('mousedown', (e) => {
      if (this.locked) this.buttons.add(e.button);
    });
    window.addEventListener('mouseup', (e) => this.buttons.delete(e.button));
    target.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * SENSITIVITY;
      this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch - e.movementY * SENSITIVITY));
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === target;
      if (!this.locked) this.clear();
      this.onLockChange(this.locked);
    });
  }

  async lock() {
    try {
      // Raw mouse input (no OS acceleration) where supported.
      await this.target.requestPointerLock({ unadjustedMovement: true });
    } catch {
      await this.target.requestPointerLock();
    }
  }

  sample(): PlayerInput {
    const k = this.keys;
    return {
      forward: (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0),
      right: (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0),
      jump: k.has('Space'),
      fire: this.buttons.has(0),
      grapple: this.buttons.has(2) || k.has('KeyE') || k.has('ShiftLeft'),
      yaw: this.yaw,
      pitch: this.pitch,
    };
  }

  private clear() {
    this.keys.clear();
    this.buttons.clear();
  }
}
