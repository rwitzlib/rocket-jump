import * as THREE from 'three';
import { CRATE } from '../shared/config';
import type { BoxDef, MapDef, RingDef } from '../shared/map';
import { moverPose } from '../shared/mover';
import type { GameSim } from '../shared/sim';
import { buildDecor } from './decor';
import { Sky } from './sky';
import { crateTexture, levelMaterial } from './surfaces';
import { THEMES, type Theme } from './themes';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const ONE = new THREE.Vector3(1, 1, 1);

/**
 * A box mesh's geometry with UVs in meters, and an `aBase` attribute (height above the box's
 * bottom) for contact shadow. Axis-aligned boxes take their UVs from world position, so textures
 * run on seamlessly across neighboring boxes; rotated ones (ramps, bridges) use their own faces.
 */
function boxGeometry(box: BoxDef, localFaces: number[] = []): THREE.BoxGeometry {
  const [w, h, d] = box.size;
  const geo = new THREE.BoxGeometry(w, h, d);
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = geo.attributes.uv;
  const base = new Float32Array(pos.count);
  if (box.rot) {
    const faces = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    for (let i = 0; i < pos.count; i++) {
      const f = Math.floor(i / 4);
      uv.setXY(i, uv.getX(i) * faces[f][0], uv.getY(i) * faces[f][1]);
    }
  } else {
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + box.pos[0];
      const y = pos.getY(i) + box.pos[1];
      const z = pos.getZ(i) + box.pos[2];
      const nx = nor.getX(i);
      const ny = nor.getY(i);
      // u runs to the right as you face the surface, v runs up (or north on floors).
      if (nx !== 0) uv.setXY(i, -z * nx, y);
      else if (ny !== 0) uv.setXY(i, x, -z * ny);
      else uv.setXY(i, x * nor.getZ(i), y);
    }
  }
  // Faces that show one picture each (a container's doors) keep BoxGeometry's own 0..1 UVs.
  const original = new THREE.BoxGeometry(w, h, d).attributes.uv;
  for (const f of localFaces) for (let v = 0; v < 4; v++) uv.setXY(f * 4 + v, original.getX(f * 4 + v), original.getY(f * 4 + v));
  for (let i = 0; i < pos.count; i++) base[i] = pos.getY(i) + h / 2;
  geo.setAttribute('aBase', new THREE.BufferAttribute(base, 1));
  return geo;
}

/** The end faces of a box shaped like a shipping container (12 m long, 2.6 m square), if it is one. */
function containerEnds(box: BoxDef): number[] {
  const [w, h, d] = box.size;
  if (h !== 2.6) return [];
  if (w === 12 && d === 2.6) return [0, 1];
  if (d === 12 && w === 2.6) return [4, 5];
  return [];
}

export interface Level {
  /** Static level meshes (scorch marks get projected onto them). */
  meshes: THREE.Mesh[];
  theme: Theme;
  /** Half-width of the map, meters. */
  extent: number;
  bounds: THREE.Box3;
  /** `moverTick`: where to draw the moving solids (MapDef.movers), in ticks. */
  update(dt: number, camera: THREE.Camera, moverTick?: number): void;
}

/** One of a level's boxes, painted with its surfaces (the map editor builds them one at a time too). */
export function boxMesh(box: BoxDef): THREE.Mesh {
  const side = levelMaterial(box.mat ?? 'grid', box.color);
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z.
  const faces = [side, side, box.top ? levelMaterial(box.top.mat, box.top.color) : side, side, side, side];
  // A shipping container gets its doors on both ends.
  const ends = box.mat === 'container' ? containerEnds(box) : [];
  for (const f of ends) faces[f] = levelMaterial('doors', box.color);
  const material = faces.every((m) => m === side) ? side : faces;
  const mesh = new THREE.Mesh(boxGeometry(box, ends), material);
  mesh.position.set(...box.pos);
  if (box.rot) mesh.rotation.set(...box.rot);
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.updateMatrixWorld();
  return mesh;
}

/**
 * A ring (see RingDef), the same shape it collides as: flat top and bottom, the walls smooth round
 * the curve. UVs in meters (the walls' u runs round the middle radius), and `aBase` like a box's.
 */
