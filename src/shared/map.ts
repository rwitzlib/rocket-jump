// Maps are plain data so the client (meshes) and a future server (colliders only) build from the same source.

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

export interface MapDef {
  boxes: BoxDef[];
  crates: Vec3Tuple[];
  spawns: SpawnDef[];
  pickups: Vec3Tuple[]; // mystery box centers
  killY: number;
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
