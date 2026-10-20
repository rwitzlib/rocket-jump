import type { ExplosionId, TrailId } from '../shared/progress';
import { GLYPHS, SPRITE as S } from './spriteframes';

// How the trail and explosion skins look, as data: what each one throws off, in which shapes and
// colors and how they move. effects.ts plays these. A few skins with motion of their own (lightning
// arcs, Bubble Pop's swelling bubble) are drawn in code there instead and have no recipe here.

/** Shapes a trail lays along its path, at each step (every 0.3 m of flight). */
export interface Emit {
  frame: number | readonly number[]; // one is picked at random
  /** Glowing (added onto what's behind) rather than solid. */
  glow?: boolean;
  chance?: number; // per step
  every?: number; // only every Nth step
  count?: number; // this many at once (a firework's pop)
  size: readonly [number, number]; // meters, picked between
  grow?: number; // its size at the end, as a multiple of the start
  life: readonly [number, number]; // seconds
  colors: readonly number[]; // starting color, one picked at random
  fade?: number; // the color it ends as (default: where it started)
  alpha?: number;
  spread?: number; // meters off the path
  speed?: number; // random drift, m/s
  back?: number; // m/s back along the path (exhaust)
  gravity?: number; // m/s² down (negative floats up)
  drag?: number;
  spin?: number; // most radians per second, either way
  hold?: boolean;
  /** Weaving side to side along the path (a scarf, a dragon's body). */
  wave?: { amp: number; length: number };
  /** Cycles through the rainbow along the path. */
  hue?: boolean;
}

export interface TrailFx {
  /** The plain trail's smoke puffs under the shapes: off, or how much of it. */
  smoke?: false | { alpha?: number; life?: number; size?: number };
  /** The exhaust glow right behind the rocket. */
  flame?: false;
  emits: readonly Emit[];
}

/** A cloud of shapes thrown out by a blast. Speeds and distances scale with the blast. */
export interface Burst {
  frame: number | readonly number[];
  glow?: boolean;
  count: number;
  speed: readonly [number, number]; // m/s outward
  size: readonly [number, number];
  grow?: number;
  life: readonly [number, number];
  colors: readonly number[];
  fade?: number;
  alpha?: number;
  gravity?: number;
  drag?: number;
  spin?: number;
  hold?: boolean;
  up?: number; // m/s away from the surface, on top
  /** Starts this far out (in blast radii) rather than at the center. */
  shell?: number;
  /** Flies in toward the center instead, arriving as it fades (an implosion). */
  inward?: boolean;
  swirl?: number; // m/s round the surface's normal
  flat?: boolean; // outward along the surface only
  delay?: number; // seconds after the blast
  /** Centered this far up from the surface (in blast radii), and scattered this far across. */
  lift?: number;
  scatter?: number;
}

export interface BlastFx {
  /** The parts every blast has, in this one's colors: the white-hot core (HDR rgb), the shockwave ring, the light. */
  tint: { flash: readonly [number, number, number]; ring: number; light: number };
  /** The opening blink of light: its two colors and size (in blast radii). */
  flash?: { colors: readonly [number, number]; size?: number };
  fireball?: { count: number; colors: readonly [number, number]; scale?: number };
  sparks?: { count: number; colors: readonly [number, number]; speed?: number };
  smoke?: { count: number; dark: number; light: number; alpha: number; scale: number };
  bursts?: readonly Burst[];
  /** More shockwave rings after the first, this many, one after another. */
  rings?: number;
  /** Jagged bolts crackling out across the surface, and (sky) one striking from above. */
  bolts?: { count: number; colors: readonly [number, number]; sky?: boolean; reach?: number };
  /** A splat of this color left on what it hit, instead of a scorch. */
  decal?: number;
  /** A column of light (HDR rgb). */
  beam?: readonly [number, number, number];
  /** Goes off a second time, a beat later. */
  again?: number;
}

const RAINBOW = [0xff4040, 0xffa020, 0xffe040, 0x40e060, 0x40a0ff, 0xa060ff];
const CANDY = [0xff5ab0, 0x5ad0ff, 0xffe040, 0x80ff80, 0xffffff];
const PAINT = [0xff3090, 0x30c0ff, 0xffd020, 0x60e040, 0xa040ff];

