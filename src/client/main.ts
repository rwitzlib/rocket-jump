import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { PROTOCOL_VERSION } from '../shared/config';
import { MAPS } from '../shared/map';
import { cleanText, MAX_NAME, type ServerMessage } from '../shared/protocol';
import type { BotSkill } from '../shared/bot';
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
import { LIMITS, loadSettings, saveSettings } from './settings';

// The page: menus, settings, and the connection to a game. A session is one transport (a
// WebSocket to the server, or an in-page server for practice) and the Game for its current map,
// rebuilt whenever the server moves on to the next map.
//
// URL options, mostly for development:
//   ?net=loopback&ping=100&jitter=10&loss=0.02&bots=2   practice behind a fake network, with the N overlay
//   ?map=citadel                                        preselects the practice map
//   ?server=ws://host:8080/ws                           plays online against another server

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
  const practiceMap = $<HTMLSelectElement>('practice-map');
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
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.autoClear = false;
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  window.addEventListener('resize', () => renderer.setSize(window.innerWidth, window.innerHeight, false));

  await RAPIER.init();

  const settings = loadSettings();
  const audio = new GameAudio();
  const input = new Input(canvas);
  const hud = new Hud('');
  const announcer = new Announcer(hud, audio, '');
  const chat = new Chat(input);
  chat.onLine = () => audio.play('blip', { volume: 0.4 });
  const perf = new PerfOverlay(gpuName(renderer));
  let screen: Screen = 'menu';
  let session: Session | null = null;
  const ctx: GameContext = { renderer, audio, input, hud, announcer, perf, settings, netOverlay: null };

  // --- settings -------------------------------------------------------------------------------

  const applySettings = () => {
    input.sensitivity = settings.sensitivity;
    input.invertY = settings.invertY;
    audio.setVolume(settings.volume);
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
  const invert = $<HTMLInputElement>('set-invert');
  invert.checked = settings.invertY;
  invert.addEventListener('change', () => {
    settings.invertY = invert.checked;
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

  // --- maps for practice ------------------------------------------------------------------------

  for (const [name, def] of Object.entries(MAPS)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = def.title;
    opt.title = def.blurb;
    practiceMap.append(opt);
  }
  practiceMap.value = params.get('map') && MAPS[params.get('map')!] ? params.get('map')! : 'arena';

  // --- screens ---------------------------------------------------------------------------------

  const show = (s: Screen) => {
    screen = s;
    menu.hidden = s !== 'menu';
    connecting.hidden = s !== 'connecting';
    hudRoot.hidden = s !== 'game';
    pause.hidden = s !== 'game' || input.locked;
    if (s === 'menu') refreshServerStatus();
  };

  function showError(text: string) {
    menuError.textContent = text;
    menuError.hidden = !text;
  }

  input.onLockChange = (locked) => {
    if (screen === 'game') pause.hidden = locked;
    if (!locked) chat.close();
  };
  const play = () => {
    audio.resume();
    void input.lock();
  };
  $('resume').addEventListener('click', play);
  pause.addEventListener('click', (e) => {
    if (e.target === pause) play();
  });
  $('leave').addEventListener('click', () => leave(''));
  $('connecting-cancel').addEventListener('click', () => leave(''));

  document.addEventListener('keydown', (e) => {
    if (isTyping(e.target)) return;
    if (e.code === 'KeyM' && screen === 'game') $('mute').textContent = audio.toggleMute() ? 'Sound off (M)' : '';
  });

  // --- sessions --------------------------------------------------------------------------------

  const joinMessage = () => ({ type: 'join' as const, name: settings.name, version: PROTOCOL_VERSION });

  function begin(transport: Transport, practice: boolean) {
    leave('');
    audio.resume();
    showError('');
    hud.reset();
    chat.clear();
    const s: Session = { transport, game: null, id: null, joinTimer: 0, practice };
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
      transport.send(joinMessage());
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
        if (!s.game || s.game.map !== msg.map) {
          const seq = s.game?.client.lastSeq ?? 0;
          s.game?.dispose();
          s.game = startGame(ctx, msg.map, msg.id, s.transport, seq);
          s.game.client.match = msg.match;
        }
        chat.send = (text) => s.transport.send({ type: 'chat', text });
        if (first) {
          show('game');
          play();
          $('pause-hint').textContent = s.practice ? 'Practice keeps going while you are away.' : "You're still in the match while you're away.";
          if (!s.practice) chat.add(null, `Welcome to Rocket Jump on ${mapTitle(msg.map)}. First to ${msg.match.fragLimit} wins. T to chat.`);
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
    if (document.pointerLockElement) document.exitPointerLock();
    hud.reset();
    chat.clear();
    show('menu');
    showError(error);
  }

  onlineButton.addEventListener('click', () => {
    begin(new WsTransport(params.get('server') ?? WsTransport.defaultUrl()), false);
  });

  const startPractice = (conditions: NetConditions, bots: number) => {
    const options: Partial<ServerOptions> = { maps: [practiceMap.value], minPlayers: bots + 1, maxPlayers: 1, botSkill: practiceSkill.value as BotSkill };
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
      onlineButton.disabled = false;
      onlineStatus.textContent = params.get('server')!;
      return;
    }
    try {
      const res = await fetch('/status', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const status = (await res.json()) as { map: string; players: string[]; maxPlayers: number; match: { phase: string } };
      const n = status.players.length;
      onlineButton.disabled = n >= status.maxPlayers;
      onlineStatus.textContent =
        n === 0 ? `${mapTitle(status.map)} · nobody on yet, bots will fill in` : `${mapTitle(status.map)} · ${n}/${status.maxPlayers} playing${n >= status.maxPlayers ? ' (full)' : ''}`;
    } catch {
      onlineButton.disabled = true;
      onlineStatus.textContent = 'Server offline. Practice is still available.';
    }
    statusTimer = window.setTimeout(refreshServerStatus, 5000);
  }

  practiceButton.disabled = false;
  show('menu');

  // --- frame loop -----------------------------------------------------------------------------

  const frame = (now: number) => {
    const s = session;
    if (s) {
      s.transport.update(now);
      s.game?.frame(now);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  if (params.get('net') === 'loopback') {
    startPractice({ ping: numParam('ping', 100), jitter: numParam('jitter', 10), loss: numParam('loss', 0) }, numParam('bots', 2));
  }

  if (import.meta.env.DEV) Object.assign(window, { rj: { get session() { return session; }, frame, settings, hud, input } });
}

function gpuName(renderer: THREE.WebGLRenderer): string {
  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown GPU';
  // "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x...) Direct3D11 ...)" -> the readable part.
  return name.match(/ANGLE \([^,]+, (.+?)(?: \(0x[0-9A-Fa-f]+\))? Direct3D/)?.[1] ?? name;
}

main();
