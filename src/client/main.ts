// First: the colorblind palette has to be in place before any module bakes team colors into materials.
import { PALETTE } from './palette';
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { MODES, PROTOCOL_VERSION, type GameMode } from '../shared/config';
import { MAPS, PLAYABLE_MAPS } from '../shared/map';
import { sanitizeMap } from '../shared/custommap';
import { cleanText, MAX_NAME, type ServerMessage } from '../shared/protocol';
import type { BotSkill } from '../shared/bot';
import { MAIN_ROOM, type RoomInfo } from '../shared/rooms';
import type { ServerOptions } from '../shared/server';
import { Announcer } from './announcer';
import { GameAudio } from './audio';
import { Chat } from './chat';
import { startGame, type Game, type GameContext } from './game';
import { Hud, mapTitle } from './hud';
import { ACTIONS, DEFAULT_BINDS, Input, isTyping, keyName, type Action } from './input';
import { Loopback, type NetConditions } from './net/loopback';
import { ReconnectingTransport } from './net/reconnect';
import { NetOverlay } from './net/netoverlay';
import type { Transport } from './net/transport';
import { WsTransport } from './net/wsclient';
import { PerfOverlay } from './perf';
import { MapEditor } from './editor';
import { decodeMapCode } from '../shared/custommap';
import { profileKey, ProfilePanel } from './profile';
import { hasTrained } from './tutorial';
import { isTouchDevice, TouchControls } from './touch';
import { MenuBackdrop } from './menubackdrop';
import { PostFX } from './postfx';
import { hasSavedSettings, LIMITS, loadSettings, saveSettings, type CrosshairStyle } from './settings';

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

type Screen = 'menu' | 'connecting' | 'game' | 'editor';

interface Session {
  transport: Transport;
  game: Game | null;
  id: string | null;
  joinTimer: number;
  practice: boolean;
  watch: boolean; // joined to spectate
  room: string; // MAIN_ROOM, or a room's code
  token: string | null; // from the server's welcome: a different one means a fresh start (the server restarted)
  muted: Set<string>; // players whose chat we hide (/mute)
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

/** Tells the server what someone did in the menus (for its owner's numbers; see server/analytics.ts). */
function track(name: string) {
  void fetch(`${apiBase()}/event`, { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }).catch(() => {});
}

/** Round trip to a server's /health, the best of three (ms), or null if it doesn't answer. */
async function pingServer(base: string): Promise<number | null> {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    try {
      await fetch(`${base}/health`, { cache: 'no-store', mode: base ? 'cors' : 'same-origin' });
    } catch {
      return null;
    }
    best = Math.min(best, performance.now() - t0);
  }
  return Math.round(best);
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

  const touchDevice = isTouchDevice();
  if (touchDevice) $('touch-warning').hidden = false;
  track('visit');
  if (touchDevice) track('touch-device');
  let trained = hasTrained();

