import type { BoxDef, DecorDef, MapDef, Vec3Tuple } from '../map';
import { block, box, decor, facingCenter, quad, ramp, solid, turnBox, turnDecor, turnPos } from './helpers';

// Sunken Temple: a stepped pyramid in a jungle basin, late in a golden afternoon. Grand stairs climb
// all four sides to a shrine on top; a ring of columns (half of them still holding their lintels)
// circles it, and in each corner stands a ruined gatehouse with a roof to fight from. Cliffs close it
// in: giant stone heads stare out of two of them, waterfalls pour down the other two.

const CLIFF = 0x8e7f68;
const CLIFF_TOP = 0x5f9a42;
const STONE = 0xcbb68c;
const STONE_DARK = 0xa8946c;
const PAVING = 0xbca983;
const STEPS = 0xc4b089;
const GRASS = 0x6aa84a;
const COPPER = 0x5fa08a;

const T1 = 4; // pyramid tier tops
const T2 = 8;
const T3 = 12;

// --- One quarter of the map, turned four ways --------------------------------------------------

// Cliffs along the +Z edge: uneven blocks of rock with grassy tops, some with a ledge in front.
const cliffs: BoxDef[] = [
  { x: -52, w: 26, h: 24, off: 0 },
  { x: -27, w: 24, h: 31, off: -1.5 },
  { x: 0, w: 30, h: 27, off: 0.8 },
  { x: 27, w: 24, h: 33, off: -1 },
  { x: 52, w: 26, h: 25, off: 0.5 },
].flatMap(({ x, w, h, off }) => [block(x, 0, 73 + off, [w, h, 12], 'rock', CLIFF, { top: { mat: 'grass', color: CLIFF_TOP } })]);
const ledges: BoxDef[] = [
  block(-40, 0, 65.5, [10, 6, 3], 'rock', CLIFF, { top: { mat: 'grass', color: CLIFF_TOP } }),
  block(38, 0, 65, [8, 9, 4], 'rock', CLIFF, { top: { mat: 'grass', color: CLIFF_TOP } }),
];

// The grand stair up the +Z face: a solid wedge of steps from the ground to the top tier, with a
// balustrade wall either side.
const stair: BoxDef[] = [
  ramp([0, 0, 33], [0, T3, 8], 6, 'steps', STEPS, 6),
  ramp([-3.6, 1, 33], [-3.6, T3 + 1, 8], 1.2, 'stone', STONE_DARK, 7),
  ramp([3.6, 1, 33], [3.6, T3 + 1, 8], 1.2, 'stone', STONE_DARK, 7),
];

// A ruined gatehouse in the (+X, +Z) corner: two walls in an L with a doorway, holding up a roof.
const gatehouse: BoxDef[] = [
  block(53, 0, 40.5, [2.4, 10, 7], 'stone', STONE),
  block(53, 0, 51.5, [2.4, 10, 7], 'stone', STONE),
  block(53, 6.5, 46, [2.4, 3.5, 4], 'carved', STONE_DARK), // lintel over the doorway
  block(46, 0, 53, [16, 10, 2.4], 'carved', STONE),
  block(48, 10, 48, [11, 1, 11], 'stone', STONE_DARK, { top: { mat: 'tile', color: PAVING } }),
  // Steps up its inside wall to the roof.
  ramp([27, 0, 50.2], [42.6, 11, 50.2], 3.2, 'steps', STEPS, 4),
  // Rubble in front.
  block(38, 0, 38, [3, 1.2, 2], 'stone', STONE_DARK),
];

const quarter: BoxDef[] = [...cliffs, ...ledges, ...stair, ...gatehouse];

// --- Columns ------------------------------------------------------------------------------------

const COLUMN_R = 38;
const columns: BoxDef[] = [];
const columnTops: Vec3Tuple[] = [];
for (let k = 0; k < 12; k++) {
  const a = ((15 + k * 30) * Math.PI) / 180;
  const x = Math.sin(a) * COLUMN_R;
  const z = Math.cos(a) * COLUMN_R;
  const broken = k % 4 === 3; // every fourth one has toppled
  columns.push(block(x, 0, z, [2.8, 0.6, 2.8], 'stone', STONE_DARK));
  columns.push(block(x, 0.6, z, [1.8, broken ? 3.4 : 7, 1.8], 'stone', STONE));
  if (!broken) columns.push(block(x, 7.6, z, [2.8, 0.9, 2.8], 'carved', STONE_DARK));
  columnTops.push([x, broken ? -1 : 8.5, z]);
}
// Lintels across pairs of standing columns: walkways in the air.
for (let k = 0; k < 12; k += 2) {
  const [a, b] = [columnTops[k], columnTops[k + 1]];
  if (a[1] < 0 || b[1] < 0) continue;
  columns.push(ramp([a[0], 9.6, a[2]], [b[0], 9.6, b[2]], 2.2, 'carved', STONE_DARK, 1.1));
}
// A toppled column lying in the grass by each broken one.
for (let k = 3; k < 12; k += 4) {
  const a = ((15 + k * 30 + 9) * Math.PI) / 180;
  columns.push(box([Math.sin(a) * (COLUMN_R + 3), 0.9, Math.cos(a) * (COLUMN_R + 3)], [1.8, 1.8, 6], 'stone', STONE, { rot: [0, a + 0.4, 0] }));
}

