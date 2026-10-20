import { Euler, Quaternion, Vector3 } from 'three';
import type { BoxDef, DecorDef, SpawnDef, SurfaceKind, Vec3Tuple } from '../map';

// Building blocks for laying out maps by hand.

const _q = new Quaternion();
const _yaw = new Quaternion();
const _tilt = new Quaternion();
const _euler = new Euler();
const UP = new Vector3(0, 1, 0);
const RIGHT = new Vector3(1, 0, 0);
const _v = new Vector3();

/** Turns a point `k` quarter turns about Y (the same direction as a +90° yaw in three.js). */
export function turnPos([x, y, z]: Vec3Tuple, k: number): Vec3Tuple {
  for (let i = 0; i < k; i++) [x, z] = [z, -x];
  return [x, y, z];
}

export function turnBox(box: BoxDef, k: number): BoxDef {
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

export function turnDecor(d: DecorDef, k: number): DecorDef {
  return { ...d, pos: turnPos(d.pos, k), yaw: (d.yaw ?? 0) + (k * Math.PI) / 2 };
}

/** Four-way symmetry: the items as given, then turned a quarter, a half and three quarters about Y. */
export function quad<T>(items: T[], turn: (item: T, k: number) => T): T[] {
  return [0, 1, 2, 3].flatMap((k) => items.map((item) => turn(item, k)));
}

/** Two-way symmetry: the items as given and turned half way round. */
export function pair<T>(items: T[], turn: (item: T, k: number) => T): T[] {
  return [0, 2].flatMap((k) => items.map((item) => turn(item, k)));
}

/** A spawn looking at the middle of the map. */
export function facingCenter(pos: Vec3Tuple): SpawnDef {
  return { pos, yaw: Math.atan2(pos[0], pos[2]) };
}

export function box(pos: Vec3Tuple, size: Vec3Tuple, mat: SurfaceKind, color: number, extra: Partial<BoxDef> = {}): BoxDef {
  return { pos, size, mat, color, ...extra };
}

/** A box standing on `y` (its bottom there), centered at x, z. */
export function block(x: number, y: number, z: number, size: Vec3Tuple, mat: SurfaceKind, color: number, extra: Partial<BoxDef> = {}): BoxDef {
  return box([x, y + size[1] / 2, z], size, mat, color, extra);
}

/** A collider with nothing drawn: for scenery that should be solid, like a tree trunk or a statue. */
export function solid(pos: Vec3Tuple, size: Vec3Tuple): BoxDef {
  return { pos, size, color: 0, hidden: true };
}

/**
 * A ramp (or any slab) whose top surface runs in a straight line from `from` to `to`, both points on
 * the top surface's center line. `thickness` hangs below that line.
 */
export function ramp(from: Vec3Tuple, to: Vec3Tuple, width: number, mat: SurfaceKind, color: number, thickness = 0.6, extra: Partial<BoxDef> = {}): BoxDef {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const run = Math.hypot(dx, dz);
  const length = Math.hypot(run, dy);
  // Tilt the +Z axis up by the slope, then swing it round to face along the run.
  _tilt.setFromAxisAngle(RIGHT, -Math.atan2(dy, run));
  _yaw.setFromAxisAngle(UP, Math.atan2(dx, dz));
  _q.multiplyQuaternions(_yaw, _tilt);
  _euler.setFromQuaternion(_q, 'XYZ');
  // From the top surface's middle down half the thickness, along the slab's own up.
  _v.set(0, 1, 0).applyQuaternion(_q).multiplyScalar(-thickness / 2);
  const pos: Vec3Tuple = [(from[0] + to[0]) / 2 + _v.x, (from[1] + to[1]) / 2 + _v.y, (from[2] + to[2]) / 2 + _v.z];
  return { pos, size: [width, thickness, length], rot: [_euler.x, _euler.y, _euler.z], mat, color, ...extra };
}

/** A shipping container lying along X or Z, its bottom at `level` containers up. */
export function container(x: number, z: number, level: number, along: 'x' | 'z', color: number, y0 = 0): BoxDef {
  const size: Vec3Tuple = along === 'x' ? [12, 2.6, 2.6] : [2.6, 2.6, 12];
  return box([x, y0 + 1.3 + level * 2.6, z], size, 'container', color);
}

export function decor(kind: DecorDef['kind'], pos: Vec3Tuple, extra: Partial<DecorDef> = {}): DecorDef {
  return { kind, pos, ...extra };
}

/**
 * Solid cores for a `floatingRock` decor hanging below `pos` (the island's bottom), so it can be
 * grappled and stood on, and so players and rockets can't pass through it. The drawn rock is a lumpy
 * blob over a downward cone; this follows the same taper in thin tiers, each a stack of crossed
 * rectangles whose corners all sit on the outline's ellipse, so together they fill it to within a
 * percent or so without any corner sticking out.
 */
export function floatingRockSolids([x, y, z]: Vec3Tuple, [w, depth, d]: Vec3Tuple): BoxDef[] {
  // Radius as a fraction of the size, at `t` (0 at the island's bottom, 1 at the tip): see client/decor.ts.
  // The blob's lumps run from 0.78 to 1.18 of its radius and the cone is a hexagon, so this sits
  // about on their average surface.
  const radius = (t: number) => {
    const blob = 0.52 * 0.97 * Math.sqrt(Math.max(0, 1 - ((t - 0.12) / 0.3) ** 2));
    const cone = t < 0.1 ? 0 : 0.45 * 0.93 * (1 - (t - 0.1) / 0.9);
    return Math.max(blob, cone);
  };
  const out: BoxDef[] = [];
  const tiers = 13;
  const bottomT = 0.975;
  for (let i = 0; i < tiers; i++) {
    const top = (i / tiers) * bottomT;
    const bottom = ((i + 1) / tiers) * bottomT;
    const r = radius((top + bottom) / 2);
    const pos: Vec3Tuple = [x, y - ((top + bottom) / 2) * depth, z];
    const h = (bottom - top) * depth;
    for (const a of RECT_ANGLES) out.push(solid(pos, [2 * r * Math.cos(a) * w, h, 2 * r * Math.sin(a) * d]));
  }
  // The smaller spike hanging off to one side, from 0.6 down to 1.1.
  const spikeTiers = 6;
  for (let i = 0; i < spikeTiers; i++) {
    const t = 0.6 + ((i + 0.5) / spikeTiers) * 0.48;
    const r = 0.12 * 0.93 * (1 - (t - 0.6) / 0.5);
    const pos: Vec3Tuple = [x + 0.15 * w, y - t * depth, z + 0.1 * d];
    const h = (0.48 / spikeTiers) * depth;
    for (const a of RECT_ANGLES) out.push(solid(pos, [2 * r * Math.cos(a) * w, h, 2 * r * Math.sin(a) * d]));
  }
  return out;
}

// Rectangles with their corners on a circle at these angles: their union is a 20-sided star whose
// notches sit within 1% of the circle.
const RECT_ANGLES = [15, 30, 45, 60, 75].map((deg) => (deg * Math.PI) / 180);

/**
 * Solid cores for a `statue` decor (a great stone head) at `pos`, facing +Z turned `k` quarter turns:
 * the same boxes the head is drawn with (see client/decor.ts), so nothing passes through its face.
 */
export function statueSolids(pos: Vec3Tuple, scale: number, k: number): BoxDef[] {
  const parts: [Vec3Tuple, Vec3Tuple][] = [
    [[0, 3, 0], [6, 6, 5]], // head
    [[0, 6.4, 0], [6.4, 1.2, 5.4]], // headdress band
    [[0, 7.4, 0], [5.6, 1, 4.6]],
    [[0, 4.4, 2.55], [5, 0.5, 0.3]], // brow
    [[0, 2.6, 2.8], [1.3, 1.9, 1]], // nose (drawn tipped back a little)
    [[0, 1.2, 2.55], [2.6, 0.7, 0.2]], // lips
    [[-3.29, 3, 0.2], [0.6, 2.2, 1.4]], // ears
    [[3.29, 3, 0.2], [0.6, 2.2, 1.4]],
  ];
  return parts.map(([offset, size]) => {
    // Turned about the statue's own spot, then moved there.
    const turned = turnBox(solid(offset.map((v) => v * scale) as Vec3Tuple, size.map((s) => s * scale) as Vec3Tuple), k);
    return { ...turned, pos: [pos[0] + turned.pos[0], pos[1] + turned.pos[1], pos[2] + turned.pos[2]] };
  });
}
