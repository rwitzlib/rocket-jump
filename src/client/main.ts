import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { DT, GRAPPLE, GRENADE, ROCKET } from '../shared/config';
import { ARENA } from '../shared/map';
import { GameSim, type DeathCause, type PlayerSim, type SimEvent } from '../shared/sim';
import { GameAudio } from './audio';
import { CameraFX } from './camerafx';
import { Effects } from './effects';
import { Hud } from './hud';
import { Input } from './input';
import { buildLevel, CrateView } from './level';
import { Loopback, type NetConditions } from './net/loopback';
import { NetClient } from './net/netclient';
import { NetOverlay } from './net/netoverlay';
import { PerfOverlay } from './perf';
import { PickupView } from './pickups';
import { RemotePlayersView } from './remoteview';
import { Rope } from './rope';
import { ViewModel } from './viewmodel';

const FOV = 90;
const VIEWMODEL_FOV = 60; // weapons get their own FOV so changing the world FOV does not warp them
const LOCAL_ID = 'local';

// `?net=loopback` runs a real server in the page behind a fake network, for building and testing
// netcode without deploying anything. Optional: &ping=100&jitter=10&loss=0.02&bots=2
const params = new URLSearchParams(location.search);
const LOOPBACK = params.get('net') === 'loopback';
const numParam = (name: string, fallback: number) => Number(params.get(name) ?? fallback) || 0;