export function ringMesh(ring: RingDef): THREE.Mesh {
  const n = ring.segments ?? 64;
  const r0 = ring.radius - ring.width / 2;
  const r1 = ring.radius + ring.width / 2;
  const h = ring.height / 2;
  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  const base: number[] = [];
  const index: number[] = [];
  // Each face of the cross-section, swept round: its two edges (radius, height), and which way it faces.
  const faces: [number, number, number, number, 'in' | 'up' | 'out' | 'down'][] = [
    [r0, -h, r0, h, 'in'],
    [r0, h, r1, h, 'up'],
    [r1, h, r1, -h, 'out'],
    [r1, -h, r0, -h, 'down'],
  ];
  for (const [ra, ya, rb, yb, facing] of faces) {
    const start = position.length / 3;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      for (const [r, y] of [[ra, ya], [rb, yb]]) {
        position.push(c * r, y, s * r);
        const [nx, ny, nz] = facing === 'up' ? [0, 1, 0] : facing === 'down' ? [0, -1, 0] : facing === 'out' ? [c, 0, s] : [-c, 0, -s];
        normal.push(nx, ny, nz);
        if (facing === 'up' || facing === 'down') uv.push(c * r, s * r);
        else uv.push(a * ring.radius, y);
        base.push(y + h);
      }
    }
    for (let i = 0; i < n; i++) {
      const a = start + i * 2;
      // (Same outward winding as the collision mesh.)
      index.push(a, a + 3, a + 1, a, a + 2, a + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('aBase', new THREE.Float32BufferAttribute(base, 1));
  geo.setIndex(index);
  const mesh = new THREE.Mesh(geo, levelMaterial(ring.mat ?? 'grid', ring.color));
  mesh.position.set(...ring.pos);
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

/** Builds the static level: boxes, sky, light, fog and scenery. */
export function buildLevel(scene: THREE.Scene, map: MapDef): Level {
  const theme = THEMES[map.theme ?? 'classic'] ?? THEMES.classic;
  // Everything below is sized from the map's footprint, so bigger maps keep their shadows and stay visible.
  const bounds = new THREE.Box3();
  for (const box of map.boxes) {
    if (box.hidden) continue;
    bounds.union(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(...box.pos), new THREE.Vector3(...box.size)));
  }
  const extent = Math.max(-bounds.min.x, bounds.max.x, -bounds.min.z, bounds.max.z);

  const sky = new Sky(theme);
  scene.add(sky.mesh);
  scene.background = new THREE.Color(theme.sky.horizon);
  scene.fog = new THREE.Fog(theme.sky.horizon, Math.max(60, extent * theme.fog[0]), Math.max(180, extent * theme.fog[1]));

  scene.add(new THREE.HemisphereLight(theme.hemi.sky, theme.hemi.ground, theme.hemi.intensity));
  const sun = new THREE.DirectionalLight(theme.sun.color, theme.sun.intensity);
  // One shadow map over the whole level: the light sits outside a sphere around it, looking at its center.
  const center = bounds.getCenter(new THREE.Vector3());
  const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius;
  sun.position.copy(center).addScaledVector(new THREE.Vector3(...theme.sunDir).normalize(), radius + 10);
  sun.target.position.copy(center);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -radius;
  sun.shadow.camera.right = sun.shadow.camera.top = radius;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = radius * 2 + 20;
  sun.shadow.bias = -0.1 / sun.shadow.camera.far; // about 10 cm in world units, whatever the map size
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 2.5;
  scene.add(sun, sun.target);

  const meshes = map.boxes.filter((box) => !box.hidden).map((box) => {
    const mesh = boxMesh(box);
    scene.add(mesh);
    return mesh;
  });

  const decor = buildDecor(scene, map.decor ?? [], theme);

  // Moving solids: their boxes and scenery in a group each, posed from the tick every frame. (Not
  // in `meshes`: a scorch mark projected onto one would hang in the air when it moved on.)
  const movers = (map.movers ?? []).map((def) => {
    const group = new THREE.Group();
    for (const box of def.boxes) if (!box.hidden) group.add(boxMesh(box));
    for (const ring of def.rings ?? []) group.add(ringMesh(ring));
    const parts = buildDecor(group, def.decor ?? [], theme);
    scene.add(group);
    return { def, group, decor: parts };
  });

  return {
    meshes: [...meshes, ...decor.surfaces],
    theme,
    extent,
    bounds,
    update(dt, _camera, moverTick = 0) {
      sky.update(dt);
      decor.update(dt);
      for (const m of movers) {
        moverPose(m.def, moverTick, m.group.position, m.group.quaternion);
        m.decor.update(dt);
      }
    },
  };
}

/** Dynamic crate meshes that follow their physics bodies. */
export class CrateView {
  private readonly mesh: THREE.InstancedMesh;

  constructor(scene: THREE.Scene, private readonly sim: GameSim) {
    const geo = new THREE.BoxGeometry(CRATE.size, CRATE.size, CRATE.size);
    const { map, normalMap } = crateTexture();
    const mat = new THREE.MeshStandardMaterial({ map, normalMap, roughness: 0.75 });
    // One draw call for every crate.
    this.mesh = new THREE.InstancedMesh(geo, mat, Math.max(sim.crates.length, 1));
    this.mesh.count = sim.crates.length;
    this.mesh.castShadow = this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    // Different crates get turned a different way, so the brace doesn't line up across a stack.
    this.flips = sim.crates.map((_, i) => new THREE.Quaternion().setFromEuler(_e.set(0, (((i * 7) % 4) * Math.PI) / 2, 0)));
    this.sync(true);
  }

  private readonly flips: THREE.Quaternion[];

  sync(force = false) {
    let changed = false;
    this.sim.crates.forEach((body, i) => {
      // Resting crates are asleep and can't have moved. Skipping them also avoids allocating
      // Rapier result objects for every crate on every frame.
      if (body.isSleeping() && !force) return;
      const t = body.translation();
      const r = body.rotation();
      _q.set(r.x, r.y, r.z, r.w).multiply(this.flips[i]);
      _m.compose(_p.set(t.x, t.y, t.z), _q, ONE);
      this.mesh.setMatrixAt(i, _m);
      changed = true;
    });
    if (changed) this.mesh.instanceMatrix.needsUpdate = true;
  }
}