const boxes: BoxDef[] = [
  // The basin floor, with ground running on out beyond the cliffs for the jungle.
  box([0, -2, 0], [260, 4, 260], 'dirt', 0x7a5e40, { top: { mat: 'grass', color: GRASS } }),
  // Invisible walls just behind the cliffs, so nobody wanders off into the trees.
  ...quad([solid([0, 50, 80], [170, 100, 2])], turnBox),

  // The pyramid.
  block(0, 0, 0, [36, T1, 36], 'stone', STONE, { top: { mat: 'tile', color: PAVING } }),
  block(0, T1, 0, [26, T2 - T1, 26], 'stone', STONE, { top: { mat: 'tile', color: PAVING } }),
  block(0, T2, 0, [16, T3 - T2, 16], 'carved', STONE, { top: { mat: 'tile', color: PAVING } }),
  // The shrine on top: four pillars under a green copper roof.
  ...quad([block(4.6, T3, 4.6, [1.8, 6, 1.8], 'stone', STONE)], turnBox),
  block(0, T3 + 6, 0, [12.5, 1.4, 12.5], 'carved', STONE_DARK, { top: { mat: 'roof', color: COPPER } }),
  block(0, T3 + 7.4, 0, [7, 1.6, 7], 'stone', STONE_DARK, { top: { mat: 'roof', color: COPPER } }),
  block(0, T3 + 9, 0, [2.5, 2, 2.5], 'carved', 0xd8b860), // gilded cap
  block(0, T3, 0, [3, 0.8, 3], 'carved', STONE_DARK), // altar

  // Corner blocks where the cliffs meet.
  ...quad([block(72, 0, 72, [16, 30, 16], 'rock', CLIFF, { top: { mat: 'grass', color: CLIFF_TOP } })], turnBox),
  ...quad(quarter, turnBox),
  ...columns,

  // The statue heads' solid cores (the faces themselves are scenery).
  solid([0, 8.5, -64.5], [14.5, 17, 11]),
  solid([0, 8.5, 64.5], [14.5, 17, 11]),
  // Waterfall pools' stone rims (low enough to walk over).
  ...[-1, 1].flatMap((side) => [
    block(side * 59, 0, -8, [14, 0.4, 1], 'stone', STONE_DARK),
    block(side * 59, 0, 8, [14, 0.4, 1], 'stone', STONE_DARK),
    block(side * 52.5, 0, 0, [1, 0.4, 17], 'stone', STONE_DARK),
  ]),
  // Trunks of the big trees inside the basin.
  ...quad([solid([30, 4, 56], [1.6, 8, 1.6])], turnBox),
];

const crates: Vec3Tuple[] = quad<Vec3Tuple>(
  [
    [22, 0.6, 26], [23.3, 0.6, 26], [22.6, 1.8, 26],
    [46, 11.6, 46],
  ],
  turnPos,
);

// --- Scenery ------------------------------------------------------------------------------------

// Jungle beyond the cliffs: a ring of trees and palms on the ground outside.
const jungle: DecorDef[] = [];
for (let k = 0; k < 64; k++) {
  const a = (k / 64) * Math.PI * 2;
  const r = 86 + ((k * 37) % 23);
  jungle.push(decor(k % 3 === 0 ? 'palm' : 'tree', [Math.cos(a) * r, 0, Math.sin(a) * r], { scale: 1.6 + ((k * 13) % 7) * 0.12, color: k % 2 ? 0x4f9a42 : 0x3f8a3a }));
}
// Trees growing on the cliff tops.
const cliffTrees: DecorDef[] = quad(
  [
    decor('tree', [-40, 24, 76], { scale: 1.2 }),
    decor('palm', [-14, 31, 74], { scale: 1.1 }),
    decor('tree', [18, 33, 75], { scale: 1.3, color: 0x3f8a3a }),
    decor('bush', [44, 25, 70]),
    decor('bush', [-26, 31, 70]),
  ],
  turnDecor,
);

