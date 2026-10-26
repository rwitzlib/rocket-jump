import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { PLAYER, TEAMS } from '../shared/config';
import { PALETTE } from './palette';
import { TINTS, type Look } from '../shared/progress';
import type { WeaponId } from '../shared/types';
import type { RemotePlayer } from './net/netclient';
import { buildGauntlet, buildHookHead, LAUNCHER, PRIMARY_MODELS } from './weapons';
import { buildFlagModel } from './objectives';

// Other players: an armored figure built from primitives, sized to the hit capsule (feet at -0.9,
// eyes at +0.6 from its center). It carries the same two weapons you do, a shoulder-mounted rocket
// (or whichever primary they're carrying) launcher on the right and a grapple gauntlet on the left, both following where the player aims,
// so you can read their aim and see shots leave the barrel. Legs walk, strafe and tuck mid-air
// from the interpolated movement; the gauntlet swings to point along the rope while grappling.

const COLORS = [0x3d9cf0, 0xf0a830, 0xa860f0, 0x40c878, 0xf05a80, 0x30c8d0];
/** Armor colors players can pick (after 'auto'), from their profile. */
const TINT_COLORS = TINTS.slice(1).map((t) => t.color);
/** Colors by index: the free-for-all palette, then red and blue for teams, then the picked tints. */
const ALL_COLORS = [...COLORS, ...TEAMS.map((t) => t.color), ...TINT_COLORS];
const OVERDRIVE_COLOR = 0xff40d0;

const TAG_HEIGHT = 0.045; // with no size attenuation: about 2% of the screen height at a 90° FOV
const HIP_Y = -0.05; // relative to the capsule center
const SHOULDER_Y = 0.43; // relative to the hips
const NECK_Y = 0.5;
const THIGH = 0.4;
const SHIN = 0.38;
const STRIDE = 2.6; // gait radians per meter traveled
const MAX_LEG_TURN = 0.9; // radians the legs turn toward a sideways run
const RECOIL_TIME = 0.35;
const CORPSE_TIME = 1.15; // seconds from the hit to the pop
const CORPSE_SWELL = 0.14; // seconds it puffs up before popping
const CORPSE_GRAVITY = 16;
const CORPSE_RADIUS = 0.45; // how close the body's center gets to a wall
const BLAST_MEMORY = 400; // ms an explosion is remembered for, to blame for a death that shows up a little later // a little floatier than real gravity, for the cartoon arc
const Y = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, -1);
const GAUNTLET_REST = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.2, -0.1, 0));

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();

interface Leg {
  thigh: THREE.Object3D;
  shin: THREE.Object3D;
}

interface Entry {
  root: THREE.Group;
  body: THREE.Object3D;
  legs: THREE.Object3D;
  left: Leg;
  right: Leg;
  torso: THREE.Object3D;
  head: THREE.Object3D;
  aim: THREE.Object3D;
  launcher: THREE.Object3D;
  /** Each primary weapon's model and muzzle; only the one in hand is visible. */
  primaries: Partial<Record<WeaponId, { root: THREE.Object3D; muzzle: THREE.Object3D }>>;
  primary: WeaponId;
  muzzle: THREE.Object3D;
  flash: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  gauntlet: THREE.Object3D;
  hookTip: THREE.Object3D;
  rope: THREE.Line;
  hook: THREE.Object3D;
  hookHead: THREE.Object3D; // the one loaded in the gauntlet, hidden while it's out on the rope
  shell: THREE.Mesh;
  overdrive: THREE.Mesh;
  carried: THREE.Object3D[]; // a flag on their back, red's then blue's
  color: number; // index into ALL_COLORS
  tag: THREE.Sprite;
  tagName: string;
  // Animation state
  lastPos: THREE.Vector3;
  vel: THREE.Vector3;
  phase: number;
  air: number; // 0 grounded .. 1 airborne pose
  recoil: number;
  fresh: boolean;
  alive: boolean; // as of the last sync, to catch the moment they die
}

/**
 * A knocked-out player: a copy of their model thrown into the air, tumbling with its limbs flailing,
 * bouncing off the ground, until it swells and pops.
 */
interface Corpse {
  id: string;
  root: THREE.Group;
  vel: THREE.Vector3;
  axis: THREE.Vector3;
  spin: number; // radians per second about `axis`
  age: number;
  launched: boolean; // thrown yet: waits a frame, so the explosion that killed them has been seen
  limbs: THREE.Object3D[]; // thighs, shins, aim, gauntlet, head: each flails on its own beat
}

