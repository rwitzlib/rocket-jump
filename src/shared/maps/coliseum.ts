import type { BoxDef, DecorDef, MapDef, Vec3Tuple } from '../map';
import { block, box, decor, facingCenter, quad, ramp, turnBox, turnDecor, turnPos } from './helpers';

// Coliseum: a small torch-lit arena at night, sized for duels and small games. A raised dais in the
// middle, a ring of pillars around it carrying a square of beams to swing from, a balcony on each
// wall with a ramp up to it, and a stone block in every corner. Nowhere to hide for long.

const SAND = 0xc8b088;
const STONE = 0xb8a890;
const STONE_DARK = 0x8a7c68;
const WALL = 0x7a6e60;

const HALF = 30;
const BEAMS = 11;

const quarter: BoxDef[] = [
  // Steps up the dais on this side.
  ramp([0, 0, 9], [0, 2, 5], 4, 'steps', STONE),
  // Pillars: one under the beam, one on the diagonal.
  block(15, 0, 0, [2, BEAMS - 0.4, 2], 'carved', STONE),
  block(10.6, 0, 10.6, [2, 8, 2], 'carved', STONE),
  // The beam on this side of the square.
  box([0, BEAMS, 15], [32, 0.8, 0.8], 'stone', STONE_DARK),
  // A balcony against the wall, and its ramp.
  block(0, 0, 26, [24, 5, 6], 'stone', STONE_DARK, { top: { mat: 'tile', color: STONE } }),
  ramp([-20, 0, 26], [-12, 5, 26], 3, 'steps', STONE),
  // A block in the corner to stand on.
  block(25, 0, 25, [8, 3, 8], 'stone', STONE_DARK),
  // The wall.
  box([0, 6, HALF + 0.5], [HALF * 2 + 2, 12, 1], 'brick', WALL),
];

const boxes: BoxDef[] = [
  block(0, -1, 0, [HALF * 2, 1, HALF * 2], 'sand', SAND),
  block(0, 0, 0, [10, 2, 10], 'stone', STONE, { top: { mat: 'tile', color: 0xd8c8a8 } }),
  ...quad(quarter, turnBox),
];

const quarterDecor: DecorDef[] = [
  decor('torch', [5, 2, 4.6]),
  decor('torch', [29.4, 5, 20]),
  decor('banner', [0, 8, 29.95], { size: [3, 5, 0], yaw: Math.PI, color: 0xa83a3a }),
  decor('statue', [29, 3, 29], { scale: 0.8 }),
];

export const COLISEUM: MapDef = {
  title: 'Coliseum',
  blurb: 'A small torch-lit arena: made for duels. A dais, pillars, beams and four balconies.',
  theme: 'night',
  fragLimit: 15,
  boxes,
  crates: quad<Vec3Tuple>([[18, 0.6, 6]], turnPos),
  spawns: quad([facingCenter([25, 4, 25]), facingCenter([8, 1, 22])], (s, k) => facingCenter(turnPos(s.pos, k))),
  pickups: [[0, 3.4, 0], ...quad<Vec3Tuple>([[0, 6.4, 26]], turnPos)],
  items: [
    ...quad<Vec3Tuple>([[20, 0, 8]], turnPos).map((pos) => ({ kind: 'health' as const, pos })),
    { kind: 'armor', pos: [26, 3, 26] },
    { kind: 'armor', pos: [-26, 3, -26] },
    { kind: 'overdrive', pos: [0, BEAMS + 0.4, 15] },
  ],
  flags: [[0, 0, 20], [0, 0, -20]],
  hills: [[0, 2, 0], [0, 5, 26], [0, 5, -26], [26, 5, 0], [-26, 5, 0]],
  race: {
    start: [8, 1, 20],
    rings: [[0, 2.5, 20], [0, 7.5, 26], [15, BEAMS + 2.5, 0], [0, 4.5, 0], [-26, 5, -26]],
  },
  killY: -20,
  botOrbit: 16,
  decor: [
    ...quad(quarterDecor, turnDecor),
    decor('mountains', [0, -10, 0], { size: [260, 70, 0], color: 0x3a3a50 }),
  ],
};
