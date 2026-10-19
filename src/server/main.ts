import RAPIER from '@dimforge/rapier3d-compat';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { WebSocketServer, type WebSocket } from 'ws';
import { DT, MATCH, MODES, type GameMode } from '../shared/config';
import { MAPS } from '../shared/map';
import { parseClientMessage } from '../shared/protocol';
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
//   MAPS=dockyard,temple:ctf,skyreach:tdm,arena,citadel:ctf   rotation: maps, each with an optional :mode
//   MODE=ffa              mode for rotation entries without one: ffa, tdm, ctf or race
//   TIME_LIMIT=480        seconds per match (default: per mode, 8 min; CTF 10, races 5)
//   FRAG_LIMIT=25         kills to win (default: per map, 15 to 25; team deathmatch 1.6x)
//   INTERMISSION=15       seconds on the results screen
//   MIN_PLAYERS=4         bots fill in up to this many players (0: no bots)
//   MAX_PLAYERS=12        people allowed in at once
//   MAX_SPECTATORS=8      people allowed to watch on top of that
//   BOT_SKILL=auto        easy, normal or hard; auto follows how the people on the server are doing
//   MAX_ROOMS=8           rooms at once, the main one included (each costs a match's CPU)
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

const maps = (process.env.MAPS ?? 'dockyard,temple:ctf,skyreach:tdm,arena,citadel:ctf').split(',').map((m) => m.trim()).filter((m) => m.split(':')[0] in MAPS);
const mode = (Object.keys(MODES) as GameMode[]).find((m) => m === process.env.MODE) ?? MATCH.mode;
const sockets = new Map<string, { ws: WebSocket; wire: WireEncoder; room: Room }>();
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
  },
  { maxRooms: Math.max(1, env('MAX_ROOMS', 8)), idleTimeout: 120 },
);
const game = rooms.main.server;

/** Opening rooms is limited per address: a few a minute. */
const ROOM_CREATE_LIMIT = 3;
const roomsOpened = new Map<string, number[]>();

const json = (res: import('node:http').ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }).end(JSON.stringify(body));

/** POST /rooms: checks the request and the address's recent rooms, then opens one. */
function openRoom(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
  const addr = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '');
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk: string) => {
    body += chunk;
    if (body.length > 2048) req.destroy();
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
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  if (url.pathname === '/status') {
    json(res, 200, { ...game.status(), rooms: rooms.count, tickMs: Math.round(tickMs * 100) / 100, uptime: Math.round(process.uptime()) });
    return;
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
  const id = `p${nextId++}`;
  const wire = new WireEncoder();
  sockets.set(id, { ws, wire, room });
  ws.binaryType = 'nodebuffer';
  const addr = req.headers['x-forwarded-for'] ?? req.socket.remoteAddress;
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
      joined = true;
      log('join', { id, room: room.code, name: msg.name, addr });
    }
    game.receive(id, msg);
  });
  ws.on('close', () => {
    sockets.delete(id);
    if (joined) log('leave', { id, room: room.code });
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
  log('listening', { url: `http://localhost:${PORT}`, maps: game.options.maps.join(','), static: STATIC_DIR });
});

function log(event: string, data: Record<string, unknown>) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...data }));
}

const shutdown = () => {
  log('shutdown', {});
  for (const ws of wss.clients) ws.close(1001, 'Server restarting');
  http.close();
  setTimeout(() => process.exit(0), 500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
