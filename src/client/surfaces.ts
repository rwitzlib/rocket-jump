import * as THREE from 'three';
import type { SurfaceKind } from '../shared/map';

// Painted surfaces for level geometry, drawn on canvases at startup: no image files to load. Each
// kind is a light, mostly grey pattern that the box's color tints, plus a height field turned into a
// normal map so grout, seams and planks catch the light. Textures repeat every `tile` meters, mapped
// from world position so neighboring boxes line up.
//
// Every level material also gets two cheap touches in its shader: contact shadow toward the bottom
// of each box (fake ambient occlusion where walls meet the floor), and a slow world-space
// brightness wobble that breaks up the repetition of a texture over big floors.

const SIZE = 256;

interface SurfaceSpec {
  tile: number; // meters per repeat
  roughness: number;
  metalness?: number;
  bump: number; // normal map strength
  /** Paints albedo (0..255 grey or color) and height (0..1) per pixel. */
  paint(ctx: Painter): void;
}

/** Albedo and height canvases being painted together. */
class Painter {
  readonly albedo: CanvasRenderingContext2D;
  readonly height: CanvasRenderingContext2D;
  private seed: number;

  constructor(seed: number) {
    this.seed = seed;
    const mk = () => {
      const c = document.createElement('canvas');
      c.width = c.height = SIZE;
      return c.getContext('2d', { willReadFrequently: true })!;
    };
    this.albedo = mk();
    this.height = mk();
    this.fill('#ffffff', 0.5);
  }

  rand(): number {
    // mulberry32
    let t = (this.seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  fill(color: string, height: number) {
    this.albedo.fillStyle = color;
    this.albedo.fillRect(0, 0, SIZE, SIZE);
    this.height.fillStyle = grey(height);
    this.height.fillRect(0, 0, SIZE, SIZE);
  }

  /** A rectangle drawn wrapped around the edges, so patterns tile. */
  rect(x: number, y: number, w: number, h: number, color: string | null, height: number | null) {
    for (const dx of [0, -SIZE, SIZE]) {
      for (const dy of [0, -SIZE, SIZE]) {
        if (x + dx + w < 0 || x + dx > SIZE || y + dy + h < 0 || y + dy > SIZE) continue;
        if (color) {
          this.albedo.fillStyle = color;
          this.albedo.fillRect(x + dx, y + dy, w, h);
        }
        if (height !== null) {
          this.height.fillStyle = grey(height);
          this.height.fillRect(x + dx, y + dy, w, h);
        }
      }
    }
  }

  /** A raised block with sloped (beveled) edges and a shade of its own. */
  block(x: number, y: number, w: number, h: number, shade: number, bevel: number, top = 0.8) {
    for (let i = 0; i <= bevel; i++) {
      const t = i / Math.max(bevel, 1);
      this.rect(x + i, y + i, w - i * 2, h - i * 2, null, 0.2 + (top - 0.2) * t);
    }
    this.rect(x + 1, y + 1, w - 2, h - 2, grey(shade), null);
  }

  circle(x: number, y: number, r: number, color: string | null, height: number | null) {
    for (const dx of [0, -SIZE, SIZE]) {
      for (const dy of [0, -SIZE, SIZE]) {
        if (color) {
          this.albedo.fillStyle = color;
          this.albedo.beginPath();
          this.albedo.arc(x + dx, y + dy, r, 0, Math.PI * 2);
          this.albedo.fill();
        }
        if (height !== null) {
          this.height.fillStyle = grey(height);
          this.height.beginPath();
          this.height.arc(x + dx, y + dy, r, 0, Math.PI * 2);
          this.height.fill();
        }
      }
    }
  }

  /** Multiplies in tileable value noise: `amount` of brightness variation at `scale` cells per texture. */
  speckle(scale: number, amount: number, heightAmount = 0) {
    const n = tileNoise(scale, this);
    const a = this.albedo.getImageData(0, 0, SIZE, SIZE);
    const h = this.height.getImageData(0, 0, SIZE, SIZE);
    for (let i = 0; i < SIZE * SIZE; i++) {
      const k = 1 - amount / 2 + n[i] * amount;
      a.data[i * 4] *= k;
      a.data[i * 4 + 1] *= k;
      a.data[i * 4 + 2] *= k;
      if (heightAmount) h.data[i * 4] = h.data[i * 4 + 1] = h.data[i * 4 + 2] = Math.min(255, h.data[i * 4] + (n[i] - 0.5) * heightAmount * 255);
    }
    this.albedo.putImageData(a, 0, 0);
    this.height.putImageData(h, 0, 0);
  }
}

const grey = (v: number) => {
  const c = Math.round(Math.min(Math.max(v, 0), 1) * 255);
  return `rgb(${c},${c},${c})`;
};

/** Smooth value noise that wraps every `cells` cells across the texture. */
function tileNoise(cells: number, p: Painter): Float32Array {
  const grid = Array.from({ length: cells * cells }, () => p.rand());
  const at = (x: number, y: number) => grid[((y % cells) + cells) % cells * cells + (((x % cells) + cells) % cells)];
  const out = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const fx = (x / SIZE) * cells;
      const fy = (y / SIZE) * cells;
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      let tx = fx - ix;
      let ty = fy - iy;
      tx = tx * tx * (3 - 2 * tx);
      ty = ty * ty * (3 - 2 * ty);
      const a = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * tx;
      const b = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * tx;
      out[y * SIZE + x] = a + (b - a) * ty;
    }
  }
  return out;
}

