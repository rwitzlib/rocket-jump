import RAPIER from '@dimforge/rapier3d-compat';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { WebSocketServer, type WebSocket } from 'ws';
import { DT, MATCH, MODES, type GameMode } from '../shared/config';
import { MAPS, PLAYABLE_MAPS } from '../shared/map';
import { isOffensive, VOTE_KICK } from '../shared/moderation';
import Stripe from 'stripe';
import { decodeLook, encodeLook, levelOf, newProfile, viewProfile, wornLook, type Profile } from '../shared/progress';
import { DiscordAuth, safeReturn } from './auth';
import { basicPassword, clientAddr, ConnectionCap, MessageBudget, RateLimiter, sameSecret, securityHeaders } from './guard';
import { Shop } from './shop';
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
//   STATS_KEY=secret      turns on /stats (HTTP Basic auth, any user name, this as the password):
//                         players, sessions, early leavers, modes, maps
//   TRUST_PROXY=0         how many proxies of ours sit in front (a TLS proxy, a load balancer): only
//                         then is X-Forwarded-For believed, for rate limits and vote-kick bans
//   TRUST_CLOUDFLARE=0    1: Cloudflare may be in front of those (its orange-cloud proxy). Its
//                         CF-Connecting-IP is believed only on requests that came from its addresses
//   MAX_CONNECTIONS_PER_ADDRESS=8   WebSockets one address may hold open at once
//   REGION=EU West        where this server is, shown in server lists
//   SERVERS=Name|https://host,...   other Rocket Jump servers to list in the menu (with their ping)
//   STATIC_DIR=dist       where the built client is
//
// Signing in and the skin shop (both off unless set; a .env file next to package.json is read too):
//
//   PUBLIC_URL=https://rocketjump.gg   this server's address, for Discord to send players back to
//                                      (default http://localhost:PORT)
//   PUBLIC_ORIGINS=https://rocketjump.gg,...   pages that may ask for a sign-in or checkout and be
//                                      sent back (default: PUBLIC_URL's; any localhost when unset)
//   DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET   Discord sign-in (redirect: PUBLIC_URL/auth/discord/callback)
//   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET   the shop (webhook: PUBLIC_URL/stripe/webhook)

// (Real environment variables win over the file.)
try {
  process.loadEnvFile();
} catch {
  // no .env: fine
}

const env = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== '' && process.env[name] !== undefined ? v : fallback;
};

