import * as THREE from 'three';

// Chunks thrown out by explosions and by players being blown apart: small tumbling blocks drawn as
// one instanced mesh. They fall, bounce once or twice off the ground they started over, shrink and
// vanish. Purely visual.

const MAX = 240;
const GRAVITY = 22;

interface Chunk {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  axis: THREE.Vector3;
  angle: number;
  spin: number;
  size: number;
  age: number;
  life: number;
  floor: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

export class Debris {
  readonly mesh: THREE.InstancedMesh;
  private readonly chunks: Chunk[] = [];
  private next = 0;

  constructor(scene: THREE.Scene) {
    const material = new THREE.MeshStandardMaterial({ roughness: 0.7 });
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, MAX);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = MAX;
    for (let i = 0; i < MAX; i++) {
      this.chunks.push({ pos: new THREE.Vector3(), vel: new THREE.Vector3(), axis: new THREE.Vector3(1, 0, 0), angle: 0, spin: 0, size: 0, age: 1, life: 0, floor: 0 });
      this.mesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
      this.mesh.setColorAt(i, _c.set(0xffffff));
    }
    scene.add(this.mesh);
  }

  /** Throws `count` chunks from `at`, `speed` m/s give or take, biased along `up`. `floor`: the ground height under them. */
  throw(at: THREE.Vector3, count: number, speed: number, colors: readonly number[], size: number, floor: number, up = _up) {
    for (let k = 0; k < count; k++) {
      const c = this.chunks[this.next];
      const i = this.next;
      this.next = (this.next + 1) % MAX;
      c.pos.copy(at);
      c.vel.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      if (c.vel.dot(up) < 0) c.vel.addScaledVector(up, -2 * c.vel.dot(up));
      c.vel.addScaledVector(up, 0.6).normalize().multiplyScalar(speed * (0.5 + Math.random() * 0.7));
      c.axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      c.angle = Math.random() * 6;
      c.spin = 6 + Math.random() * 10;
      c.size = size * (0.5 + Math.random() * 0.7);
      c.age = 0;
      c.life = 1.4 + Math.random() * 1.2;
      c.floor = floor;
      this.mesh.setColorAt(i, _c.set(colors[k % colors.length]));
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number) {
    let any = false;
    this.chunks.forEach((c, i) => {
      if (c.age >= c.life) return;
      any = true;
      c.age += dt;
      c.vel.y -= GRAVITY * dt;
      c.pos.addScaledVector(c.vel, dt);
      const half = c.size / 2;
      if (c.pos.y < c.floor + half && c.vel.y < 0) {
        // Bounce, losing most of the energy, and spin down.
        c.pos.y = c.floor + half;
        c.vel.y *= -0.35;
        c.vel.x *= 0.6;
        c.vel.z *= 0.6;
        c.spin *= 0.5;
      }
      c.angle += c.spin * dt;
      const shrink = c.age >= c.life ? 0 : Math.min(1, (c.life - c.age) / 0.4);
      _q.setFromAxisAngle(c.axis, c.angle);
      this.mesh.setMatrixAt(i, _m.compose(c.pos, _q, _s.setScalar(c.size * shrink)));
    });
    if (any) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

const _up = new THREE.Vector3(0, 1, 0);
