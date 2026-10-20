import type { BoxDef, DecorDef, MapDef, Vec3Tuple } from '../map';
import { block, box, decor, facingCenter, quad, ramp, turnBox, turnDecor, turnPos } from './helpers';

// Foundry: a tall steel hall built around a pit of molten metal. Everything here is about height
// and the grapple. Four smokestack towers stand in the corners with catwalks at 12 m joining them
// round the walls; ramps climb to the catwalks; a lattice of girders at 30 m spans the whole hall,
// with chains hanging off it to swing on; and over the pit floats a little island (with the
// overdrive) that only a rocket jump or a swing reaches. Falling into the pit is the end of you.

const FLOOR = 0x6e6a66;
const STEEL = 0x56606e;
const RUST = 0xa0583a;
const GIRDER = 0x3a4250;
const CATWALK = 0x8a8478;
const HAZARD = 0xe0b030;

const HALF = 45;
const PIT = 12; // half-width of the pit
const DECK = 12; // catwalk height
const TOWER = 32; // tower centers on the diagonals
const GIRDERS = 30;

const quarter: BoxDef[] = [
  // The floor round the pit, a slab per side (they overlap at the corners).
  block(0, -1, (PIT + HALF) / 2, [HALF * 2, 1, HALF - PIT], 'concrete', FLOOR),
  // The pit's lip: a low hazard-striped kerb.
  block(0, 0, PIT + 0.4, [PIT * 2 + 1.6, 0.4, 0.8], 'hazard', HAZARD),
  // A corner tower with its deck at catwalk height.
  block(TOWER, 0, TOWER, [8, 24, 8], 'metal', RUST, { top: { mat: 'metal', color: STEEL } }),
  block(TOWER, DECK - 0.6, TOWER, [14, 0.6, 14], 'plank', CATWALK),
  // The catwalk along the wall to the next tower, and a landing beside it where the ramp comes up.
  block(0, DECK - 0.6, 34, [50, 0.6, 4], 'plank', CATWALK),
  block(0, DECK - 0.6, 38, [16, 0.6, 4], 'plank', CATWALK),
  ramp([-24, 0, 38], [-8, DECK, 38], 3, 'metal', STEEL, 0.5),
  // Cover on the floor.
  block(22, 0, 18, [3, 2.5, 6], 'metal', STEEL),
  block(8, 0, 30, [6, 3, 2], 'container', 0x3a7ab0),
  // A chain hanging from the girders, to swing on.
  box([14, GIRDERS - 7, 14], [0.5, 14, 0.5], 'metal', GIRDER),
];

const boxes: BoxDef[] = [
  ...quad(quarter, turnBox),
  // The walls, and the pit's bottom (well below the point of no return).
  box([0, 22, HALF + 0.5], [HALF * 2 + 2, 44, 1], 'brick', 0x7a5040),
  box([0, 22, -HALF - 0.5], [HALF * 2 + 2, 44, 1], 'brick', 0x7a5040),
  box([HALF + 0.5, 22, 0], [1, 44, HALF * 2 + 2], 'brick', 0x7a5040),
  box([-HALF - 0.5, 22, 0], [1, 44, HALF * 2 + 2], 'brick', 0x7a5040),
  block(0, -16, 0, [PIT * 2, 1, PIT * 2], 'rock', 0x3a2a20),
  // The girders: a grid across the whole hall.
  ...[-28, -14, 0, 14, 28].flatMap((k) => [box([0, GIRDERS, k], [HALF * 2, 1.2, 1.2], 'metal', GIRDER), box([k, GIRDERS + 1.2, 0], [1.2, 1.2, HALF * 2], 'metal', GIRDER)]),
  // The island over the pit.
  block(0, 4, 0, [10, 1, 10], 'metal', STEEL, { top: { mat: 'hazard', color: HAZARD } }),
];

const crates: Vec3Tuple[] = quad<Vec3Tuple>([[26, 0.6, 22], [27.3, 0.6, 22], [26.6, 1.8, 22], [-6, DECK + 0.6, 34]], turnPos);

const quarterDecor: DecorDef[] = [
  decor('lamp', [HALF - 0.6, 0, 20], { yaw: Math.PI, color: 0xffb060 }),
  decor('barrel', [40, 0, 40]),
  decor('barrel', [41.2, 0, 39.2], { color: 0x3a7ab0 }),
  decor('pallets', [36, 0, 14]),
  decor('reel', [18, 0, 40]),
];

export const FOUNDRY: MapDef = {
  title: 'Foundry',
  blurb: 'A steel hall over a pit of molten metal. Towers, catwalks and girders to swing from.',
  theme: 'foundry',
  fragLimit: 20,
  boxes,
  crates,
  spawns: quad([facingCenter([38, 1, 20]), facingCenter([26.5, DECK + 1, 26.5])], (s, k) => facingCenter(turnPos(s.pos, k))),
  pickups: [...quad<Vec3Tuple>([[32, DECK + 1.4, 26.5]], turnPos), [0, 6.4, 0]],
  items: [
    ...quad<Vec3Tuple>([[20, 0, 10]], turnPos).map((pos) => ({ kind: 'health' as const, pos })),
    { kind: 'armor', pos: [0, DECK, 34] },
    { kind: 'armor', pos: [0, DECK, -34] },
    { kind: 'overdrive', pos: [3, 5, 3] },
  ],
  flags: [[0, 0, 40], [0, 0, -40]],
  hills: [[0, 5, 0], [0, 0, 26], [26, 0, 0], [0, 0, -26], [-26, 0, 0]],
  race: {
    start: [38, 1, 38],
    rings: [[38, 2.5, 26], [0, 7.5, 0], [-32, DECK + 2.5, 25], [7, GIRDERS, 7], [32, DECK + 2.5, -25]],
  },
  killY: -8,
  botOrbit: 22,
  decor: [
    ...quad(quarterDecor, turnDecor),
    decor('water', [0, -6, 0], { size: [PIT * 2, 0, PIT * 2], color: 0xff6a1a }),
    decor('halo', [0, -5, 0], { size: [PIT, 0, 0], color: 0xff8030 }),
  ],
};
