import type { BoxDef, MapDef } from '../map';
import { block, box, decor, ramp } from './helpers';

// Training: a walled course, run as a race with no one else in it, that teaches one move per ring.
// Walk through the start gate; jump a low wall; rocket jump onto a ledge; swing on the grapple
// across a gap; rocket jump over a second gap; grapple up a tower. Nothing on it can kill you:
// falling into a gap only means a walk (or a rocket jump) back up. The client's coach (tutorial.ts)
// says what to do next, by ring.

const FLOOR = 0x8a94a6;
const WALL = 0x5d6678;
const LEDGE = 0xb8a68a;
const ACCENT = 0xd96c4a;
const BEAM = 0x4a5f8a;
const PIT = 0x56607a;

const HALF_W = 9; // the course is 18 m wide
const LEDGE_Y = 4; // the raised platforms' tops

const boxes: BoxDef[] = [
  // 1. The start: flat floor, then a low wall to jump.
  block(0, -1, -10, [HALF_W * 2, 1, 32], 'grid', FLOOR),
  block(0, 0, -12, [16, 0.9, 1.5], 'hazard', ACCENT),
  // 2. A ledge too high to jump: rocket jump onto it.
  block(0, -4, -38, [HALF_W * 2, 8, 24], 'stone', LEDGE, { top: { mat: 'tile', color: 0xc8b89a } }),
  // 3. A wide gap with a beam high over it to swing from. Ramps up out of the pit on either side.
  block(0, -5, -62, [HALF_W * 2, 1, 24], 'concrete', PIT),
  box([0, 16, -62], [1.4, 1.4, 30], 'metal', BEAM),
  box([0, 16, -49], [HALF_W * 2, 1.4, 1.4], 'metal', BEAM),
  box([0, 16, -75], [HALF_W * 2, 1.4, 1.4], 'metal', BEAM),
  ramp([-6, -4, -70], [-6, LEDGE_Y, -50.4], 3, 'plank', 0xa07a52),
  ramp([6, -4, -54], [6, LEDGE_Y, -73.6], 3, 'plank', 0xa07a52),
  // 4. The far platform, then a shallow gap to rocket jump across.
  block(0, -4, -84, [HALF_W * 2, 8, 20], 'stone', LEDGE, { top: { mat: 'tile', color: 0xc8b89a } }),
  block(0, -1, -98, [HALF_W * 2, 2, 8], 'concrete', PIT),
  // 5. The last platform and its tower: grapple the top and get pulled up.
  block(0, -4, -116, [HALF_W * 2, 8, 28], 'stone', LEDGE, { top: { mat: 'tile', color: 0xc8b89a } }),
  block(0, LEDGE_Y, -123, [10, 14, 8], 'brick', 0xa8644a, { top: { mat: 'tile', color: ACCENT } }),
  // Walls all round, tall enough to grapple along.
  box([-HALF_W - 0.5, 10, -63], [1, 28, 140], 'concrete', WALL),
  box([HALF_W + 0.5, 10, -63], [1, 28, 140], 'concrete', WALL),
  box([0, 10, 6.5], [HALF_W * 2 + 2, 28, 1], 'concrete', WALL),
  box([0, 10, -132.5], [HALF_W * 2 + 2, 28, 1], 'concrete', WALL),
];

export const TRAINING: MapDef = {
  title: 'Training',
  blurb: 'Learn to rocket jump and grapple, one ring at a time.',
  tutorial: true,
  boxes,
  crates: [],
  spawns: [{ pos: [0, 1, 3], yaw: 0 }],
  flags: [[-4, 0, 2], [4, 0, 2]], // (unused: training is never capture the flag)
  pickups: [],
  race: {
    start: [0, 1, 3],
    rings: [
      [0, 2, -3], // the start gate
      [0, 2.2, -20], // over the low wall
      [0, LEDGE_Y + 2, -30], // up on the ledge
      [0, 8, -62], // swinging over the gap
      [0, LEDGE_Y + 2, -105], // across the second gap
      [0, LEDGE_Y + 16.5, -123], // on top of the tower
    ],
  },
  killY: -20,
  decor: [
    decor('mountains', [0, -20, -60], { size: [420, 150, 0], color: 0x7a8a9a }),
    decor('lamp', [-7.5, 0, -2]),
    decor('lamp', [7.5, 0, -2], { yaw: Math.PI }),
    decor('stripe', [0, 0.02, -3], { size: [16, 0, 0.4], color: 0xffe060 }),
    decor('banner', [0, 14, -128.9], { size: [4, 6, 0], color: 0xd96c4a }),
  ],
};
