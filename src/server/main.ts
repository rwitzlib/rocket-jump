import RAPIER from '@dimforge/rapier3d-compat';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { WebSocketServer, type WebSocket } from 'ws';
import { DT, MATCH, MODES, type GameMode } from '../shared/config';
import { MAPS, PLAYABLE_MAPS } from '../shared/map';
import { VOTE_KICK } from '../shared/moderation';
import { allowedLook, decodeLook, encodeLook, levelOf, newProfile, viewProfile } from '../shared/progress';
import { Store } from './store';
import { Analytics, CLIENT_EVENTS, statsPage, type ClientEvent } from './analytics';
import { parseClientMessage, type ServerMessage } from '../shared/protocol';
import { MAIN_ROOM, parseRoomRequest, Rooms, type Room } from '../shared/rooms';
import { decodeClientMessage, WireEncoder } from '../shared/wire';

// The dedicated server: serves the built game (dist/) over HTTP and runs the game's rooms, with
// players connected over WebSockets at /ws (?room=CODE for any room but the main one).
//
//   GET  /rooms    the public rooms, for the server browser
//   POST /rooms    opens a room: { name, mode, map, bots, skill, private } -> { code }
//   GET  /status   the main room, plus the number of rooms and the tick time
//
// Everything is configured with environment variables (the rotation and match settings are the
// main room's; opened rooms pick their own mode and map):
//
//   PORT=8080             HTTP + WebSocket port
//   HOST=0.0.0.0          interface to listen on
//   MAPS=dockyard,temple:ctf,foundry:koth,skyreach:tdm,canyon:ctf,arena:instagib,coliseum,citadel:elim   rotation: maps, each with an optional :mode
//   MODE=ffa              mode for rotation entries without one: ffa, tdm, ctf or race
//   TIME_LIMIT=480        seconds per match (default: per mode, 8 min; CTF 10, races 5)
//   FRAG_LIMIT=25         kills to win (default: per map, 15 to 25; team deathmatch 1.6x)
//   INTERMISSION=15       seconds on the results screen
//   MIN_PLAYERS=4         bots fill in up to this many players (0: no bots)
//   MAX_PLAYERS=12        people allowed in at once
//   MAX_SPECTATORS=8      people allowed to watch on top of that
//   BOT_SKILL=auto        easy, normal or hard; auto follows how the people on the server are doing
//   MAX_ROOMS=8           rooms at once, the main one included (each costs a match's CPU)
//   RECONNECT_GRACE=30    seconds a player whose connection drops is held for them to come back
//   DATA_DIR=/data        where profiles (XP, stats, challenges), race records and the server's
//                         numbers are saved; unset, they're kept in memory only and lost on restart
//   STATS_KEY=secret      turns on /stats?key=secret: players, sessions, early leavers, modes, maps
//   REGION=EU West        where this server is, shown in server lists
//   SERVERS=Name|https://host,...   other Rocket Jump servers to list in the menu (with their ping)
//   STATIC_DIR=dist       where the built client is

const env = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== '' && process.env[name] !== undefined ? v : fallback;
};

