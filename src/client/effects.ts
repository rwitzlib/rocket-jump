import * as THREE from 'three';
import { ROCKET } from '../shared/config';
import type { GameSim, Rocket } from '../shared/sim';

const _pos = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

interface Puff {
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  age: number;
  life: number;
  grow: number;
}

interface Blast {
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  light: THREE.PointLight;
  age: number;
}

const BLAST_TIME = 0.35;

/** Rockets, smoke trails, explosions and the grapple rope. Purely visual: reads sim state, never writes it. */
export class Effects {
  private rocketMeshes = new Map<number, THREE.Object3D>();
  private rocketProto: THREE.Object3D;
  private puffs: Puff[] = [];
  private freePuffs: Puff[] = [];
  private blasts: Blast[] = [];
  private lights: THREE.PointLight[] = [];
  private rope: THREE.Mesh;
  private hook: THREE.Mesh;
  private sphere = new THREE.SphereGeometry(1, 16, 12);

  constructor(private readonly scene: THREE.Scene) {
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 0.6, 10).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x55606e, metalness: 0.5, roughness: 0.4 }),
    );
    const flame = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xffb347 }),
    );
    flame.position.z = 0.35;
    this.rocketProto = new THREE.Group().add(body, flame);

    // Pre-allocated so the number of lights never changes (changing it forces shader recompiles).
    for (let i = 0; i < 4; i++) {
      const light = new THREE.PointLight(0xff9a40, 0, 14, 2);
      scene.add(light);
      this.lights.push(light);
    }

    this.rope = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, 1, 6),
      new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.6 }),
    );
    this.hook = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.18),
      new THREE.MeshStandardMaterial({ color: 0x7cf0a0, emissive: 0x2a8a50 }),
    );
    this.rope.visible = this.hook.visible = false;
    scene.add(this.rope, this.hook);
  }

  explosion(at: THREE.Vector3) {
    const mesh = new THREE.Mesh(
      this.sphere,
      new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, depthWrite: false }),
    );
    mesh.position.copy(at);
    this.scene.add(mesh);

    const light = this.lights.shift()!;
    this.lights.push(light);
    light.position.copy(at);

    this.blasts.push({ mesh, light, age: 0 });
    for (let i = 0; i < 10; i++) {
      _pos.set(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).multiplyScalar(2.5).add(at);
      this.puff(_pos, 1.2 + Math.random(), 2.5, 0x6f6a66);
    }
  }

  update(sim: GameSim, alpha: number, dt: number) {
    this.syncRockets(sim.rockets, alpha);

    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const b = this.blasts[i];
      b.age += dt;
      const t = b.age / BLAST_TIME;
      if (t >= 1) {
        this.scene.remove(b.mesh);
        b.mesh.material.dispose();
        b.light.intensity = 0;
        this.blasts.splice(i, 1);
        continue;
      }
      b.mesh.scale.setScalar(0.5 + ROCKET.blastRadius * 0.8 * Math.sqrt(t));
      b.mesh.material.opacity = 1 - t;
      b.light.intensity = 60 * (1 - t);
    }

    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.age += dt;
      const t = p.age / p.life;
      if (t >= 1) {
        p.mesh.visible = false;
        this.freePuffs.push(p);
        this.puffs.splice(i, 1);
        continue;
      }
      p.mesh.scale.setScalar(0.15 + p.grow * t);
      p.mesh.material.opacity = 0.5 * (1 - t);
      p.mesh.position.y += dt * 0.6;
    }
  }

  /** Draws the rope from the player's hand to the anchor, or hides it. */
  setRope(from: THREE.Vector3 | null, to: THREE.Vector3 | null) {
    if (!from || !to) {
      this.rope.visible = this.hook.visible = false;
      return;
    }
    _pos.subVectors(to, from);
    const len = _pos.length();
    this.rope.position.copy(from).addScaledVector(_pos, 0.5);
    this.rope.quaternion.setFromUnitVectors(_up, _pos.divideScalar(len));
    this.rope.scale.set(1, len, 1);
    this.hook.position.copy(to);
    this.rope.visible = this.hook.visible = true;
  }

  private syncRockets(rockets: Rocket[], alpha: number) {
    const alive = new Set<number>();
    for (const r of rockets) {
      alive.add(r.id);
      let mesh = this.rocketMeshes.get(r.id);
      if (!mesh) {
        mesh = this.rocketProto.clone();
        this.scene.add(mesh);
        this.rocketMeshes.set(r.id, mesh);
      }
      mesh.position.lerpVectors(r.prevPos, r.pos, alpha);
      mesh.lookAt(_pos.copy(mesh.position).sub(r.dir));
      this.puff(mesh.position, 0.6, 0.6, 0xdddddd);
    }
    for (const [id, mesh] of this.rocketMeshes) {
      if (!alive.has(id)) {
        this.scene.remove(mesh);
        this.rocketMeshes.delete(id);
      }
    }
  }

  private puff(at: THREE.Vector3, grow: number, life: number, color: number) {
    let p = this.freePuffs.pop();
    if (!p) {
      if (this.puffs.length > 400) return;
      const mesh = new THREE.Mesh(
        this.sphere,
        new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }),
      );
      this.scene.add(mesh);
      p = { mesh, age: 0, life, grow };
    }
    p.age = 0;
    p.life = life;
    p.grow = grow;
    p.mesh.material.color.setHex(color);
    p.mesh.position.copy(at);
    p.mesh.scale.setScalar(0.15);
    p.mesh.visible = true;
    this.puffs.push(p);
  }
}