  let renderer: THREE.WebGLRenderer;
  try {
    // On laptops with two GPUs this asks for the discrete one. Some browsers ignore it on Windows,
    // where the OS graphics setting for the browser decides (see the P overlay for which GPU is in use).
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch {
    showError("Your browser couldn't start WebGL, which Rocket Jump needs. Try another browser, or turn on hardware acceleration.");
    return;
  }
  // Phones have very dense screens and modest GPUs: a lower resolution keeps the frame rate up.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, touchDevice ? 1.5 : 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Neutral keeps the cartoon colors saturated where ACES would wash them toward grey.
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.autoClear = false;
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  window.addEventListener('resize', () => renderer.setSize(window.innerWidth, window.innerHeight, false));

  await RAPIER.init();

  const settings = loadSettings();
  // First visit on a phone: start on the lighter graphics.
  if (touchDevice && !hasSavedSettings()) settings.graphics = 'low';
  const audio = new GameAudio();
  const input = new Input(canvas);
  const hud = new Hud('');
  hud.isPlaying = () => input.active;
  const touch = new TouchControls(input);
  if (touchDevice) input.device = 'touch';
  input.onPadBoard = (held) => hud.showBoard(held && input.active);
  const announcer = new Announcer(hud, audio, '');
  const chat = new Chat(input);
  chat.onLine = () => audio.play('blip', { volume: 0.4 });
  const perf = new PerfOverlay(gpuName(renderer));
  const post = new PostFX(renderer);
  let screen: Screen = 'menu';
  let session: Session | null = null;
  let editor: MapEditor | undefined; // (made further down, once the page's pieces exist)
  const ctx: GameContext = { renderer, audio, input, hud, announcer, perf, post, settings, netOverlay: null };

  // --- settings -------------------------------------------------------------------------------

  const crosshairSample = $('crosshair-sample');
  const applySettings = () => {
    input.sensitivity = settings.sensitivity;
    input.padSensitivity = settings.padSensitivity;
    input.invertY = settings.invertY;
    input.binds = settings.binds;
    touch.setLayout(settings.touchLayout);
    audio.setVolume(settings.volume);
    post.quality = settings.graphics;
    const root = document.documentElement.style;
    root.setProperty('--ch-color', settings.crosshairColor);
    root.setProperty('--ch-size', String(settings.crosshairSize));
    root.setProperty('--ch-grapple', PALETTE.grapple);
    for (const el of [$('crosshair'), crosshairSample]) el.dataset.style = settings.crosshairStyle;
    showKeys();
    session?.game?.applySettings();
    saveSettings(settings);
  };
  /** The keys on the HUD's weapon list, for whatever's bound (or the gamepad, if that's in use). */
  let shownDevice = '';
  const showKeys = () => {
    shownDevice = input.device;
    $('key-fire').textContent = input.label('fire');
    $('key-grapple').textContent = input.label('grapple');
  };
  const slider = (key: 'sensitivity' | 'padSensitivity' | 'fov' | 'volume' | 'crosshairSize', format: (v: number) => string) => {
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
  slider('padSensitivity', (v) => v.toFixed(2));
  slider('fov', (v) => `${v}°`);
  slider('volume', (v) => `${Math.round(v * 100)}%`);
  slider('crosshairSize', (v) => `${v.toFixed(1)}x`);
  const touchLayout = $<HTMLSelectElement>('set-touchLayout');
  touchLayout.value = settings.touchLayout;
  touchLayout.addEventListener('change', () => {
    settings.touchLayout = touchLayout.value === 'left' ? 'left' : 'right';
    applySettings();
  });
  const graphics = $<HTMLSelectElement>('set-graphics');
  graphics.value = settings.graphics;
  graphics.addEventListener('change', () => {
    settings.graphics = graphics.value === 'low' ? 'low' : 'high';
    applySettings();
  });
  const checkbox = (id: string, key: 'invertY' | 'killcam' | 'hints' | 'colorblind', changed?: () => void) => {
    const el = $<HTMLInputElement>(id);
    el.checked = settings[key];
    el.addEventListener('change', () => {
      settings[key] = el.checked;
      applySettings();
      changed?.();
    });
  };
  checkbox('set-invert', 'invertY');
  checkbox('set-killcam', 'killcam');
  checkbox('set-hints', 'hints');
  checkbox('set-colorblind', 'colorblind', () => ($('colorblind-note').hidden = settings.colorblind === PALETTE.colorblind));
  const crosshairStyle = $<HTMLSelectElement>('set-crosshairStyle');
  crosshairStyle.value = settings.crosshairStyle;
  crosshairStyle.addEventListener('change', () => {
    settings.crosshairStyle = crosshairStyle.value as CrosshairStyle;
    applySettings();
  });
  const crosshairColor = $<HTMLInputElement>('set-crosshairColor');
  crosshairColor.value = settings.crosshairColor;
  $('out-crosshairColor').textContent = settings.crosshairColor;
  crosshairColor.addEventListener('input', () => {
    settings.crosshairColor = crosshairColor.value;
    $('out-crosshairColor').textContent = settings.crosshairColor;
    applySettings();
  });

  // Settings tabs.
  for (const tab of document.querySelectorAll<HTMLElement>('#settings .tab')) {
    tab.addEventListener('click', () => {
      for (const t of document.querySelectorAll<HTMLElement>('#settings .tab')) t.classList.toggle('active', t === tab);
      for (const pane of document.querySelectorAll<HTMLElement>('#settings .tab-pane')) pane.hidden = pane.dataset.pane !== tab.dataset.tab;
      input.capture = null;
    });
  }

  // Key bindings: each action's keys as buttons; click one (or +) and press what should do it.
  const bindsEl = $('binds');
  const renderBinds = () => {
    bindsEl.replaceChildren(
      ...ACTIONS.map(({ id, label }) => {
        const row = document.createElement('div');
        row.className = 'bind-row';
        const name = document.createElement('span');
        name.textContent = label;
        const keys = document.createElement('div');
        keys.className = 'bind-keys';
        const slots = settings.binds[id];
        for (let i = 0; i <= Math.min(slots.length, 3); i++) {
          const b = document.createElement('button');
          b.className = i < slots.length ? 'ghost' : 'ghost add';
          b.textContent = i < slots.length ? keyName(slots[i]) : '+';
          b.title = i < slots.length ? 'Click, then press a new key (Backspace clears)' : 'Add a key';
          b.addEventListener('click', () => listen(id, i));
          keys.append(b);
        }
        row.append(name, keys);
        return row;
      }),
    );
  };
  const listen = (action: Action, slot: number) => {
    renderBinds();
    const row = bindsEl.querySelectorAll<HTMLElement>('.bind-row')[ACTIONS.findIndex((a) => a.id === action)];
    const button = row.querySelectorAll<HTMLButtonElement>('button')[slot];
    button.textContent = 'Press a key…';
    button.classList.add('listening');
    input.capture = (code) => {
      const list = settings.binds[action];
      if (code === 'Backspace' || code === 'Delete') list.splice(slot, 1);
      else if (code !== 'Escape') {
        // One key, one job (Shift can grapple on foot and descend in a helicopter: that pair may share).
        for (const { id } of ACTIONS) {
          const pair = (id === 'grapple' && action === 'down') || (id === 'down' && action === 'grapple');
          if (id !== action && !pair) settings.binds[id] = settings.binds[id].filter((c) => c !== code);
        }
        list[slot] = code;
        settings.binds[action] = [...new Set(list.filter(Boolean))];
      }
      applySettings();
      renderBinds();
    };
  };
  renderBinds();
  $('binds-reset').addEventListener('click', () => {
    settings.binds = structuredClone(DEFAULT_BINDS);
    applySettings();
    renderBinds();
  });
  $('settings-done').addEventListener('click', () => (input.capture = null));
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
  modal('profile', ['open-profile'], 'profile-done');
  const showLevel = (level: number) => {
    const chip = $('menu-level');
    chip.hidden = level <= 1;
    chip.textContent = `Level ${level}`;
  };
  const profilePanel = new ProfilePanel(apiBase, showLevel);
  // Back from signing in with Discord, or from buying a skin.
  void profilePanel.handleReturn();
  $('open-profile').addEventListener('click', () => {
    track('profile-open');
    void profilePanel.open();
  });
  $('open-settings').addEventListener('click', () => track('settings-open'));

  // --- maps for practice ------------------------------------------------------------------------

  for (const name of PLAYABLE_MAPS) {
    const def = MAPS[name];
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = def.title;
    opt.title = def.blurb;
    practiceMap.append(opt);
  }
  practiceMap.value = params.get('map') && PLAYABLE_MAPS.includes(params.get('map')!) ? params.get('map')! : 'arena';
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
    if (s !== 'editor' && editor?.isOpen) editor.close();
    connecting.hidden = s !== 'connecting';
    hudRoot.hidden = s !== 'game';
    pause.hidden = s !== 'game' || input.active;
    if (s === 'menu') {
      refreshServerStatus();
      $('play-training').classList.toggle('new', !hasTrained());
      if (!trained && hasTrained()) track('training-complete');
      trained = hasTrained();
    }
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
    if (active && free && !toldFree && input.device === 'keyboard') {
      toldFree = true;
      chat.add(null, "This browser won't capture the mouse, so: arrow keys look around, click or F fires, right click or Q grapples, Esc pauses.");
    }
  };
  /** Starts play. `clicked`: the player asked for it, so play even if the mouse can't be captured. */
  const play = (clicked = true) => {
    audio.resume();
    // On a phone: the whole screen, sideways, if the browser lets us.
    if (clicked && input.device === 'touch' && !document.fullscreenElement) {
      void document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })
        .then(() => (window.screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape'))
        .catch(() => {});
    }
    void input.start(clicked);
  };
  $('resume').addEventListener('click', () => play());
  touch.onBoard = (held) => hud.showBoard(held);
  touch.onChat = () => chat.send && chat.open();
  touch.onPause = () => input.stop();
  pause.addEventListener('click', (e) => {
    if (e.target === pause) play();
  });
  $('leave').addEventListener('click', () => leave(''));
  $('connecting-cancel').addEventListener('click', () => leave(''));

  document.addEventListener('keydown', (e) => {
    if (isTyping(e.target)) return;
    if (e.code === 'KeyM' && screen === 'game') $('mute').textContent = audio.toggleMute() ? 'Sound off (M)' : '';
    if (e.code === 'KeyK' && screen === 'game' && session?.game) {
      const saved = session.game.saveClip();
      if (saved) track('clip-saved');
      chat.add(null, saved ? 'Replay saved to your downloads.' : 'No replay to save yet: they come from the killcam and the play of the match.');
    }
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

  /** The join for a session. Online games carry the profile key, so they count toward XP and stats. */
  const joinMessage = (watch: boolean, online = true) => {
    const key = online ? profileKey() : null;
    return { type: 'join' as const, name: settings.name, version: PROTOCOL_VERSION, spectate: watch, ...(key ? { profile: key } : {}) };
  };

  function begin(transport: Transport, practice: boolean, watch = false, room = MAIN_ROOM) {
    leave('');
    audio.resume();
    showError('');
    hud.reset();
    chat.clear();
    const s: Session = { transport, game: null, id: null, joinTimer: 0, practice, watch, room, token: null, muted: new Set() };
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
      transport.send(joinMessage(watch, !practice));
      s.joinTimer = window.setTimeout(sendJoin, 1000);
    };
    sendJoin();
  }

  function receive(s: Session, msg: ServerMessage) {
    switch (msg.type) {
      case 'welcome': {
        const first = !s.id;
        // A room on a map made in the editor: the map comes with the welcome.
        if (msg.custom) {
          const map = sanitizeMap(msg.custom);
          if (map) MAPS[msg.map] = map;
        }
        // Reconnected to a server that had forgotten us (it restarted): we're someone new there.
        const restarted = !first && !!msg.token && !!s.token && msg.token !== s.token;
        if (restarted) chat.add(null, 'The server restarted, so this is a new match.');
        s.id = msg.id;
        s.token = msg.token ?? s.token;
        clearTimeout(s.joinTimer);
        // A new map, a new mode, or starting or stopping spectating: a fresh game.
        const g = s.game;
        if (!g || restarted || g.map !== msg.map || g.mode !== msg.mode || g.spectator !== msg.spectator) {
          const seq = g?.client.lastSeq ?? 0;
          g?.dispose();
          hud.reset();
          s.game = startGame(ctx, { map: msg.map, mode: msg.mode, localId: msg.id, transport: s.transport, startSeq: seq, spectator: msg.spectator, apiBase: s.practice ? null : apiBase() });
          s.game.client.match = msg.match;
        }
        spectateButton.textContent = msg.spectator ? 'Join the game' : 'Spectate';
        chat.send = (text) => {
          if (!localCommand(s, text)) s.transport.send({ type: 'chat', text });
        };
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
        if (msg.id !== null && s.muted.has(msg.id)) break;
        if (msg.id === null) chat.add(null, msg.text);
        else chat.add(msg.name, msg.text, msg.id === s.id);
        break;
      case 'snapshot':
        s.game?.receive(msg);
        break;
      case 'progress': {
        // What we just earned: a line in the corner, more for a level or a finished challenge.
        const g = msg.gain;
        hud.xpGained(g.xp, g.reasons[0]?.replace(/ \+\d+$/, '') ?? '');
        for (const c of g.completed) {
          hud.medal('CHALLENGE COMPLETE', c, 'notice', 0x7cf0a0);
          chat.add(null, `Challenge complete: ${c}`);
        }
        if (g.levelUp) {
          hud.medal(`LEVEL ${g.level}`, g.unlocked.length ? `Unlocked: ${g.unlocked.join(', ')}` : 'Level up!', 'big', 0xffb347);
          audio.play('medal', { volume: 0.8 });
          chat.add(null, `You reached level ${g.level}!${g.unlocked.length ? ` Unlocked ${g.unlocked.join(', ')}: wear it from Profile, Skins.` : ''}`);
          showLevel(g.level);
        }
        break;
      }
    }
  }

  /** Chat commands handled here rather than by the server: /mute and /unmute. True if it was one. */
  function localCommand(s: Session, text: string): boolean {
    const m = /^\/(mute|unmute)\s*(.*)$/i.exec(text.trim());
    if (!m) return false;
    const mute = m[1].toLowerCase() === 'mute';
    const want = m[2].trim().toLowerCase();
    const people = (s.game?.client.scores ?? []).filter((p) => !p.bot && p.id !== s.id);
    if (!want) {
      const muted = people.filter((p) => s.muted.has(p.id)).map((p) => p.name);
      chat.add(null, muted.length ? `Muted: ${muted.join(', ')}. /unmute and a name to hear them again.` : 'Nobody is muted. /mute and a name hides their chat from you.');
      return true;
    }
    const exact = people.filter((p) => p.name.toLowerCase() === want);
    const found = exact.length ? exact : people.filter((p) => p.name.toLowerCase().startsWith(want));
    if (found.length !== 1) {
      chat.add(null, `Nobody (or more than one person) here is called "${m[2].trim()}".`);
      return true;
    }
    if (mute) s.muted.add(found[0].id);
    else s.muted.delete(found[0].id);
    chat.add(null, mute ? `Muted ${found[0].name}: you won't see their chat. /unmute ${found[0].name} to undo.` : `Unmuted ${found[0].name}.`);
    return true;
  }

  function leave(error: string) {
    const s = session;
    session = null;
    // Back from playing a map in the editor: back to the editor.
    if (backToEditor) {
      backToEditor = false;
      s?.transport.close();
      s?.game?.dispose();
      input.stop();
      hud.reset();
      chat.clear();
      openEditor();
      return;
    }
    $('reconnecting').hidden = true;
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

  const joinRoom = (room: string, watch = false) => {
    const transport = new ReconnectingTransport(roomUrl(room), () => joinMessage(session?.game?.spectator ?? watch));
    transport.onReconnecting = (on) => ($('reconnecting').hidden = !on);
    begin(transport, false, watch, room);
  };
  onlineButton.addEventListener('click', () => {
    track('online-start');
    joinRoom(MAIN_ROOM);
  });
  watchButton.addEventListener('click', () => joinRoom(MAIN_ROOM, true));

  // --- servers and rooms -----------------------------------------------------------------------

  for (const [mode, def] of Object.entries(MODES)) roomMode.append(new Option(def.name, mode));
  roomMap.append(new Option('Every map in turn', 'rotation'));
  for (const name of PLAYABLE_MAPS) roomMap.append(new Option(MAPS[name].title, name));
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
          detail.textContent = `${MODES[r.mode]?.name ?? r.mode} on ${r.mapTitle ?? mapTitle(r.map)} · ${r.players}/${r.maxPlayers} playing${extra ? ` · ${extra}` : ''}`;
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
    void refreshServers();
  });

  /** This server and the others it knows of, each with its ping and who's on. */
  async function refreshServers() {
    const list = $('server-list');
    const here = apiBase();
    let others: { name: string; url: string }[] = [];
    let region = '';
    try {
      const res = await fetch(`${here}/servers`, { cache: 'no-store' });
      const body = (await res.json()) as { region: string; servers: { name: string; url: string }[] };
      others = body.servers.filter((s) => new URL(s.url).host !== location.host);
      region = body.region;
    } catch {
      // an older server: just this one
    }
    const row = (name: string, detail: string, ping: number | null, url: string | null) => {
      const div = document.createElement('div');
      div.className = 'room';
      const what = document.createElement('div');
      what.className = 'what';
      const n = document.createElement('div');
      n.className = 'name';
      n.textContent = name;
      const d = document.createElement('div');
      d.className = 'detail';
      d.textContent = detail;
      what.append(n, d);
      const p = document.createElement('div');
      p.className = `ping ${ping === null ? 'bad' : ping < 80 ? 'good' : ping < 160 ? 'ok' : 'bad'}`;
      p.textContent = ping === null ? 'offline' : `${ping} ms`;
      div.append(what, p);
      if (url) {
        const go = document.createElement('button');
        go.textContent = 'Go there';
        go.addEventListener('click', () => (location.href = url));
        div.append(go);
      }
      return div;
    };
    const rows = [row(`This server${region ? ` · ${region}` : ''}`, 'Rooms below', await pingServer(here), null)];
    list.replaceChildren(...rows);
    for (const s of others) {
      const [ping, status] = await Promise.all([
        pingServer(s.url),
        fetch(`${s.url}/status`, { cache: 'no-store' })
          .then((r) => r.json() as Promise<{ players: string[]; region?: string; map: string; mode: GameMode }>)
          .catch(() => null),
      ]);
      const detail = status ? `${status.region ? `${status.region} · ` : ''}${status.players.length} playing · ${MODES[status.mode]?.name ?? ''} on ${mapTitle(status.map)}` : "Didn't answer";
      rows.push(row(s.name, detail, ping, status ? s.url : null));
      list.replaceChildren(...rows);
    }
  }

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
  practiceButton.addEventListener('click', () => {
    track('practice-start');
    startPractice({ ping: 0, jitter: 0, loss: 0 }, Number(practiceBots.value));
  });
  // Training: the course, alone, as a race nobody else is in.
  const trainingButton = $<HTMLButtonElement>('play-training');
  trainingButton.classList.toggle('new', !hasTrained());
  trainingButton.addEventListener('click', () => {
    track('training-start');
    const options: Partial<ServerOptions> = { maps: ['training'], mode: 'race', minPlayers: 0, maxPlayers: 1, timeLimit: 60 * 60 };
    begin(new Loopback({ ping: 0, jitter: 0, loss: 0 }, 'player', options), true);
  });

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

  // --- the map editor --------------------------------------------------------------------------

  /**
   * Whether players can open the editor. Off for now: the menu button is hidden and shared map links
   * don't open it. Dev builds (npm run dev) keep it, to go on working on it.
   */
  const EDITOR_ENABLED = import.meta.env.DEV;
  let backToEditor = false;
  const editorMode = $<HTMLSelectElement>('editor-mode');
  for (const [mode, def] of Object.entries(MODES)) editorMode.append(new Option(def.name, mode));
  editor = new MapEditor(renderer, post, {
    test(map) {
      track('editor-test');
      MAPS['custom-local'] = map;
      const bots = Number($<HTMLSelectElement>('editor-bots').value);
      const options: Partial<ServerOptions> = { maps: ['custom-local'], mode: editorMode.value as GameMode, minPlayers: bots + 1, maxPlayers: 1, botSkill: 'easy' };
      editor!.close();
      begin(new Loopback({ ping: 0, jitter: 0, loss: 0 }, 'player', options), true);
      backToEditor = true;
    },
    async host(map) {
      track('editor-host');
      const request = { name: map.title, mode: editorMode.value, map: 'custom', custom: map, bots: Number($<HTMLSelectElement>('editor-bots').value) ? 4 : 0, skill: 'auto', private: false };
      try {
        const res = await fetch(`${apiBase()}/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
        const answer = (await res.json()) as { code?: string; error?: string };
        if (!res.ok || !answer.code) return alert(answer.error ?? "The server couldn't open a room.");
        editor!.close();
        joinRoom(answer.code);
      } catch {
        alert("Couldn't reach the server to open a room.");
      }
    },
    exit() {
      editor!.close();
      show('menu');
    },
  });
  const openEditor = (map?: import('../shared/map').MapDef) => {
    show('editor');
    editor!.open(map);
  };
  $('open-editor').hidden = !EDITOR_ENABLED;
  $('open-editor').addEventListener('click', () => {
    track('editor-open');
    openEditor();
  });

  practiceButton.disabled = false;
  show('menu');
  // A shared map link: straight into the editor with it.
  if (params.get('mapcode') && !EDITOR_ENABLED) showError("Shared maps aren't open yet. Check back soon!");
  else if (params.get('mapcode')) {
    void decodeMapCode(params.get('mapcode')!).then((map) => {
      if (map) openEditor(map);
      else showError("That map link is broken (it may have been cut short when it was copied).");
    });
  }
  // The level badge by the name, if this browser has played online before.
  {
    const key = profileKey();
    if (key) {
      void fetch(`${apiBase()}/profile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) })
        .then((r) => (r.ok ? r.json() : null))
        .then((v: { level?: number } | null) => v?.level && showLevel(v.level))
        .catch(() => {});
    }
  }

  // --- frame loop -----------------------------------------------------------------------------

  let padTracked = false;
  let lastFrame = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(Math.max((now - lastFrame) / 1000, 0), 0.1);
    lastFrame = now;
    const s = session;
    input.pollPad(screen === 'game');
    if (input.device === 'pad' && !padTracked) {
      padTracked = true;
      track('gamepad');
    }
    touch.setVisible(screen === 'game' && input.active && input.device === 'touch' && !chat.isOpen);
    touch.setVehicle(input.vehicleMode);
    if (input.device !== shownDevice) showKeys();
    if (s) {
      s.transport.update(now);
      s.game?.frame(now);
    } else if (screen === 'editor') {
      editor?.frame(dt);
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
  if (mode === 'koth') return `Stand on the hill alone to score: first to ${limit} seconds wins.`;
  if (mode === 'elim') return `No respawns until the round is over: first team to ${limit} rounds wins.`;
  if (mode === 'instagib') return `One hit kills. First to ${limit} wins.`;
  if (mode === 'duel') return `One on one, first to ${limit}. The winner stays on.`;
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
