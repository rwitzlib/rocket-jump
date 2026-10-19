import type { Vector3 } from 'three';

// Collision groups and small geometry helpers shared by the simulation's parts.

// Players are in their own collision group and ignore each other. Movement stays predictable on
// the client, which only knows where other players were ~100ms ago. Rockets still hit players.
export const PLAYER_GROUP = 0x0002;
export const PLAYER_COLLISION_GROUPS = (PLAYER_GROUP << 16) | (0xffff & ~PLAYER_GROUP);
// Vehicles block players (you can stand on a car), but players don't block vehicles: a car that
// reaches you runs you over instead (see ramPlayers). So a vehicle collider accepts everything,
// and a vehicle's own movement query skips players.
export const VEHICLE_GROUP = 0x0004;
export const VEHICLE_COLLIDER_GROUPS = (VEHICLE_GROUP << 16) | 0xffff;
export const VEHICLE_MOVE_GROUPS = (VEHICLE_GROUP << 16) | (0xffff & ~PLAYER_GROUP);


/** Distance along a ray (unit `dir`) to where it enters a sphere, or null if it misses or the hit is past `maxDist`. */
export function raySphere(origin: Vector3, dir: Vector3, center: Vector3, radius: number, maxDist: number): number | null {
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const oz = origin.z - center.z;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  if (c <= 0) return 0; // starting inside it
  const disc = b * b - c;
  if (b > 0 || disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t <= maxDist ? t : null;
}

/** Distance from a point to the segment a-b. */
export function segmentDistance(a: Vector3, b: Vector3, point: Vector3): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = len2 > 1e-9 ? ((point.x - a.x) * abx + (point.y - a.y) * aby + (point.z - a.z) * abz) / len2 : 0;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(a.x + abx * t - point.x, a.y + aby * t - point.y, a.z + abz * t - point.z);
}

// Removes velocity the collision pass refused to let us travel (walls, floors, ceilings).
export function clipVelocity(v: number, desired: number, actual: number): number {
  if (Math.abs(desired) < 1e-6) return v;
  const ratio = actual / desired;
  return ratio < 0.99 ? v * Math.max(0, ratio) : v;
}
