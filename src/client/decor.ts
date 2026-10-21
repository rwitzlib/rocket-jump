import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { DecorDef } from '../shared/map';
import type { Theme } from './themes';

// Scenery: everything on a map that isn't played on. None of it collides, so it lives where players
// can't go (beyond the walls, over the water, out past the islands) or is small enough to run through
// (grass, flowers). Built from primitives in the same chunky style as the rest of the game.
//
// Static pieces are baked into a few big meshes, one per kind of material, with their colors in the
// vertices: a hundred trees cost a handful of draw calls. Foliage carries a sway weight that a
// little wind in the vertex shader uses. Moving things (water, flags, flames, gulls) stay separate.

type BatchKind = 'solid' | 'flat' | 'foliage' | 'glow' | 'backdrop' | 'cloud' | 'paint';

const _l = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

/** Unit primitives, scaled into place by each part's matrix. */
const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 10),
  cylHi: new THREE.CylinderGeometry(1, 1, 1, 18),
  cone: new THREE.ConeGeometry(1, 1, 8),
  cone6: new THREE.ConeGeometry(1, 1, 6),
  sphere: new THREE.SphereGeometry(1, 12, 9),
  blob: new THREE.IcosahedronGeometry(1, 1),
  octa: new THREE.OctahedronGeometry(1, 0),
  plane: new THREE.PlaneGeometry(1, 1),
  torus: new THREE.TorusGeometry(1, 0.28, 8, 16),
};

class Batch {
  private readonly parts: THREE.BufferGeometry[] = [];

  /** `worldUv`: give the parts UVs from their world X/Z, for a texture laid flat across the ground. */
  constructor(private readonly worldUv = false) {}

  /** `sway`: meters this part moves in the wind. `brightness` above 1 makes glowing parts bloom. */
  add(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, matrix: THREE.Matrix4, sway = 0, brightness = 1) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    g.applyMatrix4(matrix);
    const n = g.attributes.position.count;
    _c.set(color).multiplyScalar(brightness);
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) colors.set([_c.r, _c.g, _c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.setAttribute('aSway', new THREE.BufferAttribute(new Float32Array(n).fill(sway), 1));
    if (this.worldUv) {
      const pos = g.attributes.position;
      const uv = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) uv.set([pos.getX(i), -pos.getZ(i)], i * 2);
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }
    this.parts.push(g);
  }

  build(material: THREE.Material, shadows: boolean): THREE.Mesh | null {
    if (!this.parts.length) return null;
    const merged = mergeGeometries(this.parts);
    for (const p of this.parts) p.dispose();
    this.parts.length = 0;
    if (!merged) return null;
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }
}

/** Matrix from position, euler rotation and scale. */
function mat(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  return _l.compose(_v.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
}

/** Small deterministic random numbers, so the same map always looks the same. */
function rng(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A lumpy rock: an icosahedron with each corner pushed in or out (the same way wherever it's shared). */
function rockGeometry(seed: number, detail = 1): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed * 0.618) * 43758.5453;
    const k = 0.78 + (h - Math.floor(h)) * 0.4;
    pos.setXYZ(i, x * k, y * k * 0.85, z * k);
  }
  geo.computeVertexNormals();
  return geo;
}