const PORT = env('PORT', 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const STATIC_DIR = resolve(process.env.STATIC_DIR ?? 'dist');
const MAX_MESSAGE = 16 * 1024; // bytes: an input packet is well under 1 KB

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

await RAPIER.init();

const maps = (process.env.MAPS ?? 'dockyard,temple:ctf,foundry:koth,skyreach:tdm,canyon:ctf,arena:instagib,coliseum,citadel:elim').split(',').map((m) => m.trim()).filter((m) => m.split(':')[0] in MAPS);
const mode = (Object.keys(MODES) as GameMode[]).find((m) => m === process.env.MODE) ?? MATCH.mode;
const sockets = new Map<string, { ws: WebSocket; wire: WireEncoder; room: Room; addr: string; profile: string | null }>();
const store = new Store(process.env.DATA_DIR || null);
const analytics = new Analytics(process.env.DATA_DIR || null);
const STATS_KEY = process.env.STATS_KEY ?? '';
const REGION = process.env.REGION ?? '';
/** Other servers to list: "Name|https://host" entries, comma separated. */
const SERVERS = (process.env.SERVERS ?? '')
  .split(',')
  .map((entry) => entry.split('|').map((s) => s.trim()))
  .filter(([name, url]) => name && /^https?:\/\/[^\s]+$/.test(url ?? ''))
  .map(([name, url]) => ({ name, url: url.replace(/\/$/, '') }));

/** Sends one message to one connection, outside the game server's own sending (progress news). */
function sendTo(id: string, msg: ServerMessage) {
  const socket = sockets.get(id);
  if (socket && socket.ws.readyState === socket.ws.OPEN) socket.ws.send(socket.wire.encode(msg));
}
let bytesOut = 0; // for the status log
const rooms = new Rooms(
  (id, msg) => {
    const socket = sockets.get(id);
    // A client that can't keep up (a huge send buffer) gets skipped snapshots rather than a growing backlog.
    if (!socket || socket.ws.readyState !== socket.ws.OPEN) return;
    if (msg.type === 'snapshot' && socket.ws.bufferedAmount > 256 * 1024) return;
    const data = socket.wire.encode(msg);
    bytesOut += data.length;
    socket.ws.send(data);
  },
  {
    maps,
    mode,
    timeLimit: process.env.TIME_LIMIT ? env('TIME_LIMIT', MATCH.timeLimit) : null, // default: per mode
    fragLimit: process.env.FRAG_LIMIT ? env('FRAG_LIMIT', MATCH.fragLimit) : null, // default: per map
    intermission: env('INTERMISSION', MATCH.intermission),
    minPlayers: env('MIN_PLAYERS', MATCH.minPlayers),
    maxPlayers: env('MAX_PLAYERS', MATCH.maxPlayers),
    maxSpectators: env('MAX_SPECTATORS', 8),
    botSkill: (['easy', 'normal', 'hard'] as const).find((s) => s === process.env.BOT_SKILL) ?? 'auto',
    reconnectGrace: env('RECONNECT_GRACE', 30),
  },
  { maxRooms: Math.max(1, env('MAX_ROOMS', 8)), idleTimeout: 120 },
);
const game = rooms.main.server;

/** Addresses voted out of a room, kept out of it for a while: "room|address" -> when they may return (ms). */
const bans = new Map<string, number>();
const banKey = (room: Room, addr: string) => `${room.code}|${addr}`;
// Profile news: count it, and tell the player what they earned.
rooms.onStat = (room, id, profile, name, e) => {
  const gain = store.apply(profile, name, e);
  const p = store.find(profile)!;
  if (gain.levelUp) room.server.setLook(id, encodeLook(allowedLook(p.look, gain.level)), gain.level);
  if (gain.xp > 0) sendTo(id, { type: 'progress', gain, xp: p.xp });
  if (e.type === 'lap' && store.rank(e.map, p.id) === 1 && store.board(e.map).laps[0].time === e.time) {
    log('record', { map: e.map, name, time: e.time });
  }
};

rooms.onSuspect = (room, id, name, detail) => {
  const socket = sockets.get(id);
  log('suspect', { id, room: room.code, name, ...detail, addr: socket?.addr, map: room.server.mapName });
  analytics.suspect();
};
rooms.onDeath = (map, x, z) => analytics.death(map, x, z);
rooms.onMatchOver = (mode, map, people) => {
  if (people > 0) analytics.match();
  log('match', { mode, map, people });
};

rooms.onKick = (room, id) => {
  const socket = sockets.get(id);
  if (!socket) return;
  bans.set(banKey(room, socket.addr), Date.now() + VOTE_KICK.ban * 1000);
  log('kick', { id, room: room.code, addr: socket.addr });
  sockets.delete(id);
  socket.ws.close(4403, 'You were voted out of that game.');
};

/** Opening rooms is limited per address: a few a minute. */
const ROOM_CREATE_LIMIT = 3;
const roomsOpened = new Map<string, number[]>();

const json = (res: import('node:http').ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }).end(JSON.stringify(body));

/** Menu events: a few a minute from one address, so the numbers can't be flooded. */
const eventTimes = new Map<string, number[]>();
function eventAllowed(addr: string): boolean {
  const now = Date.now();
  const recent = (eventTimes.get(addr) ?? []).filter((t) => now - t < 60000);
  if (recent.length >= 30) return false;
  recent.push(now);
  eventTimes.set(addr, recent);
  if (eventTimes.size > 5000) eventTimes.clear();
  return true;
}

