import type { BoxDef, DecorDef, MapDef, Vec3Tuple } from '../map';
import { block, box, container, decor, facingCenter, ramp } from './helpers';

// Dockyard: a 160 m quay on a bright harbor morning. Warehouses wall off the north side (their roofs
// are fair game), the rest drops into the sea. Shipping containers stand in blocks of uneven stacks
// with lanes between them and a stepped pile in the middle; two cranes tower over it all, their
// girders the best grapple lines on the map, and the big crane's boom runs right out over the water.

const HALF = 80;
const SEA = -2.5; // water surface

const RED = 0xc8442f;
const BLUE = 0x2f6fb8;
const GREEN = 0x3f9a4f;
const YELLOW = 0xe0a92e;
const ORANGE = 0xe0702e;
const TEAL = 0x2a9a9a;
const WHITE = 0xe8e8e2;
const MAROON = 0x8a2e3a;
const PALETTE = [RED, BLUE, GREEN, YELLOW, ORANGE, TEAL, WHITE, MAROON, BLUE, RED];
const QUAY = 0xc9c3b6;
const CRANE = 0xf0a81e;
const CRANE2 = 0xd0473a;
const BRICK = 0xb0583e;
const CREAM = 0xe6dcc8;
const ROOF_METAL = 0x7d8790;
const STEEL = 0x6a7480;

/**
 * A block of container stacks: `heights[row][col]` containers high (0 for a gap), lying along X
 * (columns 12.4 m apart, rows 2.6 m apart) or along Z (the same, turned).
 */
function yard(cx: number, cz: number, along: 'x' | 'z', heights: number[][], seed: number): BoxDef[] {
  const out: BoxDef[] = [];
  const rows = heights.length;
  const cols = heights[0].length;
  heights.forEach((row, r) =>
    row.forEach((h, c) => {
      const u = (c - (cols - 1) / 2) * 12.4;
      const v = (r - (rows - 1) / 2) * 2.62;
      const [x, z] = along === 'x' ? [cx + u, cz + v] : [cx + v, cz + u];
      for (let level = 0; level < h; level++) out.push(container(x, z, level, along, PALETTE[(seed + r * 3 + c * 7 + level * 5) % PALETTE.length]));
    }),
  );
  return out;
}

