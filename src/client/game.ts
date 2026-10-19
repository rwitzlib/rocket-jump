import * as THREE from 'three';
import { DT, GRAPPLE, GRENADE, HELI, HYPERSONIC, PLAYER, ROCKET, SEEKERS, WEAPONS } from '../shared/config';
import { MAPS } from '../shared/map';
import { aimDirection } from '../shared/movement';
import type { ServerMessage } from '../shared/protocol';
import { GameSim, lockReady, type DeathCause, type SimEvent } from '../shared/sim';
import type { Announcer } from './announcer';
import type { GameAudio } from './audio';
import { CameraFX } from './camerafx';
import { Effects } from './effects';
import type { Hud } from './hud';
import type { Input } from './input';
import { buildLevel, CrateView } from './level';
import { resetLevelMaterials } from './surfaces';
import { NetClient, type RemotePlayer } from './net/netclient';
import type { NetOverlay } from './net/netoverlay';
import type { Transport } from './net/transport';
import type { PerfOverlay } from './perf';
import type { PostFX } from './postfx';
import { PickupView } from './pickups';
import { RemotePlayersView } from './remoteview';
import { Rope } from './rope';
import type { Settings } from './settings';
import { VehicleView } from './vehicles';
import { ViewModel } from './viewmodel';

// One map's worth of game: the scene, the predicted simulation, and everything drawn from it.
// The renderer, input, audio and HUD outlive it; a map change throws this away and builds anew.

const VIEWMODEL_FOV = 60; // weapons get their own FOV so changing the world FOV does not warp them

/** What a game borrows from the page for its lifetime. */
export interface GameContext {
  renderer: THREE.WebGLRenderer;
  audio: GameAudio;
  input: Input;
  hud: Hud;
  announcer: Announcer;
  perf: PerfOverlay;
  post: PostFX;
  settings: Settings;
  netOverlay: NetOverlay | null;
}

export interface Game {
  readonly map: string;
  readonly client: NetClient;
  /** Advances and draws one frame. */
  frame(now: number): void;
  receive(msg: ServerMessage): void;
  /** Re-reads FOV and the like after the settings changed. */
  applySettings(): void;
  dispose(): void;
}

