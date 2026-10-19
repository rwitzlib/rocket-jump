import * as THREE from 'three';
import { PLAYER } from '../shared/config';
import type { WeaponId } from '../shared/types';
import type { RemotePlayer } from './net/netclient';
import { buildGauntlet, buildGrenadeLauncher, buildHookHead, buildLauncher, LAUNCHER } from './weapons';

// Other players: an armored figure built from primitives, sized to the hit capsule (feet at -0.9,
// eyes at +0.6 from its center). It carries the same two weapons you do, a shoulder-mounted rocket
// (or grenade) launcher on the right and a grapple gauntlet on the left, both following where the player aims,
// so you can read their aim and see shots leave the barrel. Legs walk, strafe and tuck mid-air
// from the interpolated movement; the gauntlet swings to point along the rope while grappling.

const COLORS = [0x4fa3e0, 0xe0b04f, 0xb86fe0, 0x5fd08a, 0xe06f8a, 0x6fd6d6];

const HIP_Y = -0.05; // relative to the capsule center
const SHOULDER_Y = 0.43; // relative to the hips
const NECK_Y = 0.5;
const THIGH = 0.4;
const SHIN = 0.38;
const STRIDE = 2.6; // gait radians per meter traveled
const MAX_LEG_TURN = 0.9; // radians the legs turn toward a sideways run
const RECOIL_TIME = 0.35;
const Y = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, -1);
const GAUNTLET_REST = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.2, -0.1, 0));

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
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
  // Animation state
  lastPos: THREE.Vector3;
  vel: THREE.Vector3;
  phase: number;
  air: number; // 0 grounded .. 1 airborne pose
  recoil: number;
  fresh: boolean;
}