const boxes: BoxDef[] = [
  // The quay: a deep concrete slab whose sides run down into the water.
  box([0, -3, 0], [HALF * 2, 6, HALF * 2], 'concrete', QUAY),
  // A timber jetty off the south side.
  box([-40, -0.3, HALF + 15], [8, 0.6, 30], 'plank', 0xa88a64),
  // Painted curbs along the water's edge.
  box([0, 0.15, HALF - 0.25], [HALF * 2, 0.3, 0.5], 'hazard', 0xffffff),
  box([HALF - 0.25, 0.15, -10], [0.5, 0.3, HALF * 2 - 20], 'hazard', 0xffffff),
  box([-HALF + 0.25, 0.15, -10], [0.5, 0.3, HALF * 2 - 20], 'hazard', 0xffffff),

  // --- North side: two warehouses and the harbor office between them --------------------------
  block(-47, 0, -68, [66, 16, 24], 'brick', BRICK, { top: { mat: 'metal', color: ROOF_METAL } }),
  block(-47, 16, -68, [67, 0.5, 25], 'concrete', CREAM), // cornice
  block(47, 0, -66, [66, 12, 28], 'container', 0x4f86b8, { top: { mat: 'metal', color: ROOF_METAL } }),
  block(47, 12, -66, [67, 0.5, 29], 'concrete', 0xd8dde2),
  // Rooftop clutter: vents and AC units to hide behind.
  block(-60, 16.5, -72, [4, 2, 4], 'metal', 0x9aa2aa),
  block(-36, 16.5, -64, [6, 1.6, 3], 'metal', 0x9aa2aa),
  block(-22, 16.5, -74, [3, 1.2, 3], 'metal', 0x9aa2aa),
  block(36, 12.5, -70, [5, 2.2, 5], 'metal', 0x9aa2aa),
  block(62, 12.5, -60, [3, 1.4, 8], 'metal', 0x9aa2aa),
  // Roll-up doors on the warehouse fronts (just proud of the wall).
  block(-64, 0, -55.8, [8, 7, 0.4], 'container', 0x8a9298),
  block(-30, 0, -55.8, [8, 7, 0.4], 'container', 0x8a9298),
  block(30, 0, -51.8, [8, 6, 0.4], 'container', 0xd8dde2),
  block(64, 0, -51.8, [8, 6, 0.4], 'container', 0xd8dde2),
  // Harbor office: a tall cream tower with a lookout deck.
  block(0, 0, -72, [14, 24, 14], 'brick', CREAM, { top: { mat: 'tile', color: 0xc8b8a0 } }),
  block(0, 24, -72, [16, 0.6, 16], 'concrete', 0xd8d2c4),
  block(-7.7, 24.6, -72, [0.6, 1, 16], 'concrete', 0xd8d2c4), // lookout parapet
  block(7.7, 24.6, -72, [0.6, 1, 16], 'concrete', 0xd8d2c4),
  block(0, 24.6, -79.7, [16, 1, 0.6], 'concrete', 0xd8d2c4),
  block(0, 0, -64.6, [6, 3.4, 0.8], 'concrete', 0xd8d2c4), // porch over the door
  // Ramp up the warehouse front onto the east roof.
  ramp([79, 0, -50.5], [50, 12, -50.5], 3.4, 'metal', STEEL),
  // Steps up from the yard to a landing against the west warehouse: rocket jump the last 8 m to its roof.
  ramp([-17, 0, -35], [-17, 8, -55], 3.4, 'steps', 0xb0aca0),
  block(-17, 0, -58, [6, 8, 6], 'brick', BRICK, { top: { mat: 'tile', color: 0x9a9690 } }),

  // --- The container pile in the middle ---------------------------------------------------------
  container(0, -3.9, 0, 'x', RED),
  container(0, -1.3, 0, 'x', BLUE),
  container(0, 1.3, 0, 'x', GREEN),
  container(0, 3.9, 0, 'x', YELLOW),
  container(-2.6, 0, 1, 'z', ORANGE),
  container(0, 0, 1, 'z', WHITE),
  container(2.6, 0, 1, 'z', TEAL),
  container(0, 0, 2, 'x', RED),
  // Ramps onto the first layer from east and west.
  ramp([-14, 0, 0], [-6, 2.6, 0], 3, 'metal', STEEL),
  ramp([14, 0, 0], [6, 2.6, 0], 3, 'metal', STEEL),

  // --- Container blocks ------------------------------------------------------------------------
  // Under the red crane, two blocks either side of the spreader's lane.
  ...yard(-57, -15, 'x', [[2, 3], [1, 2], [3, 1]], 0),
  ...yard(-57, 15, 'x', [[1, 2], [3, 1], [2, 2]], 3),
  // North-east and north-west of the pile.
  ...yard(27, -32, 'x', [[1, 2], [2, 0], [1, 3]], 5),
  ...yard(-30, -30, 'z', [[2, 1], [0, 2], [1, 1]], 2),
  // South: a long low row and a taller block.
  ...yard(-27, 32, 'x', [[1, 1], [2, 1], [1, 3]], 7),
  ...yard(27, 34, 'z', [[1, 2], [2, 0], [3, 1], [1, 1]], 4),
  // Singles in the lanes.
  container(0, -34, 0, 'x', TEAL),
  container(0, -34, 1, 'x', WHITE),
  container(0, 40, 0, 'x', RED),
  container(-38, 0, 0, 'z', GREEN),
  container(38, 0, 0, 'z', YELLOW),
  container(38, 0, 1, 'z', RED),
  // Under the big crane, waiting to be loaded.
  container(64.5, -10, 0, 'z', BLUE),
  container(64.5, -10, 1, 'z', ORANGE),
  container(69.7, -10, 0, 'z', GREEN),
  container(67.1, 12, 0, 'z', MAROON),

  // --- The big crane on the east quay, its boom out over the sea -------------------------------
  ...[-20, 20].flatMap((z) => [
    block(60, 0, z, [1.8, 34, 1.8], 'metal', CRANE),
    block(74, 0, z, [1.8, 34, 1.8], 'metal', CRANE),
    block(67, 34, z, [16, 1.8, 1.8], 'metal', CRANE),
    block(67, 16, z, [14, 1, 1], 'metal', CRANE), // cross tie, walkable
    // Bogies the legs stand on.
    block(60, 0, z, [3, 1.2, 4], 'metal', 0x3a4250),
    block(74, 0, z, [3, 1.2, 4], 'metal', 0x3a4250),
  ]),
  ...[60, 74].map((x) => block(x, 34, 0, [1.8, 1.8, 41.8], 'metal', CRANE)),
  block(80, 35.8, 0, [76, 1.4, 3], 'metal', CRANE), // boom
  block(67, 37.2, 0, [10, 4, 6], 'metal', 0xe8e8e2, { top: { mat: 'metal', color: 0x9aa2aa } }), // machinery house
  block(67, 30.6, 0, [5, 3.4, 4.6], 'metal', 0x3a4250), // operator's cab
  block(53, 32.2, 0, [3, 2, 3], 'metal', 0x3a4250), // trolley riding the boom

  // --- A red rail crane over the west stacks ---------------------------------------------------
  ...[-26, 26].flatMap((z) => [
    block(-71, 0, z, [1.4, 24, 1.4], 'metal', CRANE2),
    block(-43, 0, z, [1.4, 24, 1.4], 'metal', CRANE2),
    block(-57, 24, z, [29.4, 1.4, 1.4], 'metal', CRANE2),
  ]),
  ...[-71, -43].map((x) => block(x, 24, 0, [1.4, 1.4, 53.4], 'metal', CRANE2)),
  block(-57, 22.4, 0, [27, 1.2, 3], 'metal', CRANE2), // spreader beam
  block(-57, 23.6, 0, [4, 1.6, 4], 'metal', 0x3a4250), // its trolley

  // --- South quay: a fuel shed and some cover ---------------------------------------------------
  block(58, 0, 66, [14, 5, 10], 'plank', 0x5f8a6a, { top: { mat: 'roof', color: 0x8a4a3a } }),
  block(-62, 0, 64, [10, 3, 6], 'concrete', 0xb0aca0),
  block(10, 0, 62, [4, 1.2, 10], 'concrete', 0xb0aca0),
];

