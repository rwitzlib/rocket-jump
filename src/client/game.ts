import * as THREE from 'three';
import { DT, GRAPPLE, GRENADE, HELI, HYPERSONIC, PLAYER, ROCKET, SEEKERS, TEAMS, THUNDER, WEAPONS, type GameMode } from '../shared/config';
import { MAPS } from '../shared/map';
import { aimDirection } from '../shared/movement';
import type { ServerMessage } from '../shared/protocol';
import { GameSim, lockReady, type DeathCause, type SimEvent } from '../shared/sim';
import type { Announcer } from './announcer';
import type { GameAudio } from './audio';
import { CameraFX } from './camerafx';
import { Effects } from './effects';
import type { DeathInfo, Hud, Marker } from './hud';
import type { Input } from './input';
import { KILLCAM_AFTER, KILLCAM_BEFORE, KillcamRecorder } from './killcam';
import { ClipRecorder } from './clips';
import { buildLevel, CrateView } from './level';
import { resetLevelMaterials } from './surfaces';
import { blankRemote, NetClient, type RemotePlayer } from './net/netclient';
import type { NetOverlay } from './net/netoverlay';
import type { Transport } from './net/transport';
import { clearFlags, FlagsView, formatLap, HillView, ItemsView, RaceGhost, RaceView } from './objectives';
import { noPickups } from '../shared/modes';
import type { PerfOverlay } from './perf';
import type { PostFX } from './postfx';
import { PickupView } from './pickups';
import { RemotePlayersView } from './remoteview';
import { Rope } from './rope';
import { Coach, Tips } from './tutorial';
import { fetchBoard } from './profile';
import { LAP_SAMPLE } from '../shared/server';
import { decodeLook, TRAILS, type Look } from '../shared/progress';
import type { Settings } from './settings';
import { VehicleView } from './vehicles';
import { ViewModel } from './viewmodel';

// One map's worth of game: the scene, the predicted simulation, and everything drawn from it.
// The renderer, input, audio and HUD outlive it; a map (or mode) change throws this away and
// builds anew. A spectator's game has no player of its own: the camera follows someone, or flies.

const VIEWMODEL_FOV = 60; // weapons get their own FOV so changing the world FOV does not warp them
/** How long the camera watches our body fly before the killcam takes over. */
const DEATH_CAM_TIME = 0.75;
/** The play of the match replays in slow motion so it is easier to follow. */
const HIGHLIGHT_SPEED = 0.5;
// The final kill of a match replays from just behind the shot that made it: the killer's view until
// it leaves the barrel, then riding along at full speed, slowing right down as it lands.
const FINAL_KILL_BEFORE = 4; // at most this far back, for a long missile flight
const FINAL_KILL_AFTER = 0.7;
const FINAL_KILL_LEAD = 0.5; // seconds of the killer's view before the shot leaves
const FINAL_KILL_SLOW = 0.3;
const CHASE_DISTANCE = 3;
/** Others' events come a little behind the snapshot that ends a match: how long to wait for the last kill's. */
const LAST_KILL_GRACE = 0.4;
const SPECTATE_DISTANCE = 4.5;
const FREE_CAM_SPEED = 18; // m/s

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
  readonly mode: GameMode;
  readonly spectator: boolean;
  readonly client: NetClient;
  /** Advances and draws one frame. */
  frame(now: number): void;
  receive(msg: ServerMessage): void;
  /** Re-reads FOV and the like after the settings changed. */
  applySettings(): void;
  /** Saves the last replay as a video file. False if there isn't one. */
  saveClip(): boolean;
  dispose(): void;
}

export interface GameSetup {
  map: string;
  mode: GameMode;
  localId: string;
  transport: Transport;
  startSeq: number;
  spectator: boolean;
  /** Where the server's HTTP side is, for online games (race records); null in practice. */
  apiBase: string | null;
}