export const TRAIL_FX: Partial<Record<TrailId, TrailFx>> = {
  // --- earned ---
  contrail: { smoke: { alpha: 0.75, life: 4.5, size: 0.7 }, emits: [] },
  ash: {
    emits: [
      { frame: S.flake, chance: 0.9, size: [0.14, 0.26], life: [1.6, 2.6], colors: [0x9a9a9a, 0x707070, 0x505050], spread: 0.3, speed: 0.6, gravity: 1.2, drag: 2, spin: 6, hold: true },
      { frame: S.flake, glow: true, chance: 0.4, size: [0.1, 0.18], life: [0.8, 1.4], colors: [0xff8030, 0xffb040], fade: 0x401000, spread: 0.25, speed: 0.6, gravity: 0.8, drag: 2, spin: 6 },
    ],
  },
  sparkler: {
    smoke: { alpha: 0.35 },
    emits: [
      { frame: S.twinkle, glow: true, chance: 1, size: [0.16, 0.26], life: [0.3, 0.6], colors: [0xffffff, 0xfff0a0], fade: 0xff8020, speed: 6, gravity: 14, drag: 2, spin: 8 },
      { frame: S.dot, glow: true, chance: 1, size: [0.08, 0.12], life: [0.3, 0.6], colors: [0xfff0a0], fade: 0xff6010, speed: 8, gravity: 14, drag: 2 },
    ],
  },
  dustdevil: {
    smoke: false,
    emits: [{ frame: S.puff, size: [0.3, 0.6], grow: 3, life: [0.9, 1.4], colors: [0xd8c0a0, 0xc8a880], fade: 0xa08868, alpha: 0.65, spread: 0.3, speed: 2.5, drag: 1.5, gravity: -0.6, spin: 4 }],
  },
  comet: {
    smoke: { alpha: 0.4, life: 1.6 },
    emits: [
      { frame: S.dot, glow: true, size: [0.7, 0.9], grow: 0.3, life: [0.25, 0.3], colors: [0xe0f8ff], fade: 0x4080ff },
      { frame: S.twinkle, glow: true, chance: 0.5, size: [0.15, 0.3], life: [0.8, 1.6], colors: [0xffffff, 0xc0e8ff], spread: 0.4, speed: 0.4 },
    ],
  },
  pixel: {
    smoke: false,
    emits: [{ frame: S.square, size: [0.18, 0.3], life: [0.6, 1.1], colors: [0xff4080, 0x40e0ff, 0xffe040, 0x80ff60], spread: 0.25, speed: 0.4, hold: true }],
  },
  afterburner: {
    smoke: { alpha: 0.35 },
    emits: [{ frame: S.diamond, glow: true, size: [0.7, 0.8], life: [0.16, 0.2], colors: [0xe0f0ff, 0xa0c8ff], fade: 0x2060ff }],
  },
  starlight: {
    smoke: { alpha: 0.3 },
    emits: [{ frame: [S.star, S.twinkle], glow: true, chance: 0.7, size: [0.12, 0.3], life: [0.8, 1.6], colors: [0xffffff, 0xd0e0ff, 0xfff0c0], spread: 0.35, speed: 0.3, spin: 2 }],
  },
  solarflare: {
    smoke: { alpha: 0.4 },
    emits: [
      { frame: S.dot, glow: true, size: [0.5, 0.7], grow: 1.6, life: [0.3, 0.45], colors: [0xffffff], hue: true, spread: 0.15 },
      { frame: S.dot, glow: true, chance: 0.6, size: [0.08, 0.14], life: [0.4, 0.8], colors: [0xffe080], fade: 0xff4000, speed: 3, gravity: 3 },
    ],
  },
  skywriter: { smoke: { alpha: 0.9, life: 6, size: 1 }, emits: [] },
  scarf: {
    smoke: { alpha: 0.3 },
    emits: [{ frame: S.square, size: [0.32, 0.34], life: [0.5, 0.55], colors: [0xe02020], fade: 0xb01010, wave: { amp: 0.35, length: 2.4 }, hold: true }],
  },
  checkered: {
    smoke: { alpha: 0.3 },
    emits: [{ frame: S.checker, size: [0.4, 0.4], life: [0.7, 0.8], colors: [0xffffff], wave: { amp: 0.15, length: 3 }, hold: true }],
  },
  stopwatch: {
    smoke: { alpha: 0.4 },
    emits: [{ frame: S.clock, every: 3, size: [0.3, 0.4], life: [0.9, 1.2], colors: [0xe8f8ff], speed: 0.4, spin: 3, hold: true }],
  },
  flagbearer: {
    smoke: false,
    emits: [
      { frame: S.square, size: [0.3, 0.3], life: [0.6, 0.65], colors: [0xe03040], wave: { amp: 0.18, length: 2.6 }, hold: true },
      { frame: S.square, size: [0.3, 0.3], life: [0.6, 0.65], colors: [0x2050e0], wave: { amp: -0.18, length: 2.6 }, hold: true },
    ],
  },
  crown: {
    smoke: { alpha: 0.3 },
    emits: [
      { frame: S.crown, every: 4, size: [0.35, 0.4], life: [0.8, 1], colors: [0xffd040], speed: 0.5, gravity: -0.5, hold: true },
      { frame: S.twinkle, glow: true, chance: 0.6, size: [0.12, 0.22], life: [0.5, 1], colors: [0xffffff, 0xfff0a0], spread: 0.3 },
    ],
  },
  confetti: {
    smoke: { alpha: 0.2 },
    emits: [{ frame: S.confetti, chance: 1, size: [0.1, 0.16], life: [1, 1.8], colors: RAINBOW, spread: 0.25, speed: 2, gravity: 2.5, drag: 2.5, spin: 10, hold: true }],
  },
  medal: {
    smoke: false,
    emits: [
      { frame: S.ribbon, size: [0.32, 0.32], life: [0.6, 0.7], colors: [0x2050d0], wave: { amp: 0.12, length: 2 }, hold: true },
      { frame: S.coin, every: 5, size: [0.3, 0.3], life: [0.8, 0.9], colors: [0xffffff], hold: true },
    ],
  },
  training: {
    smoke: false,
    emits: [{ frame: S.disc, every: 2, size: [0.12, 0.12], life: [2.5, 3], colors: [0xf8f8f0], hold: true }],
  },
  bats: {
    smoke: { alpha: 0.4 },
    emits: [{ frame: S.bat, chance: 0.45, size: [0.25, 0.4], life: [0.8, 1.4], colors: [0x201828, 0x302838], speed: 3, gravity: -1, drag: 1.5, spin: 1.5, hold: true }],
  },
  snowfall: {
    smoke: { alpha: 0.3 },
    emits: [{ frame: S.snowflake, chance: 0.7, size: [0.12, 0.24], life: [1.6, 2.6], colors: [0xffffff, 0xe0f0ff], spread: 0.3, speed: 0.4, gravity: 0.9, drag: 2.5, spin: 2, hold: true }],
  },
  // --- premium ---
  clouds: {
    smoke: false,
    emits: [{ frame: S.toon, size: [0.5, 0.8], grow: 1.6, life: [0.9, 1.3], colors: [0xffffff], spread: 0.2, speed: 0.5, gravity: -0.3, drag: 1, hold: true }],
  },
  hearts: {
    smoke: { alpha: 0.25 },
    emits: [{ frame: S.heart, chance: 0.7, size: [0.18, 0.32], life: [0.9, 1.5], colors: [0xff4090, 0xff80b0, 0xff2060], speed: 0.6, gravity: -1.2, drag: 1.2, spin: 1.5, hold: true }],
  },
  notes: {
    smoke: { alpha: 0.25 },
    emits: [{ frame: S.note, chance: 0.5, size: [0.22, 0.34], life: [1, 1.6], colors: [0xa060ff, 0x40c0ff, 0xff60c0, 0xffffff], speed: 0.6, gravity: -1, drag: 1.2, spin: 1, hold: true }],
  },
  paint: {
    smoke: false,
    emits: [
      { frame: S.blob, size: [0.25, 0.4], life: [0.6, 0.9], colors: PAINT, spread: 0.12, hold: true },
      { frame: S.blob, chance: 0.4, size: [0.08, 0.14], life: [0.7, 1.1], colors: PAINT, speed: 1.5, gravity: 14, drag: 0.5, hold: true },
    ],
  },
  fireworks: {
    smoke: { alpha: 0.4 },
    emits: [
      { frame: S.dot, glow: true, every: 5, count: 16, size: [0.14, 0.2], life: [0.5, 0.9], colors: RAINBOW, speed: 7, gravity: 5, drag: 3 },
      { frame: S.twinkle, glow: true, chance: 0.5, size: [0.12, 0.2], life: [0.3, 0.5], colors: [0xffffff, 0xffe080], spread: 0.15 },
    ],
  },
  sakura: {
    smoke: { alpha: 0.2 },
    emits: [{ frame: S.petal, chance: 0.9, size: [0.16, 0.26], life: [1.6, 2.6], colors: [0xffb8cc, 0xff9ab8, 0xffe0ea], spread: 0.3, speed: 1, gravity: 0.6, drag: 2.5, spin: 5, hold: true }],
  },
  leaves: {
    smoke: { alpha: 0.25 },
    emits: [{ frame: S.leaf, chance: 0.8, size: [0.2, 0.32], life: [1.6, 2.6], colors: [0xe06010, 0xd03010, 0xf0a020, 0xa04010], spread: 0.3, speed: 1, gravity: 1, drag: 2.5, spin: 5, hold: true }],
  },
  ink: {
    smoke: { alpha: 0.95, life: 1.8, size: 0.8 },
    emits: [{ frame: S.blob, chance: 0.3, size: [0.06, 0.12], life: [0.6, 1], colors: [0x101010], speed: 1.5, gravity: 10, hold: true }],
  },
  glitch: {
    smoke: { alpha: 0.4 },
    emits: [{ frame: S.square, glow: true, chance: 1, size: [0.12, 0.34], life: [0.08, 0.25], colors: [0xff0040, 0x00ffd0, 0x4060ff, 0xffffff], spread: 0.45, hold: true }],
  },
  digitalrain: {
    smoke: { alpha: 0.4 },
    emits: [{ frame: GLYPHS, glow: true, chance: 0.9, size: [0.16, 0.26], life: [0.8, 1.4], colors: [0x80ff90, 0x30ff60], fade: 0x006020, spread: 0.4, gravity: 1.5, drag: 3, hold: true }],
  },
  hologram: {
    smoke: { alpha: 0.25 },
    emits: [
      { frame: S.rocket, glow: true, every: 3, size: [0.6, 0.6], life: [0.35, 0.4], colors: [0x40e0ff], fade: 0x0060a0 },
      { frame: S.square, glow: true, chance: 0.4, size: [0.04, 0.08], life: [0.3, 0.6], colors: [0x80f0ff], spread: 0.3 },
    ],
  },
  neon: {
    smoke: false,
    emits: [
      { frame: S.dot, glow: true, size: [0.32, 0.36], life: [0.45, 0.5], colors: [0xff40d0], wave: { amp: 0.12, length: 1.4 }, hold: true },
      { frame: S.dot, glow: true, size: [0.32, 0.36], life: [0.45, 0.5], colors: [0x40e0ff], wave: { amp: -0.12, length: 1.4 }, hold: true },
    ],
  },
  dragon: {
    smoke: { alpha: 0.4 },
    flame: false,
    emits: [
      { frame: S.scale, size: [0.42, 0.46], life: [0.55, 0.6], colors: [0xc02010, 0xe03010], fade: 0x601008, wave: { amp: 0.5, length: 3.2 }, hold: true },
      { frame: S.dot, glow: true, size: [0.3, 0.4], life: [0.25, 0.35], colors: [0xffd040], fade: 0xff3000, wave: { amp: 0.5, length: 3.2 } },
      { frame: S.dragon, glow: true, every: 2, size: [0.8, 0.8], life: [0.06, 0.07], colors: [0xffc040] },
    ],
  },
  phoenix: {
    smoke: { alpha: 0.3 },
    emits: [{ frame: S.feather, glow: true, chance: 1, size: [0.25, 0.4], life: [0.7, 1.1], colors: [0xffd040, 0xff8020, 0xff4010], fade: 0x801000, spread: 0.2, speed: 1.2, gravity: -0.6, drag: 1.5, spin: 3 }],
  },
  ghost: {
    smoke: { alpha: 0.3 },
    emits: [{ frame: S.ghost, chance: 0.35, size: [0.3, 0.45], grow: 1.3, life: [0.9, 1.4], colors: [0xe8fff8], alpha: 0.6, speed: 0.4, gravity: -0.8, drag: 1 }],
  },
  cash: {
    smoke: { alpha: 0.2 },
    emits: [{ frame: S.bill, chance: 0.6, size: [0.25, 0.32], life: [1.4, 2.2], colors: [0xffffff], spread: 0.3, speed: 1, gravity: 1.2, drag: 2.5, spin: 6, hold: true }],
  },
  sprinkles: {
    smoke: { alpha: 0.25 },
    emits: [{ frame: S.confetti, chance: 1, size: [0.06, 0.1], life: [0.8, 1.4], colors: CANDY, spread: 0.2, speed: 1.5, gravity: 8, drag: 1.5, spin: 12, hold: true }],
  },
  ducks: {
    smoke: { alpha: 0.35 },
    emits: [{ frame: S.duck, chance: 0.3, size: [0.3, 0.4], life: [1.2, 1.8], colors: [0xffffff], speed: 1.2, gravity: 6, drag: 1, spin: 2, hold: true }],
  },
  smokerings: {
    smoke: { alpha: 0.2 },
    emits: [{ frame: S.ring, every: 3, size: [0.35, 0.4], grow: 2.5, life: [1.2, 1.5], colors: [0xe0dcd8], alpha: 0.8, gravity: -0.3, drag: 1 }],
  },
  blackhole: {
    smoke: { alpha: 0.8, size: 0.7 },
    flame: false,
    emits: [
      { frame: S.disc, size: [0.36, 0.4], life: [0.2, 0.25], colors: [0x000000] },
      { frame: S.ring, glow: true, size: [0.6, 0.7], grow: 0.4, life: [0.35, 0.45], colors: [0xc080ff], fade: 0x3010a0, spin: 6 },
      { frame: S.dot, glow: true, chance: 0.5, size: [0.06, 0.1], life: [0.3, 0.5], colors: [0xffd0ff], spread: 0.8, speed: 0.5 },
    ],
  },
  lava: {
    smoke: { alpha: 0.6 },
    emits: [{ frame: S.blob, glow: true, chance: 0.7, size: [0.14, 0.26], life: [0.8, 1.3], colors: [0xffd040, 0xff8020], fade: 0x401008, speed: 1, gravity: 9, drag: 0.5, hold: true }],
  },
  slime: {
    smoke: { alpha: 0.3 },
    emits: [{ frame: S.blob, chance: 0.8, size: [0.16, 0.3], life: [0.8, 1.2], colors: [0x70e030, 0x50c020, 0x90f050], fade: 0x308010, spread: 0.12, speed: 0.4, gravity: 5, drag: 1.5, hold: true }],
  },
  galaxy: {
    smoke: { alpha: 0.5 },
    emits: [
      { frame: S.dot, glow: true, size: [0.5, 0.8], grow: 2, life: [0.7, 1], colors: [0x8030ff, 0x3050ff, 0xff40c0], alpha: 0.5, spread: 0.2 },
      { frame: [S.twinkle, S.star], glow: true, chance: 0.6, size: [0.06, 0.14], life: [0.8, 1.5], colors: [0xffffff], spread: 0.5 },
    ],
  },
  blueprint: {
    smoke: false,
    emits: [
      { frame: S.square, every: 2, size: [0.16, 0.16], life: [1.4, 1.6], colors: [0xffffff], hold: true },
      { frame: S.cross, every: 6, size: [0.3, 0.3], life: [1.4, 1.6], colors: [0x80c0ff], hold: true },
      { frame: S.dot, size: [0.5, 0.5], life: [0.6, 0.7], colors: [0x2050c0], alpha: 0.5, hold: true },
    ],
  },
  soundwave: {
    smoke: false,
    emits: [{ frame: S.ring, glow: true, every: 2, size: [0.2, 0.25], grow: 4, life: [0.5, 0.6], colors: [0x40ffe0, 0x40a0ff], fade: 0x103040 }],
  },
  fairydust: {
    smoke: { alpha: 0.2 },
    emits: [{ frame: [S.twinkle, S.dot], glow: true, chance: 1, size: [0.05, 0.12], life: [0.6, 1.3], colors: [0xffffff, 0xffa0ff, 0xa0e0ff, 0xfff0a0], spread: 0.3, speed: 0.6, gravity: 0.8, drag: 2 }],
  },
  cranes: {
    smoke: { alpha: 0.25 },
    emits: [{ frame: S.crane, chance: 0.3, size: [0.3, 0.4], life: [1.4, 2], colors: [0xffffff, 0xff8060, 0x60c0ff, 0xffe060], speed: 1.5, gravity: -0.8, drag: 1, spin: 0.6, hold: true }],
  },
  bees: {
    smoke: { alpha: 0.25 },
    emits: [{ frame: S.bee, chance: 0.5, size: [0.2, 0.26], life: [0.8, 1.3], colors: [0xffffff], spread: 0.3, speed: 2.5, gravity: -0.4, drag: 0.5, spin: 1, hold: true }],
  },
};

