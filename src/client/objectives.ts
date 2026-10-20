import * as THREE from 'three';
import { DT, KOTH, PLAYER, RACE, TEAMS } from '../shared/config';
import type { FlagState } from '../shared/protocol';
import type { Item } from '../shared/sim';
import type { RaceCourse } from '../shared/modes';

// What the game modes put in the world: capture-the-flag flags and their bases, health / armor /
// overdrive items, a race's checkpoint rings, and the ghost of your best lap.

// --- flags ----------------------------------------------------------------------------------------

/** Every flag cloth, waved together once a frame (clones share their geometry). */
const cloths: { geo: THREE.PlaneGeometry; rest: Float32Array; width: number }[] = [];

/**
 * A flag on a pole, its foot at the origin: `scale` 1 is a full-size flag (about 2.6 m tall), a
 * smaller one rides on a carrier's back.
 */
export function buildFlagModel(color: number, scale = 1): THREE.Group {
  const group = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 2.6, 8), new THREE.MeshStandardMaterial({ color: 0xd8d8dc, metalness: 0.6, roughness: 0.3 }));
  pole.position.y = 1.3;
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), new THREE.MeshStandardMaterial({ color: 0xf2c230, metalness: 0.7, roughness: 0.3 }));
  knob.position.y = 2.64;
  const w = 1.3;
  const h = 0.85;
  const geo = new THREE.PlaneGeometry(w, h, 12, 4);
  geo.translate(w / 2 + 0.03, 2.55 - h / 2, 0);
  cloths.push({ geo, rest: (geo.attributes.position.array as Float32Array).slice(), width: w });
  const cloth = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, side: THREE.DoubleSide, roughness: 0.7 }));
  for (const m of [pole, knob, cloth]) m.castShadow = true;
  group.add(pole, knob, cloth);
  group.scale.setScalar(scale);
  return group;
}

/** Ripples every flag's cloth. */
export function waveFlags(time: number) {
  for (const c of cloths) {
    const pos = c.geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = c.rest[i * 3] / c.width; // 0 at the pole, ~1 at the free end
      pos.setZ(i, Math.sin(time * 6 - x * 7) * 0.12 * x);
    }
    pos.needsUpdate = true;
    c.geo.computeVertexNormals();
  }
}

/** Forgets the flags of a finished game, so their geometry can go. */
export function clearFlags() {
  cloths.length = 0;
}

/**
 * Capture the flag: each team's base (a glowing pad) and its flag, standing on the base, lying
 * where its carrier fell, or (carried) hidden here because the carrier's model wears it. A tall
 * faint beam above each flag shows where it is from anywhere on the map.
 */
export class FlagsView {
  private readonly flags: { model: THREE.Group; beam: THREE.Mesh; pad: THREE.Group }[];
  private time = 0;

  constructor(scene: THREE.Scene, homes: readonly THREE.Vector3[]) {
    this.flags = homes.map((home, team) => {
      const color = TEAMS[team].color;
      const pad = new THREE.Group();
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.8, 0.16, 32), new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.6, metalness: 0.4 }));
      disc.position.y = 0.08;
      disc.receiveShadow = true;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.45, 0.07, 8, 40), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2) }));
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.17;
      pad.add(disc, ring);
      pad.position.copy(home);
      const model = buildFlagModel(color);
      model.position.copy(home).y += 0.16;
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.25, 0.25, 60, 8, 1, true),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      beam.position.y = 30;
      model.add(beam);
      scene.add(pad, model);
      return { model, beam, pad };
    });
  }

  /** `flags` from the latest snapshot; `localId`'s carried flag isn't drawn (it would sit in our face). */
  update(dt: number, flags: readonly FlagState[]) {
    this.time += dt;
    waveFlags(this.time);
    this.flags.forEach((f, team) => {
      const s = flags[team];
      f.model.visible = !!s && !s.carrier;
      if (!s || s.carrier) return;
      f.model.position.set(s.pos[0], s.pos[1] + (s.atHome ? 0.16 : 0), s.pos[2]);
      // A dropped flag lies over a little and spins slowly, so it reads as "loose".
      f.model.rotation.set(0, s.atHome ? 0 : this.time * 1.2, s.atHome ? 0 : 0.35);
      (f.beam.material as THREE.MeshBasicMaterial).opacity = s.atHome ? 0.14 : 0.3 + Math.sin(this.time * 6) * 0.1;
    });
  }
}

// --- items ----------------------------------------------------------------------------------------

function crossTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f4f6f8';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#e03a3a';
  ctx.fillRect(size * 0.4, size * 0.15, size * 0.2, size * 0.7);
  ctx.fillRect(size * 0.15, size * 0.4, size * 0.7, size * 0.2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function glowTexture(rgb: string): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, `rgba(${rgb},0.75)`);
  g.addColorStop(0.4, `rgba(${rgb},0.3)`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

/** Health packs, armor and the overdrive: bobbing, spinning, shrinking away while they respawn. */
export class ItemsView {
  private readonly views: { group: THREE.Group; spin: THREE.Object3D; scale: number }[];
  private time = 0;

  constructor(scene: THREE.Scene, private readonly items: readonly Item[]) {
    const health = new THREE.MeshStandardMaterial({ map: crossTexture(), emissive: 0xffffff, emissiveMap: crossTexture(), emissiveIntensity: 0.35, roughness: 0.4 });
    const armor = new THREE.MeshStandardMaterial({ color: 0xf2b22e, emissive: 0xc07010, emissiveIntensity: 0.6, metalness: 0.7, roughness: 0.3 });
    const overdrive = new THREE.MeshStandardMaterial({ color: 0xff50d8, emissive: 0xff30c8, emissiveIntensity: 1.6, roughness: 0.2, metalness: 0.3, flatShading: true });
    const halos = {
      health: new THREE.SpriteMaterial({ map: glowTexture('120,255,140'), blending: THREE.AdditiveBlending, depthWrite: false }),
      armor: new THREE.SpriteMaterial({ map: glowTexture('255,190,60'), blending: THREE.AdditiveBlending, depthWrite: false }),
      overdrive: new THREE.SpriteMaterial({ map: glowTexture('255,80,220'), blending: THREE.AdditiveBlending, depthWrite: false }),
    };
    this.views = items.map((item) => {
      let spin: THREE.Object3D;
      if (item.kind === 'health') spin = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.55, 0.55), health);
      else if (item.kind === 'armor') {
        // A hexagonal chest plate standing on edge.
        spin = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.14, 6), armor);
        spin.rotation.x = Math.PI / 2;
        const holder = new THREE.Group();
        holder.add(spin);
        spin = holder;
      } else spin = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 0), overdrive);
      spin.traverse((o) => (o.castShadow = true));
      const halo = new THREE.Sprite(halos[item.kind]);
      halo.scale.setScalar(item.kind === 'overdrive' ? 2.6 : 1.8);
      const group = new THREE.Group();
      group.add(spin, halo);
      group.position.copy(item.pos);
      group.traverse((o) => (o.frustumCulled = false)); // shaders compile with everything else
      scene.add(group);
      return { group, spin, scale: 1 };
    });
  }

  update(dt: number) {
    this.time += dt;
    this.views.forEach((v, i) => {
      const item = this.items[i];
      const target = item.respawnIn > 0 ? 0 : 1;
      v.scale += (target - v.scale) * (1 - Math.exp(-dt * 6));
      if (Math.abs(target - v.scale) < 0.01) v.scale = target;
      v.group.visible = v.scale > 0;
      v.group.scale.setScalar(v.scale);
      v.group.position.y = item.pos.y + Math.sin(this.time * 2 + i * 1.3) * 0.12;
      v.spin.rotation.y = this.time * (item.kind === 'overdrive' ? 2.4 : 1.3) + i;
    });
  }
}

// --- race -----------------------------------------------------------------------------------------

/**
 * The race's checkpoint rings, each facing the way you fly through it. The next ring glows bright
 * and pulses, the one after shows dimly, the rest are faint; the start/finish gate is checkered.
 */
export class RaceView {
  private readonly rings: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>[];
  private time = 0;
  readonly centers: THREE.Vector3[];

  constructor(scene: THREE.Scene, course: RaceCourse) {
    this.centers = course.rings.map((r) => new THREE.Vector3(...r));
    const geo = new THREE.TorusGeometry(RACE.ringRadius, 0.16, 8, 48);
    this.rings = this.centers.map((center, i) => {
      const from = i === 0 ? new THREE.Vector3(...course.start.pos) : this.centers[i - 1];
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: i === 0 ? 0xffffff : 0x50e0ff, transparent: true, depthWrite: false }));
      mesh.position.copy(center);
      mesh.lookAt(from.x === center.x && from.z === center.z ? center.clone().add(new THREE.Vector3(0, 0, 1)) : from);
      mesh.frustumCulled = false;
      scene.add(mesh);
      return mesh;
    });
  }

  /** `next`: the ring to fly through next, -1 to show none as next (spectating someone else, say). */
  update(dt: number, next: number) {
    this.time += dt;
    const n = this.rings.length;
    this.rings.forEach((ring, i) => {
      const m = ring.material;
      const ahead = next < 0 ? -1 : (i - next + n) % n;
      if (ahead === 0) {
        m.opacity = 0.95;
        m.color.set(i === 0 ? 0xffe060 : 0x60ff90).multiplyScalar(1.6 + Math.sin(this.time * 7) * 0.4);
        ring.scale.setScalar(1 + Math.sin(this.time * 7) * 0.04);
      } else {
        m.opacity = ahead === 1 ? 0.5 : 0.18;
        m.color.set(i === 0 ? 0xffffff : 0x50e0ff);
        ring.scale.setScalar(1);
      }
    });
  }
}

