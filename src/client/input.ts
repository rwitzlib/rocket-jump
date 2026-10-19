import { DT } from '../shared/config';
import type { PlayerInput } from '../shared/types';

const BASE_SENSITIVITY = 0.0022; // radians per mouse count at sensitivity 1
const MAX_PITCH = Math.PI / 2 - 0.01;
/** Arrow keys turn the view this fast (radians per second, at sensitivity 1). */
const KEY_TURN = 2.4;
const KEY_TILT = 1.6;
/** Without pointer lock, a mouse move bigger than this (pixels) is a jump of the cursor, not a turn. */
const FREE_MOVE_LIMIT = 80;
/** How long to wait for the browser to grant pointer lock before playing without it. */
const LOCK_WAIT = 400; // ms

/**
 * Keyboard + mouse, sampled once per simulation tick.
 *
 * Normally the mouse is captured (pointer lock) and moves the view. Some browsers won't capture it:
 * automated ones (an AI agent driving the page), embedded ones, headless ones. When a click to play
 * doesn't get the lock, the game plays without it ("free" mode): the arrow keys look around, small
 * mouse movements over the game do too, clicks fire, and Esc pauses. Clicking the game again tries
 * for the lock once more.
 */
export class Input {
  yaw = 0;
  pitch = 0;
  /** In the game: the mouse is captured, or we're playing without it. */
  active = false;
  /** The mouse is captured (pointer lock). */
  captured = false;
  /** Playing without pointer lock. */
  free = false;
  sensitivity = 1;
  invertY = false;
  /** While false (menus, chat), keys and buttons don't reach the game. */
  enabled = true;
  /** Called when play starts or stops (`free`: playing without the mouse captured). */
  onActiveChange: (active: boolean, free: boolean) => void = () => {};

  private keys = new Set<string>();
  private buttons = new Set<number>();

  constructor(private readonly target: HTMLElement) {
    document.addEventListener('keydown', (e) => {
      if (isTyping(e.target)) return;
      if (this.active && (e.code === 'Space' || e.code.startsWith('Arrow'))) e.preventDefault();
      // With the mouse captured the browser handles Esc itself (it releases the lock).
      if (e.code === 'Escape' && this.free) {
        this.setFree(false);
        return;
      }
      this.keys.add(e.code);
    });
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.clear());

    target.addEventListener('mousedown', (e) => {
      if (!this.active) return;
      this.buttons.add(e.button);
      // Playing without the lock: every click is another chance to get it.
      if (this.free) void this.requestLock();
    });
    window.addEventListener('mouseup', (e) => this.buttons.delete(e.button));
    target.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('mousemove', (e) => {
      if (!this.active) return;
      // Without the lock only small moves count: an agent's cursor jumps across the screen.
      if (!this.captured && (e.target !== target || Math.abs(e.movementX) > FREE_MOVE_LIMIT || Math.abs(e.movementY) > FREE_MOVE_LIMIT)) return;
      const k = BASE_SENSITIVITY * this.sensitivity;
      this.turn(-e.movementX * k, -e.movementY * k);
    });

    document.addEventListener('pointerlockchange', () => {
      this.captured = document.pointerLockElement === target;
      if (this.captured) this.free = false;
      else if (!this.free) this.clear();
      this.update();
    });
  }

  private turn(yaw: number, pitch: number) {
    this.yaw += yaw;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch + pitch * (this.invertY ? -1 : 1)));
  }

  /** Works out `active` again, and tells the page if it changed. */
  private update() {
    const active = this.captured || this.free;
    if (active === this.active) return;
    this.active = active;
    this.onActiveChange(active, this.free);
  }

  private setFree(on: boolean) {
    this.free = on;
    if (!on) this.clear();
    this.update();
  }

  private async requestLock() {
    try {
      // Raw mouse input (no OS acceleration) where supported.
      await this.target.requestPointerLock({ unadjustedMovement: true });
    } catch {
      try {
        await this.target.requestPointerLock();
      } catch {
        // Refused: no recent click, an embedded or automated browser.
      }
    }
  }

  /**
   * Starts play: captures the mouse if the browser allows. `fallback` (a click to play): if it
   * doesn't, play anyway without it. Without `fallback` (joining a game) a refusal leaves the pause
   * screen up, asking for that click.
   */
  async start(fallback: boolean) {
    if (this.captured) return;
    if (typeof this.target.requestPointerLock === 'function') {
      await this.requestLock();
      // Some browsers neither lock nor say no: give it a moment.
      if (!this.captured) await new Promise((done) => setTimeout(done, LOCK_WAIT));
    }
    if (!this.captured && fallback) this.setFree(true);
  }

  /** Stops play: releases the mouse, or leaves free mode. */
  stop() {
    if (document.pointerLockElement) document.exitPointerLock();
    if (this.free) this.setFree(false);
  }

  /** In a vehicle Shift descends (a helicopter) instead of grappling, which no seat can do anyway. */
  vehicleMode = false;

  sample(): PlayerInput {
    if (!this.enabled) this.clear();
    const k = this.keys;
    // Arrow keys look around (mostly for playing without the mouse captured).
    const turn = (k.has('ArrowLeft') ? 1 : 0) - (k.has('ArrowRight') ? 1 : 0);
    const tilt = (k.has('ArrowUp') ? 1 : 0) - (k.has('ArrowDown') ? 1 : 0);
    if (turn || tilt) this.turn(turn * KEY_TURN * this.sensitivity * DT, tilt * KEY_TILT * this.sensitivity * DT);
    const shift = k.has('ShiftLeft') || k.has('ShiftRight');
    return {
      forward: (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0),
      right: (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0),
      jump: k.has('Space'),
      // F fires and Q grapples too, for anyone (or anything) that can't hold a mouse button.
      fire: this.buttons.has(0) || k.has('KeyF'),
      grapple: this.buttons.has(2) || k.has('KeyQ') || (shift && !this.vehicleMode),
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
