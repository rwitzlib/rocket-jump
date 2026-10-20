import * as THREE from 'three';
import { TRAILS, type ExplosionId } from '../shared/progress';
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js';
import { GRENADE, HYPERSONIC, ROCKET, SEEKERS } from '../shared/config';
import { isArmed, type Projectile, type ProjectileKind } from '../shared/sim';
import { Debris } from './debris';
import { bubbleTexture, ParticleSystem, puffTexture } from './particles';
import { buildDart, buildGrenade, buildMissile, buildRocket, GRENADE_LIGHT } from './weapons';

const _pos = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _rand = new THREE.Vector3();
const _step = new THREE.Vector3();
const _arc = new THREE.Vector3();
const _fork = new THREE.Vector3();
const _euler = new THREE.Euler();
const _decalSize = new THREE.Vector3();
const _decalBounds = new THREE.Box3();
const Z = new THREE.Vector3(0, 0, 1);
const DEBRIS_COLORS = [0x8a8478, 0x6a6458, 0x3a3630, 0xa89c88];

const TRAIL_SPACING = 0.3; // meters between smoke puffs, so trails look the same at any frame rate
const GRENADE_TRAIL_SPACING = 0.45;
const STREAK_SPACING = 0.6; // a hypersonic dart covers ~2 m a tick: a sparse, quick-fading streak keeps the particle count sane
const GRENADE_SPIN = 14; // radians per second of tumble
const GRENADE_UNARMED = new THREE.Color(0x7cf0a0).multiplyScalar(2.2);
const GRENADE_ARMED = new THREE.Color(0xff3c28).multiplyScalar(3);
const LIFETIME: Record<ProjectileKind, number> = {
  rocket: ROCKET.lifetime,
  grenade: GRENADE.lifetime,
  hypersonic: HYPERSONIC.lifetime,
  javelin: SEEKERS.javelin.lifetime,
  stinger: SEEKERS.stinger.lifetime,
};
const MUZZLE_BLEND_TIME = 0.2; // seconds for a rocket drawn from a barrel to merge onto its simulated path
const RING_TIME = 0.3;
const FLASH_TIME = 0.1;
const BEAM_TIME = 0.7;
const FLASH_COLOR = new THREE.Color(1.8, 1.4, 0.8);
/** The parts every explosion style shares, in each one's colors: the white-hot core, the shockwave ring, the light. */
const BLAST_TINTS: Record<ExplosionId, { flash: THREE.Color; ring: number; light: number }> = {
  classic: { flash: FLASH_COLOR, ring: 0xffd8a0, light: 0xff9a40 },
  smoky: { flash: new THREE.Color(1.4, 1, 0.6), ring: 0xd8c8b0, light: 0xff8030 },
  firecracker: { flash: new THREE.Color(2, 1.2, 1), ring: 0xffb0a0, light: 0xff5030 },
  flashpop: { flash: new THREE.Color(2.4, 2.3, 2.1), ring: 0xffffff, light: 0xfff0d0 },
  thunderclap: { flash: new THREE.Color(1.4, 1.8, 2.6), ring: 0xa0c8ff, light: 0x80b0ff },
  bubblepop: { flash: new THREE.Color(0.5, 0.9, 1.1), ring: 0xb0f0ff, light: 0x80e0ff },
};
const POP_COLORS = [0xff3030, 0x40ff60, 0xffd040, 0x40a0ff];
const ARC_SPACING = 0.07; // meters between the dots a lightning trail's arcs are drawn with
const LIGHT_TIME = 0.35;
const DECAL_TIME = 12;
const MAX_DECALS = 40;
const MAX_RINGS = 8;
const DECAL_DEPTH = 1; // how far in front of and behind the hit point a scorch projects
const DECAL_MIN_FACING = 0.5; // surfaces angled more than ~60° from the hit surface get no scorch

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

const _q = new THREE.Quaternion();
const _spin = new THREE.Quaternion();
const _n = new THREE.Vector3();

/** The triangles of a projected decal whose surface faces along `normal`, or null if there are none. */
function facingTriangles(geo: THREE.BufferGeometry, normal: THREE.Vector3): THREE.BufferGeometry | null {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const outPos: number[] = [];
  const outUv: number[] = [];
  for (let i = 0; i < pos.count; i += 3) {
    _n.set(0, 0, 0);
    for (let k = 0; k < 3; k++) _n.x += nor.getX(i + k), _n.y += nor.getY(i + k), _n.z += nor.getZ(i + k);
    if (_n.normalize().dot(normal) < DECAL_MIN_FACING) continue;
    for (let k = 0; k < 3; k++) {
      outPos.push(pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k));
      outUv.push(uv.getX(i + k), uv.getY(i + k));
    }
  }
  if (!outPos.length) return null;
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(outUv, 2));
  return out;
}

/** Concatenates non-indexed position+uv geometries (and disposes the inputs). */
function mergeTriangles(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  for (const p of parts) {
    pos.push(...(p.attributes.position.array as Float32Array));
    uv.push(...(p.attributes.uv.array as Float32Array));
    p.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return out;
}

/** Opaque at the bottom, clear at the top (V runs up a cylinder's side). */
function verticalFade(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 64, 0, 0);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(1, '#000000');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 64);
  return new THREE.CanvasTexture(canvas);
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

interface ProjectileMesh {
  mesh: THREE.Object3D;
  lastTrail: THREE.Vector3;
  seen: number;
  offset: THREE.Vector3;
  age: number;
  light: THREE.MeshBasicMaterial | null; // a grenade's arming light
  spin: number; // a grenade's tumble so far, radians
  arc: THREE.Vector3 | null; // where a lightning trail's arc got to
}

type Trail = (typeof TRAILS)[number];
const _hue = new THREE.Color();