const SURFACES = {
  // The original look: a two-tone checker on a 2 m grid.
  grid: {
    tile: 2,
    roughness: 0.85,
    bump: 0,
    paint(p) {
      p.fill('#ffffff', 0.5);
      p.rect(0, 0, SIZE / 2, SIZE / 2, '#d4d8de', null);
      p.rect(SIZE / 2, SIZE / 2, SIZE / 2, SIZE / 2, '#d4d8de', null);
      p.albedo.strokeStyle = '#9097a3';
      p.albedo.lineWidth = 3;
      p.albedo.strokeRect(0, 0, SIZE / 2, SIZE / 2);
      p.albedo.strokeRect(SIZE / 2, 0, SIZE / 2, SIZE / 2);
      p.albedo.strokeRect(0, SIZE / 2, SIZE / 2, SIZE / 2);
      p.albedo.strokeRect(SIZE / 2, SIZE / 2, SIZE / 2, SIZE / 2);
    },
  },
  // Square paving slabs with dark grout.
  tile: {
    tile: 4,
    roughness: 0.75,
    bump: 2.5,
    paint(p) {
      p.fill('#8a8a8a', 0.1);
      const n = 2;
      const s = SIZE / n;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) p.block(x * s + 3, y * s + 3, s - 6, s - 6, 0.86 + p.rand() * 0.12, 5);
      p.speckle(16, 0.12, 0.05);
    },
  },
  // Big dressed stone blocks in running bond.
  stone: {
    tile: 4,
    roughness: 0.9,
    bump: 3,
    paint(p) {
      p.fill('#7a7a7a', 0.1);
      const rows = 4;
      const h = SIZE / rows;
      for (let r = 0; r < rows; r++) {
        let x = r % 2 ? -SIZE / 6 : 0;
        while (x < SIZE) {
          const w = SIZE / 3 + (p.rand() - 0.5) * SIZE * 0.12;
          p.block(x + 3, r * h + 3, w - 6, h - 6, 0.78 + p.rand() * 0.2, 7);
          x += w;
        }
      }
      p.speckle(24, 0.22, 0.12);
      p.speckle(6, 0.12);
    },
  },
  brick: {
    tile: 2,
    roughness: 0.9,
    bump: 2.5,
    paint(p) {
      p.fill('#9a9690', 0.15);
      const rows = 8;
      const h = SIZE / rows;
      for (let r = 0; r < rows; r++) {
        const w = SIZE / 4;
        for (let k = -1; k < 5; k++) p.block(k * w + (r % 2 ? w / 2 : 0) + 2, r * h + 2, w - 4, h - 4, 0.72 + p.rand() * 0.24, 3);
      }
      p.speckle(32, 0.18, 0.06);
    },
  },
  // Vertical boards with grain and a nail at each end.
  plank: {
    tile: 3,
    roughness: 0.8,
    bump: 2,
    paint(p) {
      p.fill('#6a6a6a', 0.1);
      const n = 6;
      const w = SIZE / n;
      for (let k = 0; k < n; k++) {
        const shade = 0.78 + p.rand() * 0.2;
        p.block(k * w + 1, 0, w - 2, SIZE, shade, 2);
        const seam = p.rand() * SIZE;
        p.rect(k * w, seam, w, 3, '#5a5a5a', 0.15);
        for (let g = 0; g < 7; g++) {
          const gx = k * w + 4 + p.rand() * (w - 8);
          p.rect(gx, 0, 1.2, SIZE, grey(shade * 0.82), null);
        }
        p.circle(k * w + w / 2, seam + 9, 2.2, '#4a4a4a', 0.3);
        p.circle(k * w + w / 2, seam - 7, 2.2, '#4a4a4a', 0.3);
      }
      p.speckle(12, 0.1);
    },
  },
  // Riveted steel panels.
  metal: {
    tile: 3,
    roughness: 0.45,
    metalness: 0.35,
    bump: 2,
    paint(p) {
      p.fill('#6e6e6e', 0.2);
      const n = 2;
      const s = SIZE / n;
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          p.block(x * s + 2, y * s + 2, s - 4, s - 4, 0.82 + p.rand() * 0.1, 3, 0.6);
          for (let k = 0; k < 6; k++) {
            const t = 10 + (k * (s - 20)) / 5;
            for (const [cx, cy] of [[x * s + t, y * s + 9], [x * s + t, y * s + s - 9], [x * s + 9, y * s + t], [x * s + s - 9, y * s + t]]) {
              p.circle(cx, cy, 3, '#9a9a9a', 0.9);
            }
          }
        }
      }
      p.speckle(40, 0.08);
    },
  },
  grass: {
    tile: 6,
    roughness: 0.95,
    bump: 1.2,
    paint(p) {
      p.fill('#dcdcdc', 0.5);
      p.speckle(8, 0.25);
      p.speckle(24, 0.2, 0.2);
      for (let i = 0; i < 1400; i++) {
        const x = p.rand() * SIZE;
        const y = p.rand() * SIZE;
        const v = 0.75 + p.rand() * 0.35;
        p.rect(x, y, 1.5, 4 + p.rand() * 4, `rgb(${Math.round(225 * v)},${Math.round(255 * v)},${Math.round(200 * v)})`, 0.5 + p.rand() * 0.4);
      }
    },
  },
  dirt: {
    tile: 6,
    roughness: 1,
    bump: 1.5,
    paint(p) {
      p.fill('#d0d0d0', 0.5);
      p.speckle(10, 0.25, 0.2);
      p.speckle(48, 0.25, 0.25);
      for (let i = 0; i < 120; i++) p.circle(p.rand() * SIZE, p.rand() * SIZE, 1 + p.rand() * 3, grey(0.6 + p.rand() * 0.3), 0.8);
    },
  },
  sand: {
    tile: 8,
    roughness: 1,
    bump: 0.8,
    paint(p) {
      p.fill('#e8e8e8', 0.5);
      p.speckle(6, 0.12, 0.3);
      p.speckle(64, 0.16, 0.1);
    },
  },
  // Poured concrete in big slabs.
  concrete: {
    tile: 8,
    roughness: 0.9,
    bump: 1.5,
    paint(p) {
      p.fill('#d6d6d6', 0.6);
      p.speckle(8, 0.12);
      p.speckle(64, 0.1, 0.08);
      p.rect(0, 0, SIZE, 2, '#9a9a9a', 0.2);
      p.rect(0, 0, 2, SIZE, '#9a9a9a', 0.2);
      for (let i = 0; i < 30; i++) p.circle(p.rand() * SIZE, p.rand() * SIZE, 1 + p.rand() * 2, '#a8a8a8', 0.45);
    },
  },
  // Layered cliff rock.
  rock: {
    tile: 10,
    roughness: 0.95,
    bump: 3.5,
    paint(p) {
      p.fill('#bcbcbc', 0.5);
      let y = 0;
      while (y < SIZE) {
        const h = 14 + p.rand() * 30;
        const shade = 0.72 + p.rand() * 0.26;
        p.rect(0, y, SIZE, h, grey(shade), 0.45 + p.rand() * 0.3);
        p.rect(0, y + h - 3, SIZE, 3, grey(shade * 0.7), 0.15);
        y += h;
      }
      p.speckle(12, 0.3, 0.3);
      p.speckle(40, 0.2, 0.15);
    },
  },
  // Corrugated container steel, ridges running up and down.
  container: {
    tile: 2.4,
    roughness: 0.6,
    metalness: 0.2,
    bump: 3,
    paint(p) {
      p.fill('#e0e0e0', 0.5);
      const ridges = 8;
      for (let x = 0; x < SIZE; x++) {
        const s = Math.sin((x / SIZE) * ridges * Math.PI * 2);
        p.rect(x, 0, 1, SIZE, grey(0.82 + s * 0.12), 0.5 + s * 0.4);
      }
      p.speckle(20, 0.1);
    },
  },
  // Yellow and black warning stripes (not tinted).
  hazard: {
    tile: 2,
    roughness: 0.6,
    bump: 0.5,
    paint(p) {
      p.fill('#f2c230', 0.6);
      p.albedo.fillStyle = '#26262a';
      for (let k = -2; k < 4; k++) {
        p.albedo.beginPath();
        const x = (k * SIZE) / 2;
        p.albedo.moveTo(x, 0);
        p.albedo.lineTo(x + SIZE / 4, 0);
        p.albedo.lineTo(x + SIZE / 4 + SIZE, SIZE);
        p.albedo.lineTo(x + SIZE, SIZE);
        p.albedo.fill();
      }
      p.speckle(30, 0.15);
    },
  },
  // Overlapping roof shingles.
  roof: {
    tile: 3,
    roughness: 0.8,
    bump: 3,
    paint(p) {
      p.fill('#7a7a7a', 0.1);
      const rows = 6;
      const h = SIZE / rows;
      for (let r = 0; r < rows; r++) {
        const w = SIZE / 5;
        for (let k = -1; k < 6; k++) {
          const x = k * w + (r % 2 ? w / 2 : 0);
          const shade = 0.75 + p.rand() * 0.2;
          for (let i = 0; i < h - 2; i++) p.rect(x + 2, r * h + i, w - 4, 1, grey(shade * (0.8 + (0.2 * i) / h)), 0.2 + (0.7 * i) / h);
        }
      }
      p.speckle(30, 0.12);
    },
  },
  snow: {
    tile: 8,
    roughness: 0.7,
    bump: 1,
    paint(p) {
      p.fill('#ffffff', 0.5);
      p.speckle(6, 0.08, 0.3);
      p.speckle(40, 0.06, 0.1);
    },
  },
  // Temple stone carved with a band of glyphs.
  carved: {
    tile: 4,
    roughness: 0.9,
    bump: 3.5,
    paint(p) {
      p.fill('#808080', 0.1);
      p.block(2, 2, SIZE - 4, SIZE / 2 - 4, 0.86, 6);
      p.block(2, SIZE / 2 + 2, SIZE - 4, SIZE / 2 - 4, 0.82, 6);
      // A row of squared spirals cut into the upper block.
      for (let k = 0; k < 4; k++) {
        const cx = k * (SIZE / 4) + SIZE / 8;
        const cy = SIZE / 4;
        const ctx = [p.albedo, p.height] as const;
        for (const [i, c] of ctx.entries()) {
          c.strokeStyle = i === 0 ? '#5e5e5e' : grey(0.3);
          c.lineWidth = 5;
          c.beginPath();
          let r = 22;
          let x = cx - r;
          let y = cy - r;
          c.moveTo(x, y);
          for (let s = 0; s < 6; s++) {
            const dir = s % 4;
            const len = r * 2 - s * 8;
            if (dir === 0) x += len;
            else if (dir === 1) y += len;
            else if (dir === 2) x -= len;
            else y -= len;
            c.lineTo(x, y);
          }
          c.stroke();
          r = 22;
        }
      }
      p.speckle(24, 0.22, 0.12);
    },
  },
} as Record<SurfaceKind, SurfaceSpec>;