/** A long drooping leaf, as a strip bent down along its length. Points along +Z from the origin. */
function leafGeometry(length: number, width: number, droop: number): THREE.BufferGeometry {
  const segs = 6;
  const pos: number[] = [];
  const at = (t: number, side: number): [number, number, number] => {
    const w = Math.sin(Math.PI * Math.min(1, t * 1.15)) * width * 0.5;
    return [side * w, Math.sin(t * Math.PI * 0.6) * length * 0.18 - t * t * droop, t * length];
  };
  for (let i = 0; i < segs; i++) {
    const a = i / segs;
    const b = (i + 1) / segs;
    const [al, ac, ar] = [at(a, -1), at(a, 0), at(a, 1)];
    const [bl, bc, br] = [at(b, -1), at(b, 0), at(b, 1)];
    // A slight fold down the middle so it catches light on both halves.
    ac[1] += width * 0.08;
    bc[1] += width * 0.08;
    pos.push(...al, ...bl, ...ac, ...ac, ...bl, ...bc, ...ac, ...bc, ...ar, ...ar, ...bc, ...br);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

const LEAF = leafGeometry(3.4, 0.9, 1.6);
const BLADE = (() => {
  // Three crossed grass blades.
  const pos: number[] = [];
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI + 0.3;
    const c = Math.cos(a) * 0.09;
    const s = Math.sin(a) * 0.09;
    const lean = (k - 1) * 0.12;
    pos.push(-c, 0, -s, c, 0, s, lean, 0.55 + k * 0.08, lean * 0.5);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
})();

/** Wind for foliage: the `aSway` attribute says how much each vertex moves. */
function windy(material: THREE.MeshStandardMaterial, time: { value: number }) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aSway;\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float ph = uTime * 1.6 + transformed.x * 0.35 + transformed.z * 0.27;
        transformed.x += sin(ph) * aSway;
        transformed.z += cos(ph * 0.83) * aSway * 0.6;
        transformed.y += sin(ph * 1.7) * aSway * 0.15;`,
      );
  };
  material.customProgramCacheKey = () => 'windy';
}

export interface Decor {
  /** Flat scenery that scorch marks should land on too (paint on the ground). */
  surfaces: THREE.Mesh[];
  update(dt: number): void;
}

/** Builds a map's scenery into the scene (or into a group, like a mover's, to move it all together). */
export function buildDecor(scene: THREE.Object3D, defs: readonly DecorDef[], theme: Theme): Decor {
  const time = { value: 0 };
  const batches: Record<BatchKind, Batch> = {
    solid: new Batch(),
    flat: new Batch(),
    foliage: new Batch(),
    glow: new Batch(),
    backdrop: new Batch(),
    cloud: new Batch(),
    paint: new Batch(true),
  };
  const animated: ((dt: number, t: number) => void)[] = [];
  const base = new THREE.Matrix4();
  const world = new THREE.Matrix4();
  const random = rng(1234);

  /** Adds a part in the current decor's own space. */
  const haze = new THREE.Color(theme.sky.horizon);
  const put = (kind: BatchKind, geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, local: THREE.Matrix4, sway = 0, brightness = 1) => {
    // Far scenery isn't fogged (it would vanish into the horizon): it's painted part way into the haze instead.
    if (kind === 'backdrop') color = _c.set(color).lerp(haze, 0.3).getHex();
    batches[kind].add(geo, color, world.multiplyMatrices(base, local), sway, brightness);
  };

  for (const d of defs) {
    const s = d.scale ?? 1;
    base.compose(_v.set(...d.pos), _q.setFromEuler(_e.set(0, d.yaw ?? 0, 0)), _s.setScalar(s));
    const seed = Math.round(d.pos[0] * 13 + d.pos[2] * 7 + d.pos[1] * 3);
    const r = rng(seed);
    switch (d.kind) {
      case 'palm': {
        // A curved trunk of tapering rings, a crown of drooping fronds and a few coconuts.
        const lean = 0.25 + r() * 0.2;
        let x = 0;
        let y = 0;
        const segs = 7;
        const height = 7 + r() * 2;
        for (let i = 0; i < segs; i++) {
          const t = i / segs;
          const rad = 0.32 - t * 0.12;
          const h = height / segs;
          const tilt = lean * t * 1.4;
          put('foliage', GEO.cyl, i % 2 ? 0x8a6a46 : 0x7a5c3c, mat(x, y + h / 2, 0, 0, 0, -tilt, rad, h * 1.05, rad), t * 0.08);
          x += Math.sin(tilt) * h;
          y += Math.cos(tilt) * h;
        }
        const leaves = 8;
        for (let k = 0; k < leaves; k++) {
          const a = (k / leaves) * Math.PI * 2 + r() * 0.3;
          const shade = k % 2 ? 0x4f9a3a : 0x3f8a32;
          put('foliage', LEAF, shade, mat(x, y, 0, 0.1 - r() * 0.25, a, 0, 1, 1, 0.9 + r() * 0.3), 0.18);
        }
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * Math.PI * 2;
          put('foliage', GEO.sphere, 0x5a3f22, mat(x + Math.cos(a) * 0.3, y - 0.35, Math.sin(a) * 0.3, 0, 0, 0, 0.2, 0.22, 0.2), 0.08);
        }
        break;
      }
      case 'tree': {
        // A round cartoon tree: a short trunk and a cluster of leafy blobs.
        const h = 3 + r() * 1.5;
        const leaf = d.color ?? 0x4f9a42;
        put('foliage', GEO.cyl, 0x6e4e34, mat(0, h / 2, 0, 0, 0, 0, 0.35, h, 0.35), 0.02);
        put('foliage', GEO.cyl, 0x6e4e34, mat(0.5, h * 0.75, 0, 0, 0, -0.7, 0.14, 1.4, 0.14), 0.04);
        const blobs = 5;
        for (let k = 0; k < blobs; k++) {
          const a = (k / blobs) * Math.PI * 2 + r();
          const rad = 1.4 + r() * 0.8;
          const dist = k === 0 ? 0 : 1.3;
          _c.set(leaf).offsetHSL((r() - 0.5) * 0.03, 0, (r() - 0.5) * 0.08);
          put('foliage', GEO.blob, _c.getHex(), mat(Math.cos(a) * dist, h + 1 + r() * 1.2 + (k === 0 ? 1 : 0), Math.sin(a) * dist, r(), r(), 0, rad, rad * 0.9, rad), 0.12);
        }
        break;
      }
      case 'pine': {
        const h = 6 + r() * 3;
        put('foliage', GEO.cyl, 0x5e4430, mat(0, 1, 0, 0, 0, 0, 0.3, 2, 0.3), 0.02);
        const tiers = 4;
        for (let k = 0; k < tiers; k++) {
          const t = k / tiers;
          const rad = 2.6 * (1 - t * 0.7);
          _c.set(d.color ?? 0x2f6e4a).offsetHSL(0, 0, t * 0.06);
          put('foliage', GEO.cone, _c.getHex(), mat(0, 2 + t * h * 0.85, 0, 0, r(), 0, rad, h / tiers + 1.2, rad), 0.05 + t * 0.08);
        }
        break;
      }
      case 'bush': {
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI * 2 + r();
          const rad = 0.7 + r() * 0.5;
          _c.set(d.color ?? 0x4a8a3a).offsetHSL(0, 0, (r() - 0.5) * 0.08);
          put('foliage', GEO.blob, _c.getHex(), mat(Math.cos(a) * 0.6, rad * 0.6, Math.sin(a) * 0.6, r(), r(), 0, rad, rad * 0.8, rad), 0.06);
        }
        break;
      }
      case 'rock': {
        const [w, h, dd] = d.size ?? [2, 1.4, 2];
        put('flat', rockGeometry(seed), d.color ?? 0x8a8478, mat(0, h * 0.35, 0, 0, r() * 6, 0, w / 2, h / 2, dd / 2));
        break;
      }
      case 'grass':
      case 'flowers': {
        // A patch of tufts scattered over a rectangle.
        const [w, , dd] = d.size ?? [8, 0, 8];
        const count = Math.min(Math.round(w * dd * (d.kind === 'grass' ? 0.35 : 0.15)), 900);
        const colors = d.kind === 'grass' ? [d.color ?? 0x5fa040] : [0xff6fa0, 0xffd04a, 0xffffff, 0xb07aff];
        for (let k = 0; k < count; k++) {
          const x = (r() - 0.5) * w;
          const z = (r() - 0.5) * dd;
          const sc = 0.7 + r() * 0.8;
          _c.set(d.color ?? 0x5fa040).offsetHSL((r() - 0.5) * 0.04, 0, (r() - 0.5) * 0.1);
          put('foliage', BLADE, _c.getHex(), mat(x, 0, z, 0, r() * 6, 0, sc, sc, sc), 0.06);
          if (d.kind === 'flowers') put('foliage', GEO.sphere, colors[Math.floor(r() * colors.length)], mat(x, 0.6 * sc, z, 0, 0, 0, 0.09, 0.07, 0.09), 0.06, 1.2);
        }
        break;
      }
      case 'lamp': {
        // A harbor street lamp: a dark post, a curled arm and a glowing lantern.
        put('solid', GEO.cyl, 0x2c3440, mat(0, 0.2, 0, 0, 0, 0, 0.25, 0.4, 0.25));
        put('solid', GEO.cyl, 0x2c3440, mat(0, 3, 0, 0, 0, 0, 0.09, 6, 0.09));
        put('solid', GEO.box, 0x2c3440, mat(0.5, 5.9, 0, 0, 0, 0, 1.1, 0.1, 0.1));
        put('solid', GEO.cone6, 0x2c3440, mat(1, 5.75, 0, 0, 0, 0, 0.32, 0.3, 0.32));
        put('glow', GEO.sphere, d.color ?? 0xffe0a0, mat(1, 5.5, 0, 0, 0, 0, 0.18, 0.18, 0.18), 0, 3);
        break;
      }
      case 'torch': {
        // A stone brazier on a post with a flickering flame.
        put('flat', GEO.cyl, 0x8a7a64, mat(0, 0.6, 0, 0, 0, 0, 0.22, 1.2, 0.22));
        put('flat', GEO.cyl, 0x6e6252, mat(0, 1.3, 0, 0, 0, 0, 0.45, 0.25, 0.45));
        put('flat', GEO.cone6, 0x6e6252, mat(0, 1.12, 0, Math.PI, 0, 0, 0.45, 0.2, 0.45));
        put('glow', GEO.cyl, 0xff8030, mat(0, 1.43, 0, 0, 0, 0, 0.36, 0.04, 0.36), 0, 2.5);
        const flame = new THREE.Group();
        const outer = new THREE.Mesh(GEO.cone, new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 0.6, 0.15), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
        outer.scale.set(0.3, 0.9, 0.3);
        outer.position.y = 0.45;
        const inner = new THREE.Mesh(GEO.cone, new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 2.2, 0.9) }));
        inner.scale.set(0.15, 0.5, 0.15);
        inner.position.y = 0.25;
        flame.add(outer, inner);
        flame.position.set(...d.pos).y += 1.45 * s;
        flame.scale.setScalar(s);
        scene.add(flame);
        const phase = r() * 10;
        animated.push((_dt, t) => {
          const f = 1 + Math.sin(t * 13 + phase) * 0.08 + Math.sin(t * 23 + phase * 2) * 0.06;
          flame.scale.set(s * (2 - f), s * f, s * (2 - f));
          flame.rotation.y = t * 2 + phase;
        });
        break;
      }
      case 'crystal': {
        const color = d.color ?? 0x7ae8ff;
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2 + r();
          const h = 1.2 + r() * 2;
          const tilt = k === 0 ? 0 : 0.35 + r() * 0.3;
          put('glow', GEO.octa, color, mat(Math.cos(a) * 0.4 * (k ? 1 : 0), h * 0.4, Math.sin(a) * 0.4 * (k ? 1 : 0), Math.sin(a) * tilt, 0, -Math.cos(a) * tilt, 0.3 + r() * 0.15, h, 0.3 + r() * 0.15), 0, k === 0 ? 1.6 : 1.2);
        }
        put('flat', rockGeometry(seed), 0x5a5468, mat(0, 0, 0, 0, 0, 0, 1.1, 0.5, 1.1));
        break;
      }
      case 'barrel': {
        const color = d.color ?? 0x2f6fb0;
        put('solid', GEO.cylHi, color, mat(0, 0.6, 0, 0, 0, 0, 0.4, 1.2, 0.4));
        put('solid', GEO.cylHi, 0x3a3a40, mat(0, 0.25, 0, 0, 0, 0, 0.415, 0.06, 0.415));
        put('solid', GEO.cylHi, 0x3a3a40, mat(0, 0.95, 0, 0, 0, 0, 0.415, 0.06, 0.415));
        break;
      }
      case 'bollard': {
        put('solid', GEO.cylHi, d.color ?? 0x30343a, mat(0, 0.35, 0, 0, 0, 0, 0.25, 0.7, 0.25));
        put('solid', GEO.cylHi, d.color ?? 0x30343a, mat(0, 0.72, 0, 0, 0, 0, 0.36, 0.12, 0.36));
        break;
      }
      case 'lifebuoy': {
        for (let k = 0; k < 8; k++) {
          // Red and white quarters around the ring.
          const a = (k / 8) * Math.PI * 2;
          put('solid', GEO.box, k % 2 ? 0xffffff : 0xe03a2e, mat(Math.cos(a) * 0.38, 0, Math.sin(a) * 0.38, 0, -a, 0, 0.16, 0.16, 0.32));
        }
        break;
      }
      case 'hook': {
        // A crane hook on its cable, hanging `size[1]` meters below the pulley.
        const len = d.size?.[1] ?? 10;
        put('solid', GEO.cyl, 0x2a2a2e, mat(0, -len / 2, 0, 0, 0, 0, 0.04, len, 0.04));
        put('solid', GEO.box, 0xf2c230, mat(0, -len - 0.3, 0, 0, 0, 0, 0.7, 0.6, 0.4));
        put('solid', GEO.torus, 0x4a4e56, mat(0, -len - 1.1, 0, 0, 0, 0, 0.35, 0.35, 0.35));
        break;
      }
      case 'flag':
      case 'banner': {
        const [w, h] = d.size ?? (d.kind === 'flag' ? [2.4, 1.5, 0] : [2, 4, 0]);
        if (d.kind === 'flag') {
          put('solid', GEO.cyl, 0xd8d8dc, mat(0, 3, 0, 0, 0, 0, 0.06, 6, 0.06));
          put('solid', GEO.sphere, 0xf2c230, mat(0, 6.05, 0, 0, 0, 0, 0.1, 0.1, 0.1));
        }
        const cloth = new THREE.Mesh(new THREE.PlaneGeometry(w, h, 12, 6), clothMaterial(d.color ?? 0xd94a3a, d.kind === 'banner', time));
        if (d.kind === 'flag') cloth.geometry.translate(w / 2, 6 - h / 2 - 0.05, 0);
        else cloth.geometry.translate(0, -h / 2, 0);
        cloth.position.set(...d.pos);
        cloth.rotation.y = d.yaw ?? 0;
        cloth.scale.setScalar(s);
        cloth.castShadow = true;
        scene.add(cloth);
        break;
      }
      case 'vines': {
        // Strands of leaves hanging down a wall face (the wall is behind, toward -Z).
        const [w, h] = d.size ?? [6, 5, 0];
        const strands = Math.round(w * 1.3);
        for (let k = 0; k < strands; k++) {
          const x = (k / strands - 0.5) * w + (r() - 0.5) * 0.4;
          const len = h * (0.4 + r() * 0.6);
          const leaves = Math.round(len * 2.2);
          for (let i = 0; i < leaves; i++) {
            _c.set(0x3f8a36).offsetHSL((r() - 0.5) * 0.04, 0, (r() - 0.5) * 0.12);
            put('foliage', GEO.blob, _c.getHex(), mat(x + (r() - 0.5) * 0.3, -(i / leaves) * len, 0.15, r(), r(), r(), 0.28, 0.2, 0.12), 0.03 + (i / leaves) * 0.06);
          }
        }
        break;
      }
      case 'statue': {
        // A great carved stone head, half buried, looking out over the temple.
        const stone = d.color ?? 0x9a8e74;
        put('flat', GEO.box, stone, mat(0, 3, 0, 0, 0, 0, 6, 6, 5));
        put('flat', GEO.box, stone, mat(0, 6.4, 0, 0, 0, 0, 6.4, 1.2, 5.4)); // headdress band
        put('flat', GEO.box, 0x7a6e58, mat(0, 7.4, 0, 0, 0, 0, 5.6, 1, 4.6));
        put('flat', GEO.box, 0x7a6e58, mat(0, 4.4, 2.55, 0, 0, 0, 5, 0.5, 0.3)); // brow
        for (const x of [-1.4, 1.4]) {
          put('flat', GEO.box, 0x5a5040, mat(x, 3.7, 2.52, 0, 0, 0, 1.3, 0.8, 0.12)); // eye sockets
          put('glow', GEO.box, 0x60f0c0, mat(x, 3.7, 2.6, 0, 0, 0, 0.5, 0.35, 0.05), 0, 2);
          put('flat', GEO.box, stone, mat(x * 2.35, 3, 0.2, 0, 0, 0, 0.6, 2.2, 1.4)); // ears
        }
        put('flat', GEO.box, stone, mat(0, 2.6, 2.8, -0.15, 0, 0, 1.3, 1.8, 0.9)); // nose
        put('flat', GEO.box, 0x6e6250, mat(0, 1.2, 2.55, 0, 0, 0, 2.6, 0.7, 0.2)); // lips
        break;
      }
      case 'water': {
        const [w, , dd] = d.size ?? [400, 0, 400];
        const water = new THREE.Mesh(new THREE.PlaneGeometry(w, dd).rotateX(-Math.PI / 2), waterMaterial(d.color ?? 0x2a8ab0, theme, time));
        water.position.set(...d.pos);
        water.receiveShadow = true;
        scene.add(water);
        break;
      }
      case 'mountains': {
        // A ring of peaks around the map at `size[0]` meters, `size[1]` tall, with snowy tops.
        const [radius, height] = d.size ?? [300, 80, 0];
        const color = d.color ?? 0x6a7a6a;
        const peaks = 26;
        for (let k = 0; k < peaks; k++) {
          const a = (k / peaks) * Math.PI * 2 + random() * 0.1;
          const dist = radius * (0.9 + random() * 0.25);
          const h = height * (0.5 + random() * 0.7);
          const wide = h * (1 + random() * 0.6);
          const x = Math.cos(a) * dist;
          const z = Math.sin(a) * dist;
          put('backdrop', rockGeometry(k * 17 + 3, 1), color, mat(x, 0, z, 0, random() * 6, 0, wide, h, wide));
          if (h > height * 0.8) put('backdrop', rockGeometry(k * 17 + 3, 1), 0xf4f6fa, mat(x, h * 0.62, z, 0, random() * 6, 0, wide * 0.38, h * 0.32, wide * 0.38));
        }
        break;
      }
      case 'islands': {
        // Little palm islands scattered on the sea around the map.
        const [radius] = d.size ?? [260, 0, 0];
        const count = 7;
        for (let k = 0; k < count; k++) {
          const a = (k / count) * Math.PI * 2 + random() * 0.5;
          const dist = radius * (0.85 + random() * 0.35);
          const x = Math.cos(a) * dist;
          const z = Math.sin(a) * dist;
          const size = 10 + random() * 14;
          put('backdrop', GEO.sphere, 0xe8d6a0, mat(x, -size * 0.18, z, 0, 0, 0, size, size * 0.25, size * 0.8));
          put('backdrop', rockGeometry(k * 31 + 5), 0x4f8a3e, mat(x + size * 0.1, size * 0.08, z, 0, random() * 6, 0, size * 0.6, size * 0.35, size * 0.5));
          for (let p = 0; p < 3; p++) {
            const px = x + (random() - 0.5) * size;
            const pz = z + (random() - 0.5) * size * 0.6;
            put('backdrop', GEO.cyl, 0x8a6a46, mat(px, 4, pz, 0, 0, 0.15, 0.3, 8, 0.3));
            put('backdrop', GEO.blob, 0x3f8a32, mat(px + 0.6, 8.2, pz, 0, random() * 6, 0, 2.6, 0.8, 2.6));
          }
        }
        break;
      }
      case 'floatingRock': {
        // The rocky underside of a floating island, hanging below `pos` (the island's bottom).
        const [w, depth, dd] = d.size ?? [20, 14, 20];
        put('flat', rockGeometry(seed), d.color ?? 0x8a6a5a, mat(0, -depth * 0.12, 0, 0, r() * 6, 0, w * 0.52, depth * 0.3, dd * 0.52));
        put('flat', GEO.cone6, d.color ?? 0x8a6a5a, mat(0, -depth * 0.55, 0, Math.PI, r() * 6, 0, w * 0.45, depth * 0.9, dd * 0.45));
        put('flat', GEO.cone6, 0x6e5448, mat(w * 0.15, -depth * 0.85, dd * 0.1, Math.PI, r() * 6, 0, w * 0.12, depth * 0.5, dd * 0.12));
        // A dangling root or two.
        for (let k = 0; k < 3; k++) {
          const a = r() * Math.PI * 2;
          put('foliage', GEO.cyl, 0x5a7a3a, mat(Math.cos(a) * w * 0.4, -1.5, Math.sin(a) * dd * 0.4, 0, 0, 0, 0.12, 3 + r() * 3, 0.12), 0.05);
        }
        break;
      }
      case 'cloudSea': {
        // Puffy clouds spread out below (or around) the map, drifting slowly.
        const [radius, , spread] = d.size ?? [250, 0, 60];
        const count = 70;
        for (let k = 0; k < count; k++) {
          const a = random() * Math.PI * 2;
          const dist = Math.sqrt(random()) * radius;
          const x = Math.cos(a) * dist;
          const z = Math.sin(a) * dist;
          const y = (random() - 0.5) * spread * 0.2;
          const puffs = 4 + Math.floor(random() * 4);
          for (let p = 0; p < puffs; p++) {
            const rad = 6 + random() * 10;
            put('cloud', GEO.blob, 0xffffff, mat(x + (random() - 0.5) * 24, y + random() * 4, z + (random() - 0.5) * 16, 0, random() * 6, 0, rad, rad * 0.6, rad));
          }
        }
        break;
      }
      case 'ship': {
        // A cargo ship moored offshore: hull, a deck stacked with containers, a bridge and a funnel.
        const hullColor = d.color ?? 0x2b3a55;
        const shape = new THREE.Shape();
        shape.moveTo(-9, -40);
        shape.lineTo(9, -40);
        shape.lineTo(9, 28);
        shape.quadraticCurveTo(9, 40, 0, 46);
        shape.quadraticCurveTo(-9, 40, -9, 28);
        shape.lineTo(-9, -40);
        const hull = new THREE.ExtrudeGeometry(shape, { depth: 9, bevelEnabled: false }).rotateX(-Math.PI / 2);
        put('backdrop', hull, hullColor, mat(0, -4, 0));
        put('backdrop', new THREE.ExtrudeGeometry(shape, { depth: 2.2, bevelEnabled: false }).rotateX(-Math.PI / 2), 0xb83a2e, mat(0, -6, 0, 0, 0, 0, 1.005, 1, 1.005));
        const palette = [0xd9583a, 0x3a8ad9, 0x4cae5a, 0xe0b03a, 0xffffff, 0x8a5ad0];
        for (let row = 0; row < 6; row++) {
          for (let col = 0; col < 3; col++) {
            const stack = 1 + Math.floor(random() * 3);
            for (let lvl = 0; lvl < stack; lvl++) {
              put('backdrop', GEO.box, palette[Math.floor(random() * palette.length)], mat(-5.4 + col * 5.4, 6.3 + lvl * 2.6, 26 - row * 9, 0, 0, 0, 5, 2.5, 8.6));
            }
          }
        }
        put('backdrop', GEO.box, 0xf4f4f4, mat(0, 11, -32, 0, 0, 0, 16, 12, 8));
        put('backdrop', GEO.box, 0x203040, mat(0, 15, -27.9, 0, 0, 0, 14, 1.4, 0.2));
        put('backdrop', GEO.box, 0xf4f4f4, mat(0, 18, -32, 0, 0, 0, 20, 0.6, 9));
        put('backdrop', GEO.cylHi, 0xd9583a, mat(0, 22, -36, 0, 0, 0, 2, 8, 2));
        put('backdrop', GEO.cylHi, 0x222222, mat(0, 26.2, -36, 0, 0, 0, 2.05, 0.6, 2.05));
        break;
      }
      case 'lighthouse': {
        put('backdrop', rockGeometry(seed), 0x7a7468, mat(0, 0, 0, 0, 0, 0, 12, 7, 10));
        for (let k = 0; k < 6; k++) {
          const r0 = 3.4 - k * 0.3;
          put('backdrop', GEO.cylHi, k % 2 ? 0xd9382e : 0xf6f6f2, mat(0, 6 + k * 4, 0, 0, 0, 0, r0, 4, r0));
        }
        put('backdrop', GEO.cylHi, 0x2a2e36, mat(0, 30.3, 0, 0, 0, 0, 2.6, 0.6, 2.6));
        put('glow', GEO.cylHi, 0xfff0b0, mat(0, 32, 0, 0, 0, 0, 1.4, 2.6, 1.4), 0, 3);
        put('backdrop', GEO.cone, 0xd9382e, mat(0, 34.4, 0, 0, 0, 0, 2, 2.2, 2));
        break;
      }
      case 'stripe': {
        // Paint on the ground (a line, or a whole patch of asphalt): a flat quad just above it.
        const [w, , dd] = d.size ?? [10, 0, 0.3];
        put('paint', GEO.plane, d.color ?? 0xf2c230, mat(0, 0.01 + (d.size?.[1] ?? 0), 0, -Math.PI / 2, 0, 0, w, dd, 1));
        break;
      }
      case 'windows': {
        // A grid of windows on a wall that faces +Z: dark glass in pale frames, `size` = [width, height, columns].
        const [w, h, cols] = d.size ?? [12, 2, 4];
        const pane = w / cols;
        for (let k = 0; k < cols; k++) {
          const x = -w / 2 + pane * (k + 0.5);
          put('solid', GEO.box, d.color ?? 0xe8e4da, mat(x, 0, 0.06, 0, 0, 0, pane * 0.8, h, 0.12));
          put('glow', GEO.box, 0x2a3e52, mat(x, 0.05, 0.13, 0, 0, 0, pane * 0.66, h * 0.82, 0.02), 0, 1);
          put('glow', GEO.box, 0x8fb4d0, mat(x - pane * 0.18, h * 0.22, 0.145, 0, 0, 0.6, pane * 0.08, h * 0.5, 0.01), 0, 1); // glint
          put('solid', GEO.box, d.color ?? 0xe8e4da, mat(x, -h / 2 - 0.08, 0.16, 0, 0, 0, pane * 0.86, 0.14, 0.3)); // sill
        }
        break;
      }
      case 'fender': {
        // An old tire hung on the quay wall as a fender, facing +Z.
        put('solid', GEO.torus, 0x1e1f22, mat(0, 0, 0, 0, 0, 0, 0.55, 0.55, 0.8));
        put('solid', GEO.cyl, 0x3a3a3e, mat(0, 0.9, -0.1, 0, 0, 0, 0.03, 1.2, 0.03));
        break;
      }
      case 'cone': {
        put('solid', GEO.box, 0x22252a, mat(0, 0.03, 0, 0, 0, 0, 0.5, 0.06, 0.5));
        put('solid', GEO.cone, 0xff6a1e, mat(0, 0.4, 0, 0, 0, 0, 0.2, 0.75, 0.2));
        put('solid', GEO.cyl, 0xf6f6f6, mat(0, 0.42, 0, 0, 0, 0, 0.125, 0.12, 0.125));
        break;
      }
      case 'pallets': {
        // A pallet stacked with shrink-wrapped sacks.
        const [w, h, dd] = d.size ?? [1.3, 1.1, 1.1];
        put('solid', GEO.box, 0xa8865a, mat(0, 0.07, 0, 0, 0, 0, w, 0.14, dd));
        put('solid', GEO.box, d.color ?? 0xd8d2c0, mat(0, 0.14 + (h - 0.14) / 2, 0, 0, 0, 0, w * 0.94, h - 0.14, dd * 0.94));
        put('solid', GEO.box, 0x8a6a46, mat(0, 0.14 + (h - 0.14) * 0.5, 0, 0, 0, 0, w * 0.96, 0.08, dd * 0.96)); // strap
        break;
      }
      case 'reel': {
        // A wooden cable drum lying on its side.
        put('solid', GEO.cylHi, 0x9a7650, mat(0, 0.9, -0.55, Math.PI / 2, 0, 0, 0.9, 0.12, 0.9));
        put('solid', GEO.cylHi, 0x9a7650, mat(0, 0.9, 0.55, Math.PI / 2, 0, 0, 0.9, 0.12, 0.9));
        put('solid', GEO.cylHi, d.color ?? 0x2b3a55, mat(0, 0.9, 0, Math.PI / 2, 0, 0, 0.62, 1.0, 0.62));
        break;
      }
      case 'rail': {
        // Crane rails: two steel rails on sleepers, running along Z for `size[2]` meters.
        const len = d.size?.[2] ?? 40;
        for (const x of [-0.75, 0.75]) put('solid', GEO.box, 0x8a9098, mat(x, 0.06, 0, 0, 0, 0, 0.12, 0.12, len));
        for (let z = -len / 2 + 0.5; z < len / 2; z += 1.4) put('paint', GEO.plane, 0x5a4a3a, mat(0, 0.012, z, -Math.PI / 2, 0, 0, 2.2, 0.35, 1));
        break;
      }
      case 'piling': {
        // A timber pile standing in the water under a jetty, `size[1]` tall.
        const h = d.size?.[1] ?? 6;
        put('solid', GEO.cyl, 0x5a4632, mat(0, -h / 2, 0, 0, 0, 0, 0.35, h, 0.35));
        put('solid', GEO.cyl, 0x2e4a3a, mat(0, -h + 1.2, 0, 0, 0, 0, 0.37, 1.4, 0.37)); // weed at the waterline
        break;
      }
      case 'balloon': {
        // A hot-air balloon drifting and bobbing in the distance.
        const g = new THREE.Group();
        const stripes = [d.color ?? 0xe0503a, 0xf2c84a];
        for (let k = 0; k < 8; k++) {
          const seg = new THREE.Mesh(
            new THREE.SphereGeometry(6, 6, 12, (k / 8) * Math.PI * 2, Math.PI / 4),
            new THREE.MeshStandardMaterial({ color: stripes[k % 2], roughness: 0.7, flatShading: true }),
          );
          seg.scale.set(1, 1.2, 1);
          g.add(seg);
        }
        const basket = new THREE.Mesh(GEO.box, new THREE.MeshStandardMaterial({ color: 0x7a5a3a }));
        basket.scale.set(1.6, 1.2, 1.6);
        basket.position.y = -10;
        const flameMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 1.6, 0.4) });
        const burner = new THREE.Mesh(GEO.cone, flameMat);
        burner.scale.set(0.3, 0.8, 0.3);
        burner.position.y = -8.2;
        g.add(basket, burner);
        for (const [x, z] of [[-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]]) {
          const rope = new THREE.Mesh(GEO.cyl, new THREE.MeshStandardMaterial({ color: 0x3a2a1a }));
          rope.scale.set(0.04, 4, 0.04);
          rope.position.set(x * 1.6, -7.5, z * 1.6);
          g.add(rope);
        }
        g.position.set(...d.pos);
        g.scale.setScalar(s);
        scene.add(g);
        const phase = r() * 10;
        const y0 = d.pos[1];
        animated.push((_dt, t) => {
          g.position.y = y0 + Math.sin(t * 0.3 + phase) * 3;
          g.rotation.y = t * 0.05 + phase;
          burner.visible = Math.sin(t * 0.7 + phase) > 0.3;
        });
        break;
      }
      case 'skyIslands': {
        // Small floating islands scattered around the map in the distance, each with a tree or two.
        const [radius, spread] = d.size ?? [260, 60, 0];
        const count = 14;
        for (let k = 0; k < count; k++) {
          const a = (k / count) * Math.PI * 2 + random() * 0.3;
          const dist = radius * (0.8 + random() * 0.45);
          const x = Math.cos(a) * dist;
          const z = Math.sin(a) * dist;
          const y = (random() - 0.4) * spread;
          const size = 8 + random() * 16;
          put('backdrop', GEO.cyl, 0x6fa84e, mat(x, y, z, 0, 0, 0, size, 1.4, size * 0.8));
          put('backdrop', rockGeometry(k * 13 + 1), 0x9a7466, mat(x, y - size * 0.25, z, 0, random() * 6, 0, size * 0.95, size * 0.35, size * 0.75));
          put('backdrop', GEO.cone6, 0x8a6458, mat(x, y - size * 0.9, z, Math.PI, random() * 6, 0, size * 0.75, size * 1.2, size * 0.6));
          for (let p = 0; p < 2; p++) {
            const px = x + (random() - 0.5) * size;
            const pz = z + (random() - 0.5) * size * 0.6;
            put('backdrop', GEO.cone, 0x2f6e4a, mat(px, y + 4, pz, 0, 0, 0, 2.2, 7, 2.2));
          }
        }
        break;
      }
      case 'waterfall': {
        // Water pouring down a cliff face (facing +Z) from `pos` for `size[1]` meters, foaming at the bottom.
        const [w, h] = d.size ?? [8, 20, 0];
        const fall = new THREE.Mesh(new THREE.PlaneGeometry(w, h, 1, 8), waterfallMaterial(time));
        fall.geometry.translate(0, -h / 2, 0.4);
        // Bow it out a little at the top, like water leaving a lip.
        const pos = fall.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) pos.setZ(i, pos.getZ(i) + Math.max(0, 1 + pos.getY(i) / h) ** 3 * 1.4);
        fall.position.set(...d.pos);
        fall.rotation.y = d.yaw ?? 0;
        scene.add(fall);
        for (let k = 0; k < 9; k++) {
          const x = (r() - 0.5) * w;
          const rad = 0.8 + r() * 1.1;
          put('cloud', GEO.blob, 0xffffff, mat(x, -h + rad * 0.3, 1.6 + r() * 1.5, r(), r(), 0, rad, rad * 0.7, rad));
        }
        put('flat', rockGeometry(seed), 0x7a6e5e, mat(-w / 2 - 1, -1, 0.8, 0, 0, 0, 1.8, 1.4, 1.6));
        put('flat', rockGeometry(seed + 1), 0x7a6e5e, mat(w / 2 + 1, -0.6, 0.8, 0, 0, 0, 1.6, 1.2, 1.6));
        break;
      }
      case 'halo': {
        // A ring of glowing runes floating high over the middle, turning slowly.
        const radius = d.size?.[0] ?? 16;
        const ring = new THREE.Group();
        const stone = new THREE.MeshStandardMaterial({ color: 0x8a7a9a, roughness: 0.8, flatShading: true });
        const glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(d.color ?? 0x9af0ff).multiplyScalar(2.2) });
        const segs = 16;
        for (let k = 0; k < segs; k++) {
          const a = (k / segs) * Math.PI * 2;
          const slab = new THREE.Mesh(GEO.box, stone);
          slab.scale.set(1.2, 1.6, (radius * Math.PI * 2) / segs - 0.5);
          slab.position.set(Math.cos(a) * radius, 0, Math.sin(a) * radius);
          slab.rotation.y = -a;
          const rune = new THREE.Mesh(GEO.box, glow);
          rune.scale.set(1.25, 0.4, ((radius * Math.PI * 2) / segs) * 0.45);
          rune.position.copy(slab.position);
          rune.rotation.y = -a;
          ring.add(slab, rune);
        }
        ring.position.set(...d.pos);
        scene.add(ring);
        animated.push((_dt, t) => {
          ring.rotation.y = t * 0.08;
          ring.position.y = d.pos[1] + Math.sin(t * 0.5) * 0.8;
        });
        break;
      }
      case 'runes': {
        // Glowing bands round a ring of radius `size[0]`: the runes on a mover's stone ring (see
        // Skyreach), which turns them with it.
        const radius = d.size?.[0] ?? 16;
        const segs = 16;
        const arc = (radius * Math.PI * 2) / segs;
        for (let k = 0; k < segs; k++) {
          const a = (k / segs) * Math.PI * 2;
          put('glow', GEO.box, d.color ?? 0x9af0ff, mat(Math.cos(a) * radius, 0, Math.sin(a) * radius, 0, -a, 0, 1.25, 0.4, arc * 0.45), 0, 2.2);
        }
        break;
      }
      case 'gull': {
        // A few gulls circling overhead.
        const birds = new THREE.Group();
        const wingGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.25, 0, 0, 0.25, 1.1, 0.1, 0], 3));
        wingGeo.computeVertexNormals();
        const birdMat = new THREE.MeshBasicMaterial({ color: 0xf6f6f6, side: THREE.DoubleSide });
        const flock: { g: THREE.Group; l: THREE.Mesh; r: THREE.Mesh; a: number; rad: number; h: number; sp: number }[] = [];
        for (let k = 0; k < 6; k++) {
          const g = new THREE.Group();
          const l = new THREE.Mesh(wingGeo, birdMat);
          const rr = new THREE.Mesh(wingGeo, birdMat);
          rr.scale.x = -1;
          const bodyMesh = new THREE.Mesh(GEO.sphere, birdMat);
          bodyMesh.scale.set(0.18, 0.15, 0.5);
          g.add(l, rr, bodyMesh);
          birds.add(g);
          flock.push({ g, l, r: rr, a: random() * 6, rad: 15 + random() * 30, h: random() * 10, sp: (0.15 + random() * 0.15) * (random() < 0.5 ? 1 : -1) });
        }
        birds.position.set(...d.pos);
        scene.add(birds);
        animated.push((dt, t) => {
          for (const b of flock) {
            b.a += b.sp * dt;
            b.g.position.set(Math.cos(b.a) * b.rad, b.h + Math.sin(t * 0.7 + b.a) * 2, Math.sin(b.a) * b.rad);
            b.g.rotation.y = -b.a - (b.sp > 0 ? 0 : Math.PI);
            const flap = Math.sin(t * 7 + b.a * 10) * 0.5;
            b.l.rotation.z = flap;
            b.r.rotation.z = -flap;
          }
        });
        break;
      }
    }
  }

  const standard = (opts: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ vertexColors: true, ...opts });
  const foliage = standard({ roughness: 0.85, side: THREE.DoubleSide });
  windy(foliage, time);
  const meshes = [
    batches.solid.build(standard({ roughness: 0.6, metalness: 0.1 }), true),
    batches.flat.build(standard({ roughness: 0.95, flatShading: true }), true),
    batches.foliage.build(foliage, true),
    batches.glow.build(new THREE.MeshBasicMaterial({ vertexColors: true }), false),
    batches.backdrop.build(standard({ roughness: 0.9, flatShading: true, fog: false }), false),
    batches.cloud.build(standard({ roughness: 1, emissive: new THREE.Color(theme.sky.cloudShade).multiplyScalar(0.5) }), false),
  ];
  const paintTex = groundTexture();
  const paint = batches.paint.build(
    standard({ roughness: 0.9, map: paintTex, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    false,
  );
  if (paint) paint.receiveShadow = true;
  for (const m of [...meshes, paint]) if (m) scene.add(m);
  const clouds = meshes[5];

  let t = 0;
  return {
    surfaces: paint ? [paint] : [],
    update(dt) {
      t += dt;
      time.value = t;
      for (const a of animated) a(dt, t);
      if (clouds) {
        clouds.rotation.y = t * 0.004;
        clouds.updateMatrix();
      }
    },
  };
}

/** Falling water: streaks scrolling down, brighter and foamier toward the bottom. */
function waterfallMaterial(time: { value: number }): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform float uTime;
      varying vec2 vUv;
      float h1(float x) { return fract(sin(x * 91.7) * 43758.5453); }
      void main() {
        float col = floor(vUv.x * 24.0);
        float speed = 0.9 + h1(col) * 0.6;
        float streak = fract(vUv.y * 3.0 + uTime * speed + h1(col + 7.0));
        float bright = smoothstep(0.6, 1.0, streak) * 0.5 + 0.5;
        vec3 water = mix(vec3(0.35, 0.7, 0.85), vec3(0.85, 0.96, 1.0), bright);
        water = mix(water, vec3(1.0), smoothstep(0.25, 0.0, vUv.y) * 0.7);
        float edge = smoothstep(0.0, 0.06, vUv.x) * smoothstep(1.0, 0.94, vUv.x);
        gl_FragColor = vec4(water, 0.88 * edge);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });
  material.uniforms.uTime = time;
  return material;
}

/** A light, speckled texture for paint on the ground, so it wears like the concrete under it. */
function groundTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#e8e8e8';
  ctx.fillRect(0, 0, size, size);
  const r = rng(77);
  for (let i = 0; i < 900; i++) {
    const v = Math.round(190 + r() * 65);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(r() * size, r() * size, 1 + r() * 3, 1 + r() * 3);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.setScalar(1 / 3);
  tex.anisotropy = 8;
  return tex;
}

/** Cloth on a pole (pinned along its left edge) or hanging from a bar (pinned along its top). */
function clothMaterial(color: number, banner: boolean, time: { value: number }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.8, side: THREE.DoubleSide });
  if (banner) {
    m.map = bannerTexture(color);
    m.color.set(0xffffff);
    m.alphaTest = 0.5; // the swallowtail notch
  }
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;').replace(
      '#include <begin_vertex>',
      banner
        ? `#include <begin_vertex>
           float pin = clamp(-transformed.y / 4.0, 0.0, 1.0);
           transformed.z += sin(uTime * 1.8 + transformed.y * 1.2 + transformed.x * 0.8) * 0.18 * pin;`
        : `#include <begin_vertex>
           float pin = clamp(uv.x, 0.0, 1.0);
           transformed.z += sin(uTime * 5.0 - uv.x * 7.0) * 0.28 * pin;
           transformed.y += sin(uTime * 3.0 - uv.x * 5.0) * 0.08 * pin;`,
    );
  };
  m.customProgramCacheKey = () => (banner ? 'banner' : 'flag');
  return m;
}

/** A banner: a colored field with a gold border and a sun emblem, ending in a swallowtail. */
function bannerTexture(color = 0xd94a3a): THREE.CanvasTexture {
  const w = 128;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(w, 0);
  ctx.lineTo(w, h);
  ctx.lineTo(w / 2, h - 40);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#f2c84a';
  ctx.lineWidth = 8;
  ctx.stroke();
  ctx.fillStyle = '#f2c84a';
  ctx.beginPath();
  ctx.arc(w / 2, 95, 26, 0, Math.PI * 2);
  ctx.fill();
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    ctx.save();
    ctx.translate(w / 2, 95);
    ctx.rotate(a);
    ctx.fillRect(-3, 30, 6, 14);
    ctx.restore();
  }
  // The cut-out swallowtail is transparent.
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Cartoon water: bands of color rolling across it, glints of foam, and the sky reflected toward the horizon. */
function waterMaterial(color: number, theme: Theme, time: { value: number }): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        deep: { value: new THREE.Color(color).multiplyScalar(0.7) },
        shallow: { value: new THREE.Color(color).offsetHSL(-0.02, 0, 0.12) },
        sky: { value: new THREE.Color(theme.sky.horizon) },
        sunColor: { value: new THREE.Color(theme.sky.sunColor) },
        sunDir: { value: new THREE.Vector3(...theme.sunDir).normalize() },
      },
    ]),
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      varying vec3 vWorld;
      void main() {
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        vec4 mvPosition = viewMatrix * vec4(vWorld, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform vec3 deep;
      uniform vec3 shallow;
      uniform vec3 sky;
      uniform vec3 sunColor;
      uniform vec3 sunDir;
      uniform float uTime;
      varying vec3 vWorld;
      float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y);
      }
      void main() {
        vec2 p = vWorld.xz;
        float t = uTime;
        float n = vnoise(p * 0.07 + vec2(t * 0.05, t * 0.03)) * 0.6 + vnoise(p * 0.19 - vec2(t * 0.08, -t * 0.04)) * 0.4;
        float bands = sin(p.x * 0.09 + p.y * 0.05 + t * 0.6 + n * 5.0) * 0.5 + 0.5;
        vec3 col = mix(deep, shallow, smoothstep(0.2, 0.9, n * 0.7 + bands * 0.3));
        // Sparse foam glints where two noise layers both peak.
        float m = vnoise(p * 0.45 + vec2(t * 0.3, t * 0.2)) * vnoise(p * 0.31 - vec2(t * 0.25, -t * 0.1));
        float crest = smoothstep(0.42, 0.55, m) * smoothstep(0.35, 0.7, n);
        col = mix(col, vec3(0.92, 0.97, 1.0), crest * 0.6);
        vec3 V = normalize(cameraPosition - vWorld);
        float fres = pow(clamp(1.0 - V.y, 0.0, 1.0), 4.0);
        col = mix(col, sky, fres * 0.7);
        vec3 R = reflect(-V, vec3(0.0, 1.0, 0.0));
        float glint = pow(max(dot(R, sunDir), 0.0), 220.0) * step(0.5, n);
        col += sunColor * glint * 3.0;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
    fog: true,
  });
  material.uniforms.uTime = time; // shared with the rest of the scenery, so it isn't copied by merge()
  return material;
}
