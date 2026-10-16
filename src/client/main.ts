import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { DT } from '../shared/config';
import { ARENA } from '../shared/map';
import { GameSim, type SimEvent } from '../shared/sim';
import { Effects } from './effects';
import { Input } from './input';
import { buildLevel, CrateView } from './level';
import { ViewModel } from './viewmodel';

const FOV = 90;
const VIEWMODEL_FOV = 60; // weapons get their own FOV so changing the world FOV does not warp them
const LOCAL_ID = 'local';

async function main() {
  await RAPIER.init();

  const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
  const overlay = document.querySelector<HTMLElement>('#overlay')!;
  const crosshair = document.querySelector<HTMLElement>('#crosshair')!;
  const speedEl = document.querySelector<HTMLElement>('#speed')!;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.autoClear = false;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 500);
  camera.rotation.order = 'YXZ';

  const sim = new GameSim(ARENA);
  const me = sim.addPlayer(LOCAL_ID);

  buildLevel(scene, ARENA);
  const crates = new CrateView(scene, sim);
  const effects = new Effects(scene);
  const viewModel = new ViewModel(VIEWMODEL_FOV);
  const input = new Input(canvas);
  input.yaw = me.yaw;

  overlay.addEventListener('click', () => input.lock());
  input.onLockChange = (locked) => overlay.classList.toggle('hidden', locked);

  const resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    viewModel.resize(w / h);
  };
  window.addEventListener('resize', resize);
  resize();

  const handleEvent = (e: SimEvent) => {
    if (e.type === 'explosion') effects.explosion(e.pos);
    else if (e.type === 'fired' && e.playerId === LOCAL_ID) viewModel.fire();
    else if (e.type === 'respawn' && e.playerId === LOCAL_ID) {
      input.yaw = e.yaw;
      input.pitch = 0;
    }
  };

  const inputs = new Map([[LOCAL_ID, input.sample()]]);
  const eye = new THREE.Vector3();
  const prevEye = new THREE.Vector3();
  const hand = new THREE.Vector3();
  const target = new THREE.Vector3();
  let accumulator = 0;
  let last = performance.now();

  // Fixed-timestep simulation (60 Hz, same as a server would run) with interpolated rendering.
  const frame = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.25);
    last = now;
    accumulator += dt;

    while (accumulator >= DT) {
      inputs.set(LOCAL_ID, input.sample());
      for (const e of sim.step(inputs)) handleEvent(e);
      accumulator -= DT;
    }
    const alpha = accumulator / DT;

    // Camera: interpolated position, but the latest mouse look so aiming never lags.
    me.eye(eye);
    prevEye.copy(me.prevPos).y += eye.y - me.pos.y;
    camera.position.lerpVectors(prevEye, eye, alpha);
    camera.rotation.set(input.pitch, input.yaw, 0);
    camera.updateMatrixWorld();

    crates.sync();
    effects.update(sim, alpha, dt);
    const horizontalSpeed = Math.hypot(me.vel.x, me.vel.z);
    viewModel.update(dt, horizontalSpeed, me.grounded, !!me.grapple);
    effects.setRope(
      me.grapple ? camera.localToWorld(viewModel.ropeOrigin(FOV, hand)) : null,
      me.grapple?.anchor ?? null,
    );
    speedEl.textContent = `${horizontalSpeed.toFixed(1)} m/s`;
    crosshair.classList.toggle('can-grapple', !me.grapple && sim.grappleTarget(me, target) !== null);
    crosshair.classList.toggle('grappling', !!me.grapple);

    renderer.clear();
    renderer.render(scene, camera);
    renderer.clearDepth();
    renderer.render(viewModel.scene, viewModel.camera);

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // Handy for tweaking from the browser console during development: `game.me.vel`, `game.sim`, etc.
  if (import.meta.env.DEV) Object.assign(window, { game: { sim, me, input, camera } });
}

main();
