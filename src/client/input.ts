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
/** A gamepad's right stick turns the view this fast at full tilt (radians per second, at stick sensitivity 1). */
const PAD_TURN = 4.2;
const PAD_TILT = 2.6;
const PAD_DEADZONE = 0.15;
/** A trigger counts as pulled past this. */
const PAD_TRIGGER = 0.3;

/** What a key, mouse button or gamepad button can be bound to. */
export type Action = 'forward' | 'back' | 'left' | 'right' | 'jump' | 'fire' | 'grapple' | 'use' | 'down';

export const ACTIONS: { id: Action; label: string }[] = [
  { id: 'forward', label: 'Forward' },
  { id: 'back', label: 'Back' },
  { id: 'left', label: 'Left' },
  { id: 'right', label: 'Right' },
  { id: 'jump', label: 'Jump' },
  { id: 'fire', label: 'Fire' },
  { id: 'grapple', label: 'Grapple' },
  { id: 'use', label: 'Use / enter vehicle / restart lap' },
  { id: 'down', label: 'Helicopter descend' },
];

export type Binds = Record<Action, string[]>;

/**
 * Keyboard codes (physical positions, so WASD sits in the same place on AZERTY, QWERTZ...) and
 * mouse buttons as "Mouse0" (left) to "Mouse4". A key bound to both grapple and descend (Shift)
 * grapples on foot and descends in a helicopter.
 */
export const DEFAULT_BINDS: Binds = {
  forward: ['KeyW'],
  back: ['KeyS'],
  left: ['KeyA'],
  right: ['KeyD'],
  jump: ['Space'],
  fire: ['Mouse0', 'KeyF'],
  grapple: ['Mouse2', 'KeyQ', 'ShiftLeft'],
  use: ['KeyE'],
  down: ['KeyC', 'ShiftLeft'],
};