SURFACES.steps = {
  // Stair treads for ramps: two steps per repeat, each a flat tread with a dark nosing line.
  tile: 1.6,
  roughness: 0.9,
  bump: 4,
  paint(p) {
    p.fill('#9a9a9a', 0.3);
    const n = 2;
    const h = SIZE / n;
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < h; i++) p.rect(0, k * h + i, SIZE, 1, grey(0.82 + (0.1 * i) / h), 0.15 + (0.8 * i) / h);
      p.rect(0, k * h + h - 6, SIZE, 6, '#6a6a6a', 0.95);
    }
    p.speckle(24, 0.18, 0.08);
  },
};

SURFACES.doors = {
  // A container's end: two doors in a heavy frame, with locking bars and handles. One per face.
  tile: 1,
  roughness: 0.6,
  metalness: 0.2,
  bump: 3,
  paint(p) {
    p.fill('#9a9a9a', 0.9);
    const f = 14;
    const inner = SIZE - 2 * f;
    for (const k of [0, 1]) {
      const x0 = f + (k * inner) / 2;
      // Door panel: horizontal pressed ribs.
      for (let y = f; y < SIZE - f; y++) {
        const s = Math.sin(((y - f) / inner) * Math.PI * 10);
        p.rect(x0 + 2, y, inner / 2 - 4, 1, grey(0.8 + s * 0.08), 0.45 + s * 0.15);
      }
      // Two locking bars per door, with handles.
      for (const bx of [0.3, 0.7]) {
        const x = x0 + (inner / 2) * bx;
        p.rect(x - 3, f, 6, inner, '#c8c8c8', 0.95);
        p.rect(x - 7, SIZE / 2 - 3, 14, 6, '#d8d8d8', 1);
        p.rect(x - 6, f + 6, 12, 8, '#b0b0b0', 1);
        p.rect(x - 6, SIZE - f - 14, 12, 8, '#b0b0b0', 1);
      }
    }
    p.rect(SIZE / 2 - 2, f, 4, inner, '#5a5a5a', 0.2); // the gap between the doors
    // A stenciled box code in the corner.
    p.albedo.fillStyle = '#f4f4f4';
    p.albedo.font = 'bold 15px monospace';
    p.albedo.fillText('RJ 0447', f + 8, f + 22);
    p.speckle(24, 0.12);
  },
};