const PORT = env('PORT', 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const STATIC_DIR = resolve(process.env.STATIC_DIR ?? 'dist');
const MAX_MESSAGE = 16 * 1024; // bytes: an input packet is well under 1 KB
const MAX_BUFFERED = 4 * 1024 * 1024; // bytes waiting to go to one client before it's dropped
const ROOMS_PER_ADDRESS = 2; // rooms one address may have open at once
const JOIN_DEADLINE = 10000; // ms a new connection has to say who it is
const TRUST_PROXY = Math.max(0, Math.floor(env('TRUST_PROXY', 0)));
const TRUST_CLOUDFLARE = process.env.TRUST_CLOUDFLARE === '1' || process.env.TRUST_CLOUDFLARE === 'true';
const addrOf = (req: import('node:http').IncomingMessage) => clientAddr(req, TRUST_PROXY, TRUST_CLOUDFLARE);

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
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PUBLIC_ORIGINS = process.env.PUBLIC_ORIGINS
  ? process.env.PUBLIC_ORIGINS.split(',').map((o) => o.trim().replace(/\/$/, ''))
  : process.env.PUBLIC_URL
    ? [new URL(PUBLIC_URL).origin]
    : []; // (any localhost page)
const discord =
  process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET
    ? new DiscordAuth({ clientId: process.env.DISCORD_CLIENT_ID, clientSecret: process.env.DISCORD_CLIENT_SECRET, redirectUri: `${PUBLIC_URL}/auth/discord/callback` })
    : null;
/** Puts a profile's look on anyone playing as it right now (after a purchase, a refund, a change). */
function relook(p: Profile) {
  for (const [id, s] of sockets) if (s.profile && store.idFor(s.profile) === p.id) s.room.server.setLook(id, encodeLook(wornLook(p)), levelOf(p.xp));
}
const shop =
  process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET
    ? new Shop(new Stripe(process.env.STRIPE_SECRET_KEY), process.env.STRIPE_WEBHOOK_SECRET, store, relook)
    : null;
const REGION = process.env.REGION ?? '';
/** Other servers to list: "Name|https://host" entries, comma separated. */
const SERVERS = (process.env.SERVERS ?? '')
  .split(',')
  .map((entry) => entry.split('|').map((s) => s.trim()))
  .filter(([name, url]) => name && /^https?:\/\/[^\s]+$/.test(url ?? ''))
  .map(([name, url]) => ({ name, url: url.replace(/\/$/, '') }));
const HTTPS = PUBLIC_URL.startsWith('https:');
/** Headers for every response; the page's (with its Content Security Policy) for HTML. */
const API_HEADERS = securityHeaders({ https: HTTPS, page: false, connect: [] });
const PAGE_HEADERS = securityHeaders({ https: HTTPS, page: true, connect: SERVERS.map((s) => new URL(s.url).origin) });

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
    // One that stops reading altogether would hold the rest in memory for ever: let it go.
    if (socket.ws.bufferedAmount > MAX_BUFFERED) return void socket.ws.terminate();
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
  if (gain.levelUp) room.server.setLook(id, encodeLook(wornLook(p)), gain.level);
  if (gain.xp > 0 || gain.unlocked.length) sendTo(id, { type: 'progress', gain, xp: p.xp });
  if (e.type === 'lap' && store.rank(e.map, p.id) === 1 && store.board(e.map).laps[0].time === e.time) {
    log('record', { map: e.map, name, time: e.time });
  }
};

rooms.onSuspect = (room, id, name, detail) => {
  const socket = sockets.get(id);
  log('suspect', { id, room: room.code, name, ...detail, addr: socket?.addr, map: room.server.mapName });
  analytics.suspect();
};
let roomErrors = 0;
rooms.onError = (room, err) => {
  // (Logged the first time and then now and again, not 60 times a second.)
  if (roomErrors++ % 600 === 0) log('room-error', { room: room.code, error: (err as Error)?.stack ?? String(err), count: roomErrors });
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

// Per address, a minute at a time: opening rooms, menu events (so the numbers can't be flooded),
// sign-ins and checkouts, and changing looks.
const roomsOpened = new RateLimiter(3, 60000);
const menuEvents = new RateLimiter(30, 60000);
const accountTries = new RateLimiter(10, 60000);
const profileWrites = new RateLimiter(30, 60000);
/** Wrong room codes and wrong stats passwords, so neither can be guessed by trying them all. */
const roomMisses = new RateLimiter(20, 60000);
const statsMisses = new RateLimiter(10, 60000);
/** Who opened each room that's still open (by code), so one address can't hold them all. */
const roomOwners = new Map<string, string>();
/** WebSockets open per address. */
const connections = new ConnectionCap(Math.max(1, env('MAX_CONNECTIONS_PER_ADDRESS', 8)));

const json = (res: import('node:http').ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { ...API_HEADERS, 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }).end(JSON.stringify(body));

/** Runs a request's handler; anything it throws is a 500 for that request, not the end of the server. */
function guarded(res: import('node:http').ServerResponse, handle: () => void) {
  try {
    handle();
  } catch (err) {
    log('http-error', { error: (err as Error)?.stack ?? String(err) });
    if (!res.headersSent) json(res, 500, { error: 'Something went wrong.' });
    else res.end();
  }
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
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      // not JSON
    }
    done(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null);
  });
}

const validKey = (key: unknown): key is string => typeof key === 'string' && /^[a-f0-9]{32}$/.test(key);

/**
 * POST /profile { key }: your profile (level, stats, challenges, look, account, skins bought). A key
 * that's never played online gets a blank one, not saved. POST /profile/look { key, tint, trail }
 * puts on a look: only on a profile that exists (made by playing online), so made-up keys can't
 * fill the server with profiles.
 */
