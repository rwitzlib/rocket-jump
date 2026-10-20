import type { PlayerInput } from '../shared/types';
import type { Input } from './input';

// On-screen controls for phones and tablets. One thumb moves with a stick that appears wherever it
// lands on its half of the screen; the other half is for looking, by dragging anywhere that isn't a
// button. The buttons sit under the looking thumb: fire (big), grapple (hold to swing), jump, and a
// small row for use, scores, chat and pause. Which side looks is a setting (left-handed players).
//
// Everything feeds Input through `input.extra`, so the game sees one PlayerInput however it was made.

const STICK_RADIUS = 56; // px the stick's knob can travel from where the thumb landed
/** Dragging to look turns this much per pixel, at sensitivity 1: a thumb's swipe across the screen is about half a turn. */
const LOOK_PER_PX = 0.0055;

interface Stick {
  id: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
}

export class TouchControls {
  readonly root: HTMLElement;
  /** The scores button is held. */
  onBoard: (held: boolean) => void = () => {};
  onChat: () => void = () => {};
  onPause: () => void = () => {};
  private stick: Stick | null = null;
  private lookId: number | null = null;
  private lookLast = { x: 0, y: 0 };
  private readonly held = new Set<string>();
  private readonly knob: HTMLElement;
  private readonly base: HTMLElement;
  private layout: 'right' | 'left' = 'right';
  private shown = false;

  constructor(private readonly input: Input) {
    this.root = document.createElement('div');
    this.root.id = 'touch';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="stick-base" hidden><div class="stick-knob"></div></div>
      <div class="touch-buttons">
        <button data-act="fire" class="t-fire">FIRE</button>
        <button data-act="grapple" class="t-grapple">HOOK</button>
        <button data-act="jump" class="t-jump">JUMP</button>
        <button data-act="down" class="t-down" hidden>DOWN</button>
      </div>
      <div class="touch-row">
        <button data-act="use" class="t-small">USE</button>
        <button data-act="board" class="t-small">SCORES</button>
        <button data-act="chat" class="t-small">CHAT</button>
        <button data-act="pause" class="t-small">❚❚</button>
      </div>`;
    document.body.append(this.root);
    this.base = this.root.querySelector('.stick-base')!;
    this.knob = this.root.querySelector('.stick-knob')!;

    for (const b of this.root.querySelectorAll<HTMLButtonElement>('button')) {
      const act = b.dataset.act!;
      b.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        b.classList.add('down');
        this.held.add(act);
        if (act === 'board') this.onBoard(true);
        if (act === 'chat') this.onChat();
        if (act === 'pause') this.onPause();
        // A finger landing on a button can also drag to look, like a thumb on a real pad's button.
        if (act === 'fire' || act === 'grapple' || act === 'jump') this.startLook(e.changedTouches[0]);
      }, { passive: false });
      const up = (e: TouchEvent) => {
        e.preventDefault();
        b.classList.remove('down');
        this.held.delete(act);
        if (act === 'board') this.onBoard(false);
        for (const t of e.changedTouches) if (t.identifier === this.lookId) this.lookId = null;
      };
      b.addEventListener('touchend', up, { passive: false });
      b.addEventListener('touchcancel', up, { passive: false });
    }

    this.root.addEventListener('touchstart', (e) => this.touchStart(e), { passive: false });
    this.root.addEventListener('touchmove', (e) => this.touchMove(e), { passive: false });
    this.root.addEventListener('touchend', (e) => this.touchEnd(e), { passive: false });
    this.root.addEventListener('touchcancel', (e) => this.touchEnd(e), { passive: false });
    // Any touch at all means this is a touch device, for hints and how play starts.
    window.addEventListener('touchstart', () => (input.device = 'touch'), { capture: true, passive: true });

    input.extra = (i) => this.apply(i);
  }

  /** Shown while playing on a touch screen. */
  setVisible(on: boolean) {
    if (on === this.shown) return;
    this.shown = on;
    this.root.hidden = !on;
    if (!on) this.release();
  }

  setLayout(layout: 'right' | 'left') {
    this.layout = layout;
    this.root.classList.toggle('lefty', layout === 'left');
  }

  /** In a helicopter: show the descend button. */
  setVehicle(heli: boolean) {
    const down = this.root.querySelector<HTMLElement>('.t-down')!;
    if (down.hidden === !heli) return;
    down.hidden = !heli;
  }

  private release() {
    this.stick = null;
    this.lookId = null;
    this.held.clear();
    this.base.hidden = true;
    this.onBoard(false);
    for (const b of this.root.querySelectorAll('button.down')) b.classList.remove('down');
  }

  /** Which side of the screen moves: the other one looks. */
  private onMoveSide(x: number): boolean {
    const left = x < window.innerWidth / 2;
    return this.layout === 'right' ? left : !left;
  }

  private startLook(t: Touch) {
    if (this.lookId !== null) return;
    this.lookId = t.identifier;
    this.lookLast = { x: t.clientX, y: t.clientY };
  }

  private touchStart(e: TouchEvent) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (this.onMoveSide(t.clientX) && !this.stick) {
        this.stick = { id: t.identifier, x: t.clientX, y: t.clientY, dx: 0, dy: 0 };
        this.base.hidden = false;
        this.base.style.left = `${t.clientX}px`;
        this.base.style.top = `${t.clientY}px`;
        this.knob.style.transform = 'translate(-50%, -50%)';
      } else this.startLook(t);
    }
  }

  private touchMove(e: TouchEvent) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (this.stick && t.identifier === this.stick.id) {
        let dx = t.clientX - this.stick.x;
        let dy = t.clientY - this.stick.y;
        const len = Math.hypot(dx, dy);
        if (len > STICK_RADIUS) {
          dx *= STICK_RADIUS / len;
          dy *= STICK_RADIUS / len;
        }
        this.stick.dx = dx / STICK_RADIUS;
        this.stick.dy = dy / STICK_RADIUS;
        this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      } else if (t.identifier === this.lookId) {
        const k = LOOK_PER_PX * this.input.sensitivity;
        this.input.look(-(t.clientX - this.lookLast.x) * k, -(t.clientY - this.lookLast.y) * k);
        this.lookLast = { x: t.clientX, y: t.clientY };
      }
    }
  }

  private touchEnd(e: TouchEvent) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (this.stick && t.identifier === this.stick.id) {
        this.stick = null;
        this.base.hidden = true;
      }
      if (t.identifier === this.lookId) this.lookId = null;
    }
  }

  private apply(i: PlayerInput) {
    if (!this.shown) return;
    const s = this.stick;
    if (s) {
      // Like the keys: each direction on or off, past a third of the way out.
      if (Math.abs(s.dx) > 0.35) i.right = Math.sign(s.dx);
      if (Math.abs(s.dy) > 0.35) i.forward = -Math.sign(s.dy);
    }
    const h = this.held;
    i.fire ||= h.has('fire');
    i.grapple ||= h.has('grapple');
    i.jump ||= h.has('jump');
    i.use ||= h.has('use');
    i.down ||= h.has('down');
  }
}

/** A phone or tablet: a touch screen and no mouse. */
export const isTouchDevice = () => matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;