const textureCache = new Map<SurfaceKind, { map: THREE.CanvasTexture; normalMap: THREE.CanvasTexture | null }>();

function normalFromHeight(height: CanvasRenderingContext2D, strength: number): HTMLCanvasElement {
  const src = height.getImageData(0, 0, SIZE, SIZE).data;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const out = ctx.createImageData(SIZE, SIZE);
  const h = (x: number, y: number) => src[(((y + SIZE) % SIZE) * SIZE + ((x + SIZE) % SIZE)) * 4] / 255;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * strength;
      const dy = (h(x, y + 1) - h(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * SIZE + x) * 4;
      out.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      out.data[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      out.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      out.data[i + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvas;
}

function texturesFor(kind: SurfaceKind) {
  let t = textureCache.get(kind);
  if (t) return t;
  const spec = SURFACES[kind];
  const p = new Painter(kind.length * 7919 + kind.charCodeAt(0));
  spec.paint(p);
  const map = new THREE.CanvasTexture(p.albedo.canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const normalMap = spec.bump > 0 ? new THREE.CanvasTexture(normalFromHeight(p.height, spec.bump)) : null;
  for (const tex of [map, normalMap]) {
    if (!tex) continue;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    tex.repeat.setScalar(1 / spec.tile);
  }
  t = { map, normalMap };
  textureCache.set(kind, t);
  return t;
}

/**
 * Adds contact shadow (from the `aBase` attribute: meters above the bottom of the box) and a slow
 * world-space brightness wobble to a standard material.
 */
function addLevelShading(material: THREE.MeshStandardMaterial) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aBase;\nvarying float vBase;\nvarying vec3 vWorld;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBase = aBase;\nvWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying float vBase;
        varying vec3 vWorld;
        float lvHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float lvNoise(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(lvHash(i), lvHash(i + vec2(1, 0)), f.x), mix(lvHash(i + vec2(0, 1)), lvHash(i + vec2(1, 1)), f.x), f.y);
        }`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float wobble = lvNoise(vWorld.xz * 0.06 + vWorld.y * 0.03) * 0.6 + lvNoise(vWorld.xz * 0.21) * 0.4;
        diffuseColor.rgb *= 0.88 + wobble * 0.22;
        diffuseColor.rgb *= mix(0.5, 1.0, smoothstep(0.0, 1.4, vBase));`,
      );
  };
  material.customProgramCacheKey = () => 'level-shading';
}