export class RemotePlayersView {
  private readonly entries = new Map<string, Entry>();
  private readonly suit = new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.8 });
  private readonly metal = new THREE.MeshStandardMaterial({ color: 0x6a7484, metalness: 0.5, roughness: 0.4 });
  private readonly darkMetal = new THREE.MeshStandardMaterial({ color: 0x3a4250, metalness: 0.6, roughness: 0.35 });
  private readonly visorMat = new THREE.MeshStandardMaterial({ color: 0x0e1218, emissive: 0x2a6f8f, emissiveIntensity: 0.6, roughness: 0.1, metalness: 0.8 });
  private readonly ropeMat = new THREE.LineBasicMaterial({ color: 0x2a2a2a });
  private readonly hookProto = buildHookHead();
  private readonly shellGeo = new THREE.CapsuleGeometry(PLAYER.radius + 0.15, PLAYER.halfHeight * 2, 4, 16);
  private readonly shellMat = new THREE.MeshBasicMaterial({
    color: 0x7ce0ff,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  private readonly flashMat = new THREE.MeshBasicMaterial({
    color: 0xffc070,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  /** Stand-in for the player's color; swapped for one of `teamMats` on each clone. */
  private readonly teamProto = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.2 });
  private readonly teamMats = COLORS.map((color) => new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.2 }));
  private readonly proto: THREE.Group;

  constructor(private readonly scene: THREE.Scene) {
    this.proto = this.buildModel();
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
    for (const r of remotes.values()) {
      const e = this.entryFor(r.id);
      e.root.visible = r.alive;
      e.shell.visible = r.protected;
      this.setPrimary(e, r.primary);
      this.animate(e, r, dt);

      const grappling = r.alive && !!r.anchor;
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
    let hash = 0;
    for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
    const team = this.teamMats[Math.abs(hash) % COLORS.length];

    const root = this.proto.clone();
    root.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material === this.teamProto) o.material = team;
    });
    const get = (name: string) => root.getObjectByName(name)!;
    // Each model gets its own flash material so one player's shot doesn't light up everyone's barrel.
    const flash = get('flash') as THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
    flash.material = this.flashMat.clone();

    const shell = new THREE.Mesh(this.shellGeo, this.shellMat);
    shell.visible = false;
    root.add(shell);
    const rope = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3)), this.ropeMat);
    rope.frustumCulled = false;
    rope.visible = false;
    const hook = this.hookProto.clone();
    hook.visible = false;
    this.scene.add(root, rope, hook);

    e = {
      root,
      body: get('body'),
      legs: get('legs'),
      left: { thigh: get('thighL'), shin: get('shinL') },
      right: { thigh: get('thighR'), shin: get('shinR') },
      torso: get('torso'),
      head: get('head'),
      aim: get('aim'),
      launcher: get('launcher'),
      primaries: {
        rocket: { root: get('rocketLauncher'), muzzle: get('rocketMuzzle') },
        grenade: { root: get('grenadeLauncher'), muzzle: get('grenadeMuzzle') },
      },
      primary: 'rocket',
      muzzle: get('rocketMuzzle'),
      flash,
      gauntlet: get('gauntlet'),
      hookTip: get('hookTip'),
      hookHead: get('hookHead'),
      rope,
      hook,
      shell,
      lastPos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      phase: Math.random() * Math.PI * 2,
      air: 0,
      recoil: 0,
      fresh: true,
    };
    this.entries.set(id, e);
    return e;
  }

  private remove(id: string) {
    const e = this.entries.get(id);
    if (!e) return;
    this.scene.remove(e.root, e.rope, e.hook);
    e.rope.geometry.dispose();
    e.flash.material.dispose();
    this.entries.delete(id);
  }

  /** The rig every remote player is cloned from. Named nodes are the joints `animate` drives. */
  private buildModel(): THREE.Group {
    const { suit, metal, darkMetal, teamProto: team } = this;
    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      return m;
    };
    /** A rounded rod from a to b. */
    const limb = (a: THREE.Vector3, b: THREE.Vector3, radius: number, mat: THREE.Material) => {
      const len = a.distanceTo(b);
      const m = mesh(new THREE.CapsuleGeometry(radius, Math.max(len - radius * 2, 0.01), 3, 8), mat);
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

    // Legs: thigh pivots at the hip, shin at the knee, both pointing down -Y.
    const leg = (side: 'L' | 'R', x: number) => {
      const boot = mesh(new THREE.BoxGeometry(0.15, 0.1, 0.27), darkMetal, 0, -SHIN - 0.02, -0.04);
      const shin = named(`shin${side}`, limb(v(0, 0, 0), v(0, -SHIN + 0.04, 0), 0.075, suit), mesh(new THREE.BoxGeometry(0.13, 0.2, 0.06), team, 0, -0.14, -0.07), boot);
      shin.position.y = -THIGH;
      const knee = mesh(new THREE.SphereGeometry(0.075, 10, 8), darkMetal, 0, -THIGH, -0.03);
      const thigh = named(`thigh${side}`, limb(v(0, 0.03, 0), v(0, -THIGH, 0), 0.09, suit), knee, shin);
      thigh.position.x = x;
      return thigh;
    };
    const legs = named('legs', leg('L', -0.12), leg('R', 0.12));
    legs.position.y = HIP_Y;

    // Torso, pivoting at the waist.
    const pelvis = mesh(new THREE.BoxGeometry(0.36, 0.16, 0.22), darkMetal, 0, 0.02, 0);
    const belly = mesh(new THREE.CylinderGeometry(0.15, 0.17, 0.2, 10), suit, 0, 0.16, 0);
    const chest = mesh(new THREE.BoxGeometry(0.48, 0.28, 0.27), suit, 0, 0.34, 0);
    const plate = mesh(new THREE.BoxGeometry(0.42, 0.24, 0.06), team, 0, 0.35, -0.14);
    plate.rotation.x = -0.08;
    const pack = mesh(new THREE.BoxGeometry(0.34, 0.36, 0.14), metal, 0, 0.3, 0.19);
    const tubes = [-0.09, 0.09].map((x) => mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.3, 8), team, x, 0.32, 0.27));
    const neck = mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.1, 8), suit, 0, NECK_Y, 0);

    // Head: helmet, team-colored crest and a glowing visor at eye height (0.6 above center).
    const helmet = mesh(new THREE.SphereGeometry(0.17, 16, 12), metal, 0, 0.13, 0);
    helmet.scale.set(1, 1.05, 1.1);
    const crest = mesh(new THREE.BoxGeometry(0.05, 0.08, 0.3), team, 0, 0.29, 0.02);
    const visor = mesh(new THREE.BoxGeometry(0.28, 0.08, 0.1), this.visorMat, 0, 0.12, -0.15);
    const jaw = mesh(new THREE.BoxGeometry(0.2, 0.07, 0.1), darkMetal, 0, 0.03, -0.12);
    const head = named('head', helmet, crest, visor, jaw);
    head.position.y = NECK_Y;

    // Weapons and arms, pivoting with the aim at shoulder height. Forward is -Z.
    const launcherModel = buildLauncher(team);
    const flash = mesh(new THREE.SphereGeometry(0.16, 10, 8), this.flashMat, 0, 0, -0.06);
    flash.castShadow = false;
    flash.visible = false;
    flash.name = 'flash';
    flash.scale.set(1, 1, 1.5);
    launcherModel.muzzle.add(flash);
    launcherModel.root.name = 'rocketLauncher';
    launcherModel.muzzle.name = 'rocketMuzzle';
    const grenadeModel = buildGrenadeLauncher(team);
    grenadeModel.root.name = 'grenadeLauncher';
    grenadeModel.muzzle.name = 'grenadeMuzzle';
    grenadeModel.root.visible = false;
    const launcher = named('launcher', launcherModel.root, grenadeModel.root);
    const launcherMount = named('launcherMount', launcher);
    launcherMount.position.set(0.31, 0.13, 0);

    const shoulderR = v(0.28, 0, 0.02);
    const elbowR = v(0.37, -0.2, -0.13);
    const handR = v(0.31, 0.13, 0).add(LAUNCHER.foreGrip);
    const armR = [
      mesh(new THREE.SphereGeometry(0.11, 10, 8), team, shoulderR.x, shoulderR.y + 0.03, shoulderR.z),
      limb(shoulderR, elbowR, 0.065, suit),
      limb(elbowR, handR, 0.06, suit),
      mesh(new THREE.BoxGeometry(0.08, 0.09, 0.09), darkMetal, handR.x, handR.y, handR.z),
    ];

    // Left arm is straight along -Z from the shoulder so it can be pointed down the rope.
    const gauntletModel = buildGauntlet(team, -1);
    gauntletModel.root.position.z = -0.2;
    const gauntlet = named(
      'gauntlet',
      mesh(new THREE.SphereGeometry(0.11, 10, 8), team, 0, 0.03, 0),
      limb(v(0, 0, 0), v(0, 0, -0.24), 0.065, suit),
      gauntletModel.root,
    );
    gauntlet.quaternion.copy(GAUNTLET_REST);
    const shoulderL = named('shoulderL', gauntlet);
    shoulderL.position.set(-0.27, 0, 0.02);

    const aim = named('aim', launcherMount, ...armR, shoulderL);
    aim.position.y = SHOULDER_Y;

    const torso = named('torso', pelvis, belly, chest, plate, pack, ...tubes, neck, head, aim);
    torso.position.y = HIP_Y;
    const body = named('body', legs, torso);
    return named('player', body);
  }
}
