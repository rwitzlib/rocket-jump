import type { BoxDef, DecorDef, MapDef, MoverDef, Vec3Tuple } from '../map';
import { block, decor, facingCenter, floatingRockSolids, quad, ramp, turnBox, turnDecor, turnPos } from './helpers';

// Skyreach: floating islands above a sea of clouds at sunset. A big central island under crossed
// stone arches, four outer islands on plank bridges (each with a ruined watchtower) linked in a ring
// by long bridges round the outside, and four high crystal perches in the corners that only a
// rocket jump or a grapple reaches. Falling off is falling
// off: down through the clouds.

const GRASS = 0x86b85a;
const EARTH = 0x9a7058;
const STONE = 0xd2c2a8;
const STONE_DARK = 0xa8987e;
const PLANK = 0xa07a52;
const TOWER = 0xc8b49a;

const C_HALF = 22; // central island half-width
const O_TOP = 4; // outer island ground
const O_Z = 60; // outer island center
const PERCH_TOP = 14;
const LIFT = 0.06; // bridges' tops above the ground they rest on

const quarter: BoxDef[] = [
  // Outer island, a bit higher than the middle.
  block(0, O_TOP - 6, O_Z, [30, 6, 26], 'dirt', EARTH, { top: { mat: 'grass', color: GRASS } }),
  // Its watchtower: a stone keep with a deck and a broken parapet.
  block(9, O_TOP, 66, [8, 14, 8], 'stone', TOWER, { top: { mat: 'tile', color: STONE_DARK } }),
  block(9, O_TOP + 14, 66, [10, 0.8, 10], 'stone', STONE_DARK, { top: { mat: 'plank', color: PLANK } }),
  block(4.4, O_TOP + 14.8, 66, [0.8, 1.6, 10], 'stone', STONE),
  block(9, O_TOP + 14.8, 70.6, [6, 1.6, 0.8], 'stone', STONE),
  // A doorway arch on the island to duck through.
  block(-9, O_TOP, 54, [1.6, 6, 1.6], 'stone', STONE),
  block(-3, O_TOP, 54, [1.6, 6, 1.6], 'stone', STONE),
  block(-6, O_TOP + 6, 54, [8, 1.4, 2], 'carved', STONE_DARK),
  // Low cover walls.
  block(-8, O_TOP, 66, [6, 1.6, 1.2], 'stone', STONE_DARK),
  // The plank bridge from the middle, with solid rails. Bridges sit a hair above the ground they
  // overlap so their planks don't flicker against the grass.
  ramp([0, LIFT, C_HALF - 0.5], [0, O_TOP + LIFT, O_Z - 12.5], 4, 'plank', PLANK, 0.5),
  ramp([-2.1, 0.9 + LIFT, C_HALF - 0.5], [-2.1, O_TOP + 0.9 + LIFT, O_Z - 12.5], 0.2, 'plank', 0x7a5a3a, 0.9),
  ramp([2.1, 0.9 + LIFT, C_HALF - 0.5], [2.1, O_TOP + 0.9 + LIFT, O_Z - 12.5], 0.2, 'plank', 0x7a5a3a, 0.9),
  // A long flat bridge round the outside to the next island, so the islands make a ring. It runs
  // diagonally, so its ends reach well into each island to leave no corner hanging off the edge;
  // the rails stop at the island edges.
  ramp([13, O_TOP + LIFT, 57], [57, O_TOP + LIFT, 13], 4, 'plank', PLANK, 0.5),
  ramp([15, O_TOP + 0.9 + LIFT, 52.2], [52.2, O_TOP + 0.9 + LIFT, 15], 0.2, 'plank', 0x7a5a3a, 0.9),
  ramp([15, O_TOP + 0.9 + LIFT, 57.8], [57.8, O_TOP + 0.9 + LIFT, 15], 0.2, 'plank', 0x7a5a3a, 0.9),
  // A high crystal perch in the corner.
  block(52, PERCH_TOP - 4, 52, [14, 4, 14], 'dirt', EARTH, { top: { mat: 'grass', color: GRASS } }),
  block(56, PERCH_TOP, 56, [3, 6, 3], 'rock', 0x8a7a8a),
  // The rock hanging under each island is solid: grapple it to climb back up after a fall.
  ...floatingRockSolids([0, O_TOP - 6, O_Z], [30, 26, 26]),
  ...floatingRockSolids([52, PERCH_TOP - 4, 52], [14, 16, 14]),
];

const boxes: BoxDef[] = [
  // The central island.
  block(0, -6, 0, [C_HALF * 2, 6, C_HALF * 2], 'dirt', EARTH, { top: { mat: 'grass', color: GRASS } }),
  block(0, 0, 0, [12, 1.2, 12], 'stone', STONE_DARK, { top: { mat: 'tile', color: STONE } }),
  // Crossed arches over it: four pillars, two beams to stand on and swing from.
  ...quad([block(10, 0, 0, [2.4, 16, 2.4], 'stone', STONE)], turnBox),
  block(0, 16, 0, [22.4, 2, 2.6], 'carved', STONE_DARK),
  block(0, 18, 0, [2.6, 2, 22.4], 'carved', STONE_DARK),
  // Broken walls on the central island for cover.
  ...quad([block(14, 0, 10, [1.2, 2.4, 6], 'stone', STONE_DARK), block(-15, 0, 15, [4, 1.2, 1.2], 'stone', STONE)], turnBox),
  ...quad(quarter, turnBox),
  ...floatingRockSolids([0, -6, 0], [44, 34, 44]),
];