/** Reads a small JSON body (or null if it isn't one). */
function readJson(req: import('node:http').IncomingMessage, done: (body: Record<string, unknown> | null) => void) {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk: string) => {
    body += chunk;
    if (body.length > 2048) req.destroy();
  });
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body) as unknown;
      done(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null);
    } catch {
      done(null);
    }
  });
}

const validKey = (key: unknown): key is string => typeof key === 'string' && /^[a-f0-9]{32}$/.test(key);

/**
 * POST /profile { key }: your profile (level, stats, challenges, look). A key that's never played
 * online gets a blank one, not saved. POST /profile/look { key, tint, trail } puts on a look.
 */
function profileRequest(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, look: boolean) {
  readJson(req, (body) => {
    if (!body || !validKey(body.key)) return json(res, 400, { error: 'No profile key.' });
    const key = body.key;
    if (look) {
      const worn = store.setLook(key, decodeLook(`${String(body.tint)}/${String(body.trail)}/${String(body.explosion)}`));
      const p = store.find(key)!;
      // Anyone playing with this profile right now changes too.
      for (const [id, s] of sockets) if (s.profile === key) s.room.server.setLook(id, encodeLook(worn), levelOf(p.xp));
    }
    const p = store.find(key) ?? newProfile(Store.idOf(key), '', Date.now());
    json(res, 200, viewProfile(p, Date.now()));
  });
}

/** POST /rooms: checks the request and the address's recent rooms, then opens one. */
function openRoom(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
  const addr = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '');
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk: string) => {
    body += chunk;
    if (body.length > 300 * 1024) req.destroy(); // (a custom map can be big)
  });
  req.on('end', () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }
    const request = parseRoomRequest(parsed);
    if (!request) return json(res, 400, { error: 'That room request makes no sense.' });
    const now = Date.now();
    const recent = (roomsOpened.get(addr) ?? []).filter((t) => now - t < 60000);
    if (recent.length >= ROOM_CREATE_LIMIT) return json(res, 429, { error: "You've opened a few rooms just now. Try again in a minute." });
    const room = rooms.create(request);
    if ('error' in room) return json(res, 503, room);
    roomsOpened.set(addr, [...recent, now]);
    log('room', { code: room.code, name: room.name, mode: request.mode, map: request.map, private: request.private, addr });
    json(res, 201, { code: room.code });
  });
}

// The built client is small enough to keep in memory, compressed once: the game bundle (with
// Rapier's WASM inlined) goes from about 5 MB to under 2 MB on the wire.
const files = new Map<string, { raw: Buffer; gzip: Buffer | null; mtime: number }>();
function staticFile(file: string) {
  const mtime = statSync(file).mtimeMs;
  let entry = files.get(file);
  if (!entry || entry.mtime !== mtime) {
    const raw = readFileSync(file);
    const compressible = /\.(html|js|css|json|svg|wasm|webmanifest)$/.test(file) && raw.length > 1024;
    entry = { raw, gzip: compressible ? gzipSync(raw, { level: 9 }) : null, mtime };
    files.set(file, entry);
  }
  return entry;
}

