import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { MODES, PROTOCOL_VERSION, type GameMode } from '../shared/config';
import { MAPS } from '../shared/map';
import { cleanText, MAX_NAME, type ServerMessage } from '../shared/protocol';
import type { BotSkill } from '../shared/bot';
import { MAIN_ROOM, type RoomInfo } from '../shared/rooms';
import type { ServerOptions } from '../shared/server';
import { Announcer } from './announcer';
import { GameAudio } from './audio';
import { Chat } from './chat';
import { startGame, type Game, type GameContext } from './game';
import { Hud, mapTitle } from './hud';
import { Input, isTyping } from './input';
import { Loopback, type NetConditions } from './net/loopback';
import { NetOverlay } from './net/netoverlay';
import type { Transport } from './net/transport';
import { WsTransport } from './net/wsclient';
import { PerfOverlay } from './perf';
import { MenuBackdrop } from './menubackdrop';
import { PostFX } from './postfx';
import { LIMITS, loadSettings, saveSettings } from './settings';

// The page: menus, settings, and the connection to a game. A session is one transport (a
// WebSocket to the server, or an in-page server for practice) and the Game for its current map,
// rebuilt whenever the server moves on to the next map.
//
// URL options, mostly for development:
//   ?net=loopback&ping=100&jitter=10&loss=0.02&bots=2   practice behind a fake network, with the N overlay
//   ?map=citadel&mode=ctf                               preselects the practice map and mode
//   ?server=ws://host:8080/ws                           plays online against another server
//   ?room=ABCDE                                         joins that room straight away (an invite link)

const params = new URLSearchParams(location.search);
const numParam = (name: string, fallback: number) => Number(params.get(name) ?? fallback) || 0;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;

type Screen = 'menu' | 'connecting' | 'game';

interface Session {
  transport: Transport;
  game: Game | null;
  id: string | null;
  joinTimer: number;
  practice: boolean;
  watch: boolean; // joined to spectate
  room: string; // MAIN_ROOM, or a room's code
}

/** The game server's WebSocket address, for a room. */
function roomUrl(room: string): string {
  const base = new URLSearchParams(location.search).get('server') ?? WsTransport.defaultUrl();
  return room === MAIN_ROOM ? base : `${base}${base.includes('?') ? '&' : '?'}room=${encodeURIComponent(room)}`;
}

/** Where the game server's HTTP endpoints (/rooms) are: this page's origin, or the ?server one's. */
function apiBase(): string {
  const server = new URLSearchParams(location.search).get('server');
  if (!server) return '';
  const url = new URL(server);
  return `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`;
}

