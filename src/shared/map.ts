// Maps are plain data so the client (meshes) and a future server (colliders only) build from the same source.

import { Euler, Quaternion, Vector3 } from 'three';
import type { VehicleKind } from './types';

export type Vec3Tuple = [number, number, number];

export interface BoxDef {
  pos: Vec3Tuple; // center
  size: Vec3Tuple; // full extents
  rot?: Vec3Tuple; // euler radians (XYZ)
  color: number;
}

export interface SpawnDef {
  pos: Vec3Tuple;
  yaw: number; // facing direction, 0 = looking down -Z
}

/** Where a vehicle starts and comes back to after it's destroyed. */
export interface VehicleDef {
  kind: VehicleKind;
  pos: Vec3Tuple; // collider center
  yaw: number;
}

export interface MapDef {
  boxes: BoxDef[];
  crates: Vec3Tuple[];
  spawns: SpawnDef[];
  pickups: Vec3Tuple[]; // mystery box centers
  killY: number;
  botOrbit?: number; // radius of the circle wandering bots follow around the center
  vehicles?: VehicleDef[];
}

const FLOOR = 0x8a94a6;
const WALL = 0x6b7487;
const STONE = 0xb8a68a;
const ACCENT = 0xd96c4a;
const BEAM = 0x4a5f8a;
const PLATFORM = 0x6fa88a;

const HALF = 60;
const WALL_H = 20;

export const ARENA: MapDef = {
  boxes: [
    // floor + outer walls
    { pos: [0, -0.5, 0], size: [HALF * 2, 1, HALF * 2], color: FLOOR },
    { pos: [0, WALL_H / 2, -HALF], size: [HALF * 2, WALL_H, 1], color: WALL },
    { pos: [0, WALL_H / 2, HALF], size: [HALF * 2, WALL_H, 1], color: WALL },
    { pos: [-HALF, WALL_H / 2, 0], size: [1, WALL_H, HALF * 2], color: WALL },
    { pos: [HALF, WALL_H / 2, 0], size: [1, WALL_H, HALF * 2], color: WALL },

    // central tower with a top deck
    { pos: [0, 10, 0], size: [8, 20, 8], color: STONE },
    { pos: [0, 20.5, 0], size: [14, 1, 14], color: ACCENT },

    // tall corner pillars: grapple anchors
    { pos: [-35, 15, -35], size: [3, 30, 3], color: STONE },
    { pos: [35, 15, -35], size: [3, 30, 3], color: STONE },
    { pos: [-35, 15, 35], size: [3, 30, 3], color: STONE },
    { pos: [35, 15, 35], size: [3, 30, 3], color: STONE },

    // overhead beams between pillars: swing under these
    { pos: [0, 28, -35], size: [70, 1.5, 1.5], color: BEAM },
    { pos: [0, 28, 35], size: [70, 1.5, 1.5], color: BEAM },
    { pos: [-35, 28, 0], size: [1.5, 1.5, 70], color: BEAM },
    { pos: [35, 28, 0], size: [1.5, 1.5, 70], color: BEAM },

    // floating platforms
    { pos: [-20, 12, 0], size: [6, 0.8, 6], color: PLATFORM },
    { pos: [20, 12, 0], size: [6, 0.8, 6], color: PLATFORM },
    { pos: [0, 14, -22], size: [6, 0.8, 6], color: PLATFORM },
    { pos: [0, 14, 22], size: [6, 0.8, 6], color: PLATFORM },

    // ramps
    { pos: [-20, 2.2, 30], size: [6, 0.6, 14], rot: [-0.35, 0, 0], color: ACCENT },
    { pos: [20, 2.2, -30], size: [6, 0.6, 14], rot: [0.35, 0, 0], color: ACCENT },
    { pos: [30, 2.2, 15], size: [14, 0.6, 6], rot: [0, 0, 0.35], color: ACCENT },
    { pos: [-30, 2.2, -15], size: [14, 0.6, 6], rot: [0, 0, -0.35], color: ACCENT },

    // low cover blocks
    { pos: [-12, 1.5, -12], size: [4, 3, 4], color: WALL },
    { pos: [12, 1.5, 12], size: [4, 3, 4], color: WALL },
    { pos: [12, 2.5, -14], size: [3, 5, 6], color: WALL },
    { pos: [-12, 2.5, 14], size: [3, 5, 6], color: WALL },
    { pos: [-45, 4, 0], size: [6, 8, 12], color: STONE },
    { pos: [45, 4, 0], size: [6, 8, 12], color: STONE },
  ],
  crates: [
    [6, 0.6, 8], [7.3, 0.6, 8], [6.6, 1.8, 8],
    [-8, 0.6, -6], [-8, 1.8, -6], [-8, 3.0, -6],
    [25, 0.6, 25], [26.3, 0.6, 25], [25, 0.6, 26.3], [25.6, 1.8, 25.6],
    [-25, 0.6, -25], [-26.3, 0.6, -25], [-25.6, 1.8, -25],
    [0, 21.6, 4], [3, 21.6, -3],
  ],
  spawns: [
    { pos: [0, 2, 40], yaw: 0 },
    { pos: [0, 2, -40], yaw: Math.PI },
    { pos: [40, 2, 0], yaw: Math.PI / 2 },
    { pos: [-40, 2, 0], yaw: -Math.PI / 2 },
  ],
  pickups: [
    [0, 1.4, 30], // in front of the north and south spawns
    [0, 1.4, -30],
    [-3.5, 22.2, 3.5], // on the tower deck
  ],
  killY: -30,
};

