import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import './helpers';
import { PROTOCOL_VERSION } from '../src/shared/config';
import { GameServer, type MatchReport } from '../src/shared/server';
import { Analytics, cleanOrigin, parseFilter, statsPage } from '../src/server/analytics';
import { clientCountry } from '../src/server/guard';

// The server's numbers: weapon balance from the game server's match reports, where visitors come
// from, and the stats page that shows it all.

const pending = (server: GameServer) => (server.sim as unknown as { pendingEvents: never[] }).pendingEvents;

/** Two people and a bot on the arena; 'a' kills 'b' and the bot with rockets, which ends the match. */
function playMatch(): MatchReport[] {
  const server = new GameServer(() => {}, { minPlayers: 3, fragLimit: 2 });
  const reports: MatchReport[] = [];
  server.onMatchReport = (r) => reports.push(r);
  server.receive('a', { type: 'join', name: 'a', version: PROTOCOL_VERSION, spectate: false });
  server.receive('b', { type: 'join', name: 'b', version: PROTOCOL_VERSION, spectate: false });
  const bot = [...server.sim.players.keys()].find((id) => id.startsWith('bot'))!;
  for (let i = 0; i < 60; i++) server.tick(); // a second holding rockets
  for (const id of ['b', bot]) {
    const victim = server.sim.players.get(id)!;
    victim.protectedFor = 0;
    server.sim.damage(victim, 500, 'a', pending(server), 'rocket');
  }
  // The bot hits back: that's no one's tally but counts as a's death.
  const a = server.sim.players.get('a')!;
  a.protectedFor = 0;
  server.sim.damage(a, 500, bot, pending(server), 'grenade');
  server.tick(); // a reaches the frag limit
  return reports;
}

test('a match report counts what people did with each weapon, and leaves bots out', () => {
  const [r] = playMatch();
  assert.ok(r, 'reported');
  assert.equal(r.map, 'arena');
  assert.equal(r.finished, true);
  assert.equal(r.people.length, 2, 'the two people, not the bot');
  const [a, b] = r.people;
  assert.equal(a.weapons.rocket.kills, 2);
  assert.equal(a.weapons.rocket.hits, 2);
  assert.ok(a.weapons.rocket.damage > 0);
  assert.ok(a.weapons.rocket.held >= 0.9, `held ${a.weapons.rocket.held}`);
  assert.equal(a.weapons.grenade.deaths, 1, 'killed by the bot');
  assert.equal(a.kills, 2);
  assert.equal(b.weapons.rocket.deaths, 1);
  assert.equal(a.won, true);
  assert.equal(a.place, 1);
  assert.equal(r.matchups.rocket.rocket, 2);
  assert.equal(r.matchups.grenade.rocket, 1, 'the bot on a person counts in the matchups');
});

test('a match everyone leaves is reported once, unfinished; races and editor maps not at all', () => {
  const server = new GameServer(() => {}, { minPlayers: 0 });
  const reports: MatchReport[] = [];
  server.onMatchReport = (r) => reports.push(r);
  server.receive('a', { type: 'join', name: 'a', version: PROTOCOL_VERSION, spectate: false });
  server.tick();
  server.disconnect('a');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].finished, false);
  assert.equal(reports[0].people[0].place, null);

  const race = new GameServer(() => {}, { minPlayers: 0, maps: ['arena:race'] });
  race.onMatchReport = () => assert.fail('races have no fighting to report');
  race.receive('a', { type: 'join', name: 'a', version: PROTOCOL_VERSION, spectate: false });
  race.tick();
  race.disconnect('a');
});

test('the numbers sum match reports into weapon rows and a page', () => {
  const analytics = new Analytics(null);
  for (const r of playMatch()) analytics.fights(r);
  analytics.session('someone', 30, 'ffa', 'arena', 'DE');
  analytics.session('someone', 600, 'ffa', 'arena', 'DE');
  analytics.connected(3);
  analytics.event('visit', cleanOrigin({ tz: 'Europe/Berlin', ref: 'www.Reddit.com' }, 'DE', 'de-DE,de;q=0.9'));
  const view = analytics.view(parseFilter(new URLSearchParams('days=7')));
  assert.equal(view.totals.players, 1);
  assert.equal(view.totals.newPlayers, 1);
  assert.equal(view.totals.peak, 3);
  assert.equal(view.audience.ref['reddit.com'], 1);
  assert.equal(view.audience.tz['Europe/Berlin'], 1);
  assert.equal(view.audience.lang.de, 1);
  assert.equal(view.audience.sessionCountry.DE, 2);
  const rocket = view.weapons.rows.find((r) => r.id === 'rocket')!;
  assert.equal(rocket.kills, 2);
  assert.equal(rocket.main, 1, "a's main weapon");
  assert.equal(rocket.winRate, 1);
  assert.equal(rocket.verdict, 'needs data');
  assert.equal(view.maps.rows[0].matches, 1);
  // Filtering by another mode leaves the weapons empty.
  assert.equal(analytics.view(parseFilter(new URLSearchParams('mode=ctf'))).weapons.rows.find((r) => r.id === 'rocket')!.kills, 0);
  const page = statsPage(view, { profiles: 0, rooms: 1, connected: 0, hottest: analytics.hottest() });
  assert.match(page, /Weapon balance/);
  assert.match(page, /Rocket Launcher/);
  assert.match(page, /reddit\.com/);
  assert.doesNotMatch(page, /<script/i, 'the page runs under a CSP without inline scripts');
});

test('what a visit says about where it came from is checked', () => {
  assert.deepEqual(cleanOrigin({ tz: '__proto__', ref: '<script>', utm: 'x y' }, null, undefined), { country: null, lang: null, tz: null, ref: null });
  assert.equal(cleanOrigin({ utm: 'Discord', ref: 'reddit.com' }, null, undefined).ref, 'utm:discord', 'a campaign wins over the referrer');
  assert.equal(cleanOrigin({ tz: 'America/Argentina/Buenos_Aires' }, null, undefined).tz, 'America/Argentina/Buenos_Aires');
  assert.deepEqual(parseFilter(new URLSearchParams('days=999&map=<x>&games=nope')), { days: 30, map: '', mode: '', games: 'all' });
});

test("a country is only taken from Cloudflare's header on requests that came through Cloudflare", () => {
  const req = (remote: string, country: string) => ({ socket: { remoteAddress: remote }, headers: { 'cf-ipcountry': country } }) as unknown as IncomingMessage;
  assert.equal(clientCountry(req('172.68.1.20', 'de'), 0, true), 'DE');
  assert.equal(clientCountry(req('198.51.100.7', 'DE'), 0, true), null, 'not from Cloudflare: anyone could write it');
  assert.equal(clientCountry(req('172.68.1.20', 'DE'), 0, false), null, 'Cloudflare not trusted');
  assert.equal(clientCountry(req('172.68.1.20', 'XX'), 0, true), null);
});
