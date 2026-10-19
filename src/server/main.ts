import RAPIER from '@dimforge/rapier3d-compat';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { WebSocketServer, type WebSocket } from 'ws';
import { DT, MATCH } from '../shared/config';
import { MAPS } from '../shared/map';
import { parseClientMessage } from '../shared/protocol';
import { GameServer } from '../shared/server';

// The dedicated server: serves the built game (dist/) over HTTP and runs one GameServer, with
// players connected over WebSockets at /ws. Everything is configured with environment variables:
//
//   PORT=8080             HTTP + WebSocket port
//   HOST=0.0.0.0          interface to listen on
//   MAPS=dockyard,temple,skyreach,arena,citadel   map rotation
//   TIME_LIMIT=480        seconds per match
//   FRAG_LIMIT=25         kills to win (default: per map, 15 to 25)
//   INTERMISSION=15       seconds on the results screen
//   MIN_PLAYERS=4         bots fill in up to this many players (0: no bots)
//   MAX_PLAYERS=12        people allowed in at once
//   BOT_SKILL=auto        easy, normal or hard; auto follows how the people on the server are doing
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

const maps = (process.env.MAPS ?? 'dockyard,temple,skyreach,arena,citadel').split(',').map((m) => m.trim()).filter((m) => m in MAPS);
const sockets = new Map<string, WebSocket>();
const game = new GameServer(
  (id, msg) => {
    const ws = sockets.get(id);
    // A client that can't keep up (a huge send buffer) gets skipped snapshots rather than a growing backlog.
    if (!ws || ws.readyState !== ws.OPEN) return;
    if (msg.type === 'snapshot' && ws.bufferedAmount > 256 * 1024) return;
    ws.send(JSON.stringify(msg));
  },
  {
    maps,
    timeLimit: env('TIME_LIMIT', MATCH.timeLimit),
    fragLimit: process.env.FRAG_LIMIT ? env('FRAG_LIMIT', MATCH.fragLimit) : null, // default: per map
    intermission: env('INTERMISSION', MATCH.intermission),
    minPlayers: env('MIN_PLAYERS', MATCH.minPlayers),
    maxPlayers: env('MAX_PLAYERS', MATCH.maxPlayers),
    botSkill: (['easy', 'normal', 'hard'] as const).find((s) => s === process.env.BOT_SKILL) ?? 'auto',
  },
);

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
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ ...game.status(), tickMs: Math.round(tickMs * 100) / 100, uptime: Math.round(process.uptime()) }));
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
  // Snapshots are repetitive JSON: compression cuts them to about a quarter for very little CPU.
  perMessageDeflate: { threshold: 512, zlibDeflateOptions: { level: 1 }, serverNoContextTakeover: false, clientNoContextTakeover: true },
});
let nextId = 1;

wss.on('connection', (ws, req) => {
  const id = `p${nextId++}`;
  sockets.set(id, ws);
  ws.binaryType = 'nodebuffer';
  const addr = req.headers['x-forwarded-for'] ?? req.socket.remoteAddress;
  let joined = false;

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    const msg = parseClientMessage(parsed);
    if (!msg) return;
    if (msg.type === 'join') {
      if (joined) return;
      joined = true;
      log('join', { id, name: msg.name, addr });
    }
    game.receive(id, msg);
  });
  ws.on('close', () => {
    sockets.delete(id);
    if (joined) log('leave', { id });
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
    game.tick();
    const spent = performance.now() - t0;
    tickMs += (spent - tickMs) * 0.01;
    if (spent > DT * 1000) slowTicks++;
    ticks++;
  }
  setTimeout(loop, 2);
};
loop();

setInterval(() => {
  if (game.playerCount === 0 && slowTicks === 0) return;
  const s = game.status();
  log('status', { map: s.map, players: s.players.length, bots: s.bots, phase: s.match.phase, slowTicks });
  slowTicks = 0;
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