/** Standard-mapping gamepad buttons for each action. */
const PAD_BUTTONS: Record<Action, number[]> = {
  forward: [12], // d-pad, besides the left stick
  back: [13],
  left: [14],
  right: [15],
  jump: [0], // A / cross
  fire: [7, 5], // right trigger, right bumper
  grapple: [6, 4], // left trigger, left bumper
  use: [2], // X / square
  down: [1], // B / circle
};
const PAD_NAMES: Record<number, string> = { 0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT', 12: '↑', 13: '↓', 14: '←', 15: '→' };
const PAD_START = 9;
const PAD_BACK = 8;

const MOUSE_NAMES = ['Mouse left', 'Mouse middle', 'Mouse right', 'Mouse 4', 'Mouse 5'];

/** Key names the way the keyboard prints them, where the browser can tell us (Chrome's Keyboard Map). */
const layout = new Map<string, string>();
void (async () => {
  try {
    const kb = (navigator as Navigator & { keyboard?: { getLayoutMap(): Promise<Map<string, string>> } }).keyboard;
    const map = await kb?.getLayoutMap();
    map?.forEach((key, code) => layout.set(code, key.toUpperCase()));
  } catch {
    // no layout map: the code's own name will do
  }
})();

/** "KeyW" -> "W", "Mouse0" -> "Mouse left", "ShiftLeft" -> "Left Shift". */
export function keyName(code: string): string {
  if (code.startsWith('Mouse')) return MOUSE_NAMES[Number(code.slice(5))] ?? code;
  if (layout.has(code)) return layout.get(code)!;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  const side = /^(Shift|Control|Alt|Meta)(Left|Right)$/.exec(code);
  if (side) return `${side[2]} ${side[1] === 'Control' ? 'Ctrl' : side[1]}`;
  if (code.startsWith('Arrow')) return code.slice(5);
  return code;
}

/** Short label for a HUD hint: "LMB" for the left mouse button, "E" for a key. */
function shortName(code: string): string {
  if (code === 'Mouse0') return 'LMB';
  if (code === 'Mouse2') return 'RMB';
  if (code === 'Mouse1') return 'MMB';
  return keyName(code);
}

/**
 * Keyboard, mouse and gamepad, sampled once per simulation tick.
 *
 * Normally the mouse is captured (pointer lock) and moves the view. Some browsers won't capture it:
 * automated ones (an AI agent driving the page), embedded ones, headless ones. When a click to play
 * doesn't get the lock, the game plays without it ("free" mode): the arrow keys look around, small
 * mouse movements over the game do too, clicks fire, and Esc pauses. Clicking the game again tries
 * for the lock once more. A gamepad plays in free mode too: Start pauses and resumes.
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
  padSensitivity = 1;
  invertY = false;
  binds: Binds = structuredClone(DEFAULT_BINDS);
  /** While false (menus, chat), keys and buttons don't reach the game. */
  enabled = true;
  /** What was used last, so hints show the right buttons. */
  device: 'keyboard' | 'pad' | 'touch' = 'keyboard';
  /** Called when play starts or stops (`free`: playing without the mouse captured). */
  onActiveChange: (active: boolean, free: boolean) => void = () => {};
  /** The gamepad's Back button is held: show the scoreboard. */
  onPadBoard: (held: boolean) => void = () => {};
  /**
   * Slows the view down while the crosshair is on an enemy (gamepad aim assist): given the aim,
   * how much of the stick's turn to apply, 0..1. Set by the game.
   */
  aimFriction: (yaw: number, pitch: number) => number = () => 1;
  /** Called while a rebind is listening: the next key or button pressed, instead of playing. */
  capture: ((code: string) => void) | null = null;
  /** Extra input merged into each sample: the touch controls. */
  extra: ((input: PlayerInput) => void) | null = null;

  private pressed = new Set<string>();
  private padHeld = new Set<number>();

  constructor(private readonly target: HTMLElement) {
    document.addEventListener('keydown', (e) => {
      if (this.capture) {
        e.preventDefault();
        e.stopPropagation();
        const done = this.capture;
        this.capture = null;
        done(e.code);
        return;
      }
      if (isTyping(e.target)) return;
      this.device = 'keyboard';
      if (this.active && (e.code === 'Space' || e.code.startsWith('Arrow') || this.isBound(e.code))) e.preventDefault();
      // With the mouse captured the browser handles Esc itself (it releases the lock).
      if (e.code === 'Escape' && this.free) {
        this.setFree(false);
        return;
      }
      this.pressed.add(e.code);
    }, true);
    document.addEventListener('keyup', (e) => this.pressed.delete(e.code));
    window.addEventListener('blur', () => this.clear());

    target.addEventListener('mousedown', (e) => {
      if (!this.active) return;
      this.device = 'keyboard';
      this.pressed.add(`Mouse${e.button}`);
      // Playing without the lock: every click is another chance to get it.
      if (this.free) void this.requestLock();
    });
    window.addEventListener('mousedown', (e) => {
      if (!this.capture) return;
      e.preventDefault();
      e.stopPropagation();
      const done = this.capture;
      this.capture = null;
      done(`Mouse${e.button}`);
    }, true);
    window.addEventListener('mouseup', (e) => this.pressed.delete(`Mouse${e.button}`));
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

  private isBound(code: string): boolean {
    for (const list of Object.values(this.binds)) if (list.includes(code)) return true;
    return false;
  }

  /** The short name of what does this action now, for hints: "E", "LMB", or a gamepad button. */
  label(action: Action): string {
    if (this.device === 'pad') return PAD_NAMES[PAD_BUTTONS[action][0]] ?? '';
    const code = this.binds[action][0];
    return code ? shortName(code) : '—';
  }

  /** Turns the view by these angles (radians), as a touch drag does. */
  look(yaw: number, pitch: number) {
    this.turn(yaw, pitch);
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
    if (this.device !== 'keyboard') {
      // A gamepad or touch screen has no use for the mouse.
      if (fallback) this.setFree(true);
      return;
    }
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

  /** The first connected gamepad, if any. */
  private gamepad(): Gamepad | null {
    if (typeof navigator.getGamepads !== 'function') return null;
    for (const p of navigator.getGamepads()) if (p?.connected) return p;
    return null;
  }

  /**
   * Gamepad buttons that act outside of play (Start pauses and resumes, Back shows the scores).
   * Called every frame, even on the pause screen, which is how Start gets you back in.
   */
  pollPad(canPlay: boolean) {
    const pad = this.gamepad();
    if (!pad) return;
    const was = this.padHeld;
    const now = new Set<number>();
    pad.buttons.forEach((b, i) => {
      if (b.pressed || b.value > PAD_TRIGGER) now.add(i);
    });
    const stick = Math.max(...pad.axes.map(Math.abs));
    if (now.size || stick > 0.5) this.device = 'pad';
    if (now.has(PAD_START) && !was.has(PAD_START) && canPlay) {
      if (this.active) this.stop();
      else void this.start(true);
    }
    if (now.has(PAD_BACK) !== was.has(PAD_BACK)) this.onPadBoard(now.has(PAD_BACK));
    this.padHeld = now;
  }

  /** A short rumble, 0..1, if the gamepad can. */
  rumble(strength: number, ms = 120) {
    const pad = this.gamepad() as (Gamepad & { vibrationActuator?: { playEffect(type: string, params: object): Promise<unknown> } }) | null;
    if (!pad?.vibrationActuator || this.device !== 'pad' || !this.active) return;
    const s = Math.min(Math.max(strength, 0), 1);
    pad.vibrationActuator.playEffect('dual-rumble', { duration: ms, strongMagnitude: s, weakMagnitude: Math.min(1, s * 1.4) }).catch(() => {});
  }

  sample(): PlayerInput {
    if (!this.enabled) this.clear();
    const k = this.pressed;
    // Arrow keys look around (mostly for playing without the mouse captured), unless bound to something.
    const look = (code: string) => k.has(code) && !this.isBound(code);
    const turn = (look('ArrowLeft') ? 1 : 0) - (look('ArrowRight') ? 1 : 0);
    const tilt = (look('ArrowUp') ? 1 : 0) - (look('ArrowDown') ? 1 : 0);
    if (turn || tilt) this.turn(turn * KEY_TURN * this.sensitivity * DT, tilt * KEY_TILT * this.sensitivity * DT);

    // A key bound to both grapple and descend does whichever makes sense: descend in a vehicle, grapple on foot.
    const on = (action: Action, except?: Action) => this.binds[action].some((c) => k.has(c) && !(except && this.binds[except].includes(c)));
    const input: PlayerInput = {
      forward: (on('forward') ? 1 : 0) - (on('back') ? 1 : 0),
      right: (on('right') ? 1 : 0) - (on('left') ? 1 : 0),
      jump: on('jump'),
      fire: on('fire'),
      grapple: on('grapple', this.vehicleMode ? 'down' : undefined),
      use: on('use'),
      down: on('down', this.vehicleMode ? undefined : 'grapple'),
      yaw: this.yaw,
      pitch: this.pitch,
    };

    const pad = this.enabled && this.active ? this.gamepad() : null;
    if (pad) this.samplePad(pad, input);
    if (this.extra && this.enabled && this.active) this.extra(input);
    input.yaw = this.yaw;
    input.pitch = this.pitch;
    return input;
  }

  private samplePad(pad: Gamepad, input: PlayerInput) {
    const axis = (i: number) => {
      const v = pad.axes[i] ?? 0;
      return Math.abs(v) < PAD_DEADZONE ? 0 : (v - Math.sign(v) * PAD_DEADZONE) / (1 - PAD_DEADZONE);
    };
    const held = (i: number) => {
      const b = pad.buttons[i];
      return !!b && (b.pressed || b.value > PAD_TRIGGER);
    };
    const button = (a: Action) => PAD_BUTTONS[a].some(held);
    const lx = axis(0);
    const ly = axis(1);
    // The stick moves you as far as it's pushed, but walking is snapped to full speed past halfway:
    // movement here is all or nothing per direction, like keys.
    if (Math.abs(lx) > 0.5 || button('right') || button('left')) input.right = Math.sign(lx) || (button('right') ? 1 : -1);
    if (Math.abs(ly) > 0.5 || button('forward') || button('back')) input.forward = -Math.sign(ly) || (button('forward') ? 1 : -1);
    input.jump ||= button('jump');
    input.fire ||= button('fire');
    input.grapple ||= !this.vehicleMode && button('grapple');
    input.use ||= button('use');
    input.down ||= button('down');
    // Look: a squared curve for fine aim near the middle, and aim assist slowing it over an enemy.
    const rx = axis(2);
    const ry = axis(3);
    if (rx || ry) {
      const friction = this.aimFriction(this.yaw, this.pitch);
      const curve = (v: number) => Math.sign(v) * v * v;
      this.turn(-curve(rx) * PAD_TURN * this.padSensitivity * friction * DT, -curve(ry) * PAD_TILT * this.padSensitivity * friction * DT);
    }
  }

  clear() {
    this.pressed.clear();
  }
}

/** Keys typed into a text box (the chat, the name field) aren't game controls. */
export function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}