/**
 * King of the hill: a glowing ring on the floor where the hill is, with a column of light over it,
 * colored by who has it: white for nobody, green for you, red for someone else, yellow contested.
 */
export class HillView {
  private readonly group = new THREE.Group();
  private readonly ring: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  private readonly column: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  private time = 0;

  constructor(
    scene: THREE.Scene,
    private readonly spots: readonly THREE.Vector3[],
  ) {
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(KOTH.radius, 0.12, 8, 64), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false }));
    this.ring.rotation.x = Math.PI / 2;
    this.ring.position.y = 0.08;
    const column = new THREE.CylinderGeometry(KOTH.radius, KOTH.radius, KOTH.height, 48, 1, true);
    column.translate(0, KOTH.height / 2, 0);
    this.column = new THREE.Mesh(column, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide }));
    this.group.add(this.ring, this.column);
    this.group.renderOrder = 2;
    scene.add(this.group);
  }

  /** Where the hill is now: its floor center. */
  get position(): THREE.Vector3 {
    return this.group.position;
  }

  update(dt: number, index: number, state: 'free' | 'mine' | 'theirs' | 'contested') {
    this.time += dt;
    const spot = this.spots[Math.max(0, index) % this.spots.length];
    this.group.position.copy(spot);
    const color = state === 'mine' ? 0x60ff90 : state === 'theirs' ? 0xff5a4a : state === 'contested' ? 0xffe060 : 0xffffff;
    const pulse = 1 + Math.sin(this.time * (state === 'free' ? 2 : 6)) * 0.25;
    this.ring.material.color.set(color).multiplyScalar(1.4 * pulse);
    this.column.material.color.set(color);
    this.column.material.opacity = 0.06 + 0.04 * pulse;
  }
}