const http = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') {
    // (Other servers' menus time this for a ping, so anyone may ask.)
    res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*', 'cache-control': 'no-store' }).end('ok');
    return;
  }
  if (url.pathname === '/status') {
    json(res, 200, { ...game.status(), region: REGION, rooms: rooms.count, connected: sockets.size, tickMs: Math.round(tickMs * 100) / 100, uptime: Math.round(process.uptime()) });
    return;
  }
  // GET /servers: this one and the others it knows of, for the menu's server list.
  if (url.pathname === '/servers') {
    json(res, 200, { region: REGION, servers: SERVERS });
    return;
  }
  // POST /event { name }: the page saying what someone did in the menus (see analytics.ts).
  if (url.pathname === '/event' && req.method === 'POST') {
    const addr = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
    readJson(req, (body) => {
      const name = body?.name;
      if (typeof name === 'string' && (CLIENT_EVENTS as readonly string[]).includes(name) && eventAllowed(addr)) analytics.event(name as ClientEvent);
      res.writeHead(204, { 'access-control-allow-origin': '*' }).end();
    });
    return;
  }
  if (url.pathname === '/event' && req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' }).end();
    return;
  }
  // GET /stats?key=STATS_KEY: the numbers (add &format=json for JSON). Off unless STATS_KEY is set.
  if (url.pathname === '/stats') {
    if (!STATS_KEY || url.searchParams.get('key') !== STATS_KEY) return json(res, 404, { error: 'Not found' });
    const report = analytics.report();
    if (url.searchParams.get('format') === 'json') return json(res, 200, { ...report, heat: Object.fromEntries(Object.keys(MAPS).map((m) => [m, analytics.heat(m)])) });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(statsPage(report, { profiles: store.profileCount, rooms: rooms.count, connected: sockets.size }));
    return;
  }
  if (url.pathname === '/profile' || url.pathname === '/profile/look') {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' }).end();
      return;
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    profileRequest(req, res, url.pathname === '/profile/look');
    return;
  }
  // GET /leaderboard?map=NAME the fastest race laps there (&ghost=1 adds the record lap's path);
  // without a map, the top three on every map.
  if (url.pathname === '/leaderboard') {
    const map = url.searchParams.get('map');
    if (map) {
      if (!(map in MAPS)) return json(res, 404, { error: 'No such map.' });
      const board = store.board(map);
      const ghost = url.searchParams.get('ghost') && board.ghost ? { ...board.ghost, name: board.laps[0]?.name ?? '' } : undefined;
      return json(res, 200, { map, laps: board.laps, ghost });
    }
    const all: Record<string, unknown> = {};
    for (const name of PLAYABLE_MAPS) all[name] = store.board(name).laps.slice(0, 3);
    return json(res, 200, all);
  }
  if (url.pathname === '/rooms') {
    // (A page from elsewhere, like the dev server with ?server=, asks before it posts.)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type' }).end();
      return;
    }
    if (req.method === 'POST') openRoom(req, res);
    else json(res, 200, rooms.list());
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  // Static files from dist/, never outside it. Unknown paths get the game page.
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = normalize(join(STATIC_DIR, path));
  if (file !== STATIC_DIR && !file.startsWith(STATIC_DIR + sep)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(STATIC_DIR, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Client not built. Run `npm run build` first.');
    return;
  }
  // Built assets have content hashes in their names, so they can be cached forever.
  const hashed = url.pathname.startsWith('/assets/');
  const body = staticFile(file);
  const gzip = body.gzip && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
  const data = gzip ? body.gzip! : body.raw;
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    'content-length': data.length,
    'x-content-type-options': 'nosniff',
    vary: 'accept-encoding',
    ...(gzip ? { 'content-encoding': 'gzip' } : {}),
  });
  res.end(req.method === 'HEAD' ? undefined : data);
});

const wss = new WebSocketServer({
  server: http,
  path: '/ws',
  maxPayload: MAX_MESSAGE,
  // Even delta-coded binary snapshots still shrink by about half (names, repeated ids, quiet
  // records), and they're mostly a few hundred bytes, so the threshold is low.
  perMessageDeflate: { threshold: 64, zlibDeflateOptions: { level: 1 }, serverNoContextTakeover: false, clientNoContextTakeover: true },
});
let nextId = 1;