const quarterDecor: DecorDef[] = [
  // Torches either side of the stair foot, and on the corners of the top tier.
  decor('torch', [-5.6, 0, 34]),
  decor('torch', [5.6, 0, 34]),
  decor('torch', [7.2, T3, 7.2]),
  // Banners hanging down the second tier either side of the stair.
  decor('banner', [-8.5, T2, 13.08], { size: [2.4, 3.8, 0], color: 0xb8402e }),
  decor('banner', [8.5, T2, 13.08], { size: [2.4, 3.8, 0], color: 0xb8402e }),
  decor('banner', [-12, T1, 18.08], { size: [2.2, 3.4, 0], color: 0x2e6ab8 }),
  decor('banner', [12, T1, 18.08], { size: [2.2, 3.4, 0], color: 0x2e6ab8 }),
  // The gatehouse: vines over its outer walls, a torch at its door.
  decor('vines', [46, 10, 54.25], { size: [14, 6, 0] }),
  decor('vines', [54.25, 10, 46], { size: [12, 7, 0], yaw: Math.PI / 2 }),
  decor('torch', [51, 0, 42.5]),
  // Vines down the cliff faces.
  decor('vines', [-27, 31, 65.7], { size: [12, 14, 0], yaw: Math.PI }),
  decor('vines', [27, 33, 66.3], { size: [10, 18, 0], yaw: Math.PI }),
  decor('vines', [-52, 24, 66.9], { size: [10, 10, 0], yaw: Math.PI }),
  // Undergrowth along the cliff foot.
  decor('bush', [-60, 0, 62]),
  decor('bush', [-16, 0, 64]),
  decor('bush', [12, 0, 63]),
  decor('bush', [60, 0, 60]),
  decor('grass', [-30, 0, 60], { size: [30, 0, 8] }),
  decor('grass', [20, 0, 58], { size: [24, 0, 10] }),
  decor('flowers', [44, 0, 30], { size: [10, 0, 8] }),
  decor('grass', [26, 0, 40], { size: [12, 0, 12] }),
  decor('rock', [16, 0, 48], { size: [3, 2, 2.5] }),
  decor('rock', [-46, 0, 52], { size: [4, 2.6, 3] }),
  decor('rock', [64, 0, 36], { size: [2.5, 1.5, 2] }),
  // The big tree inside the basin (its trunk is solid).
  decor('tree', [30, 0, 56], { scale: 1.9, color: 0x4a9440 }),
  // A worn dirt path from the cliffs to the stair.
  decor('stripe', [0, 0, 50], { size: [7, 0, 34], color: 0xa88a62 }),
  // Paving round the foot of the pyramid.
  decor('stripe', [0, 0, 24], { size: [46, 0, 12], color: 0xc4b48e }),
];

export const TEMPLE: MapDef = {
  title: 'Sunken Temple',
  blurb: 'Golden-hour jungle ruins round a stepped pyramid: stairs, columns and a shrine on top.',
  theme: 'jungle',
  fragLimit: 20,
  boxes,
  crates,
  spawns: quad([facingCenter([24, 1, 60]), facingCenter([-24, 1, 60])], (s, k) => facingCenter(turnPos(s.pos, k))),
  pickups: [[0, T3 + 2.1, 0], ...quad<Vec3Tuple>([[48, 12.3, 48]], turnPos)],
  items: [
    ...quad<Vec3Tuple>([[15, T1, 15]], turnPos).map((pos) => ({ kind: 'health' as const, pos })),
    { kind: 'armor', pos: [51, 11, 45] },
    { kind: 'armor', pos: [-51, 11, -45] },
    { kind: 'overdrive', pos: [5, T3 + 7.4, 5] }, // on the shrine's lower roof
  ],
  // In front of the two stone heads.
  flags: [[0, 0, 52], [0, 0, -52]],
  // Over a lintel, through the shrine, a gatehouse roof, then the top of a cliff.
  race: {
    start: [24, 1, 60],
    rings: [[22, 2.5, 50], [18.4, 11.5, 31.8], [0, 14, 0], [48, 12.5, -48], [72, 35, -27]],
  },
  killY: -30,
  botOrbit: 46,
  decor: [
    ...quad(quarterDecor, turnDecor),
    ...jungle,
    ...cliffTrees,
    decor('mountains', [0, 0, 0], { size: [330, 90, 0], color: 0x4f7a48 }),
    // Stone heads staring out of the north and south cliffs.
    decor('statue', [0, 0, -63], { scale: 2.3 }),
    decor('statue', [0, 0, 63], { scale: 2.3, yaw: Math.PI }),
    // Waterfalls down the east and west cliffs into pools.
    decor('waterfall', [66.6, 27, 0], { size: [9, 27, 0], yaw: -Math.PI / 2 }),
    decor('waterfall', [-66.6, 27, 0], { size: [9, 27, 0], yaw: Math.PI / 2 }),
    decor('water', [59, 0.06, 0], { size: [13, 0, 15], color: 0x2a9aa0 }),
    decor('water', [-59, 0.06, 0], { size: [13, 0, 15], color: 0x2a9aa0 }),
  ],
};
