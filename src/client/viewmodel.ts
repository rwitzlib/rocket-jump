import * as THREE from 'three';
import { GRENADE, WEAPONS } from '../shared/config';
import type { WeaponId } from '../shared/types';
import { buildGauntlet, LAUNCHER, PRIMARY_MODELS, type LauncherModel } from './weapons';

// First-person weapons, rendered in their own scene after the world so they never clip into walls.
// The launcher rides on the right shoulder, as it does on the player models, its barrel running
// out toward the crosshair with the right hand on the fore grip. The grapple is on the left forearm.
// Picking up a different primary weapon dips the old one out of view and brings the new one up.

const SHOULDER = new THREE.Vector3(0.36, -0.15, -0.2);
const SHOULDER_TILT = new THREE.Euler(0.05, 0.1, 0); // barrel angled in toward the crosshair
const LEFT_ARM = new THREE.Vector3(-0.32, -0.32, -0.36);
const LEFT_TILT = new THREE.Euler(0.06, -0.12, 0.12);

const READY = new THREE.Color(0x7cf0a0);
const READY_GLOW = new THREE.Color(0x3cbf6a);
const CHARGING = new THREE.Color(0xff5a3c);
const CHARGING_GLOW = new THREE.Color(0x401008);

const SWAP_TIME = 0.45; // seconds to lower one launcher and raise the other
const CHAMBER = (Math.PI * 2) / GRENADE.drum; // one turn of the drum: a chamber per grenade

const _p = new THREE.Vector3();

export class ViewModel {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private launcher = new THREE.Group();
  private grappler = new THREE.Group();
  private readonly launchers: Partial<Record<WeaponId, LauncherModel>>;
  private shown: WeaponId = 'rocket'; // the launcher in hand
  private wanted: WeaponId = 'rocket'; // the one being swapped to
  private swap = 0; // 1 just picked up .. 0 settled
  private stowed = 0; // 0 grapple arm up .. 1 lowered out of view, for a two-handed weapon
  private muzzle: THREE.Object3D;
  private hookTip: THREE.Object3D;
  private hookHead: THREE.Object3D;
  private launcherLight: THREE.MeshStandardMaterial;
  private grappleStrip: THREE.MeshStandardMaterial;
  private flash: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private recoil = 0;
  private drumTurn = 0; // where the drum is turning to, radians
  private reloadPose = 0; // 0 aiming .. 1 tipped down and rolled over for a reload
  private grappleKick = 0;
  private bob = 0;

