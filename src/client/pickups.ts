import * as THREE from 'three';
import { PICKUP } from '../shared/config';
import type { Pickup } from '../shared/sim';

// Mystery boxes: glowing "?" cubes that bob and spin above the floor, wrapped in a soft halo. A
// taken box shrinks away and grows back when the server says it has respawned.

const BOB_HEIGHT = 0.15;
const BOB_SPEED = 2; // radians per second
const SPIN_SPEED = 1.2;
const GROW_RATE = 6; // 1/s, how fast a box pops in or out

function faceTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, '#9b5cff');
  g.addColorStop(1, '#5a2bd0');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = '#ffd860';
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, size - 10, size - 10);
  ctx.fillStyle = '#ffe680';
  ctx.font = 'bold 92px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('?', size / 2, size / 2 + 6);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function haloTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(200,150,255,0.7)');
  g.addColorStop(0.4, 'rgba(150,90,255,0.3)');
  g.addColorStop(1, 'rgba(120,60,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

interface BoxView {
  group: THREE.Group;
  cube: THREE.Mesh;
  scale: number;
}

export class PickupView {
  private readonly boxes: BoxView[];
  private time = 0;

  constructor(scene: THREE.Scene, private readonly pickups: readonly Pickup[]) {
    const face = faceTexture();
    const geo = new THREE.BoxGeometry(PICKUP.size, PICKUP.size, PICKUP.size);
    const mat = new THREE.MeshStandardMaterial({ map: face, emissive: 0xffffff, emissiveMap: face, emissiveIntensity: 0.55, roughness: 0.4 });
    const haloMat = new THREE.SpriteMaterial({ map: haloTexture(), blending: THREE.AdditiveBlending, depthWrite: false });

    this.boxes = pickups.map((p) => {
      const cube = new THREE.Mesh(geo, mat);
      cube.castShadow = true;
      const halo = new THREE.Sprite(haloMat);
      halo.scale.setScalar(PICKUP.size * 3);
      const group = new THREE.Group();
      group.add(cube, halo);
      group.position.copy(p.pos);
      // Always drawn, so their shaders compile behind the start menu with everything else.
      group.traverse((o) => (o.frustumCulled = false));
      scene.add(group);
      return { group, cube, scale: 1 };
    });
  }

  update(dt: number) {
    this.time += dt;
    this.boxes.forEach((b, i) => {
      const p = this.pickups[i];
      const target = p.respawnIn > 0 ? 0 : 1;
      b.scale += (target - b.scale) * (1 - Math.exp(-dt * GROW_RATE));
      if (Math.abs(target - b.scale) < 0.01) b.scale = target;
      b.group.visible = b.scale > 0;
      b.group.scale.setScalar(b.scale);
      b.group.position.y = p.pos.y + Math.sin(this.time * BOB_SPEED + i * 1.7) * BOB_HEIGHT;
      b.cube.rotation.set(0.35, this.time * SPIN_SPEED + i, 0.25);
    });
  }
}