/** Rockets, grenades, trails and explosions. Purely visual: reads game state, never writes it. */
export class Effects {
  /** A player's rocket trail (their profile's look); null for the classic one. */
  trailOf: (ownerId: string) => Trail | null = () => null;
  readonly fire = new ParticleSystem(3000, THREE.AdditiveBlending, undefined, 1.25);
  readonly smoke = new ParticleSystem(3000, THREE.NormalBlending, puffTexture());
  /** Cartoon fireballs: solid billowing puffs, drawn a little brighter than lit so they glow. */
  readonly blast = new ParticleSystem(1200, THREE.NormalBlending, puffTexture(), 1.7);
  /** Soap bubbles, for the Bubbles trail and Bubble Pop. */
  readonly bubbles = new ParticleSystem(1500, THREE.NormalBlending, bubbleTexture(), 1.15);
  /** Effects waiting their turn (a firecracker's pops, a bolt's flickers): seconds until each. */
  private pending: { in: number; fn: () => void }[] = [];
  readonly debris: Debris;
  /** Height of the ground under a point (for debris to bounce on), or null if there's none. */
  groundAt: ((at: THREE.Vector3) => number | null) | null = null;
  private flashes: Timed<THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>>[] = [];
  private beams: Timed<THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>>[] = [];

  private projectileMeshes = new Map<number, ProjectileMesh>();
  /**
   * Projectiles are simulated from the shooter's eye. When the shooter has a visible weapon, this gives
   * the barrel's offset from that eye; the projectile is drawn starting there and eases onto its real path.
   */
  muzzleOffset: ((ownerId: string, out: THREE.Vector3) => THREE.Vector3 | null) | null = null;
  private frameNo = 0;
  private readonly protos: Record<ProjectileKind, THREE.Object3D> = {
    rocket: buildRocket(),
    grenade: buildGrenade(),
    hypersonic: buildDart(),
    javelin: buildMissile('javelin'),
    stinger: buildMissile('stinger'),
  };
  private lights: Timed<THREE.PointLight>[] = [];
  // Rings and decals are pooled and never disposed: disposing the last user of a material makes
  // three.js delete its shader program, so the next explosion would recompile it (a visible hitch).
  private rings: (Timed<THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>> & { radius: number })[] = [];
  private decals: Timed<THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>>[] = [];
  /** Starting shape for pooled scorch marks (and what the startup warm-up draws); replaced on first use. */
  private readonly decalPlaceholder = new THREE.CircleGeometry(1, 24);
  private readonly decalSurfaces: { mesh: THREE.Mesh; bounds: THREE.Box3 }[];