wss.on('connection', (ws, req) => {
  const code = new URL(req.url ?? '/', 'http://localhost').searchParams.get('room') ?? MAIN_ROOM;
  const room = rooms.get(code);
  if (!room) {
    ws.close(4404, 'There is no room with that code. It may have closed.');
    return;
  }
  const game = room.server;
  // The id can change once: a reconnecting player takes back the one they had.
  let id = `p${nextId++}`;
  const wire = new WireEncoder();
  const addr = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
  const socket = { ws, wire, room, addr, profile: null as string | null };
  let joinedAt = 0;
  let joinedTo = { mode: '', map: '' };
  sockets.set(id, socket);
  ws.binaryType = 'nodebuffer';
  let joined = false;

  ws.on('message', (data, isBinary) => {
    const raw = data as Buffer;
    const msg = parseClientMessage(decodeClientMessage(isBinary ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : raw.toString()));
    if (!msg) return;
    // Snapshots are delta-coded against the newest one the client says it has.
    if (msg.type === 'input' && msg.snap) wire.ack(msg.snap);
    if (msg.type === 'ack') wire.ack(msg.tick);
    if (msg.type === 'join') {
      if (joined) return;
      if ((bans.get(banKey(room, addr)) ?? 0) > Date.now()) {
        ws.send(wire.encode({ type: 'rejected', reason: 'You were voted out of that game a little while ago. Try another room, or come back later.' }));
        ws.close(4403, 'Voted out');
        return;
      }
      joined = true;
      joinedAt = Date.now();
      joinedTo = { mode: game.mode, map: game.mapName };
      // Back after a dropped connection: carry on as the player they were.
      const held = msg.resume ? game.resume(msg.resume) : null;
      if (held) {
        const old = sockets.get(held);
        sockets.delete(id);
        id = held;
        sockets.set(id, socket);
        if (old && old.ws !== ws) old.ws.terminate(); // a dead link the server hadn't noticed yet
        log('rejoin', { id, room: room.code, name: msg.name, addr });
      } else log('join', { id, room: room.code, name: msg.name, addr });
    }
    game.receive(id, msg);
    // Online with a profile: wear its look, show its level.
    if (msg.type === 'join' && msg.profile && !socket.profile) {
      socket.profile = msg.profile;
      const p = store.profile(msg.profile, msg.name);
      game.setLook(id, encodeLook(allowedLook(p.look, levelOf(p.xp))), levelOf(p.xp));
    }
  });
  ws.on('close', () => {
    // Replaced by a reconnection (or kicked): that player isn't this socket's any more.
    if (sockets.get(id) !== socket) return;
    sockets.delete(id);
    if (joined) {
      log('leave', { id, room: room.code });
      analytics.session(socket.profile ?? addr, (Date.now() - joinedAt) / 1000, joinedTo.mode, joinedTo.map);
    }
    game.disconnect(id);
  });
  ws.on('error', () => ws.close());
});

// Drop connections that never send a join or have gone silent (a sleeping laptop, a dead link).
const alive = new WeakMap<WebSocket, boolean>();
wss.on('connection', (ws) => {
  alive.set(ws, true);
  ws.on('pong', () => alive.set(ws, true));
  ws.on('message', () => alive.set(ws, true));
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.get(ws)) {
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
    ws.ping();
  }
}, 15000);

// A fixed 60 Hz clock. Timers are coarse (about 15 ms on Windows), so each wakeup runs however many
// ticks are due, and a long stall skips ahead rather than fast-forwarding through a backlog.
const start = performance.now();
let ticks = 0;
let slowTicks = 0;
let tickMs = 0; // smoothed time one tick takes, for /status
const loop = () => {
  const due = Math.floor((performance.now() - start) / (DT * 1000));
  if (due - ticks > 15) ticks = due - 1;
  while (ticks < due) {
    const t0 = performance.now();
    rooms.tick();
    const spent = performance.now() - t0;
    tickMs += (spent - tickMs) * 0.01;
    if (spent > DT * 1000) slowTicks++;
    ticks++;
  }
  setTimeout(loop, 2);
};
loop();

setInterval(() => {
  if (sockets.size === 0 && slowTicks === 0) return;
  const s = game.status();
  log('status', { map: s.map, mode: s.mode, players: s.players.length, spectators: s.spectators.length, bots: s.bots, phase: s.match.phase, rooms: rooms.count, connected: sockets.size, slowTicks, kbPerSecond: Math.round(bytesOut / 60 / 100) / 10 });
  slowTicks = 0;
  bytesOut = 0;
}, 60000);

http.listen(PORT, HOST, () => {
  log('listening', { url: `http://localhost:${PORT}`, maps: game.options.maps.join(','), static: STATIC_DIR, data: process.env.DATA_DIR || '(memory only)', profiles: store.profileCount });
});

function log(event: string, data: Record<string, unknown>) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...data }));
}

const shutdown = () => {
  log('shutdown', {});
  store.save();
  analytics.save();
  for (const ws of wss.clients) ws.close(1001, 'Server restarting');
  http.close();
  setTimeout(() => process.exit(0), 500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