const materialCache = new Map<string, THREE.MeshStandardMaterial>();

/** The material for a level surface of this kind and tint (shared by every box that uses both). */
export function levelMaterial(kind: SurfaceKind, color: number): THREE.MeshStandardMaterial {
  const key = `${kind}:${color}`;
  let m = materialCache.get(key);
  if (m) return m;
  const spec = SURFACES[kind];
  const t = texturesFor(kind);
  m = new THREE.MeshStandardMaterial({
    color,
    map: t.map,
    normalMap: t.normalMap,
    roughness: spec.roughness,
    metalness: spec.metalness ?? 0,
  });
  addLevelShading(m);
  materialCache.set(key, m);
  return m;
}

/** Drops cached materials and textures; the next map makes fresh ones. Call after the scene is disposed. */
export function resetLevelMaterials() {
  materialCache.clear();
  textureCache.clear();
}

/** A wooden crate face: plank fill inside a frame with a diagonal brace. Mapped once per face. */
export function crateTexture(): { map: THREE.CanvasTexture; normalMap: THREE.CanvasTexture } {
  const p = new Painter(4242);
  p.fill('#5a3c22', 0.2);
  const b = 22;
  // Planks behind the frame.
  const n = 4;
  for (let k = 0; k < n; k++) {
    const shade = 0.75 + p.rand() * 0.15;
    p.rect(b, b + (k * (SIZE - 2 * b)) / n + 1, SIZE - 2 * b, (SIZE - 2 * b) / n - 2, `rgb(${Math.round(200 * shade)},${Math.round(140 * shade)},${Math.round(80 * shade)})`, 0.4);
  }
  // Frame.
  const frame = 'rgb(222,164,96)';
  p.rect(0, 0, SIZE, b, frame, 0.85);
  p.rect(0, SIZE - b, SIZE, b, frame, 0.85);
  p.rect(0, 0, b, SIZE, frame, 0.85);
  p.rect(SIZE - b, 0, b, SIZE, frame, 0.85);
  // Diagonal brace.
  for (const [i, c] of [p.albedo, p.height].entries()) {
    c.strokeStyle = i === 0 ? frame : grey(0.85);
    c.lineWidth = b;
    c.beginPath();
    c.moveTo(b, SIZE - b);
    c.lineTo(SIZE - b, b);
    c.stroke();
  }
  // Nails at the corners.
  for (const [x, y] of [[b / 2, b / 2], [SIZE - b / 2, b / 2], [b / 2, SIZE - b / 2], [SIZE - b / 2, SIZE - b / 2]]) p.circle(x, y, 3.5, '#6a6a70', 1);
  p.speckle(20, 0.2, 0.05);
  const map = new THREE.CanvasTexture(p.albedo.canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const normalMap = new THREE.CanvasTexture(normalFromHeight(p.height, 3));
  return { map, normalMap };
}