export const BLAST_FX: Partial<Record<ExplosionId, BlastFx>> = {
  // --- earned ---
  dirtkick: {
    tint: { flash: [1.6, 1.2, 0.7], ring: 0xd8c0a0, light: 0xff9040 },
    flash: { colors: [0xffe0b0, 0xff9050] },
    fireball: { count: 8, colors: [0xffc060, 0xc04010], scale: 0.8 },
    smoke: { count: 18, dark: 0x6a5038, light: 0xa08868, alpha: 0.8, scale: 1.1 },
    bursts: [{ frame: S.rock, count: 18, speed: [6, 12], size: [0.15, 0.35], life: [0.8, 1.2], colors: [0x6a5038, 0x8a6a48, 0x4a3828], gravity: 18, drag: 0.5, spin: 8, up: 6, hold: true }],
  },
  shockwave: {
    tint: { flash: [1.6, 1.9, 2.4], ring: 0xd0e8ff, light: 0xa0c8ff },
    flash: { colors: [0xffffff, 0xa0c8ff] },
    fireball: { count: 6, colors: [0xffe0a0, 0xe06020], scale: 0.7 },
    sparks: { count: 16, colors: [0xffffff, 0x80b0ff] },
    smoke: { count: 8, dark: 0x606870, light: 0xa0a8b0, alpha: 0.5, scale: 0.9 },
    rings: 3,
  },
  sparkshower: {
    tint: { flash: [2, 1.6, 0.8], ring: 0xffd890, light: 0xffb040 },
    flash: { colors: [0xfff4d0, 0xffb060] },
    fireball: { count: 8, colors: [0xffd040, 0xe8401a], scale: 0.8 },
    sparks: { count: 130, colors: [0xffffff, 0xffa020], speed: 1.2 },
    smoke: { count: 8, dark: 0x5a5654, light: 0x9a9692, alpha: 0.5, scale: 0.8 },
  },
  mushroom: {
    tint: { flash: [2, 1.4, 0.8], ring: 0xffc890, light: 0xff8030 },
    flash: { colors: [0xfff4d0, 0xffa050], size: 1.2 },
    fireball: { count: 12, colors: [0xffd040, 0xe0401a] },
    bursts: [
      // The stem rising, then the cap rolling out on top of it.
      { frame: S.puff, count: 14, speed: [0.2, 0.8], up: 9, size: [0.8, 1.2], grow: 1.8, life: [1, 1.4], colors: [0xffa040, 0x9a6a50], fade: 0x504040, drag: 2.5, scatter: 0.12 },
      { frame: S.puff, count: 22, speed: [4, 6], flat: true, size: [1, 1.6], grow: 2.2, life: [1.4, 2], colors: [0xffb060, 0xb07050], fade: 0x585050, drag: 2.5, gravity: -0.6, lift: 1.1, delay: 0.25 },
    ],
  },
  supernova: {
    tint: { flash: [2.6, 2.3, 2.8], ring: 0xffe0ff, light: 0xfff0ff },
    bursts: [
      { frame: S.dot, glow: true, count: 60, inward: true, shell: 1.2, speed: [0, 0], size: [0.2, 0.3], life: [0.3, 0.3], colors: [0xffd0ff, 0xa0c0ff] },
      { frame: S.dot, glow: true, count: 1, speed: [0, 0], size: [3, 4], grow: 2.5, life: [0.5, 0.5], colors: [0xffffff], fade: 0xff80e0, delay: 0.3 },
      { frame: S.twinkle, glow: true, count: 40, speed: [10, 18], size: [0.2, 0.4], life: [0.6, 1], colors: [0xffffff, 0xffc0ff, 0xc0d0ff], drag: 3, delay: 0.3 },
    ],
    rings: 2,
  },
  bigbang: {
    tint: { flash: [2.2, 2, 2.8], ring: 0xc0b0ff, light: 0xb090ff },
    flash: { colors: [0xffffff, 0xb090ff], size: 1.4 },
    bursts: [
      { frame: [S.star, S.twinkle, S.dot], glow: true, count: 90, speed: [6, 22], size: [0.15, 0.4], life: [0.8, 1.6], colors: [...RAINBOW, 0xffffff], drag: 2.5, spin: 4 },
      { frame: S.dot, glow: true, count: 10, speed: [1, 3], size: [1.5, 2.5], grow: 2, life: [1, 1.4], colors: [0x6030ff, 0xff30a0, 0x3060ff], alpha: 0.5, drag: 1.5 },
      { frame: S.streak, glow: true, count: 24, speed: [20, 30], size: [0.8, 1.2], life: [0.25, 0.35], colors: [0xffffff], drag: 4 },
    ],
    rings: 1,
  },
  airburst: {
    tint: { flash: [1.6, 2, 2.4], ring: 0xb0e8ff, light: 0x90d0ff },
    flash: { colors: [0xffffff, 0x90d0ff] },
    fireball: { count: 12, colors: [0xffe080, 0xe06020] },
    sparks: { count: 24, colors: [0xffffff, 0x80d0ff] },
    smoke: { count: 10, dark: 0x8090a0, light: 0xc0d0e0, alpha: 0.5, scale: 0.9 },
    bursts: [{ frame: S.ring, glow: true, count: 3, speed: [0, 0], size: [1, 1.5], grow: 5, life: [0.5, 0.7], colors: [0xc0f0ff], fade: 0x2080c0 }],
    rings: 2,
  },
  doubletap: {
    tint: { flash: [1.8, 1.4, 0.8], ring: 0xffc0a0, light: 0xff7030 },
    flash: { colors: [0xfff4d0, 0xff8040] },
    fireball: { count: 14, colors: [0xffd040, 0xe8401a] },
    sparks: { count: 20, colors: [0xfff0c0, 0xff7020] },
    smoke: { count: 12, dark: 0x5a5654, light: 0x9a9692, alpha: 0.6, scale: 1 },
    again: 0.22,
  },
  bullseye: {
    tint: { flash: [2.4, 1.2, 1.2], ring: 0xff3040, light: 0xff4040 },
    flash: { colors: [0xffffff, 0xff4050] },
    fireball: { count: 8, colors: [0xffe0e0, 0xe02030], scale: 0.8 },
    sparks: { count: 16, colors: [0xffffff, 0xff4050] },
    bursts: [
      { frame: S.ring, glow: true, count: 1, speed: [0, 0], size: [1, 1], grow: 6, life: [0.5, 0.5], colors: [0xff2030] },
      { frame: S.ring, glow: true, count: 1, speed: [0, 0], size: [1, 1], grow: 6, life: [0.5, 0.5], colors: [0xffffff], delay: 0.12 },
      { frame: S.ring, glow: true, count: 1, speed: [0, 0], size: [1, 1], grow: 6, life: [0.5, 0.5], colors: [0xff2030], delay: 0.24 },
    ],
    rings: 2,
  },
  goldrush: {
    tint: { flash: [2, 1.7, 0.6], ring: 0xffe080, light: 0xffc030 },
    flash: { colors: [0xfff8d0, 0xffc030] },
    fireball: { count: 10, colors: [0xffe060, 0xe09010], scale: 0.9 },
    bursts: [
      { frame: S.coin, count: 30, speed: [5, 11], up: 5, size: [0.25, 0.35], life: [1, 1.6], colors: [0xffffff], gravity: 16, drag: 0.6, spin: 10, hold: true },
      { frame: S.twinkle, glow: true, count: 20, speed: [3, 8], size: [0.15, 0.3], life: [0.5, 1], colors: [0xfff0a0], drag: 3 },
    ],
  },
  banner: {
    tint: { flash: [1.6, 1.6, 2.2], ring: 0xc0d0ff, light: 0x8090ff },
    flash: { colors: [0xffffff, 0x8090ff] },
    fireball: { count: 10, colors: [0xffd040, 0xe8401a], scale: 0.9 },
    bursts: [{ frame: S.flag, count: 16, speed: [4, 9], up: 5, size: [0.4, 0.55], life: [1, 1.5], colors: [0xe03040, 0x2050e0, 0xffffff], gravity: 8, drag: 1.5, spin: 4, hold: true }],
  },
  burnout: {
    tint: { flash: [1.6, 1.2, 0.8], ring: 0xb0b0b0, light: 0xff8040 },
    flash: { colors: [0xfff0d0, 0xff8040] },
    fireball: { count: 8, colors: [0xffc060, 0xc03010], scale: 0.8 },
    sparks: { count: 40, colors: [0xffffff, 0xffa040] },
    smoke: { count: 30, dark: 0x303030, light: 0x787878, alpha: 0.85, scale: 1.3 },
  },
  sawdust: {
    tint: { flash: [1.6, 1.3, 0.8], ring: 0xe0c8a0, light: 0xffa050 },
    flash: { colors: [0xfff0d0, 0xffa050] },
    fireball: { count: 6, colors: [0xffd080, 0xd06020], scale: 0.7 },
    smoke: { count: 16, dark: 0xb89870, light: 0xe0d0b0, alpha: 0.7, scale: 1 },
    bursts: [{ frame: S.chip, count: 30, speed: [5, 12], up: 4, size: [0.15, 0.3], life: [0.8, 1.3], colors: [0xc8a070, 0xe0c090, 0xa07848], gravity: 16, drag: 0.8, spin: 12, hold: true }],
  },
  meteor: {
    tint: { flash: [2, 1.2, 0.6], ring: 0xff9060, light: 0xff5020 },
    flash: { colors: [0xffe0a0, 0xff6020], size: 1.2 },
    fireball: { count: 16, colors: [0xffb030, 0xc02010] },
    smoke: { count: 18, dark: 0x403028, light: 0x806858, alpha: 0.75, scale: 1.2 },
    bursts: [{ frame: S.rock, glow: true, count: 16, speed: [6, 13], up: 6, size: [0.2, 0.4], life: [0.9, 1.4], colors: [0xffa040, 0xff6020], fade: 0x401808, gravity: 18, drag: 0.4, spin: 6, hold: true }],
  },
  jackolantern: {
    tint: { flash: [2, 1.2, 0.4], ring: 0xffa040, light: 0xff7000 },
    flash: { colors: [0xffe080, 0xff8000] },
    fireball: { count: 12, colors: [0xffa020, 0x802000] },
    smoke: { count: 10, dark: 0x302838, light: 0x605070, alpha: 0.6, scale: 1 },
    bursts: [
      { frame: S.pumpkin, count: 1, speed: [0, 0], size: [2.4, 2.4], grow: 1.3, life: [0.7, 0.7], colors: [0xffffff], hold: true, lift: 0.3 },
      { frame: S.bat, count: 10, speed: [4, 8], up: 3, size: [0.3, 0.45], life: [0.9, 1.3], colors: [0x201828], gravity: -1, drag: 1.5, hold: true },
    ],
  },
  snowglobe: {
    tint: { flash: [1.6, 2, 2.4], ring: 0xe0f4ff, light: 0xc0e8ff },
    flash: { colors: [0xffffff, 0xc0e8ff] },
    bursts: [
      { frame: S.bubble, count: 1, speed: [0, 0], size: [3.5, 4], grow: 1.3, life: [0.5, 0.5], colors: [0xe8f8ff], lift: 0.2 },
      { frame: S.snowflake, count: 50, speed: [3, 8], up: 3, size: [0.15, 0.3], life: [1.4, 2.4], colors: [0xffffff, 0xe0f0ff], gravity: 1.2, drag: 2.5, spin: 3, hold: true },
      { frame: S.puff, count: 10, speed: [2, 4], size: [1, 1.6], grow: 2, life: [0.8, 1.2], colors: [0xf4f8ff], alpha: 0.6, drag: 3 },
    ],
  },
  finale: {
    tint: { flash: [2.2, 1.6, 2], ring: 0xffa0e0, light: 0xff60c0 },
    flash: { colors: [0xffffff, 0xff60c0] },
    fireball: { count: 8, colors: [0xffd040, 0xe8401a], scale: 0.8 },
    bursts: [
      { frame: S.dot, glow: true, count: 40, speed: [5, 9], size: [0.14, 0.2], life: [0.8, 1.2], colors: [0xff4060, 0xffd040], gravity: 4, drag: 2.5, lift: 2.2, scatter: 1.2, delay: 0.2 },
      { frame: S.dot, glow: true, count: 40, speed: [5, 9], size: [0.14, 0.2], life: [0.8, 1.2], colors: [0x40a0ff, 0xffffff], gravity: 4, drag: 2.5, lift: 2.6, scatter: 1.2, delay: 0.45 },
      { frame: S.dot, glow: true, count: 40, speed: [5, 9], size: [0.14, 0.2], life: [0.8, 1.2], colors: [0x40ff80, 0xff60e0], gravity: 4, drag: 2.5, lift: 2, scatter: 1.2, delay: 0.7 },
      { frame: S.twinkle, glow: true, count: 30, speed: [1, 3], size: [0.15, 0.25], life: [0.6, 1], colors: [0xffffff], gravity: 2, lift: 2.4, scatter: 1.6, delay: 0.9 },
    ],
  },
  // --- premium ---
  kaboom: {
    tint: { flash: [2, 1.8, 0.6], ring: 0xffe040, light: 0xffc020 },
    flash: { colors: [0xffffff, 0xffe040] },
    fireball: { count: 10, colors: [0xffe040, 0xff3020], scale: 0.9 },
    bursts: [
      { frame: [S.kaboom, S.pow, S.boom], count: 1, speed: [0, 0], size: [3.2, 3.2], grow: 1.25, life: [0.7, 0.7], colors: [0xffffff], hold: true, lift: 0.5 },
      { frame: S.halftone, count: 6, speed: [3, 6], size: [1, 1.5], grow: 1.6, life: [0.4, 0.6], colors: [0xff3020, 0xffe040], alpha: 0.8, drag: 4 },
      { frame: S.star, count: 10, speed: [6, 10], size: [0.3, 0.45], life: [0.4, 0.6], colors: [0xffe040, 0xffffff], drag: 3, spin: 8, hold: true },
    ],
  },
  tooncloud: {
    tint: { flash: [1.4, 1.4, 1.4], ring: 0xffffff, light: 0xfff0d0 },
    bursts: [
      { frame: S.toon, count: 12, speed: [3, 6], size: [1, 1.6], grow: 1.5, life: [0.8, 1.1], colors: [0xffffff], drag: 4, gravity: -0.4, hold: true },
      { frame: S.star, count: 6, speed: [0, 0], swirl: 5, size: [0.3, 0.4], life: [1.2, 1.2], colors: [0xffe040], spin: 6, lift: 0.9, hold: true, delay: 0.2 },
    ],
  },
  tesla: {
    tint: { flash: [1.4, 1.6, 2.6], ring: 0xa0c0ff, light: 0x8090ff },
    flash: { colors: [0xf0f4ff, 0x6080ff] },
    sparks: { count: 30, colors: [0xffffff, 0x6080ff], speed: 1.2 },
    smoke: { count: 6, dark: 0x384060, light: 0x8088a8, alpha: 0.4, scale: 0.8 },
    bolts: { count: 14, colors: [0xffffff, 0x7090ff], reach: 1.3 },
  },
  blackhole: {
    tint: { flash: [0.8, 0.3, 1.4], ring: 0x8040c0, light: 0x8030ff },
    bursts: [
      { frame: S.dot, glow: true, count: 80, inward: true, shell: 1.4, speed: [0, 0], swirl: 6, size: [0.12, 0.25], life: [0.45, 0.45], colors: [0xd0a0ff, 0x8040ff, 0xffffff] },
      { frame: S.disc, count: 1, speed: [0, 0], size: [1.4, 1.6], grow: 0.2, life: [0.5, 0.5], colors: [0x000000], hold: true },
      { frame: S.ring, glow: true, count: 1, speed: [0, 0], size: [3, 3.2], grow: 0.3, life: [0.5, 0.5], colors: [0xc080ff], spin: 8 },
      { frame: S.dot, glow: true, count: 30, speed: [10, 18], size: [0.2, 0.35], life: [0.4, 0.7], colors: [0xffd0ff, 0x8040ff], drag: 3, delay: 0.45 },
    ],
    rings: 1,
  },
  portal: {
    tint: { flash: [1.4, 0.8, 2.4], ring: 0xc080ff, light: 0xa040ff },
    bursts: [
      { frame: S.swirl, glow: true, count: 1, speed: [0, 0], size: [1, 1], grow: 4, life: [0.6, 0.6], colors: [0xc060ff], fade: 0x4010a0, spin: 12, hold: true },
      { frame: S.ring, glow: true, count: 1, speed: [0, 0], size: [4, 4], grow: 0.1, life: [0.6, 0.6], colors: [0xe0a0ff], hold: true },
      { frame: S.dot, glow: true, count: 50, inward: true, shell: 1, speed: [0, 0], swirl: 8, size: [0.1, 0.2], life: [0.6, 0.6], colors: [0xe0a0ff, 0x60a0ff] },
    ],
  },
  confetti: {
    tint: { flash: [2, 1.6, 2], ring: 0xffc0e0, light: 0xff80c0 },
    flash: { colors: [0xffffff, 0xff80c0] },
    bursts: [
      { frame: S.confetti, count: 70, speed: [6, 14], up: 6, size: [0.12, 0.2], life: [1.4, 2.2], colors: RAINBOW, gravity: 5, drag: 2.5, spin: 12, hold: true },
      { frame: S.ribbon, count: 10, speed: [5, 10], up: 5, size: [0.3, 0.5], life: [1.4, 2], colors: RAINBOW, gravity: 4, drag: 2.5, spin: 6, hold: true },
    ],
  },
  pinata: {
    tint: { flash: [2, 1.5, 1], ring: 0xffc080, light: 0xff9030 },
    flash: { colors: [0xffffff, 0xff9030] },
    bursts: [
      { frame: S.candy, count: 24, speed: [5, 11], up: 5, size: [0.3, 0.4], life: [1.2, 1.8], colors: [0xffffff], gravity: 14, drag: 0.8, spin: 8, hold: true },
      { frame: S.confetti, count: 30, speed: [4, 9], up: 3, size: [0.15, 0.25], life: [1, 1.6], colors: CANDY, gravity: 5, drag: 2.5, spin: 10, hold: true },
    ],
  },
  paint: {
    tint: { flash: [2, 1, 1.6], ring: 0xff80c0, light: 0xff40a0 },
    bursts: [
      { frame: S.splat, count: 8, speed: [2, 5], size: [0.8, 1.2], grow: 1.4, life: [0.5, 0.8], colors: PAINT, drag: 4, spin: 2, hold: true },
      { frame: S.blob, count: 40, speed: [6, 13], up: 4, size: [0.15, 0.3], life: [0.8, 1.2], colors: PAINT, gravity: 16, drag: 0.6, hold: true },
    ],
    decal: 0xff3090,
  },
  glitter: {
    tint: { flash: [2, 1.6, 2.2], ring: 0xffc0ff, light: 0xff90ff },
    flash: { colors: [0xffffff, 0xffa0ff] },
    bursts: [{ frame: [S.twinkle, S.dot], glow: true, count: 140, speed: [3, 12], size: [0.05, 0.14], life: [1, 2.2], colors: [0xffffff, 0xffa0ff, 0xa0e0ff, 0xfff0a0], gravity: 2, drag: 2.5 }],
  },
  ink: {
    tint: { flash: [0.6, 0.6, 0.7], ring: 0x404040, light: 0x8080a0 },
    smoke: { count: 18, dark: 0x101010, light: 0x282828, alpha: 0.95, scale: 1 },
    bursts: [
      { frame: S.splat, count: 6, speed: [2, 5], size: [1, 1.4], grow: 1.3, life: [0.6, 0.9], colors: [0x101010], drag: 4, spin: 1, hold: true },
      { frame: S.blob, count: 34, speed: [6, 12], up: 3, size: [0.12, 0.25], life: [0.8, 1.2], colors: [0x0c0c0c], gravity: 16, drag: 0.6, hold: true },
    ],
    decal: 0x101010,
  },
  glitch: {
    tint: { flash: [0.6, 2.4, 2], ring: 0x00ffd0, light: 0x40ffe0 },
    bursts: [
      { frame: S.square, glow: true, count: 40, speed: [0, 3], size: [0.3, 0.8], life: [0.1, 0.3], colors: [0xff0040, 0x00ffd0, 0x4060ff, 0xffffff], hold: true, scatter: 0.8 },
      { frame: S.square, glow: true, count: 30, speed: [0, 2], size: [0.2, 0.6], life: [0.1, 0.25], colors: [0xff0040, 0x00ffd0, 0xffffff], hold: true, scatter: 1, delay: 0.15 },
      { frame: S.square, glow: true, count: 20, speed: [0, 2], size: [0.2, 0.5], life: [0.1, 0.2], colors: [0x00ffd0, 0x4060ff], hold: true, scatter: 1.2, delay: 0.3 },
    ],
  },
  eightbit: {
    tint: { flash: [2, 1.4, 0.6], ring: 0xffc040, light: 0xff8000 },
    bursts: [
      { frame: S.square, count: 24, speed: [3, 4], flat: false, size: [0.5, 0.5], life: [0.35, 0.35], colors: [0xffe040], hold: true, drag: 0 },
      { frame: S.square, count: 32, speed: [6, 7], size: [0.6, 0.6], life: [0.4, 0.4], colors: [0xff8000], hold: true, drag: 0, delay: 0.1 },
      { frame: S.square, count: 40, speed: [9, 10], size: [0.7, 0.7], life: [0.4, 0.4], colors: [0xd02000, 0x606060], hold: true, drag: 0, delay: 0.2 },
    ],
  },
  hologram: {
    tint: { flash: [0.6, 2, 2.6], ring: 0x40e0ff, light: 0x20c0ff },
    bursts: [
      { frame: S.grid, glow: true, count: 1, speed: [0, 0], size: [1, 1], grow: 6, life: [0.7, 0.7], colors: [0x60f0ff], fade: 0x0060a0, spin: 1.5, hold: true },
      { frame: S.square, glow: true, count: 40, speed: [2, 6], size: [0.06, 0.12], life: [0.4, 0.8], colors: [0x80f0ff], drag: 2 },
    ],
    rings: 2,
  },
  fruit: {
    tint: { flash: [2, 1, 1], ring: 0xff8090, light: 0xff4050 },
    bursts: [
      { frame: S.melon, count: 14, speed: [5, 10], up: 5, size: [0.35, 0.5], life: [1, 1.5], colors: [0xffffff], gravity: 16, drag: 0.6, spin: 8, hold: true },
      { frame: S.blob, count: 30, speed: [6, 12], up: 3, size: [0.1, 0.2], life: [0.6, 1], colors: [0xff3050, 0xff6070], gravity: 16, drag: 0.6, hold: true },
    ],
    decal: 0xd02040,
  },
  pillow: {
    tint: { flash: [1.6, 1.6, 1.5], ring: 0xffffff, light: 0xfff0e0 },
    bursts: [
      { frame: S.feather, count: 50, speed: [3, 9], up: 3, size: [0.25, 0.4], life: [2, 3], colors: [0xffffff, 0xf8f0e8], gravity: 0.8, drag: 3, spin: 3, hold: true },
      { frame: S.puff, count: 8, speed: [2, 4], size: [0.8, 1.2], grow: 2, life: [0.6, 0.9], colors: [0xffffff], alpha: 0.7, drag: 3 },
    ],
  },
  ducks: {
    tint: { flash: [2, 1.8, 0.8], ring: 0xffe080, light: 0xffd040 },
    flash: { colors: [0xffffff, 0xffe060] },
    bursts: [
      { frame: S.duck, count: 18, speed: [5, 10], up: 6, size: [0.4, 0.55], life: [1.2, 1.8], colors: [0xffffff], gravity: 14, drag: 0.6, spin: 6, hold: true },
      { frame: S.bubble, count: 14, speed: [2, 5], size: [0.2, 0.4], life: [0.8, 1.4], colors: [0xe0f8ff], gravity: -1, drag: 2 },
    ],
  },
  disco: {
    tint: { flash: [2, 1.6, 2.4], ring: 0xe0c0ff, light: 0xd090ff },
    flash: { colors: [0xffffff, 0xd090ff] },
    bursts: [
      { frame: S.disc, count: 1, speed: [0, 0], size: [1.2, 1.2], life: [1, 1], colors: [0xd8d8e0], spin: 4, hold: true, lift: 0.4 },
      { frame: S.streak, glow: true, count: 30, speed: [18, 26], size: [1.2, 1.6], life: [0.4, 0.6], colors: RAINBOW, drag: 0.5, lift: 0.4 },
      { frame: S.twinkle, glow: true, count: 30, speed: [4, 10], size: [0.2, 0.35], life: [0.6, 1.1], colors: RAINBOW, drag: 2, lift: 0.4 },
    ],
  },
  drumroll: {
    tint: { flash: [1.8, 1.4, 2.4], ring: 0xd0b0ff, light: 0xa060ff },
    flash: { colors: [0xffffff, 0xa060ff] },
    fireball: { count: 6, colors: [0xffd060, 0xa040ff], scale: 0.7 },
    bursts: [
      { frame: S.note, count: 16, speed: [3, 7], up: 3, size: [0.35, 0.5], life: [1, 1.5], colors: [0xa060ff, 0x40c0ff, 0xff60c0, 0xffffff], gravity: -0.8, drag: 2, spin: 2, hold: true },
      { frame: S.ring, glow: true, count: 1, speed: [0, 0], size: [1, 1], grow: 5, life: [0.4, 0.4], colors: [0xffe080], delay: 0.1 },
    ],
    rings: 2,
  },
  ice: {
    tint: { flash: [1.4, 2, 2.6], ring: 0xc0f0ff, light: 0x80d0ff },
    flash: { colors: [0xffffff, 0x80d0ff] },
    bursts: [
      { frame: S.shard, glow: true, count: 30, speed: [6, 14], up: 3, size: [0.25, 0.55], life: [0.9, 1.3], colors: [0xe0f8ff, 0xa0e0ff], gravity: 14, drag: 0.6, spin: 10, hold: true, delay: 0.12 },
      { frame: S.puff, count: 12, speed: [1, 4], size: [0.8, 1.4], grow: 2, life: [0.8, 1.2], colors: [0xe8f8ff], alpha: 0.7, drag: 3 },
      { frame: S.snowflake, count: 16, speed: [2, 6], size: [0.15, 0.3], life: [1, 1.6], colors: [0xffffff], gravity: 1, drag: 2.5, spin: 3, hold: true },
    ],
  },
  lava: {
    tint: { flash: [2, 1, 0.4], ring: 0xff8040, light: 0xff4000 },
    flash: { colors: [0xffe080, 0xff4000] },
    fireball: { count: 12, colors: [0xffa020, 0xc02000] },
    smoke: { count: 12, dark: 0x302020, light: 0x605048, alpha: 0.8, scale: 1 },
    bursts: [{ frame: S.blob, glow: true, count: 30, speed: [5, 11], up: 5, size: [0.2, 0.4], life: [1, 1.5], colors: [0xffd040, 0xff8020], fade: 0x401008, gravity: 16, drag: 0.5, hold: true }],
    decal: 0x401008,
  },
  dragon: {
    tint: { flash: [2.2, 1.2, 0.5], ring: 0xff8040, light: 0xff4000 },
    flash: { colors: [0xffe080, 0xff4000], size: 1.2 },
    fireball: { count: 16, colors: [0xffc030, 0xd02000] },
    bursts: [
      { frame: S.dragon, glow: true, count: 1, speed: [0, 0], size: [3.4, 3.4], grow: 1.3, life: [0.7, 0.7], colors: [0xffb030], fade: 0xff2000, hold: true, lift: 0.7 },
      { frame: S.dot, glow: true, count: 40, speed: [2, 5], up: 14, size: [0.5, 0.9], grow: 2, life: [0.4, 0.7], colors: [0xffe080, 0xff8020], fade: 0xc01000, drag: 2, delay: 0.1 },
      { frame: S.scale, count: 16, speed: [5, 10], up: 4, size: [0.3, 0.45], life: [0.8, 1.2], colors: [0xc02010, 0xe03010], gravity: 12, drag: 1, spin: 8, hold: true },
    ],
  },
  phoenix: {
    tint: { flash: [2.4, 1.6, 0.6], ring: 0xffc060, light: 0xff8000 },
    flash: { colors: [0xfff0c0, 0xff8000], size: 1.2 },
    fireball: { count: 12, colors: [0xffd040, 0xff4010] },
    bursts: [
      { frame: S.wings, glow: true, count: 1, speed: [0, 0], size: [2, 2], grow: 2.4, life: [0.9, 0.9], colors: [0xffd060], fade: 0xff3000, hold: true, lift: 0.6 },
      { frame: S.feather, glow: true, count: 30, speed: [4, 9], up: 4, size: [0.3, 0.5], life: [0.9, 1.5], colors: [0xffd040, 0xff8020, 0xff4010], fade: 0x601000, gravity: 0.5, drag: 2, spin: 3, delay: 0.15 },
    ],
  },
  galaxy: {
    tint: { flash: [1.6, 1, 2.6], ring: 0xc080ff, light: 0xa060ff },
    flash: { colors: [0xffffff, 0xa060ff] },
    bursts: [
      { frame: [S.twinkle, S.star, S.dot], glow: true, count: 70, speed: [1, 4], swirl: 9, flat: true, size: [0.12, 0.3], life: [1, 1.6], colors: [0xffffff, 0xd0a0ff, 0xa0c0ff], drag: 1.5 },
      { frame: S.dot, glow: true, count: 12, speed: [1, 3], swirl: 4, flat: true, size: [1.4, 2.2], grow: 1.6, life: [1.2, 1.6], colors: [0x8030ff, 0x3050ff, 0xff40c0], alpha: 0.45, drag: 1.5 },
    ],
  },
  ghost: {
    tint: { flash: [1, 2, 1.6], ring: 0x80ffd0, light: 0x60ffc0 },
    smoke: { count: 10, dark: 0x384848, light: 0x708888, alpha: 0.5, scale: 1 },
    bursts: [
      { frame: S.skull, count: 1, speed: [0, 0], up: 3, size: [2.2, 2.2], grow: 1.6, life: [1, 1], colors: [0xe0fff4], alpha: 0.85, lift: 0.3 },
      { frame: S.ghost, count: 8, speed: [3, 6], up: 3, size: [0.6, 0.9], grow: 1.3, life: [1, 1.6], colors: [0xe8fff8], alpha: 0.7, gravity: -1.2, drag: 2 },
    ],
  },
  origami: {
    tint: { flash: [1.8, 1.6, 1.4], ring: 0xffd0c0, light: 0xffb090 },
    flash: { colors: [0xffffff, 0xffb090] },
    bursts: [
      { frame: S.crane, count: 20, speed: [4, 9], up: 4, size: [0.45, 0.6], life: [1.4, 2.2], colors: [0xffffff, 0xff8060, 0x60c0ff, 0xffe060, 0xff60a0], gravity: -0.8, drag: 1.5, spin: 1, hold: true },
      { frame: S.confetti, count: 20, speed: [4, 8], size: [0.2, 0.3], life: [1, 1.5], colors: [0xffffff, 0xf8f0e0], gravity: 4, drag: 2.5, spin: 8, hold: true },
    ],
  },
  sakura: {
    tint: { flash: [2, 1.4, 1.6], ring: 0xffc0d8, light: 0xff90b0 },
    bursts: [
      { frame: S.petal, count: 90, speed: [3, 8], swirl: 5, up: 2, size: [0.15, 0.28], life: [1.6, 2.6], colors: [0xffb8cc, 0xff9ab8, 0xffe0ea], gravity: 0.6, drag: 2.5, spin: 5, hold: true },
      { frame: S.puff, count: 6, speed: [1, 3], size: [1, 1.4], grow: 2, life: [0.7, 1], colors: [0xffe0ec], alpha: 0.6, drag: 3 },
    ],
  },
  slime: {
    tint: { flash: [1, 2, 0.8], ring: 0x90ff60, light: 0x60e020 },
    bursts: [
      { frame: S.splat, count: 6, speed: [2, 5], size: [1, 1.4], grow: 1.3, life: [0.6, 0.9], colors: [0x60d020], drag: 4, hold: true },
      { frame: S.blob, count: 36, speed: [5, 11], up: 4, size: [0.2, 0.4], life: [1, 1.4], colors: [0x70e030, 0x50c020, 0x90f050], gravity: 14, drag: 1, hold: true },
    ],
    decal: 0x50b020,
  },
  divine: {
    tint: { flash: [2.6, 2.4, 1.8], ring: 0xfff0c0, light: 0xffe8a0 },
    flash: { colors: [0xffffff, 0xfff0b0], size: 1.2 },
    beam: [2.8, 2.4, 1.4],
    bursts: [
      { frame: [S.twinkle, S.dot], glow: true, count: 40, speed: [0.5, 2], up: 5, size: [0.12, 0.25], life: [1, 1.6], colors: [0xffffff, 0xfff0b0], drag: 1, scatter: 0.4 },
      { frame: S.feather, count: 14, speed: [2, 5], up: 2, size: [0.3, 0.45], life: [1.6, 2.4], colors: [0xffffff], gravity: 0.6, drag: 2.5, spin: 2, hold: true },
      { frame: S.ring, glow: true, count: 1, speed: [0, 0], size: [2, 2], grow: 2.5, life: [0.8, 0.8], colors: [0xfff0b0], lift: 2 },
    ],
  },
};
