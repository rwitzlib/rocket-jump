import * as THREE from 'three';
import { CRATE } from '../shared/config';
import type { MapDef } from '../shared/map';
import type { GameSim } from '../shared/sim';

const TILE = 2; // meters per grid square: a consistent grid makes speed and distance readable

function gridTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#d4d8de';
  ctx.fillRect(0, 0, size / 2, size / 2);
  ctx.fillRect(size / 2, size / 2, size / 2, size / 2);
  ctx.strokeStyle = '#9097a3';
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// Box with UVs scaled to world size so the grid is the same density on every surface.
function worldScaledBox(w: number, h: number, d: number): THREE.BoxGeometry {
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv;
  const faces = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, (uv.getX(i) * faces[f][0]) / TILE, (uv.getY(i) * faces[f][1]) / TILE);
    }
  }
  return geo;
}

export function buildLevel(scene: THREE.Scene, map: MapDef) {
  scene.background = new THREE.Color(0x9ec9f0);
  scene.fog = new THREE.Fog(0x9ec9f0, 60, 180);

  scene.add(new THREE.HemisphereLight(0xdfefff, 0x5a5048, 1.6));
  const sun = new THREE.DirectionalLight(0xfff2dd, 2.4);
  sun.position.set(30, 60, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -75;
  sun.shadow.camera.right = sun.shadow.camera.top = 75;
  sun.shadow.camera.far = 200;
  sun.shadow.bias = -0.0005;
  scene.add(sun);

  const grid = gridTexture();
  const materials = new Map<number, THREE.MeshStandardMaterial>();
  const materialFor = (color: number) => {
    let m = materials.get(color);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, map: grid, roughness: 0.85 });
      materials.set(color, m);
    }
    return m;
  };

  for (const box of map.boxes) {
    const mesh = new THREE.Mesh(worldScaledBox(...box.size), materialFor(box.color));
    mesh.position.set(...box.pos);
    if (box.rot) mesh.rotation.set(...box.rot);
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
  }
}

/** Dynamic crate meshes that follow their physics bodies. */
export class CrateView {
  private meshes: THREE.Mesh[] = [];

  constructor(scene: THREE.Scene, private readonly sim: GameSim) {
    const geo = new THREE.BoxGeometry(CRATE.size, CRATE.size, CRATE.size);
    const mat = new THREE.MeshStandardMaterial({ color: 0xc98a3e, roughness: 0.7 });
    for (let i = 0; i < sim.crates.length; i++) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = mesh.receiveShadow = true;
      scene.add(mesh);
      this.meshes.push(mesh);
    }
  }

  sync() {
    this.sim.crates.forEach((body, i) => {
      const t = body.translation();
      const r = body.rotation();
      this.meshes[i].position.set(t.x, t.y, t.z);
      this.meshes[i].quaternion.set(r.x, r.y, r.z, r.w);
    });
  }
}