export function startGame(ctx: GameContext, mapName: string, localId: string, transport: Transport, startSeq: number): Game {
  const { renderer, audio, input, hud, announcer, perf, settings } = ctx;
  const map = MAPS[mapName] ?? MAPS.arena;
  const crosshair = document.querySelector<HTMLElement>('#crosshair')!;
  const speedEl = document.querySelector<HTMLElement>('#speed')!;
  const hitFlash = document.querySelector<HTMLElement>('#hit-flash')!;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(settings.fov, 1, 0.05, 500);
  camera.rotation.order = 'YXZ';

  const sim = new GameSim(map);
  const client = new NetClient(sim, localId, (msg) => transport.send(msg), startSeq);
  const me = client.me;
  if (ctx.netOverlay) ctx.netOverlay.client = client;
  const playerPos = (id: string) => sim.players.get(id)?.pos ?? client.remotes.get(id)?.pos;
  const fxAt = new THREE.Vector3();
  const DOWN = new THREE.Vector3(0, -1, 0);

  const level = buildLevel(scene, map);
  renderer.toneMappingExposure = level.theme.exposure;
  ctx.post.outlineFade = [Math.max(35, level.extent * 0.45), Math.max(90, level.extent * 1.3)];
  const crates = new CrateView(scene, sim);
  const effects = new Effects(scene, level.meshes);
  effects.groundAt = (at) => {
    const d = sim.clearDistance(at, DOWN, 40);
    return d < 40 ? at.y - d - 0.3 : null;
  };
  const rope = new Rope(scene);
  const remoteView = new RemotePlayersView(scene);
  remoteView.castLevel = (from, dir, max, normal) => sim.castLevel(from, dir, max, normal);
  remoteView.onPoof = (at, color) => {
    effects.burst(at, color);
    audio.play('bounce', { at, volume: 1, rate: 0.6 });
  };
  const pickupView = new PickupView(scene, sim.pickups);
  const vehicleView = new VehicleView(scene, sim.vehicles);
  let fov = settings.fov;
  // Rockets and grenades are drawn leaving the barrel you see: the first-person one for ours, the model's for others.
  effects.muzzleOffset = (id, out) => {
    // In a vehicle we're in third person: our shots leave our model's launcher (if it's drawn), not the first-person one.
    if (id !== localId || me.vehicle >= 0) return remoteView.muzzleOffset(id, out);
    camera.updateMatrixWorld();
    return camera.localToWorld(viewModel.muzzleOrigin(fov, out)).sub(camera.position);
  };
  const viewModel = new ViewModel(VIEWMODEL_FOV);
  const cameraFx = new CameraFX(settings.fov);
  input.yaw = me.yaw;
  input.pitch = 0;
  hud.setLocalId(localId);
  announcer.setLocalId(localId);
  let death: { killerId: string | null; cause: DeathCause } | null = null;
  // After we die: the camera backs off into third person to watch our body fly.
  let deathCam: { from: THREE.Vector3; yaw: number; age: number; target: THREE.Vector3 } | null = null;
  const camGoal = new THREE.Vector3();

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

  // Draw every effect once now so all shaders compile before play. Browsers compile shaders lazily
  // on first draw, which otherwise freezes the game at the first rocket/grapple.
  effects.setWarmup(true);
  rope.setWarmup(true);
  remoteView.setWarmup(true);
  ctx.post.render(scene, camera, viewModel);
  effects.setWarmup(false);
  rope.setWarmup(false);
  remoteView.setWarmup(false);

  let flash = 0;
  const handleEvent = (e: SimEvent) => {
    const mine = 'playerId' in e && e.playerId === localId;
    switch (e.type) {
      case 'explosion': {
        effects.explosion(e.pos, e.normal, e.surface, e.radius);
        remoteView.blast(e.pos, e.radius);
        audio.play('explosion', { at: e.pos, volume: 1.6 });
        const dist = e.pos.distanceTo(me.pos);
        cameraFx.shake(Math.max(0, 0.7 * (1 - dist / 25)));
        break;
      }
      case 'fired': {
        const sound = e.weapon === 'grenade' ? 'grenadeFire' : e.weapon === 'hypersonic' ? 'hypersonicFire' : 'fire';
        // Missiles share the rocket's launch sound: a deep one for the javelin, a sharp one for the stinger.
        const rate = e.weapon === 'javelin' ? 0.75 : e.weapon === 'stinger' ? 1.35 : 1;
        if (mine) {
          viewModel.fire();
          audio.play(sound, { volume: 0.8, rate });
          cameraFx.shake(e.weapon === 'grenade' ? 0.08 : e.weapon === 'javelin' || e.weapon === 'hypersonic' ? 0.18 : 0.12);
        } else {
          remoteView.fired(e.playerId);
          const at = playerPos(e.playerId);
          if (at) audio.play(sound, { at, rate });
          if (at && remoteView.muzzleOffset(e.playerId, fxAt)) effects.muzzleSmoke(fxAt.add(at).setY(fxAt.y + PLAYER.eyeOffset));
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
      case 'landed': {
        // Dust round the feet of anyone coming down hard.
        const at = playerPos(e.playerId);
        if (at && e.impactSpeed > 11) effects.dust(fxAt.copy(at).setY(at.y - PLAYER.halfHeight - PLAYER.radius), Math.min((e.impactSpeed - 11) / 20, 1));
        if (mine) {
          const hard = Math.min(e.impactSpeed / 25, 1);
          audio.play('land', { volume: 0.2 + hard * 0.8, rate: 1.1 - hard * 0.3 });
          cameraFx.impact(Math.min(e.impactSpeed / 60, 0.25));
          if (hard > 0.5) cameraFx.shake(hard * 0.25);
        }
        break;
      }
      case 'respawn': {
        const at = playerPos(e.playerId);
        if (at) effects.beam(fxAt.copy(at).setY(at.y - PLAYER.halfHeight - PLAYER.radius));
        if (mine) {
          input.yaw = e.yaw;
          input.pitch = 0;
          rope.release();
          death = null;
          deathCam = null;
        }
        break;
      }
      case 'damaged':
        if (!mine) {
          const at = playerPos(e.playerId);
          if (at) effects.hit(fxAt.copy(at).setY(at.y + 0.3));
        }
        if (mine) {
          flash = Math.max(flash, 0.3 + e.amount / 60);
          // Point at whoever did it, relative to where we're looking.
          const from = e.sourceId !== localId ? playerPos(e.sourceId) : undefined;
          if (from) {
            const bearing = Math.atan2(-(from.x - me.pos.x), -(from.z - me.pos.z));
            hud.damageFrom(-(bearing - input.yaw), e.amount);
          }
        } else if (e.sourceId === localId) {
          hud.hitMarker(false);
          // Hitting someone in midair rings out: the shot this game is built around.
          if (e.midair) audio.play('airshot', { volume: 0.45, rate: 1.2 });
          else audio.play('hit', { volume: 0.6 });
        }
        break;
      case 'entered':
        if (mine) {
          rope.release();
          audio.play('grappleAttach', { volume: 0.5, rate: 0.8 });
        }
        break;
      case 'exited':
        if (mine) audio.play('grappleRelease', { volume: 0.5 });
        break;
      case 'vehicleHit':
        if (e.sourceId === localId) {
          hud.hitMarker(false);
          audio.play('hit', { volume: 0.5, rate: 0.8 });
        }
        break;
      case 'vehicleDestroyed': {
        effects.explosion(e.pos, e.normal, false, 7);
        remoteView.blast(e.pos, 7);
        audio.play('explosion', { at: e.pos, volume: 2, rate: 0.7 });
        cameraFx.shake(Math.max(0, 1 - e.pos.distanceTo(me.pos) / 40));
        break;
      }
      case 'rammed':
        if (mine) {
          cameraFx.shake(0.6);
          flash = Math.max(flash, 0.6);
        }
        audio.play('land', { at: playerPos(e.playerId), volume: 1.2, rate: 0.7 });
        break;
      case 'killed': {
        const at = playerPos(e.playerId);
        if (at) effects.hit(fxAt.copy(at).setY(at.y + 0.3));
        // Our own body goes flying too, for the death camera to watch (others' are thrown by remoteView).
        if (mine && me.vehicle < 0) remoteView.spawnCorpse(localId, me.pos, me.vel, input.yaw, me.primary);
        hud.killed(e.playerId, e.killerId, e.cause);
        announcer.killed(e.playerId, e.killerId, e.cause, e.midair, (id) => hud.name(id));
        if (mine) {
          death = { killerId: e.killerId, cause: e.cause };
          deathCam = { from: camera.position.clone(), yaw: input.yaw, age: 0, target: me.pos.clone() };
          rope.release();
        } else if (e.killerId === localId) {
          hud.hitMarker(true);
          audio.play('kill', { volume: 0.7 });
        }
        break;
      }
    }
  };

  const eye = new THREE.Vector3();
  const prevEye = new THREE.Vector3();
  const hand = new THREE.Vector3();
  const target = new THREE.Vector3();
  let accumulator = 0;
  let last = performance.now();
  let shownFlash = '';
  let toneIn = 0; // seconds until the next lock-on or missile-warning beep
  const lockPoint = new THREE.Vector3();
  let shownSpeed = '';
  const pivot = new THREE.Vector3();
  const lookBack = new THREE.Vector3();
  // Ourselves as another player would see us, drawn in third person while riding as a gunner.
  const self: RemotePlayer = { id: localId, pos: new THREE.Vector3(), yaw: 0, pitch: 0, anchor: null, alive: true, protected: false, grounded: true, primary: me.primary, vehicle: -1, seat: -1, hidden: false };
  const shownPlayers = new Map<string, RemotePlayer>();

  // Fixed-timestep simulation (60 Hz, same as the server) with interpolated rendering.
  const frame = (now: number) => {
    // rAF timestamps can land slightly before `last`; a negative dt would run springs backwards.
    const dt = Math.min(Math.max((now - last) / 1000, 0), 0.25);
    perf.frame(now - last, now);
    last = now;
    accumulator += dt;

    while (accumulator >= DT) {
      for (const e of client.predict(input.sample())) handleEvent(e);
      accumulator -= DT;
    }
    for (const e of client.update(dt, now)) handleEvent(e);
    ctx.netOverlay?.update(now);
    const alpha = accumulator / DT;
    const speed = me.vel.length();
    const horizontalSpeed = Math.hypot(me.vel.x, me.vel.z);
    const ride = me.alive && me.vehicle >= 0 ? sim.vehicles[me.vehicle] : null;
    input.vehicleMode = !!ride;
    const rideSeat = ride ? ride.config.seats[me.seat] : null;
    vehicleView.update(alpha, dt);

    shownPlayers.clear();
    for (const [id, r] of client.remotes) shownPlayers.set(id, r);
    if (ride && rideSeat && !rideSeat.hidden) {
      vehicleView.seatPosition(ride.index, me.seat, alpha, self.pos);
      self.yaw = input.yaw;
      self.pitch = input.pitch;
      self.primary = me.primary;
      shownPlayers.set(localId, self);
    }
    remoteView.names = hud.setNames(client.scores);
    remoteView.sync(shownPlayers, dt);

    // Camera: interpolated position, but the latest mouse look so aiming never lags. In a vehicle
    // it orbits behind a pivot above your seat (the sim aims along the same line), pulled in
    // short of any wall behind it.
    if (ride && rideSeat) {
      vehicleView.seatPosition(ride.index, me.seat, alpha, pivot).y += rideSeat.pivot;
      aimDirection(input.yaw, input.pitch, lookBack).negate();
      camera.position.copy(pivot).addScaledVector(lookBack, sim.clearDistance(pivot, lookBack, rideSeat.camDist));
    } else {
      me.eye(eye);
      prevEye.copy(me.prevPos).y += eye.y - me.pos.y;
      camera.position.lerpVectors(prevEye, eye, alpha);
    }
    camera.position.add(client.visualOffset);
    camera.rotation.set(input.pitch, input.yaw, 0);
    if (deathCam && !me.alive) {
      deathCam.age += dt;
      const corpse = remoteView.corpsePosition(localId);
      if (corpse) deathCam.target.copy(corpse);
      // Behind and above where we were looking, eased in, and kept out of walls.
      aimDirection(deathCam.yaw, -0.38, lookBack).negate();
      camGoal.copy(deathCam.target).addScaledVector(lookBack, sim.clearDistance(deathCam.target, lookBack, 4.5));
      const t = Math.min(deathCam.age / 0.5, 1);
      camera.position.lerpVectors(deathCam.from, camGoal, t * t * (3 - 2 * t));
      camera.lookAt(deathCam.target);
    }
    fov = cameraFx.apply(camera, dt, speed);

    crates.sync();
    effects.setViewport(renderer.domElement.height, fov);
    const projectiles = client.renderProjectiles;
    // The grenade launcher's arc shows what's left in the drum, then the reload filling it back up.
    const grenades = me.primary === 'grenade';
    // Locking: our seeker launcher, or a helicopter's missiles while we fly one.
    const lockWeapon = sim.lockWeapon(me);
    const seeker = lockWeapon ? SEEKERS[lockWeapon] : null;
    const reloading = grenades && me.reloading;
    const reloaded = 1 - me.fireCooldown / GRENADE.reload;
    const cooldown = seeker ? seeker.cooldown : me.primary === 'hypersonic' ? HYPERSONIC.cooldown : ROCKET.cooldown;
    const fireReady = grenades ? (reloading ? reloaded : 1) : 1 - me.fireCooldown / cooldown;
    const fireCharge = grenades ? (reloading ? reloaded : me.drum / GRENADE.drum) : fireReady;
    const grappleReady = 1 - me.grappleCooldown / GRAPPLE.cooldown;
    const piloting = !!ride && me.seat === 0 && ride.kind === 'heli';
    const driving = !!ride && me.seat === 0 && ride.kind === 'car';
    // A seeker loads its next missile once the launch kick has settled.
    const loading = reloading || (!!seeker && me.fireCooldown > 0 && me.fireCooldown < seeker.cooldown - 0.35);
    viewModel.setPrimary(me.primary);
    viewModel.update(dt, horizontalSpeed, me.grounded, !!me.grapple, fireReady, grappleReady, loading);
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
    // No grapple from a seat.
    const grappleStowed = !!WEAPONS[me.primary].twoHanded || !!ride;
    crosshair.classList.toggle('can-grapple', !me.grapple && !grappleStowed && sim.grappleTarget(me, target) !== null);
    crosshair.classList.toggle('grappling', !!me.grapple);
    hud.setHealth(me.health);
    hud.setProtected(me.alive && me.protectedFor > 0);
    const locked = lockReady(lockWeapon, me);
    const lockStatus = !seeker ? '' : sim.lockCooldown(me) > 0 ? 'Reloading' : locked ? 'Locked' : me.lockTarget ? 'Locking' : '';
    const primaryName = WEAPONS[me.primary].name;
    const secondaryName = WEAPONS[me.secondary].name;
    if (piloting) {
      hud.setCooldowns(1 - ride.fireCooldown / HELI.podCooldown, 1 - ride.missileCooldown / HELI.missileCooldown);
      hud.setWeapons('Rocket pods', `Heat seeker${lockStatus ? `  ${lockStatus}` : ''}`, '', false, false);
    } else if (driving) {
      hud.setCooldowns(0, 0);
      hud.setWeapons('Driving', 'Your gunner shoots', '', false, false);
    } else {
      hud.setCooldowns(fireCharge, grappleStowed ? 0 : grappleReady);
      if (grenades) hud.setWeapons(primaryName, secondaryName, reloading ? 'Reloading' : `${me.drum}/${GRENADE.drum}`, reloading || me.drum === 0, grappleStowed);
      else if (seeker) hud.setWeapons(primaryName, secondaryName, lockStatus, lockStatus === 'Reloading' || lockStatus === 'Locked', grappleStowed);
      else hud.setWeapons(primaryName, secondaryName, '', false, grappleStowed);
    }

    // What E would do: get out, or get into the nearest vehicle with room.
    hud.setVehicle(ride ? { name: ride.config.name, health: ride.health, maxHealth: ride.config.health } : null);
    if (ride) hud.setPrompt(null);
    else if (me.alive) {
      let near: (typeof sim.vehicles)[number] | null = null;
      let nearDist = Infinity;
      for (const v of sim.vehicles) {
        const dist = v.pos.distanceTo(me.pos);
        if (v.alive && v.seats.includes(null) && dist < v.config.enterRange && dist < nearDist) {
          near = v;
          nearDist = dist;
        }
      }
      if (!near) hud.setPrompt(null);
      else if (near.seats[0] === null) hud.setPrompt('E', `${near.kind === 'heli' ? 'Fly' : 'Drive'} ${near.config.name}`);
      else hud.setPrompt('E', `Ride ${near.config.name} as gunner`);
    } else hud.setPrompt(null);

    // Seeker lock box: the sim's lock box, scaled to the current FOV, plus a marker on whoever it's locking onto.
    if (seeker && me.alive) {
      const pxPerUnit = window.innerHeight / 2 / Math.tan((fov * Math.PI) / 360);
      const at = me.lockTarget ? playerPos(me.lockTarget) : undefined;
      let marker: { x: number; y: number } | null = null;
      if (at) {
        camera.updateMatrixWorld();
        lockPoint.copy(at).project(camera);
        if (lockPoint.z < 1) marker = { x: ((lockPoint.x + 1) / 2) * window.innerWidth, y: ((1 - lockPoint.y) / 2) * window.innerHeight };
      }
      hud.setLock({
        halfWidth: Math.tan(seeker.lockBox[0]) * pxPerUnit,
        halfHeight: Math.tan(seeker.lockBox[1]) * pxPerUnit,
        progress: me.lockTarget ? me.lockProgress / seeker.lockTime : 0,
        locked,
        marker,
      });
    } else hud.setLock(null);

    // Beeps: slow while locking, fast once locked, and a low warble when a missile is after you.
    let incoming = false;
    if (me.alive) for (const p of projectiles) if (p.target === localId && p.ownerId !== localId) incoming = true;
    hud.setMissileWarning(incoming);
    toneIn -= dt;
    if (toneIn <= 0) {
      if (incoming) {
        audio.play('lockTone', { rate: 0.6, volume: 0.6 });
        toneIn = 0.22;
      } else if (seeker && me.alive && locked) {
        audio.play('lockTone', { rate: 1.5, volume: 0.3 });
        toneIn = 0.08;
      } else if (seeker && me.alive && me.lockTarget) {
        audio.play('lockTone', { volume: 0.3 });
        toneIn = 0.18;
      }
    }
    const intermission = client.match?.phase === 'intermission';
    hud.setDeath(me.alive || intermission ? null : (death ?? { killerId: null, cause: 'rocket' }), me.respawnIn);
    hud.setScores(client.scores, client.match);
    hud.setMatch(client.match, client.scores);
    hud.setResults(client.match, client.scores);
    announcer.update(dt, client.match, client.scores);

    level.update(dt, camera);
    ctx.post.render(scene, camera, me.alive && !ride && !intermission ? viewModel : null);
  };

  // Handy for tweaking from the browser console during development: `game.me.vel`, `game.sim`, etc.
  if (import.meta.env.DEV) Object.assign(window, { game: { sim, me, client, transport, hud, input, camera, scene, renderer, effects, audio, handleEvent, frame, vehicleView, level, post: ctx.post, viewModel, remoteView } });

  return {
    map: mapName,
    client,
    frame,
    receive: (msg) => client.receive(msg),
    applySettings() {
      cameraFx.baseFov = settings.fov;
    },
    dispose() {
      window.removeEventListener('resize', resize);
      input.vehicleMode = false;
      remoteView.dispose();
      rope.release();
      for (const s of [scene, viewModel.scene]) {
        s.traverse((o) => {
          const mesh = o as THREE.Mesh;
          mesh.geometry?.dispose();
          const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
          for (const m of materials) {
            for (const value of Object.values(m)) if (value instanceof THREE.Texture) value.dispose();
            m.dispose();
          }
        });
        s.clear();
      }
      sim.world.free();
      resetLevelMaterials();
    },
  };
}