/** Seconds as "1:02.345", or "0:00.000". */
export function formatLap(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}`;
}

const GHOST_KEY = 'rocket-jump:ghost:';

/**
 * Your best lap on this map, as a see-through figure flying it alongside you. Recorded from your
 * own predicted positions every tick of a lap; kept in the browser for next time.
 */
export class RaceGhost {
  private readonly mesh: THREE.Group;
  private recording: number[] = []; // x, y, z per tick of the lap under way
  // The lap before: the server's correction restarts our lap clock a moment before the news that
  // the lap was done arrives, so the finished lap is usually here by then.
  private previous: number[] = [];
  private best: Float32Array | null = null;
  /** The record lap on this map (online): its own gold ghost. Positions every `recordStride` ticks. */
  private recordPath: Float32Array | null = null;
  private recordStride = 1;
  private readonly recordMesh: THREE.Group;
  recordTime = 0;
  recordName = '';
  private splits: number[] = []; // seconds at each ring this lap
  private bestSplits: number[] = [];
  bestTime = 0;

  constructor(
    scene: THREE.Scene,
    private readonly map: string,
  ) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xbfe8ff, transparent: true, opacity: 0.28, depthWrite: false });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(PLAYER.radius, PLAYER.halfHeight * 2, 4, 12), mat);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.12, 0.1), new THREE.MeshBasicMaterial({ color: 0x80f0ff, transparent: true, opacity: 0.6, depthWrite: false }));
    visor.position.set(0, PLAYER.eyeOffset, -0.36);
    this.mesh = new THREE.Group();
    this.mesh.add(body, visor);
    this.mesh.visible = false;
    scene.add(this.mesh);
    const gold = new THREE.MeshBasicMaterial({ color: 0xffd060, transparent: true, opacity: 0.3, depthWrite: false });
    this.recordMesh = new THREE.Group();
    this.recordMesh.add(new THREE.Mesh(body.geometry, gold), new THREE.Mesh(visor.geometry, new THREE.MeshBasicMaterial({ color: 0xfff0a0, transparent: true, opacity: 0.6, depthWrite: false })));
    this.recordMesh.children[1].position.copy(visor.position);
    this.recordMesh.visible = false;
    scene.add(this.recordMesh);
    try {
      const saved = JSON.parse(localStorage.getItem(GHOST_KEY + map) ?? 'null') as { time: number; path: number[]; splits?: number[] } | null;
      if (saved && saved.time > 0 && Array.isArray(saved.path)) {
        this.best = Float32Array.from(saved.path, (v) => v / 100);
        this.bestTime = saved.time;
        this.bestSplits = Array.isArray(saved.splits) ? saved.splits.map(Number) : [];
      }
    } catch {
      // No storage, or something unreadable in it: no ghost until you set a lap.
    }
  }

  /** Every tick, with the local player's lap clock (-1 before the start gate) and position. */
  record(lapTime: number, pos: THREE.Vector3) {
    const i = Math.round(lapTime / DT) * 3;
    // The lap clock went back: a new lap (or a restart). Keep the old one until we hear how it went.
    if (lapTime < 0 || i < this.recording.length - 3 * 30) {
      if (this.recording.length) this.previous = this.recording;
      this.recording = [];
    }
    if (lapTime < 0 || i > 60 * 60 * 10 * 3) return; // (ten minutes is not a lap)
    if (i < this.recording.length - 3) this.recording.length = i; // a small correction backwards
    this.recording[i] = pos.x;
    this.recording[i + 1] = pos.y;
    this.recording[i + 2] = pos.z;
  }

  /** We flew through ring `index` this far into the lap: how far ahead (negative) or behind the best lap we are, if there is one. */
  split(index: number, time: number): number | null {
    this.splits[index] = time;
    const best = this.bestSplits[index];
    return best ? time - best : null;
  }

  /** A lap of ours just finished in `time` seconds: keep it if it's the best yet. */
  lapDone(time: number) {
    const splits = this.splits;
    this.splits = [];
    const ticks = Math.round(time / DT);
    if (this.bestTime && time >= this.bestTime) return;
    const source = this.recording.length >= ticks * 3 * 0.8 ? this.recording : this.previous;
    if (source.length < ticks * 3 * 0.8) return; // we didn't see this lap (joined mid-lap, say)
    const path = source.slice(0, ticks * 3);
    // Holes (ticks we didn't see, like the first one or two) take the nearest seen position.
    for (let i = 0; i < path.length; i++) {
      if (path[i] !== undefined) continue;
      let j = i + 3;
      while (j < path.length && path[j] === undefined) j += 3;
      path[i] = i >= 3 ? path[i - 3] : (path[j] ?? 0);
    }
    this.best = Float32Array.from(path);
    this.bestTime = time;
    this.bestSplits = splits;
    try {
      localStorage.setItem(GHOST_KEY + this.map, JSON.stringify({ time, splits, path: path.map((v) => Math.round(v * 100)) }));
    } catch {
      // Out of space or blocked: the ghost still runs this session.
    }
  }

  /** The map's record lap (from the server's leaderboard): x, y, z in centimeters every `stride` ticks. */
  setRecord(path: number[], stride: number, time: number, name: string) {
    this.recordPath = Float32Array.from(path, (v) => v / 100);
    this.recordStride = stride;
    this.recordTime = time;
    this.recordName = name;
  }

  /** Places the ghosts where they were this far into their laps; hidden with no lap under way. */
  update(lapTime: number) {
    placeGhost(this.mesh, this.best, 1, lapTime);
    placeGhost(this.recordMesh, this.recordPath, this.recordStride, lapTime);
  }
}

/** Puts a ghost where its path was `lapTime` into the lap (sampled every `stride` ticks), or hides it. */
function placeGhost(mesh: THREE.Object3D, path: Float32Array | null, stride: number, lapTime: number) {
  if (!path || lapTime < 0) {
    mesh.visible = false;
    return;
  }
  const t = lapTime / DT / stride;
  const i = Math.floor(t);
  if (i >= path.length / 3 - 1) {
    mesh.visible = false;
    return;
  }
  const f = t - i;
  const a = i * 3;
  mesh.position.set(path[a] + (path[a + 3] - path[a]) * f, path[a + 1] + (path[a + 4] - path[a + 1]) * f, path[a + 2] + (path[a + 5] - path[a + 2]) * f);
  const dx = path[a + 3] - path[a];
  const dz = path[a + 5] - path[a + 2];
  if (dx * dx + dz * dz > 1e-6) mesh.rotation.y = Math.atan2(-dx, -dz);
  mesh.visible = true;
}