  /** `surfaces` are the static level meshes scorch marks are projected onto. */
  constructor(private readonly scene: THREE.Scene, surfaces: THREE.Mesh[]) {
    this.decalSurfaces = surfaces.map((mesh) => ({ mesh, bounds: new THREE.Box3().setFromObject(mesh) }));
    // Both systems sit at the origin, so force the glow to draw after (on top of) the smoke.
    this.blast.points.renderOrder = 1;
    this.bubbles.points.renderOrder = 1;
    this.fire.points.renderOrder = 2;
    scene.add(this.smoke.points, this.blast.points, this.bubbles.points, this.fire.points);
    this.debris = new Debris(scene);

    // Pooled like the rings: a white-hot ball at the heart of each blast, and a column of light where someone respawns.
    const flashGeo = new THREE.SphereGeometry(1, 16, 12);
    const beamGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 20, 1, true).translate(0, 0.5, 0);
    const fadeUp = verticalFade();
    for (let i = 0; i < 4; i++) {
      const additive = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false };
      const flash = new THREE.Mesh(flashGeo, new THREE.MeshBasicMaterial({ color: FLASH_COLOR, ...additive }));
      const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 2.2, 2.8), side: THREE.DoubleSide, alphaMap: fadeUp, ...additive }));
      flash.visible = beam.visible = false;
      flash.userData.radius = 1;
      scene.add(flash, beam);
      this.flashes.push({ obj: flash, age: FLASH_TIME });
      this.beams.push({ obj: beam, age: BEAM_TIME });
    }

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
      this.rings.push({ obj: ring, age: RING_TIME, radius: ROCKET.blastRadius });
    }

    const decalTex = scorchTexture();
    for (let i = 0; i < MAX_DECALS; i++) {
      const decal = new THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>(
        this.decalPlaceholder,
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

  private warmProjectiles: THREE.Object3D[] = [];

  /**
   * Makes one of every effect drawable (or puts them back). Rendering a frame in this state at
   * startup compiles all their shaders up front; otherwise the first explosion freezes the game
   * for ~200 ms while the GPU compiles mid-play.
   */
  setWarmup(on: boolean) {
    const showcase: THREE.Object3D[] = [this.rings[0].obj, this.decals[0].obj, this.flashes[0].obj, this.beams[0].obj, this.debris.mesh];
    if (on) {
      this.warmProjectiles = Object.values(this.protos).map((proto) => proto.clone());
      this.scene.add(...this.warmProjectiles);
      showcase.push(...this.warmProjectiles);
      _pos.set(0, 1, 0);
      this.fire.emit({ pos: _pos, life: 1, size: [1, 1], color: [0xffffff, 0xffffff] });
      this.smoke.emit({ pos: _pos, life: 1, size: [1, 1], color: [0xffffff, 0xffffff] });
      this.fire.update(0);
      this.smoke.update(0);
      this.blast.emit({ pos: _pos, life: 1, size: [1, 1], color: [0xffffff, 0xffffff] });
      this.blast.update(0);
      this.bubbles.emit({ pos: _pos, life: 1, size: [1, 1], color: [0xffffff, 0xffffff] });
      this.bubbles.update(0);
    } else {
      for (const obj of this.warmProjectiles) this.scene.remove(obj);
      this.warmProjectiles = [];
      this.fire.update(1e6); // ages out the warm-up particles
      this.smoke.update(1e6);
      this.blast.update(1e6);
      this.bubbles.update(1e6);
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
    this.blast.setViewport(heightPx, fov);
    this.bubbles.setViewport(heightPx, fov);
  }

  /**
   * `radius`: the blast's real reach, which the fireball and shockwave are sized to. `style`: the
   * shooter's explosion skin. Each draws its own fire, sparks and smoke; the shockwave ring at the
   * real radius, the scorch, the light and the debris are the same for all (only tinted), so a blast
   * reads the same whatever it looks like.
   */
  explosion(at: THREE.Vector3, normal: THREE.Vector3, surface: boolean, radius: number, style: ExplosionId = 'classic') {
    const r = radius;
    const k = radius / ROCKET.blastRadius; // everything below was tuned on a rocket's blast
    switch (style) {
      case 'smoky':
        this.fire.emit({ pos: at, life: 0.08, size: [r * 1.4, r * 1.8], color: [0xffe0b0, 0xff9050], alpha: 0.8 });
        this.fireball(at, normal, k, 9, [0xffc060, 0xb03010]);
        this.sparks(at, normal, surface, 10, [0xffd0a0, 0xc04010]);
        this.smokeCloud(at, normal, 30, 0x3a3634, 0x6a6662, 0.85, 1.4);
        break;
      case 'firecracker':
        this.fire.emit({ pos: at, life: 0.07, size: [r * 1.6, r * 2], color: [0xfff0e0, 0xff6040], alpha: 0.9 });
        this.fireball(at, normal, k * 0.7, 8, [0xffe080, 0xe02020]);
        this.sparks(at, normal, surface, 20, [0xffe8a0, 0xff3020]);
        this.smokeCloud(at, normal, 8, 0x6a6460, 0xa8a4a0, 0.5, 0.8);
        // ...then a string of small pops round it, each a beat after the last.
        for (let i = 0; i < 6; i++) {
          randomInSphere(_rand).multiplyScalar(r * 0.55);
          if (surface && _rand.dot(normal) < 0) _rand.reflect(normal);
          const pop = at.clone().add(_rand);
          const color = POP_COLORS[i % POP_COLORS.length];
          this.after(0.08 + i * 0.07 + Math.random() * 0.04, () => this.pop(pop, color));
        }
        break;
      case 'flashpop':
        this.fire.emit({ pos: at, life: 0.13, size: [r * 2.6, r * 3.2], color: [0xffffff, 0xfff4e0], alpha: 1 });
        for (let i = 0; i < 10; i++) {
          randomInSphere(_rand);
          _vel.copy(_rand).multiplyScalar(8 * k).addScaledVector(normal, 2 * k);
          this.fire.emit({ pos: at, vel: _vel, life: 0.2 + Math.random() * 0.15, size: [1.2 * k, 2.2 * k], color: [0xffffff, 0xd8e4ff], alpha: 0.9, drag: 7 });
        }
        this.sparks(at, normal, surface, 44, [0xffffff, 0xb8c8ff], 1.4);
        this.smokeCloud(at, normal, 6, 0xc8c8cc, 0xe8e8ec, 0.35, 0.8);
        break;
      case 'thunderclap':
        this.thunderclap(at, normal, surface, r);
        break;
      case 'bubblepop':
        this.bubblePop(at, normal, r);
        break;
      default:
        // Flash, then a fireball of solid cartoon puffs over a few glowing ones, sparks, and smoke
        // that lingers and drifts up after the fire is gone.
        this.fire.emit({ pos: at, life: 0.09, size: [r * 2.2, r * 2.6], color: [0xfff4d0, 0xffb060], alpha: 1 });
        this.fireball(at, normal, k, 18, [0xffd040, 0xe8401a]);
        for (let i = 0; i < 8; i++) {
          randomInSphere(_rand);
          _vel.copy(_rand).multiplyScalar(6 * k).addScaledVector(normal, 3 * k);
          this.fire.emit({ pos: at, vel: _vel, life: 0.3 + Math.random() * 0.2, size: [1.5 * k, 2.6 * k], color: [0xfff0c0, 0xff6020], alpha: 0.8, drag: 6, gravity: -2 });
        }
        this.sparks(at, normal, surface, 28, [0xfff0c0, 0xff7020]);
        this.smokeCloud(at, normal, 16, 0x5a5654, 0x9a9692, 0.65, 1);
    }
    const tint = BLAST_TINTS[style];

    // Shockwave ring flat against the surface, sized to the real blast radius.
    const ring = oldest(this.rings);
    ring.age = 0;
    ring.radius = radius;
    ring.obj.visible = true;
    ring.obj.material.color.setHex(tint.ring);
    ring.obj.position.copy(at).addScaledVector(normal, 0.05);
    ring.obj.quaternion.setFromUnitVectors(Z, normal);

    // Scorch mark, only when the rocket hit something.
    if (surface) this.addDecal(at, normal);

    // Light flash: reuse the oldest light.
    const light = oldest(this.lights);
    light.age = 0;
    light.obj.color.setHex(tint.light);
    light.obj.position.copy(at).addScaledVector(normal, 0.8);

    // A white-hot core that swells and is gone in a blink.
    const flash = oldest(this.flashes);
    flash.age = 0;
    flash.obj.visible = true;
    flash.obj.material.color.copy(tint.flash);
    flash.obj.position.copy(at).addScaledVector(normal, 0.3 * k);
    flash.obj.userData.radius = r * 0.32;

    // Chunks of whatever it hit, and a skirt of dust rolling out along the ground.
    if (surface) {
      const floor = this.groundAt?.(_pos.copy(at).addScaledVector(normal, 0.5)) ?? at.y;
      this.debris.throw(at, Math.round(7 * k), 11 * Math.sqrt(k), DEBRIS_COLORS, 0.16 * k, floor, normal);
      if (normal.y > 0.6) {
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2 + Math.random() * 0.3;
          _vel.set(Math.cos(a), 0, Math.sin(a)).multiplyScalar((6 + Math.random() * 4) * k);
          _pos.set(at.x + Math.cos(a) * 0.6, at.y + 0.3, at.z + Math.sin(a) * 0.6);
          this.smoke.emit({ pos: _pos, vel: _vel, life: 0.8 + Math.random() * 0.5, size: [0.8 * k, 2.4 * k], color: [0xd8cdb8, 0xb8b0a4], alpha: 0.55, drag: 3.5, gravity: -0.6 });
        }
      }
    }
  }

  /** Solid cartoon puffs pushed outward (biased away from the surface) that slow down quickly: pale at the heart, `color[1]` at the edge. */
  private fireball(at: THREE.Vector3, normal: THREE.Vector3, k: number, count: number, color: [number, number]) {
    for (let i = 0; i < count; i++) {
      randomInSphere(_rand);
      const heart = 1 - _rand.length();
      _vel.copy(_rand).multiplyScalar(9 * k).addScaledVector(normal, 4 * k);
      _pos.copy(at).addScaledVector(_rand, 0.7 * k);
      this.blast.emit({
        pos: _pos,
        vel: _vel,
        life: 0.35 + Math.random() * 0.25,
        size: [1.6 * k, (2.6 + Math.random() * 1.4) * k],
        color: [heart > 0.4 ? 0xfff6c0 : color[0], color[1]],
        alpha: 1,
        drag: 6,
        gravity: -3,
      });
    }
  }

  /** Small, fast sparks that fall (bouncing off the surface they started on). */
  private sparks(at: THREE.Vector3, normal: THREE.Vector3, surface: boolean, count: number, color: [number, number], speed = 1) {
    for (let i = 0; i < count; i++) {
      randomInSphere(_rand).normalize();
      if (surface && _rand.dot(normal) < 0) _rand.reflect(normal);
      _vel.copy(_rand).multiplyScalar((12 + Math.random() * 16) * speed);
      this.fire.emit({ pos: at, vel: _vel, life: 0.4 + Math.random() * 0.6, size: [0.18, 0.06], color, alpha: 1, gravity: 22, drag: 1.5 });
    }
  }

  /** Smoke that lingers and drifts up. `scale` grows it and makes it last longer. */
  private smokeCloud(at: THREE.Vector3, normal: THREE.Vector3, count: number, dark: number, light: number, alpha: number, scale: number) {
    for (let i = 0; i < count; i++) {
      randomInSphere(_rand);
      _vel.copy(_rand).multiplyScalar(3 * scale).addScaledVector(normal, 1.5);
      _pos.copy(at).addScaledVector(_rand, 1.2 * scale);
      const shade = _hue.setHex(dark).offsetHSL(0, 0, Math.floor(Math.random() * 3) * 0.04).getHex(); // (a shade or two lighter, now and then)
      this.smoke.emit({
        pos: _pos,
        vel: _vel,
        life: (1.6 + Math.random() * 1.4) * scale,
        size: [1.5 * scale, (5 + Math.random() * 2) * scale],
        color: [shade, light],
        alpha,
        drag: 2,
        gravity: -1.2,
      });
    }
  }

  /** A firecracker's little pop: a blink of light and a star of colored sparks. */
  private pop(at: THREE.Vector3, color: number) {
    this.fire.emit({ pos: at, life: 0.07, size: [1.6, 2.2], color: [0xffffff, color], alpha: 1 });
    for (let i = 0; i < 12; i++) {
      randomInSphere(_rand).normalize();
      _vel.copy(_rand).multiplyScalar(6 + Math.random() * 6);
      this.fire.emit({ pos: at, vel: _vel, life: 0.3 + Math.random() * 0.3, size: [0.14, 0.04], color: [0xffffff, color], alpha: 1, gravity: 14, drag: 2.5 });
    }
    this.smoke.emit({ pos: at, life: 0.7, size: [0.4, 1.4], color: [0xc8c4c0, 0x9a9692], alpha: 0.4, drag: 2, gravity: -0.6 });
  }

  /**
   * Thunderclap: a bolt strikes down out of the sky onto the blast and flickers twice more, and
   * arcs crackle out from it along the ground.
   */
  private thunderclap(at: THREE.Vector3, normal: THREE.Vector3, surface: boolean, r: number) {
    const k = r / ROCKET.blastRadius;
    const strike = () => {
      const top = at.clone().add(_rand.set((Math.random() - 0.5) * 6, 18, (Math.random() - 0.5) * 6));
      this.bolt(top, at, 1.1, 0.16, 0.5, [0xffffff, 0x5a9cff], 2);
    };
    strike();
    this.after(0.07, strike);
    this.after(0.17, strike);
    this.fire.emit({ pos: at, life: 0.12, size: [r * 2, r * 2.4], color: [0xf0f6ff, 0x6aa4ff], alpha: 1 });
    for (let i = 0; i < 10; i++) {
      randomInSphere(_rand);
      _vel.copy(_rand).multiplyScalar(7 * k).addScaledVector(normal, 2 * k);
      this.fire.emit({ pos: at, vel: _vel, life: 0.25 + Math.random() * 0.2, size: [1.2 * k, 2.4 * k], color: [0xe0ecff, 0x3a6cff], alpha: 0.8, drag: 6 });
    }
    // Arcs out across the surface (or every way, in the air), each a short jagged bolt.
    for (let i = 0; i < 7; i++) {
      randomInSphere(_rand).normalize();
      if (surface) _rand.addScaledVector(normal, -_rand.dot(normal)).normalize();
      const end = at.clone().addScaledVector(_rand, r * (0.6 + Math.random() * 0.5)).addScaledVector(normal, 0.15);
      this.after(Math.random() * 0.25, () => this.bolt(at, end, 0.35, 0.12, 0.28, [0xffffff, 0x80b0ff], 0));
    }
    this.sparks(at, normal, surface, 24, [0xffffff, 0x60a0ff], 1.2);
    this.smokeCloud(at, normal, 10, 0x404858, 0x8890a8, 0.55, 0.9);
  }

  /**
   * A jagged bolt of light from one point to another, drawn as a line of glowing dots (so it costs
   * nothing new to draw), with `forks` short branches off it.
   */
  private bolt(from: THREE.Vector3, to: THREE.Vector3, jag: number, life: number, size: number, color: [number, number], forks: number) {
    const length = from.distanceTo(to);
    const steps = Math.max(2, Math.ceil(length / 1.2));
    const points: THREE.Vector3[] = [from.clone()];
    for (let i = 1; i < steps; i++) points.push(new THREE.Vector3().lerpVectors(from, to, i / steps).add(randomInSphere(_rand).multiplyScalar(jag)));
    points.push(to.clone());
    for (let i = 1; i < points.length; i++) this.dots(points[i - 1], points[i], 0.15, life, size, color);
    for (let f = 0; f < forks; f++) {
      const start = points[1 + Math.floor(Math.random() * (points.length - 2))];
      const end = start.clone().add(randomInSphere(_rand).multiplyScalar(3)).addScaledVector(_step.subVectors(to, from).normalize(), 2);
      this.bolt(start, end, jag * 0.5, life * 0.8, size * 0.6, color, 0);
    }
  }

  /** A line of glowing dots, `spacing` apart. */
  private dots(from: THREE.Vector3, to: THREE.Vector3, spacing: number, life: number, size: number, color: [number, number]) {
    const n = Math.max(1, Math.round(from.distanceTo(to) / spacing));
    for (let i = 0; i <= n; i++) {
      _pos.lerpVectors(from, to, i / n);
      this.fire.emit({ pos: _pos, life: life * (0.7 + Math.random() * 0.6), size: [size, size * 0.5], color, alpha: 1 });
    }
  }

  /** Bubble Pop: one big bubble swells over the blast, then bursts into a cloud of little ones and a splash. */
  private bubblePop(at: THREE.Vector3, normal: THREE.Vector3, r: number) {
    const k = r / ROCKET.blastRadius;
    const center = at.clone().addScaledVector(normal, 0.4 * k);
    // (Three, each bigger than the last, as one particle would fade before it had grown.)
    for (let i = 0; i < 3; i++) this.after(i * 0.055, () => this.bubbles.emit({ pos: center, life: 0.12, size: [r * (0.45 + i * 0.4), r * (0.9 + i * 0.4)], color: [0xffffff, 0xd8f8ff], alpha: 1 }));
    this.after(0.16, () => {
      this.fire.emit({ pos: center, life: 0.08, size: [r * 1.2, r * 1.6], color: [0xe8ffff, 0x60d8ff], alpha: 0.6 });
      for (let i = 0; i < 46; i++) {
        randomInSphere(_rand).normalize();
        _pos.copy(center).addScaledVector(_rand, r * 0.7);
        _vel.copy(_rand).multiplyScalar((2 + Math.random() * 5) * k).addScaledVector(normal, 1);
        const s = (0.18 + Math.random() * 0.4) * Math.sqrt(k);
        this.bubbles.emit({ pos: _pos, vel: _vel, life: 1.2 + Math.random() * 1.4, size: [s, s * 1.15], color: [0xffffff, 0xc8f0ff], alpha: 0.95, drag: 2.5, gravity: -0.7 });
      }
      // Droplets from the burst film, falling.
      for (let i = 0; i < 26; i++) {
        randomInSphere(_rand).normalize();
        _vel.copy(_rand).multiplyScalar(8 + Math.random() * 8);
        _pos.copy(center).addScaledVector(_rand, r * 0.6);
        this.fire.emit({ pos: _pos, vel: _vel, life: 0.4 + Math.random() * 0.4, size: [0.14, 0.05], color: [0xffffff, 0x60d8ff], alpha: 0.9, gravity: 20, drag: 2 });
      }
      this.smokeCloud(center, normal, 8, 0xd8f0f8, 0xf0faff, 0.3, 0.8);
    });
  }

  /** Runs `fn` `seconds` from now (in effect time, so a paused game waits). */
  private after(seconds: number, fn: () => void) {
    this.pending.push({ in: seconds, fn });
  }

  /** Someone blown apart: armor chunks in their color, a puff of smoke and a spray of sparks. */
  burst(at: THREE.Vector3, color: number) {
    const floor = this.groundAt?.(at) ?? at.y - 0.9;
    this.debris.throw(at, 16, 9, [color, 0xeef0f3, 0x39404e, color], 0.24, floor);
    this.fire.emit({ pos: at, life: 0.12, size: [2.2, 3], color: [0xffffff, color], alpha: 0.9 });
    // A big cartoon "poof": a ring of puffs bursting outward round a fat one in the middle.
    for (let i = 0; i < 16; i++) {
      randomInSphere(_rand);
      _vel.copy(_rand).normalize().multiplyScalar(4 + Math.random() * 2).setY(_rand.y * 2 + 1.5);
      _pos.copy(at).addScaledVector(_rand, 0.4);
      this.smoke.emit({ pos: _pos, vel: _vel, life: 0.8 + Math.random() * 0.5, size: [1.4, 3], color: [0xffffff, 0xc8c8d0], alpha: 0.9, drag: 4, gravity: -0.8 });
    }
    this.smoke.emit({ pos: at, life: 0.6, size: [2.2, 3.6], color: [0xffffff, 0xe0e0e8], alpha: 0.9, gravity: -0.5 });
    for (let i = 0; i < 18; i++) {
      randomInSphere(_rand).normalize();
      _vel.copy(_rand).multiplyScalar(6 + Math.random() * 8);
      this.fire.emit({ pos: at, vel: _vel, life: 0.3 + Math.random() * 0.4, size: [0.14, 0.04], color: [0xffffff, color], alpha: 1, gravity: 16, drag: 2 });
    }
  }

  /** A hit landing on a player: a quick star of sparks. */
  hit(at: THREE.Vector3) {
    this.fire.emit({ pos: at, life: 0.08, size: [0.9, 1.3], color: [0xffffff, 0xffc070], alpha: 0.9 });
    for (let i = 0; i < 8; i++) {
      randomInSphere(_rand).normalize();
      _vel.copy(_rand).multiplyScalar(5 + Math.random() * 6);
      this.fire.emit({ pos: at, vel: _vel, life: 0.15 + Math.random() * 0.2, size: [0.12, 0.03], color: [0xfff6d0, 0xff9a40], alpha: 1, gravity: 10, drag: 3 });
    }
  }

  /** Dust kicked up round a player's feet as they land hard. `amount` 0..1. */
  dust(feet: THREE.Vector3, amount: number) {
    const n = Math.round(4 + amount * 8);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
      _vel.set(Math.cos(a), 0.15, Math.sin(a)).multiplyScalar(2 + amount * 3);
      _pos.set(feet.x + Math.cos(a) * 0.3, feet.y + 0.15, feet.z + Math.sin(a) * 0.3);
      this.smoke.emit({ pos: _pos, vel: _vel, life: 0.5 + Math.random() * 0.3, size: [0.3, 0.9 + amount * 0.6], color: [0xe8e0d0, 0xc8c0b4], alpha: 0.5, drag: 4, gravity: -0.3 });
    }
  }

  /** A column of light where a player has just respawned. */
  beam(feet: THREE.Vector3) {
    const beam = oldest(this.beams);
    beam.age = 0;
    beam.obj.visible = true;
    beam.obj.position.copy(feet);
    for (let i = 0; i < 16; i++) {
      randomInSphere(_rand);
      _pos.copy(feet).add(_rand.setY(Math.abs(_rand.y) * 2));
      _vel.set(0, 2 + Math.random() * 3, 0);
      this.fire.emit({ pos: _pos, vel: _vel, life: 0.5 + Math.random() * 0.4, size: [0.12, 0.03], color: [0xe0ffff, 0x40c0ff], alpha: 1, drag: 1 });
    }
  }

  /** A little smoke left at a muzzle as it fires. */
  muzzleSmoke(at: THREE.Vector3) {
    for (let i = 0; i < 3; i++) {
      randomInSphere(_rand).multiplyScalar(0.5);
      _vel.copy(_rand).setY(_rand.y + 0.6);
      this.smoke.emit({ pos: at, vel: _vel, life: 0.6 + Math.random() * 0.3, size: [0.2, 0.8], color: [0xe8e4e0, 0xb0aca8], alpha: 0.45, drag: 2.5, gravity: -0.5 });
    }
  }

  /** A grenade bouncing off something before it's armed: a few sparks, more the harder it hit. */
  bounce(at: THREE.Vector3, normal: THREE.Vector3, speed: number) {
    const count = Math.min(Math.round(speed / 2), 10);
    for (let i = 0; i < count; i++) {
      randomInSphere(_rand).normalize();
      if (_rand.dot(normal) < 0) _rand.reflect(normal);
      _vel.copy(_rand).multiplyScalar(3 + Math.random() * speed * 0.5);
      this.fire.emit({ pos: at, vel: _vel, life: 0.2 + Math.random() * 0.25, size: [0.1, 0.03], color: [0xfff0c0, 0xff9040], alpha: 1, gravity: 22, drag: 2 });
    }
    _vel.copy(normal).multiplyScalar(0.6);
    this.smoke.emit({ pos: at, vel: _vel, life: 0.6, size: [0.2, 0.7], color: [0xb8b0a4, 0x8a8682], alpha: 0.5, drag: 3 });
  }

  /** A mystery box being taken: a burst of glitter spraying out of it. */
  sparkle(at: THREE.Vector3) {
    this.fire.emit({ pos: at, life: 0.25, size: [1.5, 3], color: [0xfff4d0, 0xc070ff], alpha: 0.9 });
    for (let i = 0; i < 40; i++) {
      randomInSphere(_rand).normalize();
      _vel.copy(_rand).multiplyScalar(3 + Math.random() * 5);
      _vel.y += 2;
      this.fire.emit({
        pos: at,
        vel: _vel,
        life: 0.5 + Math.random() * 0.6,
        size: [0.16, 0.04],
        color: [Math.random() < 0.5 ? 0xffe070 : 0xd090ff, 0x8040ff],
        alpha: 1,
        gravity: 6,
        drag: 2.5,
      });
    }
  }

  update(projectiles: readonly Projectile[], alpha: number, dt: number) {
    if (this.pending.length) {
      const due = this.pending.filter((p) => (p.in -= dt) <= 0);
      this.pending = this.pending.filter((p) => p.in > 0);
      for (const p of due) p.fn();
    }
    this.syncProjectiles(projectiles, alpha, dt);
    this.fire.update(dt);
    this.smoke.update(dt);
    this.blast.update(dt);
    this.bubbles.update(dt);

    this.debris.update(dt);
    for (const f of this.flashes) {
      if (!f.obj.visible) continue;
      f.age += dt;
      const t = f.age / FLASH_TIME;
      f.obj.visible = t < 1;
      f.obj.scale.setScalar((f.obj.userData.radius as number) * (0.4 + 0.6 * Math.sqrt(t)));
      f.obj.material.opacity = 1 - t * t;
    }
    for (const b of this.beams) {
      if (!b.obj.visible) continue;
      b.age += dt;
      const t = b.age / BEAM_TIME;
      b.obj.visible = t < 1;
      b.obj.scale.set(1 - t * 0.6, 3 + t * 9, 1 - t * 0.6);
      b.obj.material.opacity = (1 - t) * 0.25;
    }

    for (const l of this.lights) {
      l.age += dt;
      l.obj.intensity = l.age < LIGHT_TIME ? 120 * (1 - l.age / LIGHT_TIME) ** 2 : 0;
    }

    for (const r of this.rings) {
      if (!r.obj.visible) continue;
      r.age += dt;
      const t = r.age / RING_TIME;
      r.obj.visible = t < 1;
      r.obj.scale.setScalar(0.3 + r.radius * Math.sqrt(t));
      r.obj.material.opacity = (1 - t) * 0.8;
    }

    for (const d of this.decals) {
      if (!d.obj.visible) continue;
      d.age += dt;
      d.obj.visible = d.age < DECAL_TIME;
      d.obj.material.opacity = Math.min(1, (DECAL_TIME - d.age) / 2);
    }
  }

  /**
   * Projects a scorch mark onto the level around the hit point. It only exists where there's
   * surface facing roughly the same way as the one hit, so at an edge or a corner it stops at the
   * edge instead of hanging out into the air (which a flat disc did).
   */
  private addDecal(at: THREE.Vector3, normal: THREE.Vector3) {
    const size = (1.4 + Math.random() * 0.5) * 2;
    _decalSize.set(size, size, DECAL_DEPTH * 2);
    _euler.setFromQuaternion(_q.setFromUnitVectors(Z, normal).multiply(_spin.setFromAxisAngle(Z, Math.random() * Math.PI * 2)));
    _decalBounds.setFromCenterAndSize(at, _pos.setScalar(size * Math.SQRT2));

    const parts: THREE.BufferGeometry[] = [];
    for (const s of this.decalSurfaces) {
      if (!s.bounds.intersectsBox(_decalBounds)) continue;
      const projected = new DecalGeometry(s.mesh, at, _euler, _decalSize);
      const kept = facingTriangles(projected, normal);
      projected.dispose();
      if (kept) parts.push(kept);
    }
    if (!parts.length) return; // hit something that isn't level geometry, like a crate that will move away

    const entry = oldest(this.decals);
    const decal = entry.obj;
    if (decal.geometry !== this.decalPlaceholder) decal.geometry.dispose();
    decal.geometry = parts.length === 1 ? parts[0] : mergeTriangles(parts);
    entry.age = 0;
    decal.visible = true;
    decal.material.opacity = 1;
  }

  private syncProjectiles(projectiles: readonly Projectile[], alpha: number, dt: number) {
    const frame = ++this.frameNo;
    for (const r of projectiles) {
      let entry = this.projectileMeshes.get(r.id);
      if (!entry) {
        const mesh = this.protos[r.kind].clone();
        let light: THREE.MeshBasicMaterial | null = null;
        const lightMesh = mesh.getObjectByName(GRENADE_LIGHT) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | undefined;
        if (lightMesh) lightMesh.material = light = lightMesh.material.clone();
        this.scene.add(mesh);
        // Only for projectiles seen right as they're fired; one that first shows up mid-flight stays on its path.
        const offset = new THREE.Vector3();
        if (r.life > LIFETIME[r.kind] - MUZZLE_BLEND_TIME / 2) this.muzzleOffset?.(r.ownerId, offset);
        entry = { mesh, lastTrail: r.prevPos.clone().add(offset), seen: frame, offset, age: 0, light, spin: 0, arc: null };
        this.projectileMeshes.set(r.id, entry);
      }
      entry.seen = frame;
      entry.age += dt;
      const { mesh, lastTrail } = entry;
      const blend = Math.min(entry.age / MUZZLE_BLEND_TIME, 1);
      mesh.position.lerpVectors(r.prevPos, r.pos, alpha).addScaledVector(entry.offset, 1 - blend * blend * (3 - 2 * blend));
      // A grenade rolling to a stop jitters in direction: it keeps the pose it had while still moving.
      if (r.kind !== 'grenade' || r.vel.lengthSq() > 4) mesh.lookAt(_pos.copy(mesh.position).sub(r.vel));
      if (r.kind === 'grenade') {
        this.updateGrenade(r, entry, dt);
        continue;
      }

      if (r.kind === 'hypersonic') {
        this.layStreak(lastTrail, mesh.position);
        continue;
      }

      // Lay smoke + exhaust glow at fixed spacing along the path traveled since the last frame, in
      // the colors of the shooter's trail.
      const trail = this.trailOf(r.ownerId);
      const fire = trail ? [...trail.fire] : [0xffd080, 0xff5010];
      const smoke = trail ? [...trail.smoke] : [0xd8d4d0, 0x8a8682];
      if (trail?.id === 'rainbow') fire[1] = _hue.setHSL((performance.now() / 1500 + r.id * 0.17) % 1, 1, 0.55).getHex();
      let gap = lastTrail.distanceTo(mesh.position);
      _step.subVectors(mesh.position, lastTrail).normalize();
      while (gap >= TRAIL_SPACING) {
        lastTrail.addScaledVector(_step, TRAIL_SPACING);
        gap -= TRAIL_SPACING;
        if (trail?.id === 'lightning') {
          this.layArc(entry, fire as [number, number], smoke as [number, number]);
          continue;
        }
        if (trail?.id === 'bubbles') {
          this.layBubble(lastTrail, fire as [number, number], smoke as [number, number]);
          continue;
        }
        randomInSphere(_rand).multiplyScalar(0.4);
        this.smoke.emit({
          pos: lastTrail,
          vel: _rand,
          life: 0.9 + Math.random() * 0.5,
          size: [0.35, 1.6],
          color: smoke as [number, number],
          alpha: 0.7,
          drag: 1,
          gravity: -0.4,
        });
        this.fire.emit({ pos: lastTrail, life: 0.12, size: [0.5, 0.2], color: fire as [number, number], alpha: 0.8 });
        if (trail?.id === 'rainbow') fire[1] = _hue.offsetHSL(0.03, 0, 0).getHex();
      }
    }
    for (const [id, entry] of this.projectileMeshes) {
      if (entry.seen !== frame) {
        this.scene.remove(entry.mesh);
        entry.light?.dispose();
        this.projectileMeshes.delete(id);
      }
    }
  }

  /** One step of a lightning trail: a jagged arc crackling along the path in flickering dots, and now and then a fork off it. */
  private layArc(entry: ProjectileMesh, fire: [number, number], smoke: [number, number]) {
    const at = entry.lastTrail;
    entry.arc ??= at.clone();
    _arc.copy(at).add(randomInSphere(_rand).multiplyScalar(0.6));
    this.dots(entry.arc, _arc, ARC_SPACING, 0.24, 0.3, fire);
    if (Math.random() < 0.3) this.dots(_arc, _fork.copy(_arc).add(randomInSphere(_rand).multiplyScalar(1.6)), ARC_SPACING, 0.14, 0.18, fire);
    entry.arc.copy(_arc);
    this.fire.emit({ pos: at, life: 0.1, size: [0.45, 0.15], color: fire, alpha: 0.7 });
    randomInSphere(_rand).multiplyScalar(0.3);
    this.smoke.emit({ pos: at, vel: _rand, life: 0.6 + Math.random() * 0.3, size: [0.25, 1.1], color: smoke, alpha: 0.45, drag: 1.5, gravity: -0.3 });
  }

  /** One step of a bubble trail: (most steps) a bubble that drifts off and floats up, over a faint mist. */
  private layBubble(at: THREE.Vector3, fire: [number, number], smoke: [number, number]) {
    if (Math.random() < 0.6) {
      randomInSphere(_rand).multiplyScalar(0.25);
      _pos.copy(at).add(_rand);
      _vel.copy(_rand).multiplyScalar(2).setY(_rand.y + 0.5);
      const s = 0.12 + Math.random() * 0.26;
      this.bubbles.emit({ pos: _pos, vel: _vel, life: 1 + Math.random(), size: [s, s * 1.2], color: [0xffffff, smoke[0]], alpha: 0.9, drag: 1.5, gravity: -0.5 });
    }
    this.fire.emit({ pos: at, life: 0.12, size: [0.4, 0.15], color: fire, alpha: 0.6 });
    randomInSphere(_rand).multiplyScalar(0.3);
    this.smoke.emit({ pos: at, vel: _rand, life: 0.6 + Math.random() * 0.3, size: [0.25, 1], color: smoke, alpha: 0.2, drag: 1.5, gravity: -0.3 });
  }

  /** A hypersonic dart's trail: a thin, bright cyan streak over a faint vapor line that fades fast. */
  private layStreak(lastTrail: THREE.Vector3, to: THREE.Vector3) {
    let gap = lastTrail.distanceTo(to);
    _step.subVectors(to, lastTrail).normalize();
    while (gap >= STREAK_SPACING) {
      lastTrail.addScaledVector(_step, STREAK_SPACING);
      gap -= STREAK_SPACING;
      this.fire.emit({ pos: lastTrail, life: 0.18, size: [0.35, 0.08], color: [0xe0fcff, 0x2ad0ff], alpha: 0.9 });
      randomInSphere(_rand).multiplyScalar(0.15);
      this.smoke.emit({ pos: lastTrail, vel: _rand, life: 0.45, size: [0.12, 0.45], color: [0xf0f4f8, 0xc0c8d0], alpha: 0.35, drag: 2 });
    }
  }

  /** Tumbles end over end, trails thin smoke, and its light goes from green to blinking red once armed. */
  private updateGrenade(r: Projectile, entry: ProjectileMesh, dt: number) {
    const { mesh, lastTrail } = entry;
    entry.spin += dt * GRENADE_SPIN * Math.min(r.vel.length() / GRENADE.speed, 1);
    if (r.vel.lengthSq() > 4) mesh.rotateX(entry.spin);
    if (entry.light) {
      const armed = isArmed(r);
      entry.light.color.copy(armed ? GRENADE_ARMED : GRENADE_UNARMED);
      entry.light.visible = !armed || Math.floor(entry.age * 12) % 2 === 0;
    }
    let gap = lastTrail.distanceTo(mesh.position);
    _step.subVectors(mesh.position, lastTrail).normalize();
    while (gap >= GRENADE_TRAIL_SPACING) {
      lastTrail.addScaledVector(_step, GRENADE_TRAIL_SPACING);
      gap -= GRENADE_TRAIL_SPACING;
      randomInSphere(_rand).multiplyScalar(0.2);
      this.smoke.emit({ pos: lastTrail, vel: _rand, life: 0.5 + Math.random() * 0.3, size: [0.15, 0.6], color: [0xe0dcd8, 0xa8a4a0], alpha: 0.45, drag: 1, gravity: -0.3 });
    }
  }
}
