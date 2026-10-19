import * as THREE from 'three';
import { CRATE } from '../shared/config';
import type { BoxDef, MapDef } from '../shared/map';
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
  update(dt: number, camera: THREE.Camera): void;
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
    scene.add(mesh);
    return mesh;
  });

  const decor = buildDecor(scene, map.decor ?? [], theme);

  return {
    meshes: [...meshes, ...decor.surfaces],
    theme,
    extent,
    bounds,
    update(dt) {
      sky.update(dt);
      decor.update(dt);
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
