import type { Action, Input } from './input';
import { formatLap } from './objectives';
import type { Settings } from './settings';

// Teaching. The Coach talks you round the Training course, one move per ring. Tips are one-off
// hints for someone's first few games, each shown once (ever) when it first becomes useful, and
// switched off in the settings.

const TRAINED_KEY = 'rocket-jump:trained';
const TIPS_KEY = 'rocket-jump:tips';
const TIP_TIME = 8; // seconds a tip stays up

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // not remembered
    }
  },
};

/** Whether this browser has finished the training course. */
export const hasTrained = () => store.get(TRAINED_KEY) === '1';

/** "{fire}" in a line becomes the key (or button) that does it now. */
function keys(text: string, input: Input): string {
  return text.replace(/\{(\w+)\}/g, (_, action: string) => input.label(action as Action));
}

/** What to do next on the training course, by the ring you're heading for. */
const STEPS = [
  'Welcome to training! Move with {forward} {left} {back} {right} and look with the mouse. Walk through the yellow ring to start.',
  'Jump over the low wall with {jump}, and through the next ring.',
  'Too high to jump: rocket jump. Stand by the wall, look straight down, then press {jump} and {fire} together. Your own rockets never hurt you. Steer onto the ledge with {forward}.',
  'Grapple: aim at the beam over the gap and hold {grapple}. It pulls you in; hold {forward} and let go to fly through the ring. Fell in? Walk up a ramp and try again.',
  'Rocket jump for distance: run at the gap, and right at the edge look down and press {jump} and {fire}. Your speed carries you over.',
  'Last one: grapple the top edge of the tower and let it pull you up, then let go and land on top, through the ring.',
];

export class Coach {
  private readonly el = document.querySelector<HTMLElement>('#coach')!;
  private shown = '';
  private done: number | null = null; // the lap time, once the course is finished

  constructor(private readonly input: Input) {
    this.el.hidden = false;
  }

  /** Passed a ring: after the last, the course is done. */
  passed(index: number, time: number): boolean {
    if (index !== STEPS.length - 1) return false;
    this.done = time;
    store.set(TRAINED_KEY, '1');
    return true;
  }

  /** Back at the start (fell out, or restarted). */
  reset() {
    this.done = null;
  }

  update(nextRing: number) {
    const text =
      this.done !== null
        ? `Training complete in ${formatLap(this.done)}! You know the moves. Press Esc and Leave match, then try Practice against bots or Play online. {use} runs the course again.`
        : (STEPS[nextRing] ?? '');
    const shown = keys(text, this.input);
    if (shown === this.shown) return;
    this.shown = shown;
    this.el.textContent = shown;
    this.el.classList.toggle('done', this.done !== null);
    this.el.classList.remove('fresh');
    void this.el.offsetWidth;
    this.el.classList.add('fresh');
  }

  dispose() {
    this.el.hidden = true;
    this.el.textContent = '';
  }
}

/** One-off hints for new players, each shown once ever, if the setting is on. */
export class Tips {
  private readonly el = document.querySelector<HTMLElement>('#tip')!;
  private readonly seen: Set<string>;
  private left = 0;

  constructor(
    private readonly settings: Settings,
    private readonly input: Input,
  ) {
    let seen: string[] = [];
    try {
      seen = JSON.parse(store.get(TIPS_KEY) ?? '[]') as string[];
    } catch {
      // start over
    }
    this.seen = new Set(Array.isArray(seen) ? seen : []);
  }

  /** Shows a tip, unless it's been shown before (or another is still up, or tips are off). */
  show(id: string, text: string) {
    if (!this.settings.hints || this.seen.has(id) || this.left > 0) return;
    this.seen.add(id);
    store.set(TIPS_KEY, JSON.stringify([...this.seen]));
    this.el.textContent = keys(text, this.input);
    this.el.hidden = false;
    this.left = TIP_TIME;
  }

  update(dt: number) {
    if (this.left <= 0) return;
    this.left -= dt;
    if (this.left <= 0) this.el.hidden = true;
  }

  dispose() {
    this.left = 0;
    this.el.hidden = true;
  }
}