// Four-way symmetric maps: describe one quadrant (+X, +Z) and `quad` turns it into all four, each a
// quarter turn about the vertical axis from the last, so no side has an advantage.

const _q = new Quaternion();
const _yaw = new Quaternion();
const _euler = new Euler();
const UP = new Vector3(0, 1, 0);

/** Turns a point `k` quarter turns about Y (the same direction as a +90° yaw in three.js). */
function turnPos([x, y, z]: Vec3Tuple, k: number): Vec3Tuple {
  for (let i = 0; i < k; i++) [x, z] = [z, -x];
  return [x, y, z];
}

function turnBox(box: BoxDef, k: number): BoxDef {
  const pos = turnPos(box.pos, k);
  if (!box.rot) {
    // Axis-aligned boxes stay axis-aligned: an odd number of quarter turns just swaps width and depth.
    const [w, h, d] = box.size;
    return { ...box, pos, size: k % 2 ? [d, h, w] : [w, h, d] };
  }
  _q.setFromEuler(_euler.set(...box.rot));
  _q.premultiply(_yaw.setFromAxisAngle(UP, (k * Math.PI) / 2));
  _euler.setFromQuaternion(_q);
  return { ...box, pos, rot: [_euler.x, _euler.y, _euler.z] };
}

function quad<T>(items: T[], turn: (item: T, k: number) => T): T[] {
  return [0, 1, 2, 3].flatMap((k) => items.map((item) => turn(item, k)));
}

/** A spawn looking at the middle of the map. */
function facingCenter(pos: Vec3Tuple): SpawnDef {
  return { pos, yaw: Math.atan2(pos[0], pos[2]) };
}

// Citadel: a 240 m square in three layers. The ground has cover and crates; a ring deck around the
// central spire (14 m) connects by long bridges to balconies on four corner towers; above that,
// tower tops (30 m), floating platforms and the spire deck (40 m), with a frame of beams around the
// top of everything to swing from. Long ramps lead up to the ring; the rest is rocket jumps and grapples.
const C_HALF = 120;
const C_WALL_H = 50;
const RING_Y = 14; // ring deck and bridges
const TOWER_H = 30;
const SPIRE_H = 40;
const BEAM_Y = 46;
const TOWER = 85; // corner tower center, on both axes

// Long ramp from the ground to the ring deck: its top surface rises to meet the deck's outer edge
// (z = 18) over 36 m, about 22°.
const RAMP_RUN = 36;
const RAMP_RISE = RING_Y + 0.5;
const RAMP_TILT = Math.atan2(RAMP_RISE, RAMP_RUN);

