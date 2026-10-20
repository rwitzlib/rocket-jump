import * as THREE from 'three';
import { PLAYER, ROCKET } from '../shared/config';
import { aimDirection } from '../shared/movement';
import type { Projectile } from '../shared/projectile';
import { DEFAULT_LOOK, TRAILS, type Look } from '../shared/progress';
import { Effects } from './effects';
import { blankRemote } from './net/netclient';
import { RemotePlayersView } from './remoteview';

// The character beside the Skins tab, wearing whatever's picked (or hovered, to try a skin on). It
// stands facing you, swaying a little, and every few seconds turns round, fires a rocket off into
// the distance to show the trail, and watches it burst, then turns back. The game's own player model
// and effects draw it, in a small renderer of its own that only runs while it's on screen.

const ID = 'preview';
const CYCLE = 3.6; // seconds per loop
const TURN_AT = 1.5; // when it starts turning to fire
const FIRE_AT = 1.9;
const BACK_AT = 2.9; // when it turns back to face you
const FLIGHT = 0.65; // seconds a rocket flies before it bursts
const ROCKET_SPEED = 13; // m/s: well under a real rocket's, so the trail reads at this size
const FACE_YAW = Math.PI - 0.6; // three quarters on to the camera, turned a little to its left
const AIM_YAW = 0.35; // away from the camera and a little left: the rocket flies off into the distance
const AIM_PITCH = 0.3;
const CENTER = PLAYER.halfHeight + PLAYER.radius; // capsule center above the floor

const smooth = (t: number) => {
  const x = THREE.MathUtils.clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

export class SkinPreview {
  readonly canvas = document.createElement('canvas');
  private renderer: THREE.WebGLRenderer | null = null; // made the first time it's shown
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  private readonly players: RemotePlayersView;
  private readonly effects: Effects;
  private readonly me = blankRemote(ID);
  private readonly looks = new Map<string, Look>([[ID, DEFAULT_LOOK]]);
  private rocket: Projectile | null = null;
  private rocketAge = 0;
  private shots = 0;
  private time = 0;
  private last = 0;
  private raf = 0;

  constructor() {
    this.canvas.className = 'skin-preview';
    this.scene.add(new THREE.HemisphereLight(0xdde8ff, 0x302820, 1.8));
    const sun = new THREE.DirectionalLight(0xfff2e0, 2.6);
    sun.position.set(3, 6, 5);
    const rim = new THREE.DirectionalLight(0x8ab8ff, 1.4);
    rim.position.set(-4, 3, -4);
    this.scene.add(sun, rim);
    // A plinth to stand on.
    const plinth = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.82, 0.12, 40), new THREE.MeshStandardMaterial({ color: 0x2a303c, roughness: 0.7 }));
    plinth.position.y = -0.06;
    const edge = new THREE.Mesh(new THREE.TorusGeometry(0.76, 0.012, 6, 48).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffb347 }));
    this.scene.add(plinth, edge);

    this.players = new RemotePlayersView(this.scene);
    this.players.looks = this.looks;
    this.effects = new Effects(this.scene, []);
    this.effects.trailOf = (id) => {
      const trail = this.looks.get(id)?.trail;
      return id === ID && trail && trail !== 'classic' ? (TRAILS.find((t) => t.id === trail) ?? null) : null;
    };
    this.me.pos.set(0, CENTER, 0);
    this.me.yaw = FACE_YAW;
    this.camera.position.set(0.65, 1.55, 4.4);
    this.camera.lookAt(-0.45, 1.5, -2);
    if (import.meta.env.DEV) Object.assign(window, { skinPreview: this });
  }

  /** What it wears: the look worn, or one being tried on. */
  wear(look: Look) {
    this.looks.set(ID, look);
  }

  /** Runs while the canvas is on screen; stops by itself once it isn't. */
  start() {
    if (this.raf) return;
    this.last = performance.now();
    const loop = (now: number) => {
      this.raf = 0;
      if (!this.canvas.isConnected || !this.canvas.offsetParent) return;
      this.frame(Math.min((now - this.last) / 1000, 0.1));
      this.last = now;
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Steps the loop by dt seconds and draws it. */
  frame(dt: number) {
    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.toneMapping = THREE.NeutralToneMapping;
    }
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (w && h && (this.canvas.width !== Math.round(w * this.renderer.getPixelRatio()) || this.canvas.height !== Math.round(h * this.renderer.getPixelRatio()))) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.effects.setViewport(this.canvas.height, this.camera.fov);
    }

    const before = this.time % CYCLE;
    this.time += dt;
    const t = this.time % CYCLE;
    // Facing you (swaying a little), then turning to aim, then back.
    const sway = FACE_YAW + Math.sin(this.time * 0.9) * 0.25;
    const aim = t < TURN_AT ? 0 : t < BACK_AT ? smooth((t - TURN_AT) / (FIRE_AT - TURN_AT - 0.1)) : 1 - smooth((t - BACK_AT) / (CYCLE - BACK_AT));
    this.me.yaw = THREE.MathUtils.lerp(sway, AIM_YAW, aim);
    this.me.pitch = AIM_PITCH * aim;
    if (before < FIRE_AT && t >= FIRE_AT) this.fire();

    this.players.sync(new Map([[ID, this.me]]), dt);
    const r = this.rocket;
    if (r) {
      r.prevPos.copy(r.pos);
      r.pos.addScaledVector(r.vel, dt);
      this.rocketAge += dt;
      if (this.rocketAge >= FLIGHT) {
        this.effects.explosion(r.pos, new THREE.Vector3(0, 1, 0), false, ROCKET.blastRadius * 0.6, this.looks.get(ID)?.explosion);
        this.rocket = null;
      }
    }
    this.effects.update(this.rocket ? [this.rocket] : [], 1, dt);
    this.renderer.render(this.scene, this.camera);
  }

  private fire() {
    this.players.fired(ID);
    const from = new THREE.Vector3();
    if (this.players.muzzleOffset(ID, from)) from.add(this.me.pos).setY(from.y + PLAYER.eyeOffset);
    else from.copy(this.me.pos).setY(this.me.pos.y + PLAYER.eyeOffset);
    const vel = aimDirection(AIM_YAW, AIM_PITCH, new THREE.Vector3()).multiplyScalar(ROCKET_SPEED);
    this.shots++;
    this.rocket = {
      id: this.shots,
      kind: 'rocket',
      ownerId: ID,
      shot: this.shots,
      pos: from.clone(),
      prevPos: from.clone(),
      vel,
      life: ROCKET.lifetime,
      traveled: 0,
      lag: 0,
      struck: null,
      target: null,
      phase: 'terminal',
      apex: 0,
      from: -1,
      power: 1,
    };
    this.rocketAge = 0;
  }
}
