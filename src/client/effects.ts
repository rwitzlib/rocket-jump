import * as THREE from 'three';
import { ROCKET } from '../shared/config';
import type { Rocket } from '../shared/sim';
import { ParticleSystem } from './particles';

const _pos = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _rand = new THREE.Vector3();
const _step = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1);

const TRAIL_SPACING = 0.3; // meters between smoke puffs, so trails look the same at any frame rate
const MUZZLE_BLEND_TIME = 0.2; // seconds for a rocket drawn from a barrel to merge onto its simulated path
const RING_TIME = 0.3;
const LIGHT_TIME = 0.35;
const DECAL_TIME = 12;
const MAX_DECALS = 40;
const MAX_RINGS = 8;

interface Timed<T> {
  obj: T;
  age: number;
}

function oldest<T extends { age: number }>(items: T[]): T {
  let pick = items[0];
  for (const item of items) if (item.age > pick.age) pick = item;
  return pick;
}

function randomInSphere(out: THREE.Vector3): THREE.Vector3 {
  do out.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
  while (out.lengthSq() > 1);
  return out;
}

function scorchTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(10,8,6,0.85)');
  g.addColorStop(0.5, 'rgba(20,16,12,0.55)');
  g.addColorStop(1, 'rgba(20,16,12,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

/** Rockets, trails and explosions. Purely visual: reads game state, never writes it. */
export class Effects {
  readonly fire = new ParticleSystem(3000, THREE.AdditiveBlending);
  readonly smoke = new ParticleSystem(3000, THREE.NormalBlending);

  private rocketMeshes = new Map<number, { mesh: THREE.Object3D; lastTrail: THREE.Vector3; seen: number; offset: THREE.Vector3; age: number }>();
  /**
   * Rockets are simulated from the shooter's eye. When the shooter has a visible weapon, this gives
   * the barrel's offset from that eye; the rocket is drawn starting there and eases onto its real path.
   */
  muzzleOffset: ((ownerId: string, out: THREE.Vector3) => THREE.Vector3 | null) | null = null;
  private frameNo = 0;
  private rocketProto: THREE.Object3D;
  private lights: Timed<THREE.PointLight>[] = [];
  // Rings and decals are pooled and never disposed: disposing the last user of a material makes
  // three.js delete its shader program, so the next explosion would recompile it (a visible hitch).
  private rings: Timed<THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>>[] = [];
  private decals: Timed<THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>>[] = [];

  constructor(private readonly scene: THREE.Scene) {
    // Both systems sit at the origin, so force the glow to draw after (on top of) the smoke.
    this.fire.points.renderOrder = 1;
    scene.add(this.smoke.points, this.fire.points);

    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 0.6, 10).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x55606e, metalness: 0.5, roughness: 0.4 }),
    );
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.08, 0.2, 10).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0xd96c4a, roughness: 0.5 }),
    );
    nose.position.z = -0.4;
    const flame = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffd080 }));
    flame.position.z = 0.33;
    this.rocketProto = new THREE.Group().add(body, nose, flame);

    const ringGeo = new THREE.RingGeometry(0.85, 1, 48);
    for (let i = 0; i < MAX_RINGS; i++) {
      const ring = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({
          color: 0xffd8a0,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      ring.visible = false;
      scene.add(ring);
      this.rings.push({ obj: ring, age: RING_TIME });
    }

    const decalGeo = new THREE.CircleGeometry(1, 24);
    const decalTex = scorchTexture();
    for (let i = 0; i < MAX_DECALS; i++) {
      const decal = new THREE.Mesh(
        decalGeo,
        new THREE.MeshBasicMaterial({
          map: decalTex,
          transparent: true,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -4,
        }),
      );
      decal.visible = false;
      scene.add(decal);
      this.decals.push({ obj: decal, age: DECAL_TIME });
    }

    // A fixed pool: the number of lights in the scene must not change, or three.js recompiles shaders.
    for (let i = 0; i < 4; i++) {
      const light = new THREE.PointLight(0xff9a40, 0, 16, 2);
      scene.add(light);
      this.lights.push({ obj: light, age: LIGHT_TIME });
    }
  }

  private warmRocket: THREE.Object3D | null = null;

  /**
   * Makes one of every effect drawable (or puts them back). Rendering a frame in this state at
   * startup compiles all their shaders up front; otherwise the first explosion freezes the game
   * for ~200 ms while the GPU compiles mid-play.
   */
  setWarmup(on: boolean) {
    const showcase: THREE.Object3D[] = [this.rings[0].obj, this.decals[0].obj];
    if (on) {
      this.warmRocket = this.rocketProto.clone();
      this.scene.add(this.warmRocket);
      showcase.push(this.warmRocket);
      _pos.set(0, 1, 0);
      this.fire.emit({ pos: _pos, life: 1, size: [1, 1], color: [0xffffff, 0xffffff] });
      this.smoke.emit({ pos: _pos, life: 1, size: [1, 1], color: [0xffffff, 0xffffff] });
      this.fire.update(0);
      this.smoke.update(0);
    } else {
      if (this.warmRocket) this.scene.remove(this.warmRocket);
      this.warmRocket = null;
      this.fire.update(1e6); // ages out the warm-up particles
      this.smoke.update(1e6);
    }
    for (const obj of showcase) {
      obj.visible = on;
      // Off-screen objects are culled before drawing, which would skip their compile.
      obj.traverse((o) => (o.frustumCulled = !on));
    }
  }

  setViewport(heightPx: number, fov: number) {
    this.fire.setViewport(heightPx, fov);
    this.smoke.setViewport(heightPx, fov);
  }

  explosion(at: THREE.Vector3, normal: THREE.Vector3, surface: boolean) {
    const r = ROCKET.blastRadius;

    // 1. Flash: a single huge, very short-lived glow.
    this.fire.emit({ pos: at, life: 0.09, size: [r * 2.2, r * 2.6], color: [0xfff4d0, 0xffb060], alpha: 1 });

    // 2. Fireball: puffs pushed outward (biased away from the surface) that slow down quickly.
    for (let i = 0; i < 24; i++) {
      randomInSphere(_rand);
      _vel.copy(_rand).multiplyScalar(10).addScaledVector(normal, 5);
      _pos.copy(at).addScaledVector(_rand, 0.6);
      this.fire.emit({
        pos: _pos,
        vel: _vel,
        life: 0.4 + Math.random() * 0.35,
        size: [2, 3.5 + Math.random() * 2],
        color: [0xfff0c0, 0xff4a10],
        alpha: 1,
        drag: 6,
        gravity: -2,
      });
    }

    // 3. Sparks: small, fast, affected by gravity.
    for (let i = 0; i < 28; i++) {
      randomInSphere(_rand).normalize();
      if (surface && _rand.dot(normal) < 0) _rand.reflect(normal);
      _vel.copy(_rand).multiplyScalar(12 + Math.random() * 16);
      this.fire.emit({
        pos: at,
        vel: _vel,
        life: 0.4 + Math.random() * 0.6,
        size: [0.18, 0.06],
        color: [0xfff0c0, 0xff7020],
        alpha: 1,
        gravity: 22,
        drag: 1.5,
      });
    }

    // 4. Smoke: lingers and drifts up after the fire is gone.
    for (let i = 0; i < 14; i++) {
      randomInSphere(_rand);
      _vel.copy(_rand).multiplyScalar(3).addScaledVector(normal, 1.5);
      _pos.copy(at).addScaledVector(_rand, 1.2);
      const shade = 0x5a5654 + Math.floor(Math.random() * 3) * 0x101010;
      this.smoke.emit({
        pos: _pos,
        vel: _vel,
        life: 1.6 + Math.random() * 1.4,
        size: [1.5, 5 + Math.random() * 2],
        color: [shade, 0x9a9692],
        alpha: 0.65,
        drag: 2,
        gravity: -1.2,
      });
    }

    // 5. Shockwave ring flat against the surface, sized to the real blast radius.
    const ring = oldest(this.rings);
    ring.age = 0;
    ring.obj.visible = true;
    ring.obj.position.copy(at).addScaledVector(normal, 0.05);
    ring.obj.quaternion.setFromUnitVectors(Z, normal);

    // 6. Scorch mark, only when the rocket hit something.
    if (surface) this.addDecal(at, normal);

    // 7. Light flash: reuse the oldest light.
    const light = oldest(this.lights);
    light.age = 0;
    light.obj.position.copy(at).addScaledVector(normal, 0.8);
  }

  update(rockets: readonly Rocket[], alpha: number, dt: number) {
    this.syncRockets(rockets, alpha, dt);
    this.fire.update(dt);
    this.smoke.update(dt);

    for (const l of this.lights) {
      l.age += dt;
      l.obj.intensity = l.age < LIGHT_TIME ? 120 * (1 - l.age / LIGHT_TIME) ** 2 : 0;
    }

    for (const r of this.rings) {
      if (!r.obj.visible) continue;
      r.age += dt;
      const t = r.age / RING_TIME;
      r.obj.visible = t < 1;
      r.obj.scale.setScalar(0.3 + ROCKET.blastRadius * Math.sqrt(t));
      r.obj.material.opacity = (1 - t) * 0.8;
    }

    for (const d of this.decals) {
      if (!d.obj.visible) continue;
      d.age += dt;
      d.obj.visible = d.age < DECAL_TIME;
      d.obj.material.opacity = Math.min(1, (DECAL_TIME - d.age) / 2);
    }
  }

  private addDecal(at: THREE.Vector3, normal: THREE.Vector3) {
    const entry = oldest(this.decals);
    const decal = entry.obj;
    entry.age = 0;
    decal.visible = true;
    decal.material.opacity = 1;
    decal.position.copy(at).addScaledVector(normal, 0.12);
    decal.quaternion.setFromUnitVectors(Z, normal);
    decal.rotateZ(Math.random() * Math.PI * 2);
    decal.scale.setScalar(1.4 + Math.random() * 0.5);
  }

  private syncRockets(rockets: readonly Rocket[], alpha: number, dt: number) {
    const frame = ++this.frameNo;
    for (const r of rockets) {
      let entry = this.rocketMeshes.get(r.id);
      if (!entry) {
        const mesh = this.rocketProto.clone();
        this.scene.add(mesh);
        const offset = this.muzzleOffset?.(r.ownerId, new THREE.Vector3()) ?? new THREE.Vector3();
        entry = { mesh, lastTrail: r.prevPos.clone().add(offset), seen: frame, offset, age: 0 };
        this.rocketMeshes.set(r.id, entry);
      }
      entry.seen = frame;
      entry.age += dt;
      const { mesh, lastTrail } = entry;
      const blend = Math.min(entry.age / MUZZLE_BLEND_TIME, 1);
      mesh.position.lerpVectors(r.prevPos, r.pos, alpha).addScaledVector(entry.offset, 1 - blend * blend * (3 - 2 * blend));
      mesh.lookAt(_pos.copy(mesh.position).sub(r.dir));

      // Lay smoke + exhaust glow at fixed spacing along the path traveled since the last frame.
      let gap = lastTrail.distanceTo(mesh.position);
      _step.subVectors(mesh.position, lastTrail).normalize();
      while (gap >= TRAIL_SPACING) {
        lastTrail.addScaledVector(_step, TRAIL_SPACING);
        gap -= TRAIL_SPACING;
        randomInSphere(_rand).multiplyScalar(0.4);
        this.smoke.emit({
          pos: lastTrail,
          vel: _rand,
          life: 0.9 + Math.random() * 0.5,
          size: [0.35, 1.6],
          color: [0xd8d4d0, 0x8a8682],
          alpha: 0.7,
          drag: 1,
          gravity: -0.4,
        });
        this.fire.emit({ pos: lastTrail, life: 0.12, size: [0.5, 0.2], color: [0xffd080, 0xff5010], alpha: 0.8 });
      }
    }
    for (const [id, entry] of this.rocketMeshes) {
      if (entry.seen !== frame) {
        this.scene.remove(entry.mesh);
        this.rocketMeshes.delete(id);
      }
    }
  }
}
