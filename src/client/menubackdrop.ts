import * as THREE from 'three';
import { MAPS } from '../shared/map';
import { buildLevel, type Level } from './level';
import type { PostFX } from './postfx';
import { resetLevelMaterials } from './surfaces';

// Behind the main menu: one of the maps, empty and quiet, with the camera drifting slowly round it.

const SHOWCASE = ['dockyard', 'temple', 'skyreach'];
const ORBIT_SPEED = 0.035; // radians per second

export class MenuBackdrop {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(55, 1, 0.1, 500);
  private readonly level: Level;
  private angle = Math.random() * Math.PI * 2;
  private readonly center = new THREE.Vector3();

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly post: PostFX) {
    const name = SHOWCASE[Math.floor(Math.random() * SHOWCASE.length)];
    this.level = buildLevel(this.scene, MAPS[name]);
    this.level.bounds.getCenter(this.center);
    this.center.y = Math.min(this.center.y, 6);
  }

  frame(dt: number) {
    this.angle += dt * ORBIT_SPEED;
    const r = this.level.extent * 1.05;
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (this.camera.aspect !== w / h) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.camera.position.set(this.center.x + Math.cos(this.angle) * r, this.center.y + this.level.extent * 0.32, this.center.z + Math.sin(this.angle) * r);
    this.camera.lookAt(this.center);
    this.renderer.toneMappingExposure = this.level.theme.exposure;
    this.post.outlineFade = [Math.max(35, this.level.extent * 0.6), Math.max(90, this.level.extent * 1.6)];
    this.level.update(dt, this.camera);
    this.post.render(this.scene, this.camera);
  }

  dispose() {
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const m of materials) {
        for (const value of Object.values(m)) if (value instanceof THREE.Texture) value.dispose();
        m.dispose();
      }
    });
    this.scene.clear();
    resetLevelMaterials();
  }
}