// The stone ring high over the middle, turning slowly and bobbing, with glowing runes round it:
// one solid piece, so you can walk right round it as it carries you, grapple it or bounce rockets
// off it.
const HALO_RADIUS = 16;
const halo: MoverDef = {
  pivot: [0, 34, 0],
  spin: 0.08,
  bob: [0.8, 0.5],
  boxes: [],
  rings: [{ pos: [0, 0, 0], radius: HALO_RADIUS, width: 1.2, height: 1.6, mat: 'stone', color: 0x8a7a9a }],
  decor: [decor('runes', [0, 0, 0], { size: [HALO_RADIUS, 0, 0], color: 0x9af0ff })],
};

const crates: Vec3Tuple[] = quad<Vec3Tuple>(
  [
    [-10, O_TOP + 0.6, 62], [-8.8, O_TOP + 0.6, 62],
    [8, 0.6, -16],
  ],
  turnPos,
);

const quarterDecor: DecorDef[] = [
  decor('floatingRock', [0, O_TOP - 6, O_Z], { size: [30, 26, 26] }),
  decor('floatingRock', [52, PERCH_TOP - 4, 52], { size: [14, 16, 14], color: 0x8a6a6a }),
  decor('crystal', [50, PERCH_TOP, 50], { color: 0x7ae8ff, scale: 1.3 }),
  decor('crystal', [-12, O_TOP, 70], { color: 0xff7ae0 }),
  decor('pine', [12, O_TOP, 54], { color: 0x3f7a5a }),
  decor('pine', [-11, O_TOP, 50], { scale: 0.8, color: 0x3f7a5a }),
  decor('tree', [-4, O_TOP, 69], { scale: 0.9, color: 0x6aa04a }),
  decor('grass', [0, O_TOP, 60], { size: [26, 0, 20], color: 0x7ab05a }),
  decor('flowers', [-6, O_TOP, 64], { size: [8, 0, 6] }),
  decor('torch', [-3, O_TOP, O_Z - 12.4]),
  decor('torch', [3, O_TOP, O_Z - 12.4]),
  decor('torch', [-3, 0, C_HALF - 0.6]),
  decor('torch', [17, O_TOP, 50.5]),
  decor('torch', [50.5, O_TOP, 17]),
  decor('torch', [3, 0, C_HALF - 0.6]),
  decor('banner', [9, O_TOP + 14, 61.95], { size: [2.2, 4, 0], yaw: Math.PI, color: 0x5a3aa8 }),
  decor('vines', [9, O_TOP + 12, 70.05], { size: [6, 6, 0] }),
  decor('bush', [16, 0, -18]),
  decor('rock', [-18, 0, 18], { size: [2.4, 1.4, 2] }),
  decor('grass', [12, 0, 12], { size: [14, 0, 14], color: 0x7ab05a }),
];

export const SKYREACH: MapDef = {
  title: 'Skyreach',
  blurb: 'Floating islands above the clouds at sunset. Bridges, perches and a very long way down.',
  theme: 'dusk',
  fragLimit: 20,
  boxes,
  crates,
  spawns: quad([facingCenter([-8, O_TOP + 1, 60]), facingCenter([6, O_TOP + 1, 52])], (s, k) => facingCenter(turnPos(s.pos, k))),
  pickups: [[0, 2.5, 0], ...quad<Vec3Tuple>([[52, PERCH_TOP + 1.3, 52]], turnPos)],
  items: [
    ...quad<Vec3Tuple>([[8, 0, -8]], turnPos).map((pos) => ({ kind: 'health' as const, pos })),
    { kind: 'armor', pos: [10, O_TOP + 14.8, 64] },
    { kind: 'armor', pos: [-10, O_TOP + 14.8, -64] },
    { kind: 'overdrive', pos: [0, 20, 6] }, // on top of the crossed arches
  ],
  flags: [[-1, O_TOP, 62], [1, O_TOP, -62]],
  // Out to a crystal perch, over the arches, the far perch, a watchtower, and back round the bridges.
  race: {
    start: [-8, O_TOP + 1, 60],
    rings: [[-4, O_TOP + 2.5, 50], [52, PERCH_TOP + 2, 52], [0, 21.5, 0], [-52, PERCH_TOP + 2, -52], [-9, O_TOP + 16.5, -66]],
  },
  // Deep, so a fall leaves about three seconds to grapple the rocks or a bridge and climb back.
  killY: -100,
  botOrbit: 57,
  movers: [halo],
  decor: [
    ...quad(quarterDecor, turnDecor),
    decor('floatingRock', [0, -6, 0], { size: [44, 34, 44] }),
    decor('crystal', [0, 1.2, 0], { color: 0xffd27a, scale: 1.1 }),
    decor('cloudSea', [0, -75, 0], { size: [340, 0, 60] }),
    decor('skyIslands', [0, -5, 0], { size: [240, 70, 0] }),
    decor('mountains', [0, -110, 0], { size: [430, 190, 0], color: 0x7a6a8a }),
    decor('balloon', [-120, 40, -150], { color: 0xe0503a }),
    decor('balloon', [170, 25, 60], { color: 0x3a8ad9, scale: 1.2 }),
    decor('balloon', [40, 60, 200], { color: 0x4cae5a, scale: 0.9 }),
    decor('gull', [0, 30, 0]),
  ],
};