function profileRequest(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, look: boolean) {
  const addr = addrOf(req);
  readJson(req, (body) =>
    guarded(res, () => {
      if (!body || !validKey(body.key)) return json(res, 400, { error: 'No profile key.' });
      const key = body.key;
      if (look) {
        if (!profileWrites.allow(addr)) return json(res, 429, { error: 'Too many changes just now. Wait a minute.' });
        // (Anyone playing with this profile right now changes too.)
        if (store.setLook(key, decodeLook(`${String(body.tint)}/${String(body.trail)}/${String(body.explosion)}`))) relook(store.find(key)!);
      }
      const p = store.find(key) ?? newProfile(Store.idOf(key), '', Date.now());
      json(res, 200, { ...viewProfile(p, Date.now()), signIn: !!discord, shop: !!shop });
    }),
  );
}

/** The sign-in and shop requests (see auth.ts and shop.ts). Says whether it was one. */
function accountRequest(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL): boolean {
  const path = url.pathname;
  const posts = ['/auth/discord', '/auth/claim', '/auth/signout', '/shop/checkout'];
  if (posts.includes(path) && req.method === 'OPTIONS') {
    res.writeHead(204, { ...API_HEADERS, 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' }).end();
    return true;
  }
  const addr = addrOf(req);
  if (path === '/auth/discord/callback' && req.method === 'GET') {
    if (!discord) {
      json(res, 404, { error: 'Not found' });
      return true;
    }
    void discord
      .callback(url.searchParams)
      .then((to) => {
        if (to) res.writeHead(302, { ...API_HEADERS, location: to, 'cache-control': 'no-store' }).end();
        else res.writeHead(400, { ...API_HEADERS, 'content-type': 'text/plain' }).end('That sign-in link has expired. Go back to the game and try again.');
      })
      .catch((err: unknown) => {
        log('signin-failed', { error: (err as Error)?.message ?? String(err) });
        if (!res.headersSent) res.writeHead(500, { ...API_HEADERS, 'content-type': 'text/plain' }).end('Signing in went wrong. Go back to the game and try again.');
      });
    return true;
  }
  if (path === '/stripe/webhook' && req.method === 'POST') {
    if (!shop) {
      json(res, 404, { error: 'Not found' });
      return true;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) req.destroy();
      else chunks.push(chunk);
    });
    req.on('end', () =>
      guarded(res, () => {
        let did: string;
        try {
          did = shop.webhook(Buffer.concat(chunks), String(req.headers['stripe-signature'] ?? ''));
        } catch (err) {
          log('webhook-rejected', { error: (err as Error).message });
          return json(res, 400, { error: 'Bad signature' });
        }
        log('webhook', { did });
        json(res, 200, { received: true });
      }),
    );
    return true;
  }
  if (!posts.includes(path)) return false;
  if (req.method !== 'POST') {
    json(res, 405, { error: 'POST only' });
    return true;
  }
  readJson(req, (body) => guarded(res, () => {
    if (!body || !validKey(body.key)) return json(res, 400, { error: 'No profile key.' });
    const key = body.key;
    if (path === '/auth/signout') {
      store.signOut(key);
      return json(res, 200, { ok: true });
    }
    if (!accountTries.allow(addr)) return json(res, 429, { error: 'Too many tries just now. Wait a minute.' });
    if (path === '/auth/claim') {
      // Only the browser that started the sign-in (the same key) gets to finish it.
      const claim = discord?.claim(body.code, store.idFor(key), (from, user) => {
        const { key: given, profile } = store.signIn(from, user);
        log('signin', { profile: profile.id, discord: user.id, newKey: !!given });
        return { key: given };
      });
      return claim ? json(res, 200, claim) : json(res, 400, { error: 'That sign-in has expired. Try again.' });
    }
    const returnTo = safeReturn(body.returnTo, PUBLIC_ORIGINS);
    if (!returnTo) return json(res, 400, { error: "Can't send you back to that page." });
    if (path === '/auth/discord') {
      if (!discord) return json(res, 503, { error: "Signing in isn't set up on this server." });
      return json(res, 200, { url: discord.start(store.idFor(key), returnTo) });
    }
    // /shop/checkout
    if (!shop) return json(res, 503, { error: "The shop isn't set up on this server." });
    const p = store.find(key);
    if (!p) return json(res, 403, { error: 'Sign in with Discord to buy skins.' });
    shop
      .checkout(p, String(body.sku), returnTo)
      .then((result) => {
        if ('url' in result) {
          log('checkout', { profile: p.id, sku: body.sku });
          json(res, 200, result);
        } else json(res, result.status, { error: result.error });
      })
      .catch((err: unknown) => {
        log('checkout-failed', { profile: p.id, sku: body.sku, error: (err as Error).message });
        json(res, 502, { error: "Couldn't reach the payment service. Try again in a moment." });
      });
  }));
  return true;
}

