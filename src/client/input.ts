import type { PlayerInput } from '../shared/types';

const BASE_SENSITIVITY = 0.0022; // radians per mouse count at sensitivity 1
const MAX_PITCH = Math.PI / 2 - 0.01;

/** Keyboard + pointer-locked mouse, sampled once per simulation tick. */
export class Input {
  yaw = 0;
  pitch = 0;
  locked = false;
  sensitivity = 1;
  invertY = false;
  /** While false (menus, chat), keys and buttons don't reach the game. */
  enabled = true;
  onLockChange: (locked: boolean) => void = () => {};

  private keys = new Set<string>();
  private buttons = new Set<number>();

  constructor(private readonly target: HTMLElement) {
    document.addEventListener('keydown', (e) => {
      if (isTyping(e.target)) return;
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
      const k = BASE_SENSITIVITY * this.sensitivity;
      this.yaw -= e.movementX * k;
      this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch - e.movementY * k * (this.invertY ? -1 : 1)));
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
      try {
        await this.target.requestPointerLock();
      } catch {
        // Not allowed right now (no recent click, an embedded page): the pause screen asks for a click.
      }
    }
  }

  /** In a vehicle Shift descends (a helicopter) instead of grappling, which no seat can do anyway. */
  vehicleMode = false;

  sample(): PlayerInput {
    if (!this.enabled) this.clear();
    const k = this.keys;
    const shift = k.has('ShiftLeft') || k.has('ShiftRight');
    return {
      forward: (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0),
      right: (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0),
      jump: k.has('Space'),
      fire: this.buttons.has(0),
      grapple: this.buttons.has(2) || (shift && !this.vehicleMode),
      use: k.has('KeyE'),
      down: k.has('KeyC') || (shift && this.vehicleMode),
      yaw: this.yaw,
      pitch: this.pitch,
    };
  }

  clear() {
    this.keys.clear();
    this.buttons.clear();
  }
}

/** Keys typed into a text box (the chat, the name field) aren't game controls. */
export function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}