export class RemotePlayersView {
  private readonly entries = new Map<string, Entry>();
  private readonly suit = withRim(new THREE.MeshStandardMaterial({ color: 0x39404e, roughness: 0.8 }));
  private readonly armor = withRim(new THREE.MeshStandardMaterial({ color: 0xeef0f3, roughness: 0.42 }));
  private readonly darkMetal = withRim(new THREE.MeshStandardMaterial({ color: 0x2c323c, metalness: 0.5, roughness: 0.4 }));
  private readonly visorMat = new THREE.MeshStandardMaterial({ color: 0x0a1a24, emissive: 0x3fd6ff, emissiveIntensity: 1.7, roughness: 0.15, metalness: 0.6 });
  private readonly ropeMat = new THREE.LineBasicMaterial({ color: 0x2a2a2a });
  private readonly hookProto = buildHookHead();
  private readonly shellGeo = new THREE.CapsuleGeometry(PLAYER.radius + 0.18, PLAYER.halfHeight * 2, 6, 20);
  private readonly shellMat = shieldMaterial(0x7ce0ff);
  private readonly overdriveMat = shieldMaterial(OVERDRIVE_COLOR);
  private readonly flagProtos = TEAMS.map((t) => {
    const flag = buildFlagModel(t.color, 0.55);
    flag.position.set(0.12, -0.15, 0.32); // strapped to the jetpack
    flag.rotation.set(0.15, 0, -0.1);
    return flag;
  });
  private readonly flashMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(2.4, 1.6, 0.7),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  /** Stand-ins for the player's color and its glowing strips; swapped for the team's own on each clone. */
  private readonly teamProto = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.2 });
  private readonly glowProto = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff });
  private readonly teamMats = ALL_COLORS.map((color) => ({
    team: withRim(new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.15 })),
    glow: new THREE.MeshStandardMaterial({ color: 0x000000, emissive: color, emissiveIntensity: 2.4 }),
  }));
  private readonly proto: THREE.Group;
  private readonly corpses: Corpse[] = [];
  /** Recent explosions, so a body can be thrown away from the one that killed it. */
  private readonly blasts: { pos: THREE.Vector3; radius: number; time: number }[] = [];
  /** Called when a corpse pops: where, and in whose color. */
  onPoof: ((at: THREE.Vector3, color: number) => void) | null = null;
  /** Ray against the level (see GameSim.castLevel), for corpses to bounce off walls and floors. */
  castLevel: ((from: THREE.Vector3, dir: THREE.Vector3, max: number, outNormal: THREE.Vector3) => number | null) | null = null;
  /** Display names by player id, for the tags over their heads. */
  names: ReadonlyMap<string, string> = new Map();
  /** What players wear (their profile's look), by id. */
  looks: ReadonlyMap<string, Look> = new Map();
  /** Teams by player id, in team modes: their armor takes the team's color. */
  teams: ReadonlyMap<string, number> = new Map();
  /** Our own team (-1 outside team modes, or watching): name tags read white for allies, red for enemies. */
  localTeam = -1;

  constructor(private readonly scene: THREE.Scene) {
    this.proto = this.buildModel();
  }

  /** Releases every GPU resource; the scene itself is cleared by its owner. */
  dispose() {
    for (const id of [...this.entries.keys()]) this.remove(id);
    for (const c of this.corpses) this.scene.remove(c.root);
    this.corpses.length = 0;
  }

  /**
   * Knocks a player out: their model is thrown from where they stood (carrying `vel`, plus a kick
   * up and a random shove), tumbling and flailing, and pops after a second or so.
   */
  spawnCorpse(id: string, pos: THREE.Vector3, vel: THREE.Vector3, yaw: number, primary: WeaponId) {
    const root = this.dress(this.proto.clone(), this.colorIndex(id));
    for (const weapon of Object.keys(PRIMARY_MODELS)) {
      const launcher = root.getObjectByName(`${weapon}Launcher`);
      if (launcher) launcher.visible = weapon === primary;
    }
    root.position.copy(pos);
    root.rotation.y = yaw;
    this.scene.add(root);
    this.corpses.push({
      id,
      root,
      vel: vel.clone(),
      axis: new THREE.Vector3(Math.random() * 2 - 1, 0.3, Math.random() * 2 - 1).normalize(),
      spin: (7 + Math.random() * 5) * (Math.random() < 0.5 ? -1 : 1),
      age: 0,
      launched: false,
      limbs: ['thighL', 'thighR', 'shinL', 'shinR', 'aim', 'gauntlet', 'head'].map((name) => root.getObjectByName(name)!),
    });
  }

  /** An explosion went off: bodies near it get thrown away from it. */
  blast(at: THREE.Vector3, radius: number) {
    const now = performance.now();
    while (this.blasts.length && now - this.blasts[0].time > BLAST_MEMORY) this.blasts.shift();
    this.blasts.push({ pos: at.clone(), radius, time: now });
  }

  /**
   * Sends a corpse flying: away from the nearest recent explosion that could have reached it,
   * harder the closer it was and tumbling head over heels that way. With no blast about (a fall, a
   * buggy) it just pops up off the ground.
   */
  private launch(c: Corpse) {
    c.launched = true;
    const now = performance.now();
    _a.copy(c.root.position).y += 0.3; // aim from the chest, so a blast at the feet throws them up
    let best: (typeof this.blasts)[number] | null = null;
    let bestDist = Infinity;
    for (const b of this.blasts) {
      const dist = b.pos.distanceTo(_a);
      if (now - b.time < BLAST_MEMORY && dist < b.radius + 1.5 && dist < bestDist) {
        best = b;
        bestDist = dist;
      }
    }
    if (!best) {
      const shove = _b.set(Math.random() * 2 - 1, 0, Math.random() * 2 - 1).multiplyScalar(3);
      c.vel.multiplyScalar(0.7).add(shove).setY(Math.max(c.vel.y * 0.7, 0) + 6 + Math.random() * 3);
      return;
    }
    const near = 1 - Math.min(bestDist / (best.radius + 1.5), 1);
    const dir = _b.subVectors(_a, best.pos);
    if (dir.lengthSq() < 1e-4) dir.set(0, 1, 0);
    dir.normalize();
    // Never straight into the ground: a blast from above still bounces them along it.
    if (dir.y < 0.25) dir.y = 0.25 + dir.y * 0.3;
    dir.normalize();
    c.vel.multiplyScalar(0.3).addScaledVector(dir, 11 + near * 9).y += 2.5;
    // Tumble about the axis across the throw: feet over head, away from the blast.
    c.axis.crossVectors(Y, dir);
    if (c.axis.lengthSq() < 1e-4) c.axis.set(1, 0, 0);
    c.axis.normalize();
    c.spin = 8 + near * 6;
  }

  /** Where someone's corpse is right now, if they have one in the air. */
  corpsePosition(id: string): THREE.Vector3 | null {
    for (const c of this.corpses) if (c.id === id) return c.root.position;
    return null;
  }

  /**
   * Moves a corpse along its velocity, sweeping a ray ahead of it so it can't pass through walls
   * however fast it's going: it stops at whatever it hits and bounces off, losing most of the speed
   * into the surface and some along it, and some of its spin.
   */
  private moveCorpse(c: Corpse, dt: number) {
    const pos = c.root.position;
    let left = dt;
    for (let k = 0; k < 3 && left > 0; k++) {
      const speed = c.vel.length();
      if (speed < 1e-3) return;
      _b.copy(c.vel).divideScalar(speed);
      const step = speed * left;
      const hit = this.castLevel?.(pos, _b, step + CORPSE_RADIUS, _n) ?? null;
      if (hit === null) {
        pos.addScaledVector(c.vel, left);
        return;
      }
      const travel = Math.max(hit - CORPSE_RADIUS, 0);
      pos.addScaledVector(_b, travel);
      left *= 1 - travel / step;
      const into = c.vel.dot(_n);
      if (into < 0) {
        // Split into along-the-surface and into-it, keep a little of each, and send the second back out.
        c.vel.addScaledVector(_n, -into).multiplyScalar(0.7).addScaledVector(_n, -into * 0.4);
        c.spin *= 0.6;
      }
      pos.addScaledVector(_n, 0.01);
    }
  }

  private updateCorpses(dt: number) {
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      if (!c.launched) this.launch(c);
      c.age += dt;
      c.vel.y -= CORPSE_GRAVITY * dt;
      this.moveCorpse(c, dt);
      c.root.quaternion.premultiply(_q.setFromAxisAngle(c.axis, c.spin * dt));
      // Arms and legs windmilling, each on its own beat, wilder at first.
      const wild = 1.2 - Math.min(c.age / CORPSE_TIME, 1) * 0.6;
      c.limbs.forEach((limb, k) => {
        limb.rotation.x = Math.sin(c.age * (16 + k * 3) + k * 1.7) * wild;
        limb.rotation.z = Math.cos(c.age * (13 + k * 2) + k) * wild * 0.4;
      });
      // Swell for the last moment, then pop.
      const left = CORPSE_TIME - c.age;
      c.root.scale.setScalar(left < CORPSE_SWELL ? 1 + (1 - left / CORPSE_SWELL) * 0.35 : 1);
      if (left <= 0) {
        this.onPoof?.(c.root.position, this.colorOf(c.id));
        this.scene.remove(c.root);
        this.corpses.splice(i, 1);
      }
    }
  }

  /** Shows one dummy player so its shaders compile behind the start menu (see Effects.setWarmup). */
  setWarmup(on: boolean) {
    if (on) {
      const e = this.entryFor('__warmup');
      e.rope.visible = e.shell.visible = e.hook.visible = true;
      e.flash.visible = true;
      e.flash.material.opacity = 1;
    } else this.remove('__warmup');
  }

  /** A player's color: their team's, or one worked out from their id (the same for everyone). */
  colorOf(id: string): number {
    return ALL_COLORS[this.colorIndex(id)];
  }

  private colorIndex(id: string): number {
    const team = this.teams.get(id) ?? -1;
    if (team >= 0) return COLORS.length + team;
    // Outside team modes, the armor color they picked (if any).
    const tint = this.looks.get(id)?.tint;
    const picked = tint && tint !== 'auto' ? TINTS.findIndex((t) => t.id === tint) : -1;
    return picked > 0 ? COLORS.length + TEAMS.length + picked - 1 : teamIndex(id);
  }

  /** Hides (or shows again) everyone and every corpse: the killcam draws its own copies meanwhile. */
  setVisible(on: boolean) {
    for (const e of this.entries.values()) {
      if (!on) e.root.visible = e.rope.visible = e.hook.visible = false;
    }
    for (const c of this.corpses) c.root.visible = on;
    this.hidden = !on;
  }
  private hidden = false;

  /** A remote player fired: kick the launcher back and flash its muzzle. */
  fired(id: string) {
    const e = this.entries.get(id);
    if (e) e.recoil = 1;
  }

  /**
   * Where this player's rockets visually leave from, relative to where the sim fires them (the eye).
   * Null for anyone without a model, such as the local player.
   */
  muzzleOffset(id: string, out: THREE.Vector3): THREE.Vector3 | null {
    const e = this.entries.get(id);
    if (!e || !e.root.visible) return null;
    e.muzzle.getWorldPosition(out);
    return out.sub(e.root.position).setY(out.y - PLAYER.eyeOffset);
  }

  sync(remotes: ReadonlyMap<string, RemotePlayer>, dt: number) {
    this.updateCorpses(dt);
    for (const r of remotes.values()) {
      const e = this.entryFor(r.id);
      // They just died where we could see them: leave a corpse in their place.
      if (e.alive && !r.alive && e.root.visible && !e.fresh) this.spawnCorpse(r.id, e.root.position, e.vel, e.root.rotation.y, e.primary);
      e.alive = r.alive;
      e.root.visible = r.alive && !r.hidden && !this.hidden;
      const color = this.colorIndex(r.id);
      if (color !== e.color) {
        this.dress(e.root, color);
        e.color = color;
      }
      this.setTag(e, this.names.get(r.id) ?? '', this.tagColor(r.id));
      e.shell.visible = r.protected;
      e.overdrive.visible = r.overdrive;
      if (r.overdrive) e.overdrive.scale.setScalar(1 + Math.sin(performance.now() / 90) * 0.04);
      e.carried.forEach((flag, team) => (flag.visible = r.flag === team));
      this.setPrimary(e, r.primary);
      this.animate(e, r, dt);

      const grappling = r.alive && !!r.anchor && !this.hidden;
      e.rope.visible = e.hook.visible = grappling;
      e.hookHead.visible = !grappling;
      if (grappling && r.anchor) {
        e.root.updateMatrixWorld(true);
        e.hookTip.getWorldPosition(_a);
        const pos = e.rope.geometry.attributes.position as THREE.BufferAttribute;
        pos.setXYZ(0, _a.x, _a.y, _a.z);
        pos.setXYZ(1, r.anchor.x, r.anchor.y, r.anchor.z);
        pos.needsUpdate = true;
        e.rope.geometry.computeBoundingSphere();
        e.hook.position.copy(r.anchor);
        e.hook.lookAt(_a); // spike (-Z) points away from the thrower, into whatever it bit
      }
    }
    for (const id of this.entries.keys()) {
      if (!remotes.has(id) && id !== '__warmup') this.remove(id);
    }
  }

  private setPrimary(e: Entry, weapon: WeaponId) {
    const model = e.primaries[weapon];
    if (weapon === e.primary || !model) return;
    for (const m of Object.values(e.primaries)) m.root.visible = m === model;
    e.primary = weapon;
    e.muzzle = model.muzzle;
    e.muzzle.add(e.flash);
  }

  private animate(e: Entry, r: RemotePlayer, dt: number) {
    // Velocity from the interpolated motion, smoothed so snapshot steps don't twitch the legs.
    if (e.fresh || e.lastPos.distanceToSquared(r.pos) > 25 || dt <= 0) {
      e.vel.set(0, 0, 0);
      e.fresh = false;
    } else {
      _vel.subVectors(r.pos, e.lastPos).divideScalar(dt);
      e.vel.lerp(_vel, 1 - Math.exp(-dt * 12));
    }
    e.lastPos.copy(r.pos);
    e.root.position.copy(r.pos);
    e.root.rotation.y = r.yaw;

    // Movement in the player's own frame (-Z forward), to turn the legs toward a strafe or backpedal.
    const cos = Math.cos(r.yaw);
    const sin = Math.sin(r.yaw);
    const lx = e.vel.x * cos - e.vel.z * sin;
    const lz = e.vel.x * sin + e.vel.z * cos;
    const speed = Math.hypot(lx, lz);
    let legTurn = 0;
    let gaitDir = 1;
    if (speed > 0.5) {
      legTurn = Math.atan2(-lx, -lz);
      if (Math.abs(legTurn) > Math.PI / 2) {
        legTurn -= Math.PI * Math.sign(legTurn);
        gaitDir = -1;
      }
      legTurn = THREE.MathUtils.clamp(legTurn, -MAX_LEG_TURN, MAX_LEG_TURN);
    }
    const ease = 1 - Math.exp(-dt * 10);
    e.legs.rotation.y += (legTurn - e.legs.rotation.y) * ease;

    e.air += ((r.grounded ? 0 : 1) - e.air) * (1 - Math.exp(-dt * 8));
    if (r.grounded) e.phase += gaitDir * Math.min(speed, 12) * STRIDE * dt;
    const amp = Math.min(speed / 8, 1) * 0.75;
    const swing = Math.sin(e.phase) * amp;
    const lift = Math.max(0, Math.cos(e.phase)) * amp * 1.3;
    const liftR = Math.max(0, -Math.cos(e.phase)) * amp * 1.3;
    const air = e.air;
    e.left.thigh.rotation.x = THREE.MathUtils.lerp(swing, 0.7, air);
    e.left.shin.rotation.x = THREE.MathUtils.lerp(-lift, -1.1, air);
    e.right.thigh.rotation.x = THREE.MathUtils.lerp(-swing, 0.25, air);
    e.right.shin.rotation.x = THREE.MathUtils.lerp(-liftR, -0.6, air);
    e.body.position.y = Math.abs(Math.cos(e.phase)) * amp * 0.06 * (1 - air) - amp * 0.03;

    // Aim: the torso leans a little, the head most of the way, the weapons all the way.
    const lean = r.pitch * 0.2 - Math.min(speed / 8, 1) * 0.08 * (1 - air);
    e.torso.rotation.x = lean;
    e.head.rotation.x = r.pitch * 0.75 - lean;
    e.aim.rotation.x = r.pitch - lean;

    e.recoil = Math.max(0, e.recoil - dt / RECOIL_TIME);
    const kick = e.recoil * e.recoil;
    e.launcher.position.z = kick * 0.18;
    e.launcher.rotation.x = kick * 0.35;
    e.flash.material.opacity = e.recoil > 0.6 ? (e.recoil - 0.6) / 0.4 : 0;
    e.flash.visible = e.flash.material.opacity > 0;
    e.flash.scale.setScalar(0.7 + (1 - e.recoil) * 0.8);

    // While grappling, the gauntlet points along the rope instead of the aim.
    let target = GAUNTLET_REST;
    if (r.alive && r.anchor) {
      e.root.updateMatrixWorld(true);
      e.gauntlet.parent!.getWorldPosition(_a);
      _b.copy(r.anchor).sub(_a).normalize();
      // Into the gauntlet's parent space: undo the parent's world rotation.
      _m.extractRotation(e.gauntlet.parent!.matrixWorld).transpose();
      _b.applyMatrix4(_m);
      target = _q.setFromUnitVectors(FORWARD, _b);
    }
    e.gauntlet.quaternion.slerp(target, 1 - Math.exp(-dt * 18));
  }

  private entryFor(id: string): Entry {
    let e = this.entries.get(id);
    if (e) return e;
    const color = this.colorIndex(id);
    const root = this.dress(this.proto.clone(), color);
    const get = (name: string) => root.getObjectByName(name)!;
    // Each model gets its own flash material so one player's shot doesn't light up everyone's barrel.
    const flash = get('flash') as THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
    flash.material = this.flashMat.clone();

    const shell = new THREE.Mesh(this.shellGeo, this.shellMat);
    shell.visible = false;
    root.add(shell);
    const overdrive = new THREE.Mesh(this.shellGeo, this.overdriveMat);
    overdrive.visible = false;
    root.add(overdrive);
    const carried = this.flagProtos.map((proto) => {
      const flag = proto.clone();
      flag.visible = false;
      return flag;
    });
    get('torso').add(...carried);
    const rope = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3)), this.ropeMat);
    rope.frustumCulled = false;
    rope.visible = false;
    const hook = this.hookProto.clone();
    hook.visible = false;
    this.scene.add(root, rope, hook);
    // Name tag over the head. It's depth tested, so walls hide it: no seeing people through cover.
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, opacity: 0.9, sizeAttenuation: false }));
    tag.position.y = 1.35;
    tag.visible = false;
    root.add(tag);

    e = {
      root,
      tag,
      tagName: '',
      body: get('body'),
      legs: get('legs'),
      left: { thigh: get('thighL'), shin: get('shinL') },
      right: { thigh: get('thighR'), shin: get('shinR') },
      torso: get('torso'),
      head: get('head'),
      aim: get('aim'),
      launcher: get('launcher'),
      primaries: Object.fromEntries(Object.keys(PRIMARY_MODELS).map((id) => [id, { root: get(`${id}Launcher`), muzzle: get(`${id}Muzzle`) }])),
      primary: 'rocket',
      muzzle: get('rocketMuzzle'),
      flash,
      gauntlet: get('gauntlet'),
      hookTip: get('hookTip'),
      hookHead: get('hookHead'),
      rope,
      hook,
      shell,
      overdrive,
      carried,
      color,
      lastPos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      phase: Math.random() * Math.PI * 2,
      air: 0,
      recoil: 0,
      fresh: true,
      alive: true,
    };
    this.entries.set(id, e);
    return e;
  }

  /** Swaps the team-colored materials on a copy of the rig (stand-ins, or another color) for this color's. */
  private dress<T extends THREE.Object3D>(root: T, color: number): T {
    const team = this.teamMats[color];
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      if (o.material === this.teamProto) o.userData.slot = 'team';
      else if (o.material === this.glowProto) o.userData.slot = 'glow';
      if (o.userData.slot === 'team') o.material = team.team;
      else if (o.userData.slot === 'glow') o.material = team.glow;
    });
    return root;
  }

  /**
   * A name tag's text color. In team modes: white for a teammate, red for an enemy (or, watching,
   * each team's own color). Otherwise white.
   */
  private tagColor(id: string): string {
    const team = this.teams.get(id) ?? -1;
    if (team < 0) return '#fff';
    if (this.localTeam < 0) return PALETTE.teamTags[team] ?? '#fff';
    return team === this.localTeam ? '#fff' : PALETTE.enemyTag;
  }

  private setTag(e: Entry, name: string, color: string) {
    const key = `${name}|${color}`;
    if (key === e.tagName) return;
    e.tagName = key;
    e.tag.visible = !!name;
    e.tag.material.map?.dispose();
    e.tag.material.map = null;
    if (!name) return;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const font = '600 40px system-ui, sans-serif';
    ctx.font = font;
    const width = Math.ceil(ctx.measureText(name).width) + 28;
    canvas.width = width;
    canvas.height = 56;
    ctx.font = font;
    ctx.fillStyle = 'rgba(10, 14, 20, 0.55)';
    ctx.beginPath();
    ctx.roundRect(0, 0, width, 56, 12);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, width / 2, 30);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    e.tag.material.map = texture;
    e.tag.material.needsUpdate = true;
    e.tag.scale.set((width / 56) * TAG_HEIGHT, TAG_HEIGHT, 1); // a fixed size on screen, readable at any range
  }

  private remove(id: string) {
    const e = this.entries.get(id);
    if (!e) return;
    this.scene.remove(e.root, e.rope, e.hook);
    e.rope.geometry.dispose();
    e.flash.material.dispose();
    e.tag.material.map?.dispose();
    e.tag.material.dispose();
    this.entries.delete(id);
  }

  /** The rig every remote player is cloned from. Named nodes are the joints `animate` drives. */
  private buildModel(): THREE.Group {
    const { suit, armor, darkMetal, teamProto: team, glowProto: glow } = this;
    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      return m;
    };
    /** A soft-cornered box: the cartoon armor plates. */
    const rounded = (w: number, h: number, d: number, r: number, mat: THREE.Material, x = 0, y = 0, z = 0) =>
      mesh(new RoundedBoxGeometry(w, h, d, 2, r), mat, x, y, z);
    /** A rounded rod from a to b. */
    const limb = (a: THREE.Vector3, b: THREE.Vector3, radius: number, mat: THREE.Material) => {
      const len = a.distanceTo(b);
      const m = mesh(new THREE.CapsuleGeometry(radius, Math.max(len - radius * 2, 0.01), 4, 10), mat);
      m.position.addVectors(a, b).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(Y, _a.subVectors(b, a).normalize());
      return m;
    };
    const named = (name: string, ...children: THREE.Object3D[]) => {
      const g = new THREE.Group();
      if (children.length) g.add(...children);
      g.name = name;
      return g;
    };
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    /** A rounded pauldron: the top half of a squashed sphere. */
    const pad = (x: number, y: number, z: number) => {
      const m = mesh(new THREE.SphereGeometry(0.13, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), team, x, y, z);
      m.scale.set(1.05, 0.85, 1.1);
      return m;
    };

    // Legs: thigh pivots at the hip, shin at the knee, both pointing down -Y. Chunky boots with
    // team-colored toe caps, white shin guards and thigh plates, team knee pads.
    const leg = (side: 'L' | 'R', x: number) => {
      const boot = rounded(0.17, 0.13, 0.31, 0.05, darkMetal, 0, -SHIN - 0.01, -0.05);
      const toe = rounded(0.165, 0.07, 0.09, 0.03, team, 0, -SHIN - 0.03, -0.18);
      const guard = rounded(0.14, 0.24, 0.08, 0.035, armor, 0, -0.17, -0.06);
      const shin = named(`shin${side}`, limb(v(0, 0, 0), v(0, -SHIN + 0.04, 0), 0.07, suit), guard, boot, toe);
      shin.position.y = -THIGH;
      const knee = rounded(0.13, 0.12, 0.09, 0.04, team, 0, -THIGH + 0.01, -0.06);
      const plate = rounded(0.16, 0.2, 0.07, 0.03, armor, 0, -0.17, -0.07);
      const thigh = named(`thigh${side}`, limb(v(0, 0.03, 0), v(0, -THIGH, 0), 0.09, suit), plate, knee, shin);
      thigh.position.x = x;
      return thigh;
    };
    const legs = named('legs', leg('L', -0.12), leg('R', 0.12));
    legs.position.y = HIP_Y;

    // Torso, pivoting at the waist: white chest armor with a team plate and a glowing emblem, a belt
    // with a lit buckle, and a jetpack with two team-colored tanks and glowing nozzles.
    const pelvis = rounded(0.38, 0.17, 0.24, 0.06, darkMetal, 0, 0.02, 0);
    const belt = rounded(0.4, 0.06, 0.27, 0.025, suit, 0, 0.11, 0);
    const buckle = rounded(0.09, 0.06, 0.03, 0.012, glow, 0, 0.11, -0.14);
    const belly = mesh(new THREE.CylinderGeometry(0.15, 0.17, 0.2, 12), suit, 0, 0.18, 0);
    const chest = rounded(0.5, 0.31, 0.29, 0.09, armor, 0, 0.34, 0);
    const plate = rounded(0.34, 0.2, 0.07, 0.035, team, 0, 0.35, -0.14);
    plate.rotation.x = -0.08;
    const emblem = mesh(new THREE.CircleGeometry(0.045, 16), glow, 0, 0.36, -0.182);
    emblem.rotation.y = Math.PI;
    emblem.castShadow = false;
    const collar = mesh(new THREE.TorusGeometry(0.1, 0.035, 8, 16).rotateX(Math.PI / 2), darkMetal, 0, NECK_Y - 0.01, 0);
    const pack = rounded(0.36, 0.38, 0.16, 0.06, darkMetal, 0, 0.3, 0.2);
    const tanks = [-0.1, 0.1].map((x) => mesh(new THREE.CapsuleGeometry(0.06, 0.24, 4, 12), team, x, 0.32, 0.29));
    const nozzles = [-0.1, 0.1].map((x) => mesh(new THREE.CylinderGeometry(0.04, 0.06, 0.07, 12), darkMetal, x, 0.12, 0.29));
    const jets = [-0.1, 0.1].map((x) => mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.012, 12), glow, x, 0.083, 0.29));
    const neck = mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.1, 8), suit, 0, NECK_Y, 0);

    // Head: a round white helmet, a wraparound glowing visor at eye height (0.6 above center), a
    // team crest and ear pieces, and a little antenna with a lit tip.
    const helmet = mesh(new THREE.SphereGeometry(0.19, 20, 14), armor, 0, 0.13, 0);
    helmet.scale.set(1, 1.02, 1.08);
    const visor = mesh(new THREE.SphereGeometry(0.197, 24, 6, Math.PI * 1.5 - 0.85, 1.7, 1.32, 0.48), this.visorMat, 0, 0.13, 0);
    visor.scale.set(1, 1.02, 1.08);
    visor.castShadow = false;
    const crest = rounded(0.055, 0.1, 0.3, 0.025, team, 0, 0.31, 0.02);
    const ears = [-1, 1].map((side) => mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.06, 14).rotateZ(Math.PI / 2), team, side * 0.19, 0.12, 0.01));
    const antenna = mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.2, 6), darkMetal, 0.2, 0.25, 0.04);
    const antennaTip = mesh(new THREE.SphereGeometry(0.022, 8, 6), glow, 0.2, 0.35, 0.04);
    const jaw = rounded(0.2, 0.08, 0.1, 0.035, darkMetal, 0, 0.0, -0.13);
    const head = named('head', helmet, visor, crest, ...ears, antenna, antennaTip, jaw);
    head.position.y = NECK_Y;

    // Weapons and arms, pivoting with the aim at shoulder height. Forward is -Z.
    // One of each primary weapon, named `<weapon>Launcher` / `<weapon>Muzzle`; only the one carried is shown.
    const models = Object.entries(PRIMARY_MODELS).map(([id, build]) => {
      const model = build(team);
      model.root.name = `${id}Launcher`;
      model.muzzle.name = `${id}Muzzle`;
      model.root.visible = id === 'rocket';
      // Shouldered, the Javelin's sight unit would sit inside the head: carried further up the tube instead.
      const clu = model.root.getObjectByName('clu');
      if (clu) clu.position.z = -0.4;
      return model;
    });
    const launcherModel = models[0];
    const flash = mesh(new THREE.SphereGeometry(0.16, 10, 8), this.flashMat, 0, 0, -0.06);
    flash.castShadow = false;
    flash.visible = false;
    flash.name = 'flash';
    flash.scale.set(1, 1, 1.5);
    launcherModel.muzzle.add(flash);
    const launcher = named('launcher', ...models.map((m) => m.root));
    const launcherMount = named('launcherMount', launcher);
    launcherMount.position.set(0.31, 0.13, 0);

    const shoulderR = v(0.28, 0, 0.02);
    const elbowR = v(0.37, -0.2, -0.13);
    const handR = v(0.31, 0.13, 0).add(LAUNCHER.foreGrip);
    const armR = [
      mesh(new THREE.SphereGeometry(0.09, 10, 8), suit, shoulderR.x, shoulderR.y, shoulderR.z),
      pad(shoulderR.x + 0.01, shoulderR.y + 0.02, shoulderR.z),
      limb(shoulderR, elbowR, 0.065, suit),
      limb(elbowR, handR, 0.072, armor),
      rounded(0.1, 0.1, 0.11, 0.035, darkMetal, handR.x, handR.y, handR.z),
    ];

    // Left arm is straight along -Z from the shoulder so it can be pointed down the rope.
    const gauntletModel = buildGauntlet(team, -1);
    gauntletModel.root.position.z = -0.2;
    const gauntlet = named(
      'gauntlet',
      mesh(new THREE.SphereGeometry(0.09, 10, 8), suit, 0, 0, 0),
      pad(-0.01, 0.02, 0),
      limb(v(0, 0, 0), v(0, 0, -0.24), 0.065, suit),
      gauntletModel.root,
    );
    gauntlet.quaternion.copy(GAUNTLET_REST);
    const shoulderL = named('shoulderL', gauntlet);
    shoulderL.position.set(-0.27, 0, 0.02);

    const aim = named('aim', launcherMount, ...armR, shoulderL);
    aim.position.y = SHOULDER_Y;

    const torso = named('torso', pelvis, belt, buckle, belly, chest, plate, emblem, collar, pack, ...tanks, ...nozzles, ...jets, neck, head, aim);
    torso.position.y = HIP_Y;
    const body = named('body', legs, torso);
    return named('player', body);
  }
}

function teamIndex(id: string): number {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(hash) % COLORS.length;
}

/**
 * A soft light around a material's silhouette, as if lit from behind: keeps characters readable
 * against any background, the way cartoon renderers do.
 */
export function withRim<T extends THREE.MeshStandardMaterial>(material: T, strength = 0.35): T {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `float rimLight = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);
      outgoingLight += rimLight * ${strength.toFixed(2)} * (diffuseColor.rgb * 0.5 + 0.5);
      #include <opaque_fragment>`,
    );
  };
  material.customProgramCacheKey = () => `rim${strength}`;
  return material;
}

/** Spawn protection (and the overdrive): a bubble that glows at its edges, with soft bands of light around it. */
function shieldMaterial(color: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(color) } },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vY;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        vY = position.y;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vY;
      void main() {
        float edge = pow(max(1.0 - abs(dot(vNormal, vView)), 0.0), 2.5); // (pow of a hair below zero is NaN, and bloom spreads it)
        float bands = smoothstep(0.8, 1.0, sin(vY * 14.0) * 0.5 + 0.5) * 0.12;
        gl_FragColor = vec4(color * 1.8, edge * 0.9 + 0.05 + bands);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}