/** POST /rooms: checks the request and the address's recent rooms, then opens one. */
function openRoom(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
  const addr = addrOf(req);
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk: string) => {
    body += chunk;
    if (body.length > 300 * 1024) req.destroy(); // (a custom map can be big)
  });
  req.on('end', () =>
    guarded(res, () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      const request = parseRoomRequest(parsed);
      if (!request) return json(res, 400, { error: 'That room request makes no sense.' });
      for (const code of roomOwners.keys()) if (!rooms.get(code)) roomOwners.delete(code);
      if ([...roomOwners.values()].filter((owner) => owner === addr).length >= ROOMS_PER_ADDRESS) return json(res, 429, { error: 'You have rooms open already. Play in one of those, or wait for one to close.' });
      if (!roomsOpened.allow(addr)) return json(res, 429, { error: "You've opened a few rooms just now. Try again in a minute." });
      const room = rooms.create(request);
      if ('error' in room) return json(res, 503, room);
      roomOwners.set(room.code, addr);
      log('room', { code: room.code, name: room.name, mode: request.mode, map: request.map, private: request.private, addr });
      json(res, 201, { code: room.code });
    }),
  );
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

const http = createServer((req, res) => guarded(res, () => serve(req, res)));
// Slow clients (headers or bodies trickled in a byte at a time) don't get to hold sockets for minutes.
http.headersTimeout = 10000;
http.requestTimeout = 30000;
http.maxHeadersCount = 50;