const crates: Vec3Tuple[] = [
  [8, 0.6, 12], [9.3, 0.6, 12], [8.6, 1.8, 12],
  [-12, 0.6, -18], [-12, 1.8, -18],
  [18, 0.6, -12], [19.3, 0.6, -12],
  [-40, 0.6, 60], [-41.3, 0.6, 60], [-40.6, 1.8, 60],
  [40, 0.6, 62], [40, 0.6, 63.3],
  [-40, 0.6, 104], [-41.2, 0.6, 104],
  [5, 3.2, -3], // on the first container layer
  [-64, 3.6, 66],
];

const lamps: DecorDef[] = [-60, -20, 20, 60].map((x) => decor('lamp', [x, 0, 75], { yaw: Math.PI / 2 }));
const jettyLamps: DecorDef[] = [88, 102].map((z) => decor('lamp', [-36.5, 0, z], { yaw: Math.PI }));
const bollards: DecorDef[] = [
  ...Array.from({ length: 9 }, (_, i) => decor('bollard', [-72 + i * 18, 0, 78.6])),
  ...Array.from({ length: 6 }, (_, i) => decor('bollard', [78.6, 0, -40 + i * 20])),
  ...Array.from({ length: 6 }, (_, i) => decor('bollard', [-78.6, 0, -40 + i * 20])),
];
// Tires hung on the quay wall facing the water.
const fenders: DecorDef[] = [
  ...Array.from({ length: 10 }, (_, i) => decor('fender', [-70 + i * 15.5, -1.2, HALF + 0.35])),
  ...Array.from({ length: 7 }, (_, i) => decor('fender', [HALF + 0.35, -1.2, -48 + i * 18], { yaw: Math.PI / 2 })),
  ...Array.from({ length: 7 }, (_, i) => decor('fender', [-HALF - 0.35, -1.2, -48 + i * 18], { yaw: -Math.PI / 2 })),
];
const pilings: DecorDef[] = [84, 92, 100, 108].flatMap((z) => [decor('piling', [-43.6, -0.6, z], { size: [0, 5, 0] }), decor('piling', [-36.4, -0.6, z], { size: [0, 5, 0] })]);

const line = (x: number, z: number, w: number, d: number, color = 0xf2c230): DecorDef => decor('stripe', [x, 0, z], { size: [w, 0.01, d], color });
// Ground paint: darker asphalt lanes through the yard, then yellow lines and white bay markings on top.
const paint: DecorDef[] = [
  decor('stripe', [0, 0, 0], { size: [150, 0, 10], color: 0x8a8e94 }),
  decor('stripe', [0, 0, 47], { size: [150, 0, 8], color: 0x8a8e94 }),
  decor('stripe', [0, 0, -47], { size: [150, 0, 8], color: 0x8a8e94 }),
  decor('stripe', [-44, 0, 0], { size: [8, 0, 86], color: 0x8a8e94 }),
  decor('stripe', [44, 0, 0], { size: [8, 0, 86], color: 0x8a8e94 }),
  line(0, 4.6, 150, 0.25),
  line(0, -4.6, 150, 0.25),
  line(0, 51, 150, 0.25),
  line(0, 43, 150, 0.25),
  line(0, -43, 150, 0.25),
  line(-48, 0, 0.25, 86),
  line(-40, 0, 0.25, 86),
  line(40, 0, 0.25, 86),
  line(48, 0, 0.25, 86),
  // Dashed center lines.
  ...Array.from({ length: 15 }, (_, i) => line(-70 + i * 10, 0, 4, 0.2, 0xffffff)),
  ...Array.from({ length: 15 }, (_, i) => line(-70 + i * 10, 47, 4, 0.2, 0xffffff)),
  // Hatched no-parking zone in front of the office.
  ...Array.from({ length: 7 }, (_, i) => decor('stripe', [-6 + i * 2, 0, -60], { size: [0.4, 0.01, 6], color: 0xf2c230, yaw: 0.6 })),
  // Big painted bay numbers would need text: a row of white bay boxes along the south quay instead.
  ...Array.from({ length: 6 }, (_, i) => line(-50 + i * 20, 63, 0.2, 8, 0xffffff)),
];

