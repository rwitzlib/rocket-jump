import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import { serverOverride } from '../src/client/net/serverparam';
import { PROTOCOL_VERSION } from '../src/shared/config';
import { MAPS } from '../src/shared/map';
import { parseRoomRequest, Rooms } from '../src/shared/rooms';
import { GameServer, type ServerOptions } from '../src/shared/server';
import type { SimEvent } from '../src/shared/sim';
import type { StatEvent } from '../src/shared/progress';
import { basicPassword, clientAddr, ConnectionCap, isCloudflare, RateLimiter, sameSecret, securityHeaders } from '../src/server/guard';
import { newKey, Store } from '../src/server/store';
import './helpers';

// The server's defences: who a request is from, rate limits and connection caps, the headers it
// sends, the page ignoring ?server= when published, made-up profile keys, and XP that can't be farmed.

const req = (remote: string, forwarded?: string, extra: Record<string, string> = {}) =>
  ({ socket: { remoteAddress: remote }, headers: { ...(forwarded === undefined ? {} : { 'x-forwarded-for': forwarded }), ...extra } }) as unknown as IncomingMessage;

test("X-Forwarded-For is only believed from proxies we've said are ours", () => {
  assert.equal(clientAddr(req('203.0.113.9', '1.2.3.4'), 0), '203.0.113.9', 'no proxy: the header is anyone’s to write');
  // One proxy: it appends the address it saw, so whatever the client put first is ignored.
  assert.equal(clientAddr(req('10.0.0.1', '1.2.3.4, 198.51.100.7'), 1), '198.51.100.7');
  assert.equal(clientAddr(req('10.0.0.1', '198.51.100.7'), 1), '198.51.100.7');
  // Two (a CDN, then a load balancer): the client is second from the end.
  assert.equal(clientAddr(req('10.0.0.2', 'spoofed, 198.51.100.7, 10.0.0.1'), 2), '198.51.100.7');
  // Fewer entries than proxies: fall back to the socket rather than trust anything.
  assert.equal(clientAddr(req('10.0.0.1'), 1), '10.0.0.1');
});

test("Cloudflare's addresses are recognized, and nothing else is", () => {
  assert.ok(isCloudflare('172.68.1.20'));
  assert.ok(isCloudflare('::ffff:162.158.3.4'), 'IPv4 written as IPv6');
  assert.ok(isCloudflare('2a06:98c1::1'));
  assert.equal(isCloudflare('198.51.100.7'), false);
  assert.equal(isCloudflare('2001:db8::1'), false);
  assert.equal(isCloudflare('not an address'), false);
});

test("behind Railway and Cloudflare: Cloudflare's word counts only when it really came through Cloudflare", () => {
  const railway = '100.64.0.2'; // Railway's edge, as the socket sees it
  const cf = '172.68.1.20'; // a Cloudflare address
  // Through Cloudflare: Railway appends Cloudflare's address; Cloudflare says who it got it from.
  const through = req(railway, `6.6.6.6, 198.51.100.7, ${cf}`, { 'cf-connecting-ip': '198.51.100.7' });
  assert.equal(clientAddr(through, 1, true), '198.51.100.7', 'the player, not what they wrote, nor Cloudflare');
  assert.equal(clientAddr(req(railway, `198.51.100.7, ${cf}`), 1, true), '198.51.100.7', "without CF-Connecting-IP, Cloudflare's appended entry");
  assert.equal(clientAddr(through, 1, false), cf, 'without TRUST_CLOUDFLARE: everyone shares Cloudflare’s address, nobody can fake one');
  // Skipping Cloudflare, straight to the host, with made-up headers: the address Railway saw.
  const direct = req(railway, `198.51.100.7, 203.0.113.50`, { 'cf-connecting-ip': '198.51.100.7' });
  assert.equal(clientAddr(direct, 1, true), '203.0.113.50');
  // (Which is what TRUST_PROXY=2 would have got wrong.)
  assert.equal(clientAddr(direct, 2, false), '198.51.100.7');
  // A garbage CF-Connecting-IP is ignored.
  assert.equal(clientAddr(req(railway, `198.51.100.7, ${cf}`, { 'cf-connecting-ip': 'nonsense' }), 1, true), '198.51.100.7');
});

test('rate limits count per address, in a sliding window, with bounded memory', () => {
  const limit = new RateLimiter(3, 60000, 100);
  for (let i = 0; i < 3; i++) assert.ok(limit.allow('a', 1000 + i));
  assert.equal(limit.allow('a', 2000), false);
  assert.ok(limit.allow('b', 2000), 'another address has its own');
  assert.ok(limit.allow('a', 61001), 'the oldest falls out of the window');
  // Thousands of addresses don't reset anyone's count (the old limiter cleared the lot at 5000).
  const busy = new RateLimiter(1, 60000, 100);
  assert.ok(busy.allow('victim', 0));
  for (let i = 0; i < 50; i++) busy.allow(`x${i}`, 1);
  assert.equal(busy.allow('victim', 2), false);
  for (let i = 0; i < 5000; i++) busy.allow(`y${i}`, 3);
  assert.ok((busy as unknown as { hits: Map<string, number[]> }).hits.size <= 101, 'keeps at most its limit of addresses');
});

test('connections per address are capped', () => {
  const cap = new ConnectionCap(2);
  assert.ok(cap.add('a'));
  assert.ok(cap.add('a'));
  assert.equal(cap.add('a'), false);
  assert.ok(cap.add('b'));
  cap.remove('a');
  assert.ok(cap.add('a'));
  cap.remove('a');
  cap.remove('a');
  assert.equal(cap.count('a'), 0);
});