function serve(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') {
    // (Other servers' menus time this for a ping, so anyone may ask.)
    res.writeHead(200, { ...API_HEADERS, 'content-type': 'text/plain', 'access-control-allow-origin': '*', 'cache-control': 'no-store' }).end('ok');
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
    const addr = addrOf(req);
    readJson(req, (body) =>
      guarded(res, () => {
        const name = body?.name;
        if (typeof name === 'string' && (CLIENT_EVENTS as readonly string[]).includes(name) && menuEvents.allow(addr)) analytics.event(name as ClientEvent);
        res.writeHead(204, { ...API_HEADERS, 'access-control-allow-origin': '*' }).end();
      }),
    );
    return;
  }
  if (url.pathname === '/event' && req.method === 'OPTIONS') {
    res.writeHead(204, { ...API_HEADERS, 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' }).end();
    return;
  }
  // GET /stats: the numbers (add ?format=json for JSON), behind HTTP Basic auth with STATS_KEY as the
  // password: a header, so the key isn't left in proxy logs and browser history. Off unless set.
  if (url.pathname === '/stats') {
    if (!STATS_KEY) return json(res, 404, { error: 'Not found' });
    const addr = addrOf(req);
    if (statsMisses.blocked(addr)) return json(res, 429, { error: 'Too many tries just now. Wait a minute.' });
    const given = basicPassword(req.headers.authorization);
    if (given === null || !sameSecret(given, STATS_KEY)) {
      if (given !== null) {
        statsMisses.allow(addr);
        log('stats-denied', { addr });
      }
      res.writeHead(401, { ...API_HEADERS, 'www-authenticate': 'Basic realm="Rocket Jump stats", charset="UTF-8"', 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('Sign in with the stats key as the password.');
      return;
    }
    const report = analytics.report();
    if (url.searchParams.get('format') === 'json') return json(res, 200, { ...report, heat: Object.fromEntries(Object.keys(MAPS).map((m) => [m, analytics.heat(m)])) });
    res.writeHead(200, { ...PAGE_HEADERS, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(statsPage(report, { profiles: store.profileCount, rooms: rooms.count, connected: sockets.size }));
    return;
  }
  if (accountRequest(req, res, url)) return;
  if (url.pathname === '/profile' || url.pathname === '/profile/look') {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...API_HEADERS, 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' }).end();
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
      if (!Object.hasOwn(MAPS, map)) return json(res, 404, { error: 'No such map.' });
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
      res.writeHead(204, { ...API_HEADERS, 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type' }).end();
      return;
    }
    if (req.method === 'POST') openRoom(req, res);
    else json(res, 200, rooms.list());
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, API_HEADERS).end();
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
    ...(extname(file) === '.html' ? PAGE_HEADERS : API_HEADERS),
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    'content-length': data.length,
    vary: 'accept-encoding',
    ...(gzip ? { 'content-encoding': 'gzip' } : {}),
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

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
  const addr = addrOf(req);
  // A handful of connections per address (a few tabs), so one machine can't hold them all open.
  if (!connections.add(addr)) {
    ws.close(4429, 'Too many connections from your address.');
    return;
  }
  ws.once('close', () => connections.remove(addr));
  const code = new URL(req.url ?? '/', 'http://localhost').searchParams.get('room') ?? MAIN_ROOM;
  // (Private rooms are found only by their code: too many wrong ones and the address waits.)
  if (code.toLowerCase() !== MAIN_ROOM && roomMisses.blocked(addr)) {
    ws.close(4429, 'Too many wrong room codes. Wait a minute.');
    return;
  }
  const room = rooms.get(code);
  if (!room) {
    roomMisses.allow(addr);
    ws.close(4404, 'There is no room with that code. It may have closed.');
    return;
  }
  const game = room.server;
  // The id can change once: a reconnecting player takes back the one they had.
  let id = `p${nextId++}`;
  const wire = new WireEncoder();
  const socket = { ws, wire, room, addr, profile: null as string | null };
  let joinedAt = 0;
  let joinedTo = { mode: '', map: '' };
  sockets.set(id, socket);
  ws.binaryType = 'nodebuffer';
  let joined = false;
  // A connection that never says who it is goes (answering pings alone would keep it open for ever).
  const deadline = setTimeout(() => {
    if (!joined) ws.terminate();
  }, JOIN_DEADLINE);
  ws.once('close', () => clearTimeout(deadline));

  const budget = new MessageBudget();
  ws.on('message', (data, isBinary) => {
    const allowed = budget.take();
    if (allowed === 'abuse') {
      log('flood', { id, room: room.code, addr });
      return void ws.terminate();
    }
    if (allowed === 'drop') return;
    try {
      receive(data as Buffer, isBinary);
    } catch (err) {
      // A message that trips the server up costs that connection, not everyone's game.
      log('message-error', { id, room: room.code, error: (err as Error)?.stack ?? String(err) });
      ws.terminate();
    }
  });
  const receive = (raw: Buffer, isBinary: boolean) => {
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
    // Online with a profile: wear its look, show its level. (A key the server hasn't seen becomes a
    // saved profile only once it earns something, so made-up keys don't pile up.)
    if (msg.type === 'join' && msg.profile && !socket.profile) {
      socket.profile = msg.profile;
      const name = isOffensive(msg.name) ? '' : msg.name; // (the game gives them another; the profile keeps its own)
      const p = store.find(msg.profile) ? store.profile(msg.profile, name) : newProfile(Store.idOf(msg.profile), name, Date.now());
      game.setLook(id, encodeLook(wornLook(p)), levelOf(p.xp));
    }
  };
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
  log('listening', { url: `http://localhost:${PORT}`, maps: game.options.maps.join(','), static: STATIC_DIR, data: process.env.DATA_DIR || '(memory only)', profiles: store.profileCount, signIn: !!discord, shop: !!shop });
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