export const DOCKYARD: MapDef = {
  title: 'Dockyard',
  blurb: 'Sunny 160 m harbor: container stacks, giant cranes and a long drop into the sea.',
  theme: 'harbor',
  fragLimit: 20,
  boxes,
  crates,
  spawns: [
    facingCenter([-20, 1, 66]),
    facingCenter([24, 1, 66]),
    facingCenter([52, 1, 20]),
    facingCenter([52, 1, -36]),
    facingCenter([-74, 1, 40]),
    facingCenter([-74, 1, -40]),
    facingCenter([-32, 1, -50]),
    facingCenter([22, 1, -46]),
    facingCenter([-47, 17, -66]),
  ],
  pickups: [
    [0, 9.1, 0], // on top of the pile
    [-47, 17.3, -74], // west warehouse roof
    [62, 37.8, 0], // out on the crane boom
    [-40, 1.3, 106], // end of the jetty
    [44, 1.3, 20],
    [-44, 1.3, -20],
  ],
  vehicles: [
    { kind: 'car', pos: [-50, 0.7, 66], yaw: Math.PI / 2 },
    { kind: 'car', pos: [52, 0.7, 40], yaw: 0 },
  ],
  killY: -10,
  botOrbit: 46,
  decor: [
    decor('water', [0, SEA, 0], { size: [1400, 0, 1400], color: 0x2a8ab8 }),
    decor('islands', [0, SEA, 0], { size: [330, 0, 0] }),
    decor('mountains', [0, SEA - 4, 0], { size: [460, 55, 0], color: 0x5f8a5a }),
    decor('ship', [150, SEA, -20], { yaw: 0.08 }),
    decor('lighthouse', [-150, SEA, 150]),
    decor('gull', [10, 42, 10]),
    decor('gull', [-80, 30, 90]),
    decor('hook', [52, 34.6, 0], { size: [0, 18, 0] }),
    decor('rail', [60, 0, 0], { size: [0, 0, 150] }),
    decor('rail', [74, 0, 0], { size: [0, 0, 150] }),
    decor('flag', [0, 24.6, -66], { color: 0x2f6fb8 }),
    decor('flag', [-47, 16.5, -58], { color: 0xd94a3a }),
    // Windows on the warehouse fronts and all round the office tower.
    decor('windows', [-47, 12, -55.95], { size: [56, 2.2, 10] }),
    decor('windows', [47, 9, -51.95], { size: [56, 2, 10], color: 0xd8dde2 }),
    ...[6, 12, 18].flatMap((y) => [
      decor('windows', [0, y, -64.95], { size: [10, 2.4, 3] }),
      decor('windows', [7.05, y, -72], { size: [10, 2.4, 3], yaw: Math.PI / 2 }),
      decor('windows', [-7.05, y, -72], { size: [10, 2.4, 3], yaw: -Math.PI / 2 }),
    ]),
    decor('barrel', [50, 0, 58]),
    decor('barrel', [51, 0, 59.2], { color: 0xd94a3a }),
    decor('barrel', [49.6, 0, 59.6]),
    decor('barrel', [-77, 0, -50], { color: 0xd94a3a }),
    decor('barrel', [-77, 0, -48.8], { color: 0xd94a3a }),
    decor('pallets', [-10, 0, -54], { color: 0xd8d2c0 }),
    decor('pallets', [-8.4, 0, -54], { color: 0x6a9ad0 }),
    decor('pallets', [12, 0, 58], { color: 0xd8d2c0 }),
    decor('pallets', [-70, 0, 55], { color: 0xe0c070 }),
    decor('pallets', [-70, 0, 56.4], { color: 0xe0c070 }),
    decor('reel', [20, 0, -56], { yaw: 0.4 }),
    decor('reel', [-58, 0, 72], { yaw: 1.2, color: 0x8a2e3a }),
    ...[[-8, 52], [-4, 52], [0, 52], [4, 52], [8, 52], [36, 18], [36, 22]].map(([x, z]) => decor('cone', [x, 0, z])),
    ...lamps,
    ...jettyLamps,
    ...bollards,
    ...fenders,
    ...pilings,
    ...paint,
  ],
};