const citadelQuadrant: BoxDef[] = [
  // outer wall (one side per quadrant)
  { pos: [0, C_WALL_H / 2, C_HALF], size: [C_HALF * 2, C_WALL_H, 1], color: WALL },

  // ring deck around the spire: one side per quadrant, leaving a 5 m gap around the spire to drop through
  { pos: [-4, RING_Y, 14], size: [28, 1, 8], color: ACCENT },

  // ramp from the ground up to that side of the ring
  {
    pos: [10, RAMP_RISE / 2 - 0.3 / Math.cos(RAMP_TILT), 18 + RAMP_RUN / 2],
    size: [6, 0.6, Math.hypot(RAMP_RUN, RAMP_RISE)],
    rot: [RAMP_TILT, 0, 0],
    color: ACCENT,
  },

  // corner tower: balcony at ring height, deck on top, a mast above that holds up the beams
  { pos: [TOWER, TOWER_H / 2, TOWER], size: [14, TOWER_H, 14], color: STONE },
  { pos: [TOWER, RING_Y, TOWER], size: [24, 1, 24], color: PLATFORM },
  { pos: [TOWER, TOWER_H + 0.5, TOWER], size: [18, 1, 18], color: ACCENT },
  { pos: [TOWER, (TOWER_H + BEAM_Y) / 2 + 0.5, TOWER], size: [3, BEAM_Y - TOWER_H, 3], color: STONE },
  // low parapet on the tower deck: cover from people below
  { pos: [TOWER - 8.5, TOWER_H + 1.5, TOWER], size: [1, 2, 18], color: WALL },

  // diagonal bridge from the ring's corner to the tower balcony, with two cover blocks along it
  { pos: [48, RING_Y, 48], size: [5, 1, 86], rot: [0, Math.PI / 4, 0], color: BEAM },
  { pos: [38, RING_Y + 1.5, 38], size: [2.5, 2, 1], rot: [0, Math.PI / 4, 0], color: WALL },
  { pos: [58, RING_Y + 1.5, 58], size: [2.5, 2, 1], rot: [0, Math.PI / 4, 0], color: WALL },

  // beam along the top of this side, mast to mast: swing under it anywhere near the edge
  { pos: [0, BEAM_Y, TOWER], size: [TOWER * 2, 1.5, 1.5], color: BEAM },
  // and one from the mast toward the spire, over the bridge
  { pos: [TOWER / 2, BEAM_Y, TOWER / 2], size: [1.5, 1.5, TOWER * Math.SQRT2], rot: [0, Math.PI / 4, 0], color: BEAM },

  // edge rampart: a raised walk along the middle of the wall, with a pylon to grapple from
  { pos: [0, 4, 110], size: [36, 8, 10], color: STONE },
  { pos: [0, 22, 102], size: [3, 44, 3], color: STONE },
  { pos: [-27.4, 3.7, 108], size: [20.5, 0.6, 6], rot: [0, 0, 0.4], color: ACCENT }, // ramp up onto the rampart

  // floating platforms between the layers
  { pos: [50, 24, 16], size: [8, 0.8, 8], color: PLATFORM },
  { pos: [72, 36, 40], size: [7, 0.8, 7], color: PLATFORM },
  { pos: [24, 30, 60], size: [6, 0.8, 6], color: PLATFORM },

  // ground cover
  { pos: [30, 1.5, 30], size: [4, 3, 4], color: WALL },
  { pos: [44, 2, 74], size: [12, 4, 3], color: WALL },
  { pos: [74, 3, 30], size: [3, 6, 12], color: WALL },
  { pos: [60, 1, 52], size: [6, 2, 6], color: STONE },
  // a blockhouse: stand on its roof, duck behind it, rocket jump onto it
  { pos: [100, 5, 50], size: [16, 10, 18], color: STONE },
];

export const CITADEL: MapDef = {
  boxes: [
    { pos: [0, -0.5, 0], size: [C_HALF * 2, 1, C_HALF * 2], color: FLOOR },
    ...quad(citadelQuadrant, turnBox),

    // central spire with a deck on top, and crossed beams above it
    { pos: [0, SPIRE_H / 2, 0], size: [10, SPIRE_H, 10], color: STONE },
    { pos: [0, SPIRE_H + 0.5, 0], size: [18, 1, 18], color: ACCENT },
    { pos: [0, BEAM_Y + 2, 0], size: [40, 1.5, 1.5], color: BEAM },
    { pos: [0, BEAM_Y + 2, 0], size: [1.5, 1.5, 40], color: BEAM },
  ],
  crates: quad<Vec3Tuple>(
    [
      [34, 0.6, 26], [35.3, 0.6, 26], [34.6, 1.8, 26],
      [66, 0.6, 66], [66, 1.8, 66], [66, 3.0, 66],
      [96, 10.6, 46], [97.3, 10.6, 46], // on the blockhouse roof
      [TOWER - 4, RING_Y + 1.1, TOWER - 10],
    ],
    turnPos,
  ),
  spawns: quad<SpawnDef>(
    [facingCenter([60, 2, 100]), facingCenter([TOWER - 4, TOWER_H + 2, TOWER - 4])],
    (s, k) => facingCenter(turnPos(s.pos, k)),
  ),
  pickups: [
    ...quad<Vec3Tuple>([[60, 1.4, 0], [TOWER + 8, RING_Y + 1.9, TOWER - 8]], turnPos),
    [0, SPIRE_H + 1.9, 0],
  ],
  // A buggy on the ground in each quadrant, and helicopters on two of the ramparts.
  vehicles: [
    ...quad<VehicleDef>([{ kind: 'car', pos: [30, 0.7, 96], yaw: Math.atan2(30, 96) }], (v, k) => ({
      ...v,
      pos: turnPos(v.pos, k),
      yaw: v.yaw + (k * Math.PI) / 2,
    })),
    // (beside the pylon, not in front of it)
    { kind: 'heli', pos: [10, 9.2, 110], yaw: 0 },
    { kind: 'heli', pos: [-10, 9.2, -110], yaw: Math.PI },
  ],
  killY: -30,
  botOrbit: 50,
};

export const MAPS: Record<string, MapDef> = { arena: ARENA, citadel: CITADEL };