  constructor(fov: number) {
    this.camera = new THREE.PerspectiveCamera(fov, 1, 0.01, 10);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 2));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(1, 2, 1);
    const fill = new THREE.DirectionalLight(0xc8d8ff, 0.9); // lights the launcher's inner side, which faces you
    fill.position.set(-1.5, 0.6, 0.8);
    this.scene.add(key, fill);

    const glove = new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.8 });
    const knuckle = new THREE.MeshStandardMaterial({ color: 0x3a4250, metalness: 0.6, roughness: 0.35 });

    // Launcher, with the right hand wrapped around its fore grip and the forearm running off-screen.
    this.launchers = {};
    for (const [id, build] of Object.entries(PRIMARY_MODELS)) {
      const model = build();
      model.root.visible = id === 'rocket';
      this.launchers[id as WeaponId] = model;
    }
    const launcher = this.launchers.rocket!;
    // The Javelin is two-handed: the left hand holds its sight unit (the grapple arm is lowered).
    const leftHand = new THREE.Group();
    leftHand.position.set(-0.2, -0.13, 0.06);
    leftHand.add(
      new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.1), glove),
      limb(new THREE.Vector3(0, -0.02, 0.03), new THREE.Vector3(-0.18, -0.4, 0.4), 0.055, glove),
    );
    this.launchers.javelin?.root.add(leftHand);
    this.muzzle = launcher.muzzle;
    this.launcherLight = launcher.light;
    this.flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xffc070, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.flash.position.z = -0.08;
    this.flash.scale.set(1, 1, 1.6);
    this.muzzle.add(this.flash);
    const hand = new THREE.Group();
    hand.position.copy(LAUNCHER.foreGrip);
    const fist = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.1, 0.1), glove);
    const knuckles = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.035, 0.05), knuckle);
    knuckles.position.set(-0.01, 0.025, -0.045);
    const forearm = limb(new THREE.Vector3(0, -0.03, 0.02), new THREE.Vector3(0.1, -0.4, 0.42), 0.055, glove);
    hand.add(fist, knuckles, forearm);
    this.launcher.add(...Object.values(this.launchers).map((m) => m.root), hand);
    this.launcher.position.copy(SHOULDER);
    this.launcher.rotation.copy(SHOULDER_TILT);

    // Grapple gauntlet over the left forearm, fist poking out under the barrel.
    const gauntlet = buildGauntlet(undefined, -1);
    this.hookTip = gauntlet.tip;
    this.hookHead = gauntlet.hookHead;
    this.grappleStrip = gauntlet.strip;
    const leftFist = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.09), glove);
    leftFist.position.set(0, -0.01, -0.4);
    const sleeve = limb(new THREE.Vector3(0, 0, 0.02), new THREE.Vector3(-0.02, -0.06, 0.4), 0.06, glove);
    this.grappler.add(gauntlet.root, leftFist, sleeve);
    this.grappler.position.copy(LEFT_ARM);
    this.grappler.rotation.copy(LEFT_TILT);

    this.camera.add(this.launcher, this.grappler);
    this.scene.add(this.camera);
  }

  fire() {
    this.recoil = 1;
    this.drumTurn += CHAMBER;
  }

  fireGrapple() {
    this.grappleKick = 1;
  }

  /** The primary weapon to hold. Changing it plays the swap, unless `instant` (a cut to someone else's view). */
  setPrimary(weapon: WeaponId, instant = false) {
    if (!this.launchers[weapon]) return;
    if (instant) {
      this.wanted = weapon;
      this.swap = 0;
      if (this.shown !== weapon) this.show(weapon);
      return;
    }
    if (weapon === this.wanted) return;
    this.wanted = weapon;
    this.swap = 1;
  }

  /** The weapon in hand (for tests and the console). */
  get primary(): WeaponId {
    return this.shown;
  }

  private show(weapon: WeaponId) {
    const model = this.launchers[weapon]!;
    for (const m of Object.values(this.launchers)) m.root.visible = m === model;
    this.shown = weapon;
    this.muzzle = model.muzzle;
    this.muzzle.add(this.flash);
    this.launcherLight = model.light;
  }

  /**
   * `fireReady` and `grappleReady` run 0..1 as each weapon recharges; their status lights follow.
   * `reloading`: the grenade launcher's drum is being refilled, or a seeker is loading its next missile.
   */
  update(dt: number, speed: number, grounded: boolean, grappling: boolean, fireReady = 1, grappleReady = 1, reloading = false) {
    this.recoil = Math.max(0, this.recoil - dt * 4);
    this.grappleKick = Math.max(0, this.grappleKick - dt * 7);
    this.bob += dt * (grounded ? Math.min(speed, 10) : 0);
    const bobX = Math.sin(this.bob) * 0.008;
    const bobY = Math.abs(Math.cos(this.bob)) * 0.008;

    // Swapping: the old launcher drops out of view, the new one comes up in its place halfway through.
    this.swap = Math.max(0, this.swap - dt / SWAP_TIME);
    if (this.swap <= 0.5 && this.shown !== this.wanted) this.show(this.wanted);
    const lowered = Math.sin(this.swap * Math.PI);
    this.stowed += ((WEAPONS[this.shown].twoHanded ? 1 : 0) - this.stowed) * (1 - Math.exp(-dt * 8));

    // Reloading tips the launcher down and rolls the drum toward you, spinning it as it's refilled.
    // Afterwards the drum settles on the nearest chamber.
    this.reloadPose += ((reloading ? 1 : 0) - this.reloadPose) * (1 - Math.exp(-dt * 10));
    if (reloading) this.drumTurn += dt * 10;
    else this.drumTurn = Math.ceil(this.drumTurn / CHAMBER - 0.01) * CHAMBER;
    const drum = this.launchers.grenade?.drum;
    if (drum) drum.rotation.z += (this.drumTurn - drum.rotation.z) * (1 - Math.exp(-dt * 25));
    const tip = this.reloadPose;

    // Recoil shoves the launcher back along the shoulder and rocks the barrel up.
    const kick = this.recoil * this.recoil;
    this.launcher.position.set(SHOULDER.x + bobX - tip * 0.08, SHOULDER.y + bobY - kick * 0.02 - lowered * 0.35 - tip * 0.06, SHOULDER.z + kick * 0.14);
    this.launcher.rotation.set(SHOULDER_TILT.x + kick * 0.12 - lowered * 0.6 - tip * 0.35, SHOULDER_TILT.y + tip * 0.3, SHOULDER_TILT.z - kick * 0.03 + tip * 0.7);
    this.flash.material.opacity = this.recoil > 0.75 ? (this.recoil - 0.75) / 0.25 : 0;
    this.flash.visible = this.flash.material.opacity > 0;

    const reach = grappling ? -0.06 : 0;
    this.grappler.position.set(LEFT_ARM.x - bobX * 1.4, LEFT_ARM.y + bobY - this.stowed * 0.45, LEFT_ARM.z + reach + this.grappleKick * 0.06);
    this.grappler.visible = this.stowed < 0.98;
    this.grappler.rotation.set(LEFT_TILT.x + this.grappleKick * 0.2, LEFT_TILT.y, LEFT_TILT.z);
    this.hookHead.visible = !grappling;

    setStatus(this.launcherLight, fireReady);
    setStatus(this.grappleStrip, grappleReady);
  }

  /** Where rockets leave the barrel on screen, in the world camera's local space (see `toWorldCamera`). */
  muzzleOrigin(worldFov: number, out: THREE.Vector3): THREE.Vector3 {
    return this.toWorldCamera(this.muzzle, worldFov, out);
  }

  /** Where the rope leaves the gauntlet on screen, in the world camera's local space. */
  ropeOrigin(worldFov: number, out: THREE.Vector3): THREE.Vector3 {
    return this.toWorldCamera(this.hookTip, worldFov, out);
  }

  /**
   * A point on the weapons expressed in the *world* camera's local space, so it lands on the same
   * spot on screen (the two cameras have different FOVs, so the same screen point maps to different coordinates).
   */
  private toWorldCamera(obj: THREE.Object3D, worldFov: number, out: THREE.Vector3): THREE.Vector3 {
    this.camera.updateMatrixWorld(true);
    this.camera.worldToLocal(obj.getWorldPosition(_p));
    const scale = Math.tan((worldFov * Math.PI) / 360) / Math.tan((this.camera.fov * Math.PI) / 360);
    return out.set(_p.x * scale, _p.y * scale, _p.z);
  }

  resize(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}

function setStatus(mat: THREE.MeshStandardMaterial, ready: number) {
  const full = ready >= 1;
  mat.color.copy(full ? READY : CHARGING);
  mat.emissive.copy(full ? READY_GLOW : CHARGING_GLOW).multiplyScalar(full ? 1 : 0.4 + 0.6 * ready);
}

/** A rounded rod from a to b. */
function limb(a: THREE.Vector3, b: THREE.Vector3, radius: number, mat: THREE.Material): THREE.Mesh {
  const len = a.distanceTo(b);
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(radius, Math.max(len - radius * 2, 0.01), 3, 10), mat);
  m.position.addVectors(a, b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _p.subVectors(b, a).normalize());
  return m;
}