async function main() {
  const canvas = $<HTMLCanvasElement>('game');
  const menu = $('menu');
  const pause = $('pause');
  const connecting = $('connecting');
  const hudRoot = $('hud');
  const menuError = $('menu-error');
  const nameInput = $<HTMLInputElement>('name-input');
  const onlineButton = $<HTMLButtonElement>('play-online');
  const onlineStatus = $('online-status');
  const practiceButton = $<HTMLButtonElement>('play-practice');
  const watchButton = $<HTMLButtonElement>('watch-online');
  const practiceMode = $<HTMLSelectElement>('practice-mode');
  const practiceMap = $<HTMLSelectElement>('practice-map');
  const spectateButton = $<HTMLButtonElement>('pause-spectate');
  const roomsPanel = $('rooms');
  const roomList = $('room-list');
  const roomsError = $('rooms-error');
  const roomCode = $<HTMLInputElement>('room-code');
  const roomName = $<HTMLInputElement>('room-name');
  const roomMode = $<HTMLSelectElement>('room-mode');
  const roomMap = $<HTMLSelectElement>('room-map');
  const practiceBots = $<HTMLSelectElement>('practice-bots');
  const practiceSkill = $<HTMLSelectElement>('practice-skill');

  if (matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches) $('touch-warning').hidden = false;

  let renderer: THREE.WebGLRenderer;
  try {
    // On laptops with two GPUs this asks for the discrete one. Some browsers ignore it on Windows,
    // where the OS graphics setting for the browser decides (see the P overlay for which GPU is in use).
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch {
    showError("Your browser couldn't start WebGL, which Rocket Jump needs. Try another browser, or turn on hardware acceleration.");
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Neutral keeps the cartoon colors saturated where ACES would wash them toward grey.
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.autoClear = false;
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  window.addEventListener('resize', () => renderer.setSize(window.innerWidth, window.innerHeight, false));

  await RAPIER.init();

  const settings = loadSettings();
  const audio = new GameAudio();
  const input = new Input(canvas);
  const hud = new Hud('');
  hud.isPlaying = () => input.active;
  const announcer = new Announcer(hud, audio, '');
  const chat = new Chat(input);
  chat.onLine = () => audio.play('blip', { volume: 0.4 });
  const perf = new PerfOverlay(gpuName(renderer));
  const post = new PostFX(renderer);
  let screen: Screen = 'menu';
  let session: Session | null = null;
  const ctx: GameContext = { renderer, audio, input, hud, announcer, perf, post, settings, netOverlay: null };

  // --- settings -------------------------------------------------------------------------------

  const applySettings = () => {
    input.sensitivity = settings.sensitivity;
    input.invertY = settings.invertY;
    audio.setVolume(settings.volume);
    post.quality = settings.graphics;
    session?.game?.applySettings();
    saveSettings(settings);
  };
  const slider = (key: 'sensitivity' | 'fov' | 'volume', format: (v: number) => string) => {
    const el = $<HTMLInputElement>(`set-${key}`);
    const out = $<HTMLOutputElement>(`out-${key}`);
    Object.assign(el, { min: LIMITS[key].min, max: LIMITS[key].max, step: LIMITS[key].step });
    el.value = String(settings[key]);
    out.textContent = format(settings[key]);
    el.addEventListener('input', () => {
      settings[key] = Number(el.value);
      out.textContent = format(settings[key]);
      applySettings();
    });
  };
  slider('sensitivity', (v) => v.toFixed(2));
  slider('fov', (v) => `${v}°`);
  slider('volume', (v) => `${Math.round(v * 100)}%`);
  const graphics = $<HTMLSelectElement>('set-graphics');
  graphics.value = settings.graphics;
  graphics.addEventListener('change', () => {
    settings.graphics = graphics.value === 'low' ? 'low' : 'high';
    applySettings();
  });
  const invert = $<HTMLInputElement>('set-invert');
  invert.checked = settings.invertY;
  invert.addEventListener('change', () => {
    settings.invertY = invert.checked;
    applySettings();
  });
  const killcam = $<HTMLInputElement>('set-killcam');
  killcam.checked = settings.killcam;
  killcam.addEventListener('change', () => {
    settings.killcam = killcam.checked;
    applySettings();
  });
  applySettings();

  nameInput.value = settings.name;
  nameInput.addEventListener('input', () => {
    settings.name = cleanText(nameInput.value, MAX_NAME);
    saveSettings(settings);
  });

  const modal = (id: string, openers: string[], done: string) => {
    const el = $(id);
    for (const o of openers) $(o).addEventListener('click', () => (el.hidden = false));
    $(done).addEventListener('click', () => (el.hidden = true));
    el.addEventListener('click', (e) => {
      if (e.target === el) el.hidden = true;
    });
  };
  modal('settings', ['open-settings', 'pause-settings'], 'settings-done');
  modal('controls', ['open-controls', 'pause-controls'], 'controls-done');
  modal('rooms', ['open-rooms'], 'rooms-done');

  // --- maps for practice ------------------------------------------------------------------------

  for (const [name, def] of Object.entries(MAPS)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = def.title;
    opt.title = def.blurb;
    practiceMap.append(opt);
  }
  practiceMap.value = params.get('map') && MAPS[params.get('map')!] ? params.get('map')! : 'arena';
  for (const [mode, def] of Object.entries(MODES)) {
    const opt = document.createElement('option');
    opt.value = mode;
    opt.textContent = def.name;
    opt.title = def.blurb;
    practiceMode.append(opt);
  }
  practiceMode.value = params.get('mode') && params.get('mode')! in MODES ? params.get('mode')! : 'ffa';
  // Bots sit out races: the bot count means nothing there.
  const syncPracticeBots = () => (practiceBots.disabled = practiceMode.value === 'race');
  practiceMode.addEventListener('change', syncPracticeBots);
  syncPracticeBots();

  // --- screens ---------------------------------------------------------------------------------

  // A map drifting by behind the menu; thrown away while a game is on.
  let backdrop: MenuBackdrop | null = null;
  const show = (s: Screen) => {
    screen = s;
    if (s !== 'menu' && backdrop) {
      backdrop.dispose();
      backdrop = null;
      menu.classList.remove('backdrop');
    }
    menu.hidden = s !== 'menu';
    connecting.hidden = s !== 'connecting';
    hudRoot.hidden = s !== 'game';
    pause.hidden = s !== 'game' || input.active;
    if (s === 'menu') refreshServerStatus();
  };

  function showError(text: string) {
    menuError.textContent = text;
    menuError.hidden = !text;
  }

  let toldFree = false;
  input.onActiveChange = (active, free) => {
    if (screen === 'game') pause.hidden = active;
    if (!active) chat.close();
    // The browser wouldn't capture the mouse (an automated or embedded one): say how to play without it.
    if (active && free && !toldFree) {
      toldFree = true;
      chat.add(null, "This browser won't capture the mouse, so: arrow keys look around, click or F fires, right click or Q grapples, Esc pauses.");
    }
  };
  /** Starts play. `clicked`: the player asked for it, so play even if the mouse can't be captured. */
  const play = (clicked = true) => {
    audio.resume();
    void input.start(clicked);
  };
  $('resume').addEventListener('click', () => play());
  pause.addEventListener('click', (e) => {
    if (e.target === pause) play();
  });
  $('leave').addEventListener('click', () => leave(''));
  $('connecting-cancel').addEventListener('click', () => leave(''));

  document.addEventListener('keydown', (e) => {
    if (isTyping(e.target)) return;
    if (e.code === 'KeyM' && screen === 'game') $('mute').textContent = audio.toggleMute() ? 'Sound off (M)' : '';
    // Watching: J joins the game.
    if (e.code === 'KeyJ' && screen === 'game' && session?.game?.spectator) session.transport.send({ type: 'spectate', on: false });
  });
  spectateButton.addEventListener('click', () => {
    const s = session;
    if (!s?.game) return;
    s.transport.send({ type: 'spectate', on: !s.game.spectator });
    play();
  });

  // --- sessions --------------------------------------------------------------------------------

  const joinMessage = (watch: boolean) => ({ type: 'join' as const, name: settings.name, version: PROTOCOL_VERSION, spectate: watch });

  function begin(transport: Transport, practice: boolean, watch = false, room = MAIN_ROOM) {
    leave('');
    audio.resume();
    showError('');
    hud.reset();
    chat.clear();
    const s: Session = { transport, game: null, id: null, joinTimer: 0, practice, watch, room };
    roomsPanel.hidden = true;
    session = s;
    $('connecting-title').textContent = practice ? 'Starting…' : 'Connecting…';
    show('connecting');
    transport.onMessage = (msg) => {
      if (session === s) receive(s, msg);
    };
    transport.onClose = (reason) => {
      if (session === s) leave(reason);
    };
    // The join is resent until it's answered, in case the loopback's fake network loses it.
    let tries = 0;
    const sendJoin = () => {
      if (session !== s || s.id) return;
      if (++tries > 10) {
        leave("The server didn't answer. Try again in a moment.");
        return;
      }
      transport.send(joinMessage(watch));
      s.joinTimer = window.setTimeout(sendJoin, 1000);
    };
    sendJoin();
  }

  function receive(s: Session, msg: ServerMessage) {
    switch (msg.type) {
      case 'welcome': {
        const first = !s.id;
        s.id = msg.id;
        clearTimeout(s.joinTimer);
        // A new map, a new mode, or starting or stopping spectating: a fresh game.
        const g = s.game;
        if (!g || g.map !== msg.map || g.mode !== msg.mode || g.spectator !== msg.spectator) {
          const seq = g?.client.lastSeq ?? 0;
          g?.dispose();
          hud.reset();
          s.game = startGame(ctx, { map: msg.map, mode: msg.mode, localId: msg.id, transport: s.transport, startSeq: seq, spectator: msg.spectator });
          s.game.client.match = msg.match;
        }
        spectateButton.textContent = msg.spectator ? 'Join the game' : 'Spectate';
        chat.send = (text) => s.transport.send({ type: 'chat', text });
        if (first) {
          show('game');
          play(false); // joining isn't a click: without the lock, the pause screen asks for one
          $('pause-hint').textContent = s.practice ? 'Practice keeps going while you are away.' : "You're still in the match while you're away.";
          // In an opened room: its code, and a link to send people.
          $('pause-room').hidden = s.practice || s.room === MAIN_ROOM;
          $('pause-room-name').textContent = `Room ${s.room}`;
          if (!s.practice && s.room !== MAIN_ROOM) chat.add(null, `You're in room ${s.room}. Friends join with that code, or the invite link in the Esc menu.`);
          if (!s.practice) chat.add(null, `Welcome to Rocket Jump: ${MODES[msg.mode].name} on ${mapTitle(msg.map)}. ${goalText(msg.mode, msg.match.scoreLimit)} T to chat.`);
        }
        break;
      }
      case 'rejected':
        leave(msg.reason);
        break;
      case 'ping':
        s.transport.send({ type: 'pong', t: msg.t });
        break;
      case 'chat':
        if (msg.id === null) chat.add(null, msg.text);
        else chat.add(msg.name, msg.text, msg.id === s.id);
        break;
      case 'snapshot':
        s.game?.receive(msg);
        break;
    }
  }

  function leave(error: string) {
    const s = session;
    session = null;
    chat.send = null;
    if (s) {
      clearTimeout(s.joinTimer);
      s.transport.onClose = () => {};
      s.transport.close();
      s.game?.dispose();
      renderer.clear();
    }
    input.stop();
    hud.reset();
    chat.clear();
    show('menu');
    showError(error);
  }

  const joinRoom = (room: string, watch = false) => begin(new WsTransport(roomUrl(room)), false, watch, room);
  onlineButton.addEventListener('click', () => joinRoom(MAIN_ROOM));
  watchButton.addEventListener('click', () => joinRoom(MAIN_ROOM, true));

  // --- servers and rooms -----------------------------------------------------------------------

  for (const [mode, def] of Object.entries(MODES)) roomMode.append(new Option(def.name, mode));
  roomMap.append(new Option('Every map in turn', 'rotation'));
  for (const [name, def] of Object.entries(MAPS)) roomMap.append(new Option(def.title, name));
  roomMap.value = 'rotation';
  const roomsProblem = (text: string) => {
    roomsError.textContent = text;
    roomsError.hidden = !text;
  };

  /** The public rooms, refreshed every few seconds while the window is open. */
  let roomsTimer = 0;
  async function refreshRooms() {
    clearTimeout(roomsTimer);
    if (roomsPanel.hidden) return;
    try {
      const res = await fetch(`${apiBase()}/rooms`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const list = (await res.json()) as RoomInfo[];
      roomList.replaceChildren(
        ...list.map((r) => {
          const row = document.createElement('div');
          row.className = 'room';
          const what = document.createElement('div');
          what.className = 'what';
          const name = document.createElement('div');
          name.className = 'name';
          name.textContent = r.main ? `${r.name} (this server's rotation)` : r.name;
          const detail = document.createElement('div');
          detail.className = 'detail';
          const extra = [r.bots ? `${r.bots} bots` : '', r.spectators ? `${r.spectators} watching` : ''].filter(Boolean).join(' · ');
          detail.textContent = `${MODES[r.mode]?.name ?? r.mode} on ${mapTitle(r.map)} · ${r.players}/${r.maxPlayers} playing${extra ? ` · ${extra}` : ''}`;
          what.append(name, detail);
          const join = document.createElement('button');
          join.textContent = r.players >= r.maxPlayers ? 'Queue' : 'Join';
          join.addEventListener('click', () => joinRoom(r.code));
          const watch = document.createElement('button');
          watch.className = 'ghost';
          watch.textContent = 'Watch';
          watch.addEventListener('click', () => joinRoom(r.code, true));
          row.append(what, join, watch);
          return row;
        }),
      );
      roomsProblem('');
    } catch {
      roomList.replaceChildren();
      roomsProblem("Couldn't reach the server for its rooms. Practice is still available.");
    }
    roomsTimer = window.setTimeout(refreshRooms, 3000);
  }
  $('open-rooms').addEventListener('click', () => {
    roomName.value ||= settings.name ? `${settings.name}'s room` : '';
    void refreshRooms();
  });

  const joinByCode = (watch: boolean) => {
    const code = roomCode.value.trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code)) return roomsProblem('A room code is five letters and numbers.');
    joinRoom(code, watch);
  };
  $('room-join').addEventListener('click', () => joinByCode(false));
  $('room-watch').addEventListener('click', () => joinByCode(true));
  roomCode.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinByCode(false);
  });

  $('room-create').addEventListener('click', async () => {
    const request = {
      name: roomName.value,
      mode: roomMode.value,
      map: roomMap.value,
      bots: Number($<HTMLSelectElement>('room-bots').value),
      skill: $<HTMLSelectElement>('room-skill').value,
      private: $<HTMLInputElement>('room-private').checked,
    };
    try {
      const res = await fetch(`${apiBase()}/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
      const answer = (await res.json()) as { code?: string; error?: string };
      if (!res.ok || !answer.code) return roomsProblem(answer.error ?? "The server couldn't open a room.");
      joinRoom(answer.code);
    } catch {
      roomsProblem("Couldn't reach the server to open a room.");
    }
  });

  $('copy-invite').addEventListener('click', async () => {
    const s = session;
    if (!s) return;
    const link = new URL(location.href);
    link.search = '';
    if (params.get('server')) link.searchParams.set('server', params.get('server')!);
    link.searchParams.set('room', s.room);
    const button = $('copy-invite');
    try {
      await navigator.clipboard.writeText(link.toString());
      button.textContent = 'Copied!';
    } catch {
      button.textContent = link.toString(); // no clipboard (an insecure origin): show it to copy by hand
    }
    setTimeout(() => (button.textContent = 'Copy invite link'), 2500);
  });

  const startPractice = (conditions: NetConditions, bots: number) => {
    const mode = practiceMode.value as GameMode;
    const options: Partial<ServerOptions> = { maps: [practiceMap.value], mode, minPlayers: bots + 1, maxPlayers: 1, botSkill: practiceSkill.value as BotSkill };
    const loopback = new Loopback(conditions, 'player', options);
    if (params.get('net') === 'loopback') ctx.netOverlay ??= new NetOverlay(loopback, null!);
    begin(loopback, true);
  };
  practiceButton.addEventListener('click', () => startPractice({ ping: 0, jitter: 0, loss: 0 }, Number(practiceBots.value)));

  // Server status on the menu: whether it's up, and who's on.
  let statusTimer = 0;
  async function refreshServerStatus() {
    clearTimeout(statusTimer);
    if (screen !== 'menu') return;
    if (params.get('server')) {
      onlineButton.disabled = watchButton.disabled = false;
      onlineStatus.textContent = params.get('server')!;
      return;
    }
    try {
      const res = await fetch('/status', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const status = (await res.json()) as { map: string; mode?: GameMode; players: string[]; maxPlayers: number; match: { phase: string } };
      const n = status.players.length;
      const where = `${status.mode && status.mode in MODES ? `${MODES[status.mode].name} on ` : ''}${mapTitle(status.map)}`;
      // A full server still lets you in: you watch until a place comes free.
      onlineButton.disabled = false;
      watchButton.disabled = false;
      onlineStatus.textContent =
        n === 0 ? `${where} · nobody on yet, bots will fill in` : `${where} · ${n}/${status.maxPlayers} playing${n >= status.maxPlayers ? ' (full: you can watch)' : ''}`;
    } catch {
      onlineButton.disabled = watchButton.disabled = true;
      onlineStatus.textContent = 'Server offline. Practice is still available.';
    }
    statusTimer = window.setTimeout(refreshServerStatus, 5000);
  }

  practiceButton.disabled = false;
  show('menu');

  // --- frame loop -----------------------------------------------------------------------------

  let lastFrame = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(Math.max((now - lastFrame) / 1000, 0), 0.1);
    lastFrame = now;
    const s = session;
    if (s) {
      s.transport.update(now);
      s.game?.frame(now);
    } else if (screen === 'menu') {
      // Built here rather than in show(), so starting a game doesn't make one only to drop it.
      if (!backdrop) {
        backdrop = new MenuBackdrop(renderer, post);
        menu.classList.add('backdrop');
      }
      backdrop.frame(dt);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  if (params.get('net') === 'loopback') {
    startPractice({ ping: numParam('ping', 100), jitter: numParam('jitter', 10), loss: numParam('loss', 0) }, numParam('bots', 2));
  } else if (params.get('room')) {
    // An invite link: straight into the room (the pause screen asks for a click to grab the mouse).
    joinRoom(params.get('room')!.trim().toUpperCase());
  }

  if (import.meta.env.DEV) Object.assign(window, { rj: { get session() { return session; }, frame, settings, hud, input } });
}

/** "First to 20 wins." and the like, for the welcome line. */
function goalText(mode: GameMode, limit: number): string {
  if (mode === 'race') return 'Best lap wins: fly through the rings in order, E to restart.';
  if (mode === 'ctf') return `First team to ${limit} captures wins.`;
  if (mode === 'tdm') return `First team to ${limit} kills wins.`;
  return `First to ${limit} wins.`;
}

function gpuName(renderer: THREE.WebGLRenderer): string {
  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown GPU';
  // "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x...) Direct3D11 ...)" -> the readable part.
  return name.match(/ANGLE \([^,]+, (.+?)(?: \(0x[0-9A-Fa-f]+\))? Direct3D/)?.[1] ?? name;
}

main();