test('the stats key goes in a Basic auth header, compared in constant time', () => {
  const header = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  assert.equal(basicPassword(header('', 's3cret:with:colons')), 's3cret:with:colons');
  assert.equal(basicPassword(header('me', 'pw')), 'pw');
  assert.equal(basicPassword('Bearer pw'), null);
  assert.equal(basicPassword(undefined), null);
  assert.ok(sameSecret('s3cret', 's3cret'));
  assert.equal(sameSecret('s3cre', 's3cret'), false);
  assert.equal(sameSecret('', 's3cret'), false);
});

test('responses carry security headers; the page a strict CSP; HSTS only over HTTPS', () => {
  const api = securityHeaders({ https: false, page: false, connect: [] });
  assert.equal(api['x-content-type-options'], 'nosniff');
  assert.equal(api['x-frame-options'], 'DENY');
  assert.equal(api['strict-transport-security'], undefined);
  assert.equal(api['content-security-policy'], undefined);
  const page = securityHeaders({ https: true, page: true, connect: ['https://eu.rocketjump.gg'] });
  assert.match(page['strict-transport-security'], /max-age=31536000/);
  const csp = page['content-security-policy'];
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'(;|$)/, 'no inline or third-party scripts');
  assert.match(csp, /connect-src 'self' https:\/\/eu\.rocketjump\.gg(;|$)/, 'connections only to us and the listed servers');
  assert.match(csp, /frame-ancestors 'none'/);
});

test('a published page ignores ?server=, so a link can’t send the profile key elsewhere', () => {
  assert.equal(serverOverride('?server=wss://evil.example/ws', false), null);
  assert.equal(serverOverride('?server=wss://localhost:8080/ws', true), 'wss://localhost:8080/ws');
  assert.equal(serverOverride('?server=javascript:alert(1)', true), null);
  assert.equal(serverOverride('?server=https://host/ws', true), null);
  assert.equal(serverOverride('', true), null);
});

test('changing the look of a key nobody has played with makes no profile', () => {
  const store = new Store(null);
  assert.equal(store.setLook(newKey(), { tint: 'auto', trail: 'classic', explosion: 'classic' }), null);
  assert.equal(store.profileCount, 0);
  const key = newKey();
  store.profile(key, 'Ace');
  assert.ok(store.setLook(key, { tint: 'auto', trail: 'classic', explosion: 'classic' }));
  assert.equal(store.profileCount, 1);
});

/** A server with one person ('a', with a profile) and a bot, collecting the person's profile events. */
function withBot(options: Partial<ServerOptions>) {
  const server = new GameServer(() => {}, { minPlayers: 2, ...options });
  const stats: StatEvent[] = [];
  server.onStat = (_id, _profile, _name, e) => stats.push(e);
  server.receive('a', { type: 'join', name: 'a', version: PROTOCOL_VERSION, spectate: false, profile: newKey() });
  const bot = [...(server as unknown as { bots: Map<string, unknown> }).bots.keys()][0] ?? '';
  const inner = server as unknown as { track(e: SimEvent): void; matchOver(): void };
  return { stats, bot, track: (e: object) => inner.track(e as SimEvent), matchOver: () => inner.matchOver() };
}

const killed = (playerId: string, killerId: string) => ({ type: 'killed', playerId, killerId, cause: 'rocket', midair: false, distance: 10, killerHealth: 100 });

test('beating bots earns XP on the main server, but not in a room someone opened', () => {
  const main = withBot({});
  assert.ok(main.bot, 'a bot filled in');
  main.track(killed(main.bot, 'a'));
  main.matchOver();
  assert.deepEqual(
    main.stats.map((e) => e.type),
    ['kill', 'match'],
  );

  const opened = withBot({ botRewards: false });
  opened.track(killed(opened.bot, 'a'));
  opened.track(killed('a', opened.bot));
  opened.matchOver();
  assert.deepEqual(
    opened.stats.map((e) => e.type),
    ['death'],
    'only the death counts: no kill, no match alone with bots',
  );
});

test('rooms that players open don’t reward bots, and their codes are random', () => {
  const rooms = new Rooms(() => {}, { maps: ['arena'] });
  const room = rooms.create(parseRoomRequest({ mode: 'ffa', map: 'arena', bots: 4, skill: 'easy' })!);
  assert.ok(!('error' in room));
  assert.equal(room.server.options.botRewards, false);
  assert.equal(rooms.main.server.options.botRewards, true);
});

test('laps on maps from the editor earn nothing (they can be made as short as you like)', () => {
  MAPS['custom-sec01'] = MAPS.arena;
  try {
    const custom = withBot({ maps: ['custom-sec01:race'], minPlayers: 2 });
    custom.track({ type: 'lap', playerId: 'a', time: 0.5, best: true });
    assert.deepEqual(custom.stats, []);
    const real = withBot({ maps: ['arena:race'] });
    real.track({ type: 'lap', playerId: 'a', time: 30, best: true });
    assert.equal(real.stats[0]?.type, 'lap');
  } finally {
    delete MAPS['custom-sec01'];
  }
});

test("a room whose tick throws is reported, and the others keep going", () => {
  const rooms = new Rooms(() => {}, { maps: ['arena'] });
  const broken = rooms.create(parseRoomRequest({ mode: 'ffa', map: 'arena' })!);
  assert.ok(!('error' in broken));
  broken.server.tick = () => {
    throw new Error('boom');
  };
  const errors: string[] = [];
  rooms.onError = (room) => errors.push(room.code);
  const other = rooms.create(parseRoomRequest({ mode: 'ffa', map: 'arena' })!);
  assert.ok(!('error' in other));
  let ticked = 0;
  other.server.tick = () => void ticked++;
  rooms.tick();
  assert.deepEqual(errors, [broken.code]);
  assert.equal(ticked, 1, 'the room after it still ticked');
});
