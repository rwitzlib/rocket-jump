import RAPIER from '@dimforge/rapier3d-compat';
import { Euler, Quaternion, Vector3 } from 'three';
import { DT } from './config';
import type { MoverDef, RingDef } from './map';

// Moving level geometry (MapDef.movers). A mover's pose is a pure function of the tick, so the
// server, every client's prediction and its replays all put it in the same place for the same tick
// with nothing on the wire.
//
// Rapier only refreshes what ray casts and the character controller can see in world.step(), so a
// collider moved without a step is invisible to them. The sim therefore places movers for the
// coming tick just before each step (`place`), and `ensure` steps the world first when a tick is
// simulated out of order (a client replaying inputs after a correction).

const UP = new Vector3(0, 1, 0);
const _p = new Vector3();
const _q = new Quaternion();
const _qFrom = new Quaternion();
const _v = new Vector3();

/** Where a mover is at a tick (fractional ticks are fine, for drawing between ticks). */
export function moverPose(def: MoverDef, tick: number, outPos: Vector3, outRot: Quaternion) {
  const t = tick * DT;
  outPos.set(...def.pivot);
  if (def.bob) outPos.y += Math.sin(t * def.bob[1]) * def.bob[0];
  return outRot.setFromAxisAngle(UP, t * (def.spin ?? 0));
}

/**
 * A ring's closed surface, as a triangle mesh with outward-facing triangles: four corners per step
 * round the circle (inner bottom, inner top, outer top, outer bottom), joined to the next step's.
 */
export function ringMesh(ring: RingDef): { vertices: Float32Array; indices: Uint32Array } {
  const n = ring.segments ?? 64;
  const r0 = ring.radius - ring.width / 2;
  const r1 = ring.radius + ring.width / 2;
  const h = ring.height / 2;
  const [cx, cy, cz] = ring.pos;
  const vertices = new Float32Array(n * 4 * 3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const corners = [
      [r0, -h],
      [r0, h],
      [r1, h],
      [r1, -h],
    ];
    corners.forEach(([r, y], k) => vertices.set([cx + c * r, cy + y, cz + s * r], (i * 4 + k) * 3));
  }
  // Each face of the cross-section (inner wall, top, outer wall, bottom) swept round: corner k to k+1.
  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    for (let k = 0; k < 4; k++) {
      const k1 = (k + 1) % 4;
      const a = i * 4 + k;
      const b = i * 4 + k1;
      const c = j * 4 + k;
      const d = j * 4 + k1;
      indices.push(a, d, b, a, c, d);
    }
  }
  return { vertices, indices: new Uint32Array(indices) };
}

export class Movers {
  readonly defs: readonly MoverDef[];
  private readonly bodies: RAPIER.RigidBody[] = [];
  private readonly byBody = new Map<number, number>(); // rigid-body handle -> mover index
  /** The tick the colliders are placed for (and the world stepped since), or NaN before the first. */
  private placed = NaN;

  constructor(
    private readonly world: RAPIER.World,
    defs: readonly MoverDef[] = [],
  ) {
    this.defs = defs;
    const q = new Quaternion();
    defs.forEach((def, index) => {
      // Fixed, not kinematic: the level's static queries (sight lines, the camera, bodies landing)
      // leave kinematic bodies out, and this is level. It's teleported a little every tick.
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      for (const box of def.boxes) {
        q.setFromEuler(new Euler(...(box.rot ?? [0, 0, 0])));
        world.createCollider(
          RAPIER.ColliderDesc.cuboid(box.size[0] / 2, box.size[1] / 2, box.size[2] / 2)
            .setTranslation(...box.pos)
            .setRotation(q),
          body,
        );
      }
      for (const ring of def.rings ?? []) {
        const { vertices, indices } = ringMesh(ring);
        // Fixing internal edges keeps contacts on the flat top pointing straight up, so walking
        // across from one triangle to the next doesn't catch.
        world.createCollider(RAPIER.ColliderDesc.trimesh(vertices, indices, RAPIER.TriMeshFlags.ORIENTED | RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES), body);
      }
      this.byBody.set(body.handle, index);
      this.bodies.push(body);
    });
  }

  get length() {
    return this.defs.length;
  }

  /** Puts every mover where it is at `tick`. Ray casts see it there after the next world.step(). */
  place(tick: number) {
    if (!this.defs.length) return;
    this.placed = tick;
    this.bodies.forEach((body, i) => {
      moverPose(this.defs[i], tick, _p, _q);
      body.setTranslation(_p, false);
      body.setRotation(_q, false);
    });
  }

  /** Makes sure the movers are at `tick` and visible to queries, stepping the world if they weren't. */
  ensure(tick: number) {
    if (!this.defs.length || this.placed === tick) return;
    this.place(tick);
    this.world.step();
  }

  /** Which mover a collider belongs to, or -1 for anything else. */
  indexOf(collider: RAPIER.Collider): number {
    const body = collider.parent();
    return body ? (this.byBody.get(body.handle) ?? -1) : -1;
  }

  /** Moves a point riding on mover `index` from where it was at tick `from` to where that spot is at `to`. */
  carry(index: number, from: number, to: number, point: Vector3) {
    const def = this.defs[index];
    moverPose(def, from, _v, _qFrom);
    point.sub(_v).applyQuaternion(_qFrom.invert());
    this.toWorld(index, to, point, point);
  }

  /** A world point into mover `index`'s own frame at `tick`. */
  toLocal(index: number, tick: number, world: Vector3, out: Vector3): Vector3 {
    moverPose(this.defs[index], tick, _v, _qFrom);
    return out.copy(world).sub(_v).applyQuaternion(_qFrom.invert());
  }

  /** A point in mover `index`'s own frame out to the world at `tick`. */
  toWorld(index: number, tick: number, local: Vector3, out: Vector3): Vector3 {
    moverPose(this.defs[index], tick, _v, _q);
    return out.copy(local).applyQuaternion(_q).add(_v);
  }

  /** Mover `index`'s rotation at `tick`. */
  rotation(index: number, tick: number, out: Quaternion): Quaternion {
    return moverPose(this.defs[index], tick, _v, out);
  }
}
