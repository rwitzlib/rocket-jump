import type { BoxDef, DecorDef, MapDef, Vec3Tuple } from '../map';
import { block, box, decor, pair, ramp, turnBox, turnDecor, turnPos } from './helpers';

// Canyon: a long red-rock canyon at midday, built for vehicles. Each team's base sits on a plateau
// at one end, with a ramp down to the canyon floor, two buggies and a helicopter. Between them: flat
// mesas to fight from, a rock spire in the middle (overdrive on top), and a stone arch over the
// canyon at each end of the middle stretch to swing from or fly under. Two-way symmetric.

const SAND = 0xd8a878;
const ROCK = 0xb06a48;
const ROCK_DARK = 0x8a4e36;
const MESA_TOP = 0xc89a68;
const BASE = 0xa8a090;

const LENGTH = 160; // half the canyon's length
const WIDTH = 42; // half its width, to the cliff faces
const BASE_X = 130;
const BASE_TOP = 6;

const half: BoxDef[] = [
  // A cliff wall along one side, with ledges to stand on.
  block(0, 0, WIDTH + 5, [LENGTH * 2, 32, 10], 'rock', ROCK, { top: { mat: 'sand', color: MESA_TOP } }),
  block(60, 0, WIDTH - 2, [30, 12, 6], 'rock', ROCK_DARK, { top: { mat: 'sand', color: MESA_TOP } }),
  block(110, 0, WIDTH - 2.5, [20, 18, 7], 'rock', ROCK_DARK, { top: { mat: 'sand', color: MESA_TOP } }),
  // The end wall behind this base.
  block(LENGTH - 2, 0, 0, [10, 32, WIDTH * 2 + 20], 'rock', ROCK),
  // The base: a plateau with a ramp down, a wall at its back edge and a bit of cover.
  block(BASE_X + 4, 0, 0, [32, BASE_TOP, 34], 'concrete', BASE, { top: { mat: 'tile', color: 0xc0b8a8 } }),
  ramp([104, 0, 10], [118, BASE_TOP, 10], 7, 'concrete', BASE, 0.6),
  ramp([104, 0, -10], [118, BASE_TOP, -10], 7, 'concrete', BASE, 0.6),
  block(BASE_X + 6, BASE_TOP, 12, [8, 3, 2], 'container', 0xb05a3a),
  // Mesas.
  block(60, 0, -12, [18, 14, 14], 'rock', ROCK, { top: { mat: 'sand', color: MESA_TOP } }),
  block(20, 0, 14, [14, 10, 12], 'rock', ROCK_DARK, { top: { mat: 'sand', color: MESA_TOP } }),
  // An arch over the canyon: two legs and a span.
  block(90, 0, 24, [5, 20, 5], 'rock', ROCK),
  block(90, 0, -24, [5, 20, 5], 'rock', ROCK),
  box([90, 22, 0], [5, 4, 54], 'rock', ROCK_DARK),
  // Boulders for cover.
  block(40, 0, -26, [5, 3, 4], 'rock', ROCK_DARK),
  block(76, 0, 8, [4, 2.5, 6], 'rock', ROCK_DARK),
];

const boxes: BoxDef[] = [
  block(0, -1, 0, [LENGTH * 2, 1, WIDTH * 2 + 20], 'sand', SAND),
  ...pair(half, turnBox),
  // The spire in the middle.
  block(0, 0, 0, [6, 18, 6], 'rock', ROCK, { top: { mat: 'sand', color: MESA_TOP } }),
];

const halfDecor: DecorDef[] = [
  decor('rock', [70, 0, -30], { size: [4, 2, 3] }),
  decor('rock', [30, 0, 30], { size: [3, 1.6, 3] }),
  decor('cone', [112, 0, 18]),
  decor('cone', [112, 0, -18]),
  decor('flag', [BASE_X + 12, BASE_TOP, 14], { color: 0xd94a3a }),
];

export const CANYON: MapDef = {
  title: 'Canyon',
  blurb: 'A long red-rock canyon built for vehicles: buggies and helicopters at each base, mesas and arches between.',
  theme: 'desert',
  fragLimit: 20,
  boxes,
  crates: pair<Vec3Tuple>([[BASE_X - 2, BASE_TOP + 0.6, -12], [BASE_X - 0.7, BASE_TOP + 0.6, -12], [50, 0.6, 20]], turnPos),
  spawns: pair(
    [
      { pos: [126, BASE_TOP + 1, 8] as Vec3Tuple, yaw: Math.PI / 2 },
      { pos: [126, BASE_TOP + 1, -8] as Vec3Tuple, yaw: Math.PI / 2 },
      { pos: [100, 1, -28] as Vec3Tuple, yaw: Math.PI / 2 },
      { pos: [40, 1, 28] as Vec3Tuple, yaw: Math.PI / 2 },
    ],
    (s, k) => ({ pos: turnPos(s.pos, k), yaw: s.yaw + (k * Math.PI) / 2 }),
  ),
  pickups: [[0, 1.4, 12], [0, 1.4, -12], ...pair<Vec3Tuple>([[60, 15.4, -12], [20, 11.4, 14]], turnPos)],
  items: [
    ...pair<Vec3Tuple>([[70, 0, 20], [BASE_X + 10, BASE_TOP, -4]], turnPos).map((pos) => ({ kind: 'health' as const, pos })),
    { kind: 'armor', pos: [60, 14, -8] },
    { kind: 'armor', pos: [-60, 14, 8] },
    { kind: 'overdrive', pos: [0, 18, 0] },
  ],
  flags: [[BASE_X + 4, BASE_TOP, 0], [-BASE_X - 4, BASE_TOP, 0]],
  hills: [[0, 0, 22], [60, 14, -12], [-60, 14, 12], [0, 0, -22]],
  race: {
    start: [126, BASE_TOP + 1, 0],
    rings: [[115, 8.5, 0], [60, 16.5, -12], [0, 21, 0], [-60, 16.5, 12], [-90, 26.5, 0], [-20, 12.5, -14]],
  },
  vehicles: pair(
    [
      { kind: 'car' as const, pos: [100, 0.7, 20] as Vec3Tuple, yaw: Math.PI / 2 },
      { kind: 'car' as const, pos: [100, 0.7, -20] as Vec3Tuple, yaw: Math.PI / 2 },
      { kind: 'heli' as const, pos: [BASE_X + 8, BASE_TOP + 1.2, 0] as Vec3Tuple, yaw: Math.PI / 2 },
    ],
    (v, k) => ({ ...v, pos: turnPos(v.pos, k), yaw: v.yaw + (k * Math.PI) / 2 }),
  ),
  killY: -20,
  botOrbit: 60,
  decor: [
    ...pair(halfDecor, turnDecor),
    decor('mountains', [0, -10, 0], { size: [420, 120, 0], color: 0xb07050 }),
  ],
};