async function main() {
  await RAPIER.init();

  const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
  const overlay = document.querySelector<HTMLElement>('#overlay')!;
  const crosshair = document.querySelector<HTMLElement>('#crosshair')!;
  const speedEl = document.querySelector<HTMLElement>('#speed')!;
  const hitFlash = document.querySelector<HTMLElement>('#hit-flash')!;
  const muteEl = document.querySelector<HTMLElement>('#mute')!;

  // On laptops with two GPUs this asks for the discrete one. Some browsers ignore it on Windows,
  // where the OS graphics setting for the browser decides (see the P overlay for which GPU is in use).
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.autoClear = false;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 500);
  camera.rotation.order = 'YXZ';

  const sim = new GameSim(ARENA);
  let me: PlayerSim;
  let loopback: Loopback | null = null;
  let client: NetClient | null = null;
  if (LOOPBACK) {
    const conditions: NetConditions = { ping: numParam('ping', 100), jitter: numParam('jitter', 10), loss: numParam('loss', 0) };
    const lb = (loopback = new Loopback(ARENA, conditions, 'player', numParam('bots', 2)));
    const nc = (client = new NetClient(sim, lb.clientId, (msg) => lb.send(msg)));
    lb.onMessage = (msg) => nc.receive(msg);
    me = nc.me;
  } else {
    me = sim.addPlayer(LOCAL_ID);
  }
  const localId = me.id;
  const playerPos = (id: string) => sim.players.get(id)?.pos ?? client?.remotes.get(id)?.pos;

  const levelMeshes = buildLevel(scene, ARENA);
  const crates = new CrateView(scene, sim);
  const effects = new Effects(scene, levelMeshes);
  const rope = new Rope(scene);
  const remoteView = new RemotePlayersView(scene);
  const pickupView = new PickupView(scene, sim.pickups);
  let fov = FOV;
  // Rockets and grenades are drawn leaving the barrel you see: the first-person one for ours, the model's for others.
  effects.muzzleOffset = (id, out) => {
    if (id !== localId) return remoteView.muzzleOffset(id, out);
    camera.updateMatrixWorld();
    return camera.localToWorld(viewModel.muzzleOrigin(fov, out)).sub(camera.position);
  };
  const viewModel = new ViewModel(VIEWMODEL_FOV);
  const cameraFx = new CameraFX(FOV);
  const audio = new GameAudio();
  const input = new Input(canvas);
  input.yaw = me.yaw;
  const perf = new PerfOverlay(gpuName(renderer));
  const netOverlay = loopback && client && new NetOverlay(loopback, client);
  const hud = new Hud(localId);
  let death: { killerId: string | null; cause: DeathCause } | null = null;

  overlay.addEventListener('click', () => {
    audio.resume();
    input.lock();
  });
  input.onLockChange = (locked) => overlay.classList.toggle('hidden', locked);

  const showMuted = (muted: boolean) => {
    muteEl.textContent = muted ? 'Sound off (M)' : '';
  };
  document.addEventListener('keydown', (e) => {
    if (e.code === 'KeyM') showMuted(audio.toggleMute());
  });

  const resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    viewModel.resize(w / h);
    rope.setResolution(w, h);
  };
  window.addEventListener('resize', resize);
  resize();

  // Draw every effect once behind the start menu so all shaders compile now. Browsers compile
  // shaders lazily on first draw, which otherwise freezes the game at the first rocket/grapple.
  effects.setWarmup(true);
  rope.setWarmup(true);
  remoteView.setWarmup(true);
  renderer.render(scene, camera);
  renderer.render(viewModel.scene, viewModel.camera);
  effects.setWarmup(false);
  rope.setWarmup(false);
  remoteView.setWarmup(false);

  let flash = 0;
  const handleEvent = (e: SimEvent) => {
    const mine = 'playerId' in e && e.playerId === localId;
    switch (e.type) {
      case 'explosion': {
        effects.explosion(e.pos, e.normal, e.surface, e.radius);
        audio.play('explosion', { at: e.pos, volume: 1.6 });
        const dist = e.pos.distanceTo(me.pos);
        cameraFx.shake(Math.max(0, 0.7 * (1 - dist / 25)));
        break;
      }
      case 'fired': {
        const sound = e.weapon === 'grenade' ? 'grenadeFire' : 'fire';
        if (mine) {
          viewModel.fire();
          audio.play(sound, { volume: 0.8 });
          cameraFx.shake(e.weapon === 'grenade' ? 0.08 : 0.12);
        } else {
          remoteView.fired(e.playerId);
          const at = playerPos(e.playerId);
          if (at) audio.play(sound, { at });
        }
        break;
      }
      case 'bounce':
        effects.bounce(e.pos, e.normal, e.speed);
        audio.play('bounce', { at: e.pos, volume: Math.min(0.3 + e.speed / 15, 1), rate: 0.9 + Math.random() * 0.2 });
        break;
      case 'pickup': {
        const box = sim.pickups[e.box];
        if (box) effects.sparkle(box.pos);
        if (mine) {
          hud.pickedUp(e.weapon);
          audio.play('pickup', { volume: 0.7 });
        } else if (box) audio.play('pickup', { at: box.pos, volume: 0.6 });
        break;
      }
      case 'knockback':
        if (mine) {
          cameraFx.shake(0.3 * e.strength);
          flash = Math.max(flash, 0.25 + 0.5 * e.strength);
        }
        break;
      case 'grapple':
        if (!mine) break;
        if (e.attached && me.grapple) {
          rope.attach(me.grapple.anchor, me.grapple.normal);
          viewModel.fireGrapple();
          audio.play('grappleFire', { volume: 0.6 });
          // The clank plays at the anchor, slightly delayed to match the visual hook travel.
          const anchor = me.grapple.anchor.clone();
          setTimeout(() => audio.play('grappleAttach', { at: anchor, volume: 1.2 }), 80);
        } else {
          rope.release();
          audio.play('grappleRelease', { volume: 0.4 });
        }
        break;
      case 'grappleMiss':
        if (mine) {
          viewModel.fireGrapple();
          audio.play('grappleMiss', { volume: 0.4 });
        }
        break;
      case 'jumped':
        if (mine) audio.play('jump', { volume: 0.25 });
        break;
      case 'landed':
        if (mine) {
          const hard = Math.min(e.impactSpeed / 25, 1);
          audio.play('land', { volume: 0.2 + hard * 0.8, rate: 1.1 - hard * 0.3 });
          cameraFx.impact(Math.min(e.impactSpeed / 60, 0.25));
          if (hard > 0.5) cameraFx.shake(hard * 0.25);
        }
        break;
      case 'respawn':
        if (mine) {
          input.yaw = e.yaw;
          input.pitch = 0;
          rope.release();
          death = null;
        }
        break;
      case 'damaged':
        if (mine) flash = Math.max(flash, 0.3 + e.amount / 60);
        else if (e.sourceId === localId) {
          hud.hitMarker(false);
          audio.play('hit', { volume: 0.6 });
        }
        break;
      case 'killed':
        hud.killed(e.playerId, e.killerId, e.cause);
        if (mine) {
          death = { killerId: e.killerId, cause: e.cause };
          rope.release();
        } else if (e.killerId === localId) {
          hud.hitMarker(true);
          audio.play('kill', { volume: 0.7 });
        }
        break;
    }
  };

  const inputs = new Map([[localId, input.sample()]]);
  const eye = new THREE.Vector3();
  const prevEye = new THREE.Vector3();
  const hand = new THREE.Vector3();
  const target = new THREE.Vector3();
  let accumulator = 0;
  let last = performance.now();
  let shownFlash = '';
  let shownSpeed = '';

  // Fixed-timestep simulation (60 Hz, same as a server would run) with interpolated rendering.
  const frame = (now: number) => {
    // rAF timestamps can land slightly before `last`; a negative dt would run springs backwards.
    const dt = Math.min(Math.max((now - last) / 1000, 0), 0.25);
    perf.frame(now - last, now);
    last = now;
    accumulator += dt;

    loopback?.update(now);
    while (accumulator >= DT) {
      const sample = input.sample();
      if (client) {
        for (const e of client.predict(sample)) handleEvent(e);
      } else {
        inputs.set(localId, sample);
        for (const e of sim.step(inputs)) handleEvent(e);
      }
      accumulator -= DT;
    }
    if (client) {
      for (const e of client.update(dt, now)) handleEvent(e);
      remoteView.sync(client.remotes, dt);
      netOverlay?.update(now);
    }
    const alpha = accumulator / DT;
    const speed = me.vel.length();
    const horizontalSpeed = Math.hypot(me.vel.x, me.vel.z);

    // Camera: interpolated position, but the latest mouse look so aiming never lags.
    me.eye(eye);
    prevEye.copy(me.prevPos).y += eye.y - me.pos.y;
    camera.position.lerpVectors(prevEye, eye, alpha);
    if (client) camera.position.add(client.visualOffset);
    camera.rotation.set(input.pitch, input.yaw, 0);
    fov = cameraFx.apply(camera, dt, speed);

    crates.sync();
    effects.setViewport(renderer.domElement.height, fov);
    const projectiles = client ? client.renderProjectiles : sim.projectiles;
    // The grenade launcher's arc shows what's left in the drum, then the reload filling it back up.
    const grenades = me.primary === 'grenade';
    const reloading = grenades && me.reloading;
    const reloaded = 1 - me.fireCooldown / GRENADE.reload;
    const fireReady = grenades ? (reloading ? reloaded : 1) : 1 - me.fireCooldown / ROCKET.cooldown;
    const fireCharge = grenades ? (reloading ? reloaded : me.drum / GRENADE.drum) : fireReady;
    const grappleReady = 1 - me.grappleCooldown / GRAPPLE.cooldown;
    viewModel.setPrimary(me.primary);
    viewModel.update(dt, horizontalSpeed, me.grounded, !!me.grapple, fireReady, grappleReady, reloading);
    effects.update(projectiles, alpha, dt);
    pickupView.update(dt);
    if (me.grapple) rope.follow(me.grapple.anchor, me.grapple.normal);
    rope.update(dt, camera.localToWorld(viewModel.ropeOrigin(fov, hand)), camera);
    audio.update(camera, projectiles);

    // Only touch the DOM when something visibly changed; style writes every frame cost layout/paint work.
    flash = Math.max(0, flash - dt * 2.5);
    const flashText = flash.toFixed(2);
    if (flashText !== shownFlash) hitFlash.style.opacity = shownFlash = flashText;
    const speedText = `${horizontalSpeed.toFixed(1)} m/s`;
    if (speedText !== shownSpeed) speedEl.textContent = shownSpeed = speedText;
    crosshair.classList.toggle('can-grapple', !me.grapple && sim.grappleTarget(me, target) !== null);
    crosshair.classList.toggle('grappling', !!me.grapple);
    hud.setHealth(me.health);
    hud.setProtected(me.alive && me.protectedFor > 0);
    hud.setCooldowns(fireCharge, grappleReady);
    hud.setWeapons(me.primary, me.secondary, grenades ? (reloading ? 'reloading' : me.drum) : null);
    hud.setDeath(me.alive ? null : (death ?? { killerId: null, cause: 'rocket' }), me.respawnIn);
    if (hud.boardOpen) {
      hud.setScores(client ? client.scores : [...sim.players.values()].map((p) => ({ id: p.id, kills: p.kills, deaths: p.deaths })));
    }

    renderer.clear();
    renderer.render(scene, camera);
    if (me.alive) {
      renderer.clearDepth();
      renderer.render(viewModel.scene, viewModel.camera);
    }

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // Handy for tweaking from the browser console during development: `game.me.vel`, `game.sim`, etc.
  if (import.meta.env.DEV) Object.assign(window, { game: { sim, me, client, loopback, hud, input, camera, scene, renderer, effects, audio, handleEvent, frame } });
}

function gpuName(renderer: THREE.WebGLRenderer): string {
  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown GPU';
  // "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x...) Direct3D11 ...)" -> the readable part.
  return name.match(/ANGLE \([^,]+, (.+?)(?: \(0x[0-9A-Fa-f]+\))? Direct3D/)?.[1] ?? name;
}

main();