export function startGame(ctx: GameContext, setup: GameSetup): Game {
  const { renderer, audio, input, hud, announcer, perf, settings } = ctx;
  const { localId, transport, mode, spectator } = setup;
  const mapName = MAPS[setup.map] ? setup.map : 'arena';
  const map = MAPS[mapName];
  const crosshair = document.querySelector<HTMLElement>('#crosshair')!;
  const speedEl = document.querySelector<HTMLElement>('#speed')!;
  const hitFlash = document.querySelector<HTMLElement>('#hit-flash')!;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(settings.fov, 1, 0.05, 500);
  camera.rotation.order = 'YXZ';

  const sim = new GameSim(map, mode);
  const client = new NetClient(sim, localId, (msg) => transport.send(msg), setup.startSeq, spectator);
  const me = client.me;
  if (ctx.netOverlay) ctx.netOverlay.client = client;
  const playerPos = (id: string) => (id === localId && !spectator ? me.pos : client.remotes.get(id)?.pos);
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
  // The killcam's own copies of everyone, drawn while it plays (the live ones are hidden meanwhile).
  const killcamView = new RemotePlayersView(scene);
  killcamView.castLevel = remoteView.castLevel;
  const recorder = new KillcamRecorder();
  const race = mode === 'race';
  const pickupView = noPickups(mode) ? null : new PickupView(scene, sim.pickups);
  const itemsView = noPickups(mode) ? null : new ItemsView(scene, sim.items);
  const hillView = mode === 'koth' ? new HillView(scene, sim.rules.hills) : null;
  let hillHolder: string | null = null;
  let hillContested = false;
  const flagsView = mode === 'ctf' ? new FlagsView(scene, sim.flags.map((f) => f.home)) : null;
  const raceView = race ? new RaceView(scene, sim.course) : null;
  const ghost = race && !spectator ? new RaceGhost(scene, mapName) : null;
  // Online: the map's record lap flies along too, as a gold ghost.
  if (ghost && setup.apiBase !== null) {
    void fetchBoard(setup.apiBase, mapName, true)
      .then((board) => {
        if (!board.ghost?.path.length) return;
        ghost.setRecord(board.ghost.path, LAP_SAMPLE, board.ghost.time, board.ghost.name);
        hud.feedNotice(`Record lap ${formatLap(board.ghost.time)} by ${board.ghost.name}: the gold ghost`, 0xffd060);
      })
      .catch(() => {});
  }
  const vehicleView = new VehicleView(scene, sim.vehicles);
  // What everyone wears, from the scores: armor color, rocket trail and explosion.
  const looks = new Map<string, Look>();
  const shownLooks = new Map<string, string>();
  effects.trailOf = (id) => {
    const trail = looks.get(id)?.trail;
    return trail && trail !== 'classic' ? (TRAILS.find((t) => t.id === trail) ?? null) : null;
  };
  // Training talks you round its course; everywhere else, one-off tips for new players.
  const coach = map.tutorial && !spectator ? new Coach(input) : null;
  const tips = new Tips(settings, input);
  let aliveFor = 0;
  let couldGrapple = false;
  let grappleCue = 0;
  let fov = settings.fov;
  // Rockets and grenades are drawn leaving the barrel you see: the first-person one for ours, the model's for others.
  effects.muzzleOffset = (id, out) => {
    // In a vehicle we're in third person: our shots leave our model's launcher (if it's drawn), not
    // the first-person one. In the killcam the first-person weapon is the killer's.
    const firstPerson = killcamKiller ? !killcamChasing && id === killcamKiller.id && killcamKiller.vehicle < 0 : id === localId && me.vehicle < 0 && !spectator;
    if (!firstPerson) return remoteView.muzzleOffset(id, out);
    camera.updateMatrixWorld();
    return camera.localToWorld(viewModel.muzzleOrigin(fov, out)).sub(camera.position);
  };
  const viewModel = new ViewModel(VIEWMODEL_FOV);
  const cameraFx = new CameraFX(settings.fov);
  input.yaw = me.yaw;
  input.pitch = 0;
  // Gamepad aim assist: the view slows while the crosshair is on (or just off) an enemy in sight.
  const assistDir = new THREE.Vector3();
  const assistTo = new THREE.Vector3();
  input.aimFriction = (yaw, pitch) => {
    if (spectator || !me.alive) return 1;
    aimDirection(yaw, pitch, assistDir);
    let best = Infinity;
    for (const r of client.remotes.values()) {
      if (!r.alive || sim.allies(localId, r.id)) continue;
      assistTo.copy(r.pos).sub(camera.position);
      const dist = assistTo.length();
      if (dist > 90 || dist < 1) continue;
      const angle = assistDir.angleTo(assistTo);
      // A player is about a meter across: allow for that at this distance.
      best = Math.min(best, angle - Math.atan(0.6 / dist));
    }
    return best < 0.02 ? 0.4 : best < 0.08 ? 0.65 : 1;
  };
  hud.setLocalId(localId);
  announcer.setLocalId(localId);
  let death: Omit<DeathInfo, 'damage' | 'killcam'> | null = null;
  // Who hurt us this life, for the death recap.
  const damageTaken = new Map<string, number>();
  // After we die: the camera backs off into third person to watch our body fly, then (if someone
  // killed us) the killcam replays the last couple of seconds from their eyes.
  let deathCam: { from: THREE.Vector3; yaw: number; age: number; target: THREE.Vector3 } | null = null;
  // `source`: the live recorder for our own death, or a saved copy for the results screen's replays.
  // It plays `from` to `to` (`t`: where it's up to); `chase`: the shot the camera rides behind, if any.
  let killcam: {
    killerId: string;
    diedAt: number;
    from: number;
    to: number;
    t: number;
    age: number;
    shown: number;
    source: KillcamRecorder;
    highlight: boolean;
    chase: number | null;
  } | null = null;
  // A kill kept to replay on the results screen: `before` and `after` it are kept, `chase` rides its shot.
  interface Replay {
    match: number;
    killerId: string;
    victimId: string;
    cause: DeathCause;
    t: number;
    title: string;
    before: number;
    after: number;
    chase: boolean;
    source: KillcamRecorder | null;
  }
  // The play of the match: the best kill this client saw. And the match's last kill.
  let highlight: (Replay & { score: number }) | null = null;
  let finalKill: Replay | null = null;
  // The results screen's replays still to show (null until planned), for the match that ended at `endedAt`.
  let replays: Replay[] | null = null;
  let endedMatch = -1;
  let endedAt = 0;
  const lastKill = new Map<string, number>(); // killer -> recorder clock of their last kill, for multi kills
  const clips = new ClipRecorder();
  clips.onReady = (label) => tips.show('clip', `Press K to save that replay (${label}) as a video.`);
  // The killer as the killcam shows them: their weapon in first person, kicking when they fire,
  // and their grapple rope.
  let killcamKiller: RemotePlayer | null = null;
  let killcamSpeed = 0;
  let killcamRope = false;
  // Riding behind the final kill's shot: where it was last seen, its (smoothed) heading, and how
  // long ago it landed (-1: still flying).
  let killcamChasing = false;
  const chaseAt = new THREE.Vector3();
  const chaseDir = new THREE.Vector3();
  let chaseLanded = -1;
  const killcamLast = new THREE.Vector3();
  const ropeNormal = new THREE.Vector3();
  const killcamPlayers = new Map<string, RemotePlayer>();
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

  const endKillcam = () => {
    if (!killcam) return;
    killcam = null;
    killcamView.dispose();
    remoteView.setVisible(true);
  };

  /** Starts the next of the results screen's replays, once it's been kept. False if there's none to start. */
  const startReplay = (): boolean => {
    const r = replays?.[0];
    if (!r?.source) return false;
    replays!.shift();
    endKillcam();
    // Riding a shot starts just before it was fired (thunder, falls and rams have none to ride).
    const shot = r.chase ? r.source.killingShot(r.killerId, r.victimId, r.cause, r.t) : null;
    const from = shot ? Math.min(Math.max(shot.firstSeen - FINAL_KILL_LEAD, r.t - r.before), r.t - 0.6) : r.t - KILLCAM_BEFORE;
    killcam = { killerId: r.killerId, diedAt: r.t, from, to: r.t + r.after, t: from, age: DEATH_CAM_TIME, shown: from - 0.01, source: r.source, highlight: true, chase: shot?.shot ?? null };
    killcamChasing = false;
    hud.setHighlight(r.title);
    return true;
  };

  let flash = 0;
  const handleEvent = (e: SimEvent) => {
    const mine = 'playerId' in e && e.playerId === localId && !spectator;
    switch (e.type) {
      case 'explosion': {
        const style = looks.get(e.ownerId)?.explosion ?? 'classic';
        recorder.explosion(e.pos, e.normal, e.surface, e.radius, style);
        if (killcam) break; // the replay shows its own
        effects.explosion(e.pos, e.normal, e.surface, e.radius, style);
        remoteView.blast(e.pos, e.radius);
        audio.play('explosion', { at: e.pos, volume: 1.6 });
        const dist = e.pos.distanceTo(camera.position);
        cameraFx.shake(Math.max(0, 0.7 * (1 - dist / 25)));
        if (dist < 20) input.rumble(0.6 * (1 - dist / 20), 160);
        break;
      }
      case 'fired': {
        recorder.fired(e.playerId);
        const sound = e.weapon === 'grenade' ? 'grenadeFire' : e.weapon === 'hypersonic' ? 'hypersonicFire' : e.weapon === 'thunder' ? 'thunderFire' : 'fire';
        // Missiles share the rocket's launch sound: a deep one for the javelin, a sharp one for the stinger.
        const rate = e.weapon === 'javelin' ? 0.75 : e.weapon === 'stinger' ? 1.35 : 1;
        if (mine) {
          viewModel.fire();
          const thunder = e.weapon === 'thunder';
          input.rumble(thunder ? 0.5 : 0.15, thunder ? 200 : 60);
          audio.play(sound, { volume: 0.8, rate });
          cameraFx.shake(e.weapon === 'grenade' ? 0.08 : e.weapon === 'javelin' || e.weapon === 'hypersonic' ? 0.18 : thunder ? 0.4 : 0.12);
        } else {
          remoteView.fired(e.playerId);
          const at = playerPos(e.playerId);
          if (at) audio.play(sound, { at, rate });
          if (at && remoteView.muzzleOffset(e.playerId, fxAt)) effects.muzzleSmoke(fxAt.add(at).setY(fxAt.y + PLAYER.eyeOffset));
        }
        break;
      }
      case 'thunder':
        effects.thunderWave(e.pos, e.dir);
        break;
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
      case 'item': {
        const item = sim.items[e.index];
        if (item) effects.sparkle(item.pos);
        const label = e.kind === 'health' ? '+ Health' : e.kind === 'armor' ? '+ Armor' : 'OVERDRIVE';
        if (mine) {
          hud.pickedUp(label);
          audio.play('pickup', { volume: 0.8, rate: e.kind === 'overdrive' ? 0.7 : e.kind === 'armor' ? 0.85 : 1.15 });
        } else if (item) audio.play('pickup', { at: item.pos, volume: 0.6, rate: 0.9 });
        if (e.kind === 'overdrive') {
          hud.feedNotice(`${hud.name(e.playerId)} ${mine ? 'have' : 'has'} the overdrive`, 0xff40d0);
          if (mine) hud.medal('OVERDRIVE', 'Double damage', 'medal', 0xff6ae0);
        }
        break;
      }
      case 'flag': {
        announcer.flag(e.team, e.action, e.playerId, (id) => hud.name(id));
        const f = client.flags[e.team];
        const at = f ? fxAt.set(...f.pos) : null;
        if (at && (e.action === 'returned' || e.action === 'captured')) effects.beam(at);
        if (at) audio.play('pickup', { at, volume: 0.9, rate: e.action === 'captured' ? 0.6 : 0.8 });
        break;
      }
      case 'hill':
        if (hillHolder !== localId && e.playerId === localId && !spectator) {
          hud.medal('HOLDING THE HILL', 'Stay on it', 'notice', 0x60ff90);
          audio.play('pickup', { volume: 0.6, rate: 1.2 });
        }
        hillHolder = e.playerId;
        hillContested = e.contested;
        break;
      case 'checkpoint':
        if (mine && coach?.passed(e.index, e.time)) {
          hud.medal('TRAINING COMPLETE', 'You know the moves', 'big', 0x7cf0a0);
          audio.play('airshot', { volume: 0.7 });
        }
        if (!mine || !ghost) break;
        audio.play('blip', { volume: 0.6, rate: 1.3 });
        {
          const delta = ghost.split(e.index, e.time);
          if (delta !== null) hud.medal(`${delta < 0 ? '−' : '+'}${Math.abs(delta).toFixed(2)}`, `Ring ${e.index}`, 'notice', delta < 0 ? 0x7cf0a0 : 0xff8a6c);
        }
        break;
      case 'lap':
        if (mine && ghost) {
          const previous = ghost.bestTime;
          ghost.lapDone(e.time);
          audio.play(e.best ? 'airshot' : 'medal', { volume: 0.7 });
          const sub = previous && e.time < previous ? `NEW BEST · ${(e.time - previous).toFixed(2)}` : previous ? `Best ${formatLap(previous)}` : 'First lap';
          hud.medal(formatLap(e.time), sub, e.best ? 'medal' : 'notice');
        } else if (!mine && e.best) {
          const record = Math.min(Infinity, ...client.scores.filter((s) => s.bestLap > 0).map((s) => s.bestLap));
          if (e.time <= record + 1e-3) hud.feedNotice(`${hud.name(e.playerId)} set the lap record: ${formatLap(e.time)}`, 0x50e0ff);
        }
        break;
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
          coach?.reset();
          if (me.deaths > 0 || death) tips.show('respawn', 'Back in! Floating ? boxes swap your rocket launcher for something different until you die.');
          input.yaw = e.yaw;
          input.pitch = 0;
          rope.release();
          death = null;
          deathCam = null;
          damageTaken.clear();
          endKillcam();
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
          input.rumble(0.3 + e.amount / 100, 200);
          if (e.sourceId !== localId) damageTaken.set(e.sourceId, (damageTaken.get(e.sourceId) ?? 0) + e.amount);
          // Point at whoever did it, relative to where we're looking.
          const from = e.sourceId !== localId ? playerPos(e.sourceId) : undefined;
          if (from) {
            const bearing = Math.atan2(-(from.x - me.pos.x), -(from.z - me.pos.z));
            hud.damageFrom(-(bearing - input.yaw), e.amount);
          }
        } else if (e.sourceId === localId && !spectator) {
          hud.hitMarker(false);
          // Hitting someone in midair rings out: the shot this game is built around.
          if (e.midair) tips.show('airshot', 'Airshot! Hitting someone in midair is the shot this game is about: knock them into the air, then catch them.');
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
        if (e.sourceId === localId && !spectator) {
          hud.hitMarker(false);
          audio.play('hit', { volume: 0.5, rate: 0.8 });
        }
        break;
      case 'vehicleDestroyed': {
        effects.explosion(e.pos, e.normal, false, 7);
        remoteView.blast(e.pos, 7);
        recorder.explosion(e.pos, e.normal, false, 7);
        audio.play('explosion', { at: e.pos, volume: 2, rate: 0.7 });
        cameraFx.shake(Math.max(0, 1 - e.pos.distanceTo(camera.position) / 40));
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
        if (!race) {
          hud.killed(e.playerId, e.killerId, e.cause);
          announcer.killed(e.playerId, e.killerId, e.cause, e.midair, (id) => hud.name(id));
        }
        if (mine) {
          death = { killerId: e.killerId, cause: e.cause, distance: e.distance, killerHealth: e.killerHealth };
          deathCam = { from: camera.position.clone(), yaw: input.yaw, age: 0, target: me.pos.clone() };
          rope.release();
          const intermission = client.match?.phase === 'intermission';
          if (settings.killcam && e.killerId && e.killerId !== localId && !race && !intermission && recorder.covers(recorder.clock)) {
            const from = recorder.clock - KILLCAM_BEFORE;
            killcam = { killerId: e.killerId, diedAt: recorder.clock, from, to: recorder.clock + KILLCAM_AFTER, t: from, age: 0, shown: from, source: recorder, highlight: false, chase: null };
          }
        } else if (e.killerId === localId && !spectator) {
          hud.hitMarker(true);
          audio.play('kill', { volume: 0.7 });
        }
        // Perhaps the match's last kill, and a contender for the play of the match: airshots, long
        // shots and multi kills score highest. The match-ending kill can land just after the match
        // ends (the server stops the fighting then, so nothing later counts).
        const counts = client.match && (client.match.phase === 'playing' || client.match.id !== endedMatch || recorder.clock < endedAt + LAST_KILL_GRACE);
        if (e.killerId && e.killerId !== e.playerId && !race && client.match && counts && recorder.covers(recorder.clock)) {
          const kill = { match: client.match.id, killerId: e.killerId, victimId: e.playerId, cause: e.cause, t: recorder.clock, source: null };
          finalKill = { ...kill, title: `FINAL KILL · ${hud.name(e.killerId)}`, before: FINAL_KILL_BEFORE, after: FINAL_KILL_AFTER, chase: true };
          const previous = lastKill.get(e.killerId) ?? -Infinity;
          lastKill.set(e.killerId, recorder.clock);
          const multi = recorder.clock - previous < 3;
          const score = 1 + (e.midair ? 2.5 : 0) + Math.min(e.distance, 60) / 20 + (multi ? 1.5 : 0) + (e.cause === 'fall' ? 0.5 : 0);
          if (!highlight || highlight.match !== kill.match || score > highlight.score) {
            const how = [e.midair ? 'airshot' : '', multi ? 'multi kill' : '', e.distance > 25 ? `${Math.round(e.distance)} m` : ''].filter(Boolean).join(', ');
            const title = `PLAY OF THE MATCH · ${hud.name(e.killerId)}${how ? `: ${how}` : ''}`;
            highlight = { ...kill, score, title, before: KILLCAM_BEFORE, after: KILLCAM_AFTER, chase: false };
          }
        }
        break;
      }
    }
  };

  // --- spectating -----------------------------------------------------------------------------

  // Watching: follow a player, fly a free camera, or look down on the whole map from above (with
  // everyone pinned on screen, through walls). Space goes round the three.
  const spec = { cam: 'follow' as 'follow' | 'free' | 'overhead', target: null as string | null, pos: new THREE.Vector3(0, 20, 0), fire: false, grapple: false, jump: false, yaw: 0, zoom: 1 };
  const mapCenter = level.bounds.getCenter(new THREE.Vector3());
  /** Who to watch next: the living players in a fixed order, stepping `dir` from the current one. */
  const cycleTarget = (dir: number) => {
    const ids = [...client.remotes.values()].filter((r) => r.alive).map((r) => r.id).sort();
    if (!ids.length) {
      spec.target = null;
      return;
    }
    const i = spec.target ? ids.indexOf(spec.target) : -1;
    spec.target = ids[(i + dir + ids.length) % ids.length];
  };
  const spectate = (dt: number) => {
    const s = input.sample();
    if (s.fire && !spec.fire) {
      spec.cam = 'follow';
      cycleTarget(1);
    }
    if (s.grapple && !spec.grapple) {
      spec.cam = 'follow';
      cycleTarget(-1);
    }
    if (s.jump && !spec.jump) {
      spec.cam = spec.cam === 'follow' ? 'free' : spec.cam === 'free' ? 'overhead' : 'follow';
      if (spec.cam === 'free') {
        // Free camera starts where the follow camera was, looking the same way.
        spec.pos.copy(camera.position);
        input.yaw = camera.rotation.y;
        input.pitch = camera.rotation.x;
      }
    }
    spec.fire = s.fire;
    spec.grapple = s.grapple;
    spec.jump = s.jump;
    let target = spec.target ? client.remotes.get(spec.target) : undefined;
    if (spec.cam === 'follow' && !target) {
      // Stay on someone who died until they're back, unless they've left.
      cycleTarget(1);
      target = spec.target ? client.remotes.get(spec.target) : undefined;
    }
    if (spec.cam === 'follow' && target) {
      spec.yaw += Math.atan2(Math.sin(target.yaw - spec.yaw), Math.cos(target.yaw - spec.yaw)) * Math.min(1, dt * 10);
      camGoal.copy(target.pos).y += PLAYER.eyeOffset + 0.4;
      aimDirection(spec.yaw, Math.min(target.pitch, 0.4) - 0.25, lookBack).negate();
      camera.position.copy(camGoal).addScaledVector(lookBack, sim.clearDistance(camGoal, lookBack, SPECTATE_DISTANCE));
      camera.lookAt(fxAt.copy(camGoal).addScaledVector(lookBack, -6));
      const name = hud.name(target.id);
      hud.setSpectating(target.alive ? `Watching ${name}` : `Watching ${name} (respawning)`);
      return;
    }
    if (spec.cam === 'overhead') {
      // High over the middle, turned with the mouse, W and S to zoom.
      spec.zoom = Math.min(1.8, Math.max(0.35, spec.zoom - s.forward * dt * 0.8));
      const r = Math.max(40, level.extent * 1.25) * spec.zoom;
      const tilt = 0.95;
      camera.position.set(mapCenter.x + Math.sin(input.yaw) * r * Math.cos(tilt), mapCenter.y + r * Math.sin(tilt), mapCenter.z + Math.cos(input.yaw) * r * Math.cos(tilt));
      camera.lookAt(mapCenter);
      hud.setSpectating('Overhead: mouse turns, W/S zoom');
      return;
    }
    // Free camera: fly where you look.
    aimDirection(input.yaw, input.pitch, fxAt);
    spec.pos.addScaledVector(fxAt, s.forward * FREE_CAM_SPEED * dt);
    spec.pos.x += Math.cos(input.yaw) * s.right * FREE_CAM_SPEED * dt;
    spec.pos.z -= Math.sin(input.yaw) * s.right * FREE_CAM_SPEED * dt;
    camera.position.copy(spec.pos);
    camera.rotation.set(input.pitch, input.yaw, 0);
    hud.setSpectating('Free camera');
  };

  /** A teammate still standing, to watch while we're out of an elimination round. */
  const teammateUp = (): RemotePlayer | undefined => {
    const current = spec.target ? client.remotes.get(spec.target) : undefined;
    if (current?.alive && current.team === me.team) return current;
    const next = [...client.remotes.values()].find((r) => r.alive && r.team === me.team);
    spec.target = next?.id ?? null;
    return next;
  };

  // --- objective markers --------------------------------------------------------------------------

  const markerPoint = new THREE.Vector3();
  const markers: Marker[] = [];
  /** Pins a point in the world on the HUD (to the screen edge, pointing, when it's off screen). */
  const addMarker = (at: THREE.Vector3, color: number, label: string) => {
    camera.updateMatrixWorld();
    markerPoint.copy(at).project(camera);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const behind = markerPoint.z > 1;
    let x = markerPoint.x;
    let y = markerPoint.y;
    if (behind) {
      x = -x;
      y = -y;
    }
    const edge = behind || Math.abs(x) > 0.92 || Math.abs(y) > 0.88;
    if (edge) {
      const k = 1 / Math.max(Math.abs(x) / 0.92, Math.abs(y) / 0.88, 1e-6);
      x *= k;
      y *= k;
    }
    const dist = Math.round(at.distanceTo(camera.position));
    markers.push({ x: ((x + 1) / 2) * w, y: ((1 - y) / 2) * h, color, label: `${label} ${dist} m`, edge, angle: Math.atan2(x, y) });
  };
  const updateMarkers = (myTeam: number) => {
    markers.length = 0;
    if (mode === 'ctf') {
      client.flags.forEach((f, team) => {
        if (f.carrier === localId && !spectator) return;
        const carrier = f.carrier ? playerPos(f.carrier) : undefined;
        const at = carrier ? fxAt.copy(carrier).setY(carrier.y + 1.4) : fxAt.set(f.pos[0], f.pos[1] + 2.8, f.pos[2]);
        const label = myTeam < 0 ? `${TEAMS[team].name}` : team === myTeam ? (f.atHome ? 'Defend' : f.carrier ? 'Kill' : 'Return') : f.carrier ? 'Escort' : 'Take';
        addMarker(at, TEAMS[team].color, label);
      });
      // Carrying their flag: home is where it goes.
      if (me.flag >= 0 && myTeam >= 0 && !spectator) addMarker(fxAt.copy(sim.flags[myTeam].home).setY(sim.flags[myTeam].home.y + 2), TEAMS[myTeam].color, 'Capture');
    } else if (hillView && client.match) {
      const label = hillContested ? 'Contested' : hillHolder === localId && !spectator ? 'Holding' : hillHolder ? `${hud.name(hillHolder)} holds` : 'Hill';
      const color = hillContested ? 0xffe060 : hillHolder === localId && !spectator ? 0x60ff90 : hillHolder ? 0xff5a4a : 0xffffff;
      addMarker(fxAt.copy(hillView.position).setY(hillView.position.y + 3), color, label);
    } else if (race && raceView && !spectator && me.alive) {
      addMarker(raceView.centers[me.checkpoint], me.checkpoint === 0 ? 0xffe060 : 0x60ff90, me.checkpoint === 0 && me.lapTime >= 0 ? 'Finish' : me.checkpoint === 0 ? 'Start' : 'Next');
    }
    // From overhead, everyone is pinned on screen (through walls), in their team's color.
    if (spectator && spec.cam === 'overhead') {
      for (const r of client.remotes.values()) {
        if (!r.alive) continue;
        const color = r.team >= 0 ? TEAMS[r.team].color : 0xffffff;
        addMarker(fxAt.copy(r.pos).setY(r.pos.y + 1.4), color, hud.name(r.id));
      }
    }
    hud.setMarkers(markers);
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
  // Ourselves as another player would see us, drawn in third person while riding as a gunner (and
  // recorded for the killcam).
  const self: RemotePlayer = blankRemote(localId);
  const shownPlayers = new Map<string, RemotePlayer>();
  const recorded = new Map<string, RemotePlayer>();
  const killcamShown = new Map<string, RemotePlayer>();
  const lerpPos = new THREE.Vector3();

  /** One frame of the killcam: everyone as they were, seen through the killer's eyes. */
  const playKillcam = (frameDt: number): boolean => {
    if (!killcam) return false;
    killcam.age += frameDt;
    if (killcam.age < DEATH_CAM_TIME) return false;
    // Replay time from here on: everything below runs on it, so slow motion slows it all. Riding a
    // shot, it's full speed until the shot's about to land.
    const landing = THREE.MathUtils.smoothstep(killcam.t, killcam.diedAt - 0.5, killcam.diedAt - 0.1);
    const speed = killcam.chase !== null ? 1 + (FINAL_KILL_SLOW - 1) * landing : killcam.highlight ? HIGHLIGHT_SPEED : 1;
    const dt = frameDt * speed;
    const t = (killcam.t += dt);
    if (t > killcam.to) {
      clips.stop();
      return false; // over: back to watching the body until we respawn
    }
    const source = killcam.source;
    if (killcam.shown <= killcam.from) clips.start(renderer.domElement, killcam.chase !== null ? 'final kill' : killcam.highlight ? 'play of the match' : 'killcam');
    remoteView.setVisible(false);
    const projectiles = source.sample(t, killcamPlayers);
    const killer = killcamPlayers.get(killcam.killerId);
    if (!killer) return false;
    const shot = killcam.chase !== null ? projectiles.find((p) => p.ownerId === killer.id && p.shot === killcam!.chase) : undefined;
    if (shot) {
      // Riding behind the shot: its heading eased, so a seeker's turns don't whip the camera round.
      if (shot.vel.lengthSq() > 0.01) {
        fxAt.copy(shot.vel).normalize();
        if (killcamChasing) chaseDir.lerp(fxAt, Math.min(1, dt * 8)).normalize();
        else chaseDir.copy(fxAt);
      }
      chaseAt.copy(shot.pos);
      killcamChasing = true;
      chaseLanded = -1;
    } else if (killcamChasing) chaseLanded = chaseLanded < 0 ? 0 : chaseLanded + dt;
    // Riding the shot, the camera starts at the killer's eye: they're hidden until it's well clear of them.
    pivot.copy(killer.pos).y += PLAYER.eyeOffset;
    const fromEye = chaseAt.distanceTo(pivot);
    killcamShown.clear();
    for (const [id, r] of killcamPlayers) if (id !== killcam.killerId || killer.vehicle >= 0 || (killcamChasing && fromEye > CHASE_DISTANCE + 2)) killcamShown.set(id, r);
    killcamView.names = remoteView.names;
    killcamView.teams = remoteView.teams;
    killcamView.looks = looks;
    killcamView.localTeam = remoteView.localTeam;
    killcamView.sync(killcamShown, dt);
    for (const b of source.blastsBetween(killcam.shown, t)) {
      effects.explosion(b.pos, b.normal, b.surface, b.radius, b.style);
      killcamView.blast(b.pos, b.radius);
      audio.play('explosion', { at: b.pos, volume: 1.4 });
    }
    for (const id of source.firedBetween(killcam.shown, t)) if (id === killcam.killerId) viewModel.fire();
    killcam.shown = t;
    effects.update(projectiles, 1, dt);
    // Their speed, for the weapon's sway; their rope, from the hand we see.
    killcamSpeed = killcamKiller && dt > 0 ? Math.hypot(killer.pos.x - killcamLast.x, killer.pos.z - killcamLast.z) / dt : 0;
    killcamLast.copy(killer.pos);
    killcamKiller = killer;
    if (killcamChasing) {
      // Just behind and above the shot, looking a little ahead of it (pulling back from the killer's
      // eye as it leaves); once it's landed, drifting back to take in the blast. Kept out of walls.
      if (killcamRope) rope.release();
      killcamRope = false;
      lookBack.copy(chaseDir).negate();
      lookBack.y += 0.3;
      lookBack.normalize();
      const back = Math.min(CHASE_DISTANCE, fromEye) + Math.max(0, chaseLanded) * 2.5;
      camera.position.copy(chaseAt).addScaledVector(lookBack, sim.clearDistance(chaseAt, lookBack, back));
      camera.lookAt(fxAt.copy(chaseAt).addScaledVector(chaseDir, 2));
      return true;
    }
    if (killer.anchor && killer.vehicle < 0) {
      ropeNormal.copy(killer.pos).sub(killer.anchor).normalize();
      if (!killcamRope) rope.attach(killer.anchor, ropeNormal);
      else rope.follow(killer.anchor, ropeNormal);
      killcamRope = true;
    } else if (killcamRope) {
      rope.release();
      killcamRope = false;
    }
    if (killer.vehicle >= 0) {
      // From a vehicle: over their shoulder.
      pivot.copy(killer.pos).y += 2;
      aimDirection(killer.yaw, killer.pitch, lookBack).negate();
      camera.position.copy(pivot).addScaledVector(lookBack, sim.clearDistance(pivot, lookBack, 6));
    } else camera.position.copy(killer.pos).y += PLAYER.eyeOffset;
    camera.rotation.set(killer.pitch, killer.yaw, 0);
    return true;
  };

  // Fixed-timestep simulation (60 Hz, same as the server) with interpolated rendering.
  const frame = (now: number) => {
    // rAF timestamps can land slightly before `last`; a negative dt would run springs backwards.
    const dt = Math.min(Math.max((now - last) / 1000, 0), 0.25);
    perf.frame(now - last, now);
    last = now;
    accumulator += dt;

    while (accumulator >= DT) {
      if (!spectator) {
        for (const e of client.predict(input.sample())) handleEvent(e);
        ghost?.record(me.lapTime, me.pos);
      }
      accumulator -= DT;
    }
    for (const e of client.update(dt, now)) handleEvent(e);
    ctx.netOverlay?.update(now);
    const alpha = accumulator / DT;
    const speed = me.vel.length();
    const horizontalSpeed = Math.hypot(me.vel.x, me.vel.z);
    const ride = !spectator && me.alive && me.vehicle >= 0 ? sim.vehicles[me.vehicle] : null;
    input.vehicleMode = !!ride;
    const rideSeat = ride ? ride.config.seats[me.seat] : null;
    vehicleView.update(alpha, dt);
    const myTeam = spectator ? -1 : me.team;
    announcer.localTeam = myTeam;

    shownPlayers.clear();
    for (const [id, r] of client.remotes) shownPlayers.set(id, r);
    // Ourselves, as everyone else sees us: drawn while riding as a gunner, always recorded for the killcam.
    self.pos.lerpVectors(me.prevPos, me.pos, alpha);
    self.yaw = input.yaw;
    self.pitch = input.pitch;
    self.primary = me.primary;
    self.alive = me.alive;
    self.team = me.team;
    self.overdrive = me.overdrive > 0;
    self.flag = me.flag;
    self.anchor = me.grapple ? me.grapple.anchor : null;
    self.grounded = me.grounded;
    self.vehicle = me.vehicle;
    self.seat = me.seat;
    self.hidden = !!rideSeat?.hidden;
    if (ride && rideSeat && !rideSeat.hidden) {
      vehicleView.seatPosition(ride.index, me.seat, alpha, self.pos);
      shownPlayers.set(localId, self);
    }
    remoteView.names = hud.setNames(client.scores);
    for (const s of client.scores) {
      if (shownLooks.get(s.id) === s.look) continue;
      shownLooks.set(s.id, s.look);
      looks.set(s.id, decodeLook(s.look));
    }
    remoteView.looks = looks;
    const teams = new Map(client.teams);
    if (!spectator) teams.set(localId, me.team);
    remoteView.teams = teams;
    remoteView.localTeam = myTeam;
    remoteView.sync(shownPlayers, dt);
    recorded.clear();
    for (const [id, r] of client.remotes) recorded.set(id, r);
    if (!spectator) {
      if (!ride) lerpPos.copy(self.pos);
      recorded.set(localId, { ...self, pos: ride ? self.pos : lerpPos });
    }
    recorder.record(dt, recorded.values(), client.renderProjectiles);
    // Once the moment after the best kill (and the last) is in, keep a copy of it for the results screen.
    for (const r of [highlight, finalKill]) {
      if (r && !r.source && recorder.clock >= r.t + r.after) r.source = recorder.snapshot(r.t - r.before - 0.1, r.t + r.after);
    }
    // The match is over: before the results, replay its last kill riding the shot that made it, then
    // the play of the match (unless that was the last kill).
    const over = client.match?.phase === 'intermission';
    if (over && client.match!.id !== endedMatch) {
      endedMatch = client.match!.id;
      endedAt = recorder.clock;
      replays = null;
      lastKill.clear();
    }
    if (over && !spectator && !replays && recorder.clock >= endedAt + LAST_KILL_GRACE) {
      const last = finalKill?.match === endedMatch && finalKill.t > endedAt - 2 ? finalKill : null;
      const best = highlight?.match === endedMatch && highlight.t !== last?.t ? highlight : null;
      replays = [last, best].filter((r) => r !== null);
    }
    if (over && !killcam?.highlight) startReplay();
    // Until the replays start, the results wait (not for long: the last one's kept 0.7 s after its kill).
    hud.holdResults = over && !spectator && (!replays || replays.length > 0) && recorder.clock < endedAt + 2;

    // Camera: interpolated position, but the latest mouse look so aiming never lags. In a vehicle
    // it orbits behind a pivot above your seat (the sim aims along the same line), pulled in
    // short of any wall behind it.
    let replaying = false;
    let teammateWatched: string | null = null;
    if (spectator) spectate(dt);
    else {
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
      replaying = (!me.alive || !!killcam?.highlight) && playKillcam(dt);
      if (!replaying && killcam?.highlight) {
        // Straight on to the next replay, if there's one; else the results.
        if (startReplay()) replaying = playKillcam(0);
        else {
          hud.setHighlight(null);
          endKillcam();
        }
      }
      if (!replaying && killcam) {
        killcamView.dispose();
        remoteView.setVisible(true);
      }
      if (!replaying && killcamKiller) {
        killcamKiller = null;
        killcamChasing = false;
        viewModel.setPrimary(me.primary, true);
        if (killcamRope) rope.release();
        killcamRope = false;
      }
      // Out of an elimination round: after the killcam, watch a teammate who's still standing.
      const watching = mode === 'elim' && !me.alive && !replaying && deathCam && deathCam.age > 2.5 ? teammateUp() : undefined;
      if (watching) {
        spec.yaw += Math.atan2(Math.sin(watching.yaw - spec.yaw), Math.cos(watching.yaw - spec.yaw)) * Math.min(1, dt * 10);
        camGoal.copy(watching.pos).y += PLAYER.eyeOffset + 0.4;
        aimDirection(spec.yaw, Math.min(watching.pitch, 0.4) - 0.25, lookBack).negate();
        camera.position.copy(camGoal).addScaledVector(lookBack, sim.clearDistance(camGoal, lookBack, SPECTATE_DISTANCE));
        camera.lookAt(fxAt.copy(camGoal).addScaledVector(lookBack, -6));
        teammateWatched = `Watching ${hud.name(watching.id)}`;
      } else if (deathCam && !me.alive && !replaying) {
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
    }
    fov = cameraFx.apply(camera, dt, spectator ? 0 : speed);

    crates.sync();
    effects.setViewport(renderer.domElement.height, fov);
    const projectiles = client.renderProjectiles;
    // The grenade launcher's arc shows what's left in the drum, then the reload filling it back up.
    const grenades = me.primary === 'grenade';
    // Locking: our seeker launcher, or a helicopter's missiles while we fly one.
    const lockWeapon = spectator ? null : sim.lockWeapon(me);
    const seeker = lockWeapon ? SEEKERS[lockWeapon] : null;
    const reloading = grenades && me.reloading;
    const reloaded = 1 - me.fireCooldown / GRENADE.reload;
    const cooldown = seeker ? seeker.cooldown : me.primary === 'hypersonic' ? HYPERSONIC.cooldown : me.primary === 'thunder' ? THUNDER.reload : ROCKET.cooldown;
    const fireReady = grenades ? (reloading ? reloaded : 1) : 1 - me.fireCooldown / cooldown;
    const fireCharge = grenades ? (reloading ? reloaded : me.drum / GRENADE.drum) : fireReady;
    const grappleReady = 1 - me.grappleCooldown / GRAPPLE.cooldown;
    const piloting = !!ride && me.seat === 0 && ride.kind === 'heli';
    const driving = !!ride && me.seat === 0 && ride.kind === 'car';
    // A seeker loads its next missile once the launch kick has settled.
    const loading = reloading || (!!seeker && me.fireCooldown > 0 && me.fireCooldown < seeker.cooldown - 0.35);
    // During the killcam the weapon in view is the killer's.
    const held = replaying ? killcamKiller : null;
    if (held) {
      viewModel.setPrimary(held.primary, true);
      viewModel.update(dt, killcamSpeed, held.grounded, !!held.anchor, 1, 1, false);
    } else {
      viewModel.setPrimary(me.primary);
      viewModel.update(dt, horizontalSpeed, me.grounded, !!me.grapple, fireReady, grappleReady, loading);
    }
    if (!replaying) effects.update(projectiles, alpha, dt);
    pickupView?.update(dt);
    itemsView?.update(dt);
    flagsView?.update(dt, client.flags);
    raceView?.update(dt, spectator ? -1 : me.checkpoint);
    hillView?.update(dt, client.match?.hill ?? 0, hillContested ? 'contested' : !hillHolder ? 'free' : hillHolder === localId && !spectator ? 'mine' : 'theirs');
    ghost?.update(me.alive ? me.lapTime : -1);
    if (me.grapple) rope.follow(me.grapple.anchor, me.grapple.normal);
    rope.update(dt, camera.localToWorld(viewModel.ropeOrigin(fov, hand)), camera);
    audio.update(camera, projectiles);

    // Only touch the DOM when something visibly changed; style writes every frame cost layout/paint work.
    flash = Math.max(0, flash - dt * 2.5);
    const flashText = flash.toFixed(2);
    if (flashText !== shownFlash) hitFlash.style.opacity = shownFlash = flashText;
    const speedText = spectator ? '' : `${horizontalSpeed.toFixed(1)} m/s`;
    if (speedText !== shownSpeed) speedEl.textContent = shownSpeed = speedText;
    // No grapple from a seat.
    const grappleStowed = !!WEAPONS[me.primary].twoHanded || !!ride;
    const canGrapple = !spectator && me.alive && !me.grapple && !grappleStowed && sim.grappleTarget(me, target) !== null;
    crosshair.classList.toggle('can-grapple', canGrapple);
    // A soft tick as the grapple comes in range, so you can hear it without watching the crosshair.
    grappleCue = Math.max(0, grappleCue - dt);
    if (canGrapple && !couldGrapple && grappleCue === 0) {
      audio.play('blip', { volume: 0.12, rate: 1.9 });
      grappleCue = 0.35;
    }
    couldGrapple = canGrapple;
    if (canGrapple && !coach) tips.show('grapple', 'The crosshair turned green: your grapple reaches. Hold {grapple} to swing from it, let go to fly.');
    crosshair.classList.toggle('grappling', !!me.grapple);
    hud.setHealth(me.health, me.armor, me.overdrive);
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

    // What E would do: get out, or get into the nearest vehicle with room (in a race, start over).
    hud.setVehicle(ride ? { name: ride.config.name, health: ride.health, maxHealth: ride.config.health } : null);
    if (ride) hud.setPrompt(null);
    else if (race && me.alive && !spectator && me.lapTime >= 0) hud.setPrompt(input.label('use'), 'Restart');
    else if (me.alive && !spectator && !race) {
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
      else if (near.seats[0] === null) hud.setPrompt(input.label('use'), `${near.kind === 'heli' ? 'Fly' : 'Drive'} ${near.config.name}`);
      else hud.setPrompt(input.label('use'), `Ride ${near.config.name} as gunner`);
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
    if (me.alive && !spectator) for (const p of projectiles) if (p.target === localId && p.ownerId !== localId) incoming = true;
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
    const deathInfo: DeathInfo | null =
      spectator || me.alive || intermission
        ? null
        : {
            ...(death ?? { killerId: null, cause: 'rocket', distance: 0, killerHealth: 0 }),
            damage: [...damageTaken].map(([id, amount]) => ({ id, amount })).sort((a, b) => b.amount - a.amount),
            killcam: replaying,
          };
    hud.setDeath(deathInfo, me.respawnIn);
    if (!spectator) hud.setSpectating(teammateWatched);
    hud.setFlags(mode === 'ctf' ? client.flags : null, myTeam);
    hud.setRace(race && !spectator && !intermission ? { lapTime: me.alive ? me.lapTime : -1, ring: me.checkpoint, rings: sim.course.rings.length, best: ghost?.bestTime ?? 0 } : null);
    updateMarkers(myTeam);
    // Tips for the first few games, as they become useful.
    tips.update(dt);
    coach?.update(me.checkpoint);
    aliveFor = !spectator && me.alive ? aliveFor + dt : 0;
    if (!coach && !spectator && !intermission) {
      if (aliveFor > 2) {
        if (mode === 'ctf') tips.show('ctf', "Capture the flag: grab their flag (follow 'Take') and bring it to your base while your own flag is home.");
        else if (mode === 'koth') tips.show('koth', 'King of the hill: stand in the glowing ring with nobody else on it to score. It moves every minute.');
        else if (mode === 'elim') tips.show('elim', "Elimination: no health regeneration and no respawns until the round's over. Stick with your team.");
        else if (mode === 'instagib') tips.show('instagib', 'Instagib: one Hypersonic hit kills. Keep moving, and lead your shots.');
        else if (race) tips.show('race', 'Fly through the rings in order; the clock starts at the first. {use} starts over.');
        else tips.show('rocketjump', 'Rocket jump: look down, then {jump} and {fire} together. Your own rockets never hurt you.');
      }
      if (me.alive && me.health < 40 && !race) tips.show('health', 'Hurt? Health comes back after 5 seconds out of the fight, and health packs top you up.');
    }
    hud.setScores(client.scores, client.match);
    hud.setMatch(client.match, client.scores);
    hud.setResults(client.match, client.scores);
    announcer.update(dt, client.match, client.scores);

    level.update(dt, camera, client.moverTick(alpha));
    const firstPerson = (me.alive && !ride && !intermission && !spectator) || (replaying && !!killcamKiller && killcamKiller.vehicle < 0 && !killcamChasing);
    ctx.post.render(scene, camera, firstPerson ? viewModel : null);
  };

  // Handy for tweaking from the browser console during development: `game.me.vel`, `game.sim`, etc.
  if (import.meta.env.DEV) Object.assign(window, { game: { sim, me, client, transport, hud, input, camera, scene, renderer, effects, audio, handleEvent, frame, vehicleView, level, post: ctx.post, viewModel, remoteView, recorder, ghost } });

  return {
    map: mapName,
    mode,
    spectator,
    client,
    frame,
    receive: (msg) => client.receive(msg),
    saveClip: () => clips.save(),
    applySettings() {
      cameraFx.baseFov = settings.fov;
    },
    dispose() {
      window.removeEventListener('resize', resize);
      input.aimFriction = () => 1;
      clips.stop();
      hud.setHighlight(null);
      coach?.dispose();
      tips.dispose();
      input.vehicleMode = false;
      remoteView.dispose();
      killcamView.dispose();
      rope.release();
      clearFlags();
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
