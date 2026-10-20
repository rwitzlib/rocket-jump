import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PROTOCOL_VERSION } from '../src/shared/config';
import {
  allowedLook,
  applyStat,
  challengesFor,
  dayKey,
  decodeLook,
  encodeLook,
  levelOf,
  newProfile,
  viewProfile,
  weekKey,
  xpForLevel,
  type StatEvent,
} from '../src/shared/progress';
import { GameServer } from '../src/shared/server';
import { Store } from '../src/server/store';
import './helpers';

// Profiles: levels, XP, challenges, looks, the saved store, and the game server reporting stats.

test('levels follow the XP curve', () => {
  assert.equal(levelOf(0), 1);
  assert.equal(levelOf(99), 1);
  assert.equal(levelOf(100), 2);
  assert.equal(levelOf(xpForLevel(20)), 20);
  assert.equal(levelOf(xpForLevel(20) - 1), 19);
});

test('kills, airshots and wins earn XP and count in the stats', () => {
  const p = newProfile('x', 'Ace', Date.now());
  const g = applyStat(p, { type: 'kill', airshot: true, cause: 'rocket', streak: 1 }, Date.now());
  assert.equal(g.xp >= 25, true);
  assert.equal(p.stats.kills, 1);
  assert.equal(p.stats.airshots, 1);
  applyStat(p, { type: 'match', mode: 'ffa', won: true, place: 1, players: 6 }, Date.now());
  assert.equal(p.stats.wins, 1);
  assert.ok(p.xp >= 125);
});

test('challenges are the same for everyone on a day, and complete once', () => {
  const day = dayKey(Date.UTC(2026, 9, 19));
  assert.deepEqual(challengesFor(day).map((c) => c.id), challengesFor(day).map((c) => c.id));
  assert.equal(new Set(challengesFor(day).map((c) => c.id)).size, 3, 'three different ones');
  assert.equal(weekKey(Date.UTC(2026, 9, 21)), '2026-10-19', 'weeks start on Monday');
  // Do whatever today's first challenge asks, enough times.
  const now = Date.UTC(2026, 9, 19, 12);
  const p = newProfile('x', 'Ace', now);
  const want = challengesFor(dayKey(now))[0];
  const events: Record<string, StatEvent> = {
    kills: { type: 'kill', airshot: false, cause: 'rocket', streak: 1 },
    airshots: { type: 'kill', airshot: true, cause: 'rocket', streak: 1 },
    matches: { type: 'match', mode: 'ffa', won: false, place: 4, players: 6 },
    wins: { type: 'match', mode: 'ffa', won: true, place: 1, players: 6 },
    captures: { type: 'capture' },
    laps: { type: 'lap', map: 'arena', time: 30, best: true, path: [] },
    grenades: { type: 'kill', airshot: false, cause: 'grenade', streak: 1 },
    hypersonic: { type: 'kill', airshot: false, cause: 'hypersonic', streak: 1 },
    seekers: { type: 'kill', airshot: false, cause: 'stinger', streak: 1 },
    falls: { type: 'kill', airshot: false, cause: 'fall', streak: 1 },
    streak: { type: 'kill', airshot: false, cause: 'rocket', streak: 5 },
  };
  let completions = 0;
  for (let i = 0; i < want.daily + 3; i++) completions += applyStat(p, events[want.id], now).completed.filter((c) => c.startsWith('Daily')).length;
  assert.ok(completions >= 1);
  const view = viewProfile(p, now);
  assert.equal(view.daily[0].progress, view.daily[0].target);
  // The next day brings new ones, from zero.
  assert.equal(viewProfile(p, now + 86400000).daily[0].progress, 0);
});

test('looks are limited to what the level has unlocked', () => {
  assert.deepEqual(allowedLook({ tint: 'gold', trail: 'rainbow' }, 1), { tint: 'auto', trail: 'classic' });
  assert.deepEqual(allowedLook({ tint: 'gold', trail: 'ember' }, 20), { tint: 'gold', trail: 'ember' });
  assert.deepEqual(decodeLook(encodeLook({ tint: 'teal', trail: 'frost' })), { tint: 'teal', trail: 'frost' });
  assert.deepEqual(decodeLook('nonsense'), { tint: 'auto', trail: 'classic' });
});

test('the store keeps profiles and race records across a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rj-'));
  try {
    const key = 'a'.repeat(32);
    const store = new Store(dir);
    store.apply(key, 'Racer', { type: 'lap', map: 'arena', time: 31.5, best: true, path: [1, 2, 3] });
    store.apply('b'.repeat(32), 'Slower', { type: 'lap', map: 'arena', time: 40, best: true, path: [] });
    store.apply(key, 'Racer', { type: 'kill', airshot: false, cause: 'rocket', streak: 1 });
    store.save();
    const again = new Store(dir);
    assert.equal(again.find(key)?.stats.kills, 1);
    const board = again.board('arena');
    assert.deepEqual(board.laps.map((l) => l.name), ['Racer', 'Slower']);
    assert.deepEqual(board.ghost?.path, [1, 2, 3]);
    assert.equal(again.rank('arena', Store.idOf(key)), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the game server reports kills for players with a profile', () => {
  const server = new GameServer(() => {}, { minPlayers: 0 });
  const stats: string[] = [];
  server.onStat = (id, profile, _name, e) => stats.push(`${id}:${profile.slice(0, 2)}:${e.type}`);
  server.receive('a', { type: 'join', name: 'a', version: PROTOCOL_VERSION, spectate: false, profile: 'c'.repeat(32) });
  server.receive('b', { type: 'join', name: 'b', version: PROTOCOL_VERSION, spectate: false });
  const victim = server.sim.players.get('b')!;
  victim.protectedFor = 0;
  // (into the events the next tick reports)
  server.sim.damage(victim, 500, 'a', (server.sim as unknown as { pendingEvents: never[] }).pendingEvents, 'rocket');
  server.tick();
  assert.ok(stats.includes('a:cc:kill'), stats.join());
  assert.ok(!stats.some((s) => s.startsWith('b:')), 'no profile, no stats');
});
