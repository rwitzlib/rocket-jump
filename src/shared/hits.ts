import { Vector3 } from 'three';
import { PLAYER } from './config';

// Player hit tests done by hand instead of through Rapier, so they can run against positions
// other than where the colliders are right now: where the server says a player was when the shooter
// saw them (lag compensation), or where a client is drawing remote players.

/** Furthest back the server will rewind players for a hit test: 500 ms, enough for ~300 ms ping plus interpolation. */
export const REWIND_TICKS = 30;
const HISTORY_SIZE = 40; // > REWIND_TICKS + 1, so the oldest rewindable tick and the one after it are kept

const _p = new Vector3();

/**
 * Distance along a normalized ray to a player's capsule (`center` = capsule center), or null if it
 * misses within `maxDist`. A ray starting inside the capsule hits at 0.
 */
export function rayCapsule(o: Vector3, d: Vector3, center: Vector3, maxDist: number): number | null {
  const h = PLAYER.halfHeight;
  const r = PLAYER.radius;
  let best = Infinity;

  // The cylinder between the two end spheres.
  const ox = o.x - center.x;
  const oz = o.z - center.z;
  const c = ox * ox + oz * oz - r * r;
  if (c <= 0 && Math.abs(o.y - center.y) <= h) return 0;
  const a = d.x * d.x + d.z * d.z;
  if (a > 1e-9) {
    const b = ox * d.x + oz * d.z;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / a;
      if (t >= 0 && Math.abs(o.y + d.y * t - center.y) <= h) best = t;
    }
  }

  // The end spheres.
  for (let k = -1; k <= 1; k += 2) {
    const oy = o.y - (center.y + k * h);
    const b = ox * d.x + oy * d.y + oz * d.z;
    const cc = ox * ox + oy * oy + oz * oz - r * r;
    if (cc <= 0) return 0;
    const disc = b * b - cc;
    if (disc < 0) continue;
    const t = -b - Math.sqrt(disc);
    if (t >= 0 && t < best) best = t;
  }

  return best <= maxDist ? best : null;
}

/** Outward surface normal of a player's capsule at `point`. */
export function capsuleNormal(point: Vector3, center: Vector3, out: Vector3): Vector3 {
  const y = Math.min(Math.max(point.y, center.y - PLAYER.halfHeight), center.y + PLAYER.halfHeight);
  out.set(point.x - center.x, point.y - y, point.z - center.z);
  return out.lengthSq() > 1e-9 ? out.normalize() : out.set(0, 1, 0);
}

/** The last few ticks of one player's positions, for rewinding them to what a shooter saw. */
export class PositionHistory {
  private readonly ticks = new Int32Array(HISTORY_SIZE).fill(-1);
  private readonly xyz = new Float64Array(HISTORY_SIZE * 3);

  record(tick: number, pos: Vector3) {
    const i = tick % HISTORY_SIZE;
    this.ticks[i] = tick;
    this.xyz[i * 3] = pos.x;
    this.xyz[i * 3 + 1] = pos.y;
    this.xyz[i * 3 + 2] = pos.z;
  }

  /** Forget everything, e.g. after a respawn, so a rewind never lands between two lives. */
  clear() {
    this.ticks.fill(-1);
  }

  /** Position at a (fractional) tick. Returns false if that tick wasn't recorded. */
  sample(tick: number, out: Vector3): boolean {
    const t0 = Math.floor(tick);
    const i0 = t0 % HISTORY_SIZE;
    if (t0 < 0 || this.ticks[i0] !== t0) return false;
    out.set(this.xyz[i0 * 3], this.xyz[i0 * 3 + 1], this.xyz[i0 * 3 + 2]);
    const f = tick - t0;
    const i1 = (t0 + 1) % HISTORY_SIZE;
    if (f > 0 && this.ticks[i1] === t0 + 1) {
      out.lerp(_p.set(this.xyz[i1 * 3], this.xyz[i1 * 3 + 1], this.xyz[i1 * 3 + 2]), f);
    }
    return true;
  }
}
