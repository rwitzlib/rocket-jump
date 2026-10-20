import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DT, ELIM, PROTOCOL_VERSION } from '../src/shared/config';
import type { ServerMessage, WelcomeMessage } from '../src/shared/protocol';
import { GameServer, type ServerOptions } from '../src/shared/server';
import { makeSim, place, run, settle } from './helpers';

// King of the hill, instagib, elimination rounds and duels.

test('king of the hill: alone on the hill scores, contested nobody does', () => {
  const sim = makeSim('arena', 'koth');
  const a = sim.addPlayer('a');
  const b = sim.addPlayer('b');
  const hill = sim.rules.hill;
  place(a, hill.x, hill.y + 1, hill.z);
  place(b, 40, 1, 40);
  settle(sim, a);
  run(sim, 60);
  assert.ok(a.points > 0.9, `a held it ${a.points.toFixed(2)} s`);
  const before = a.points;
  place(b, hill.x + 1, hill.y + 1, hill.z);
  settle(sim, b);
  place(a, hill.x - 1, hill.y + 1, hill.z);
  run(sim, 60);
  assert.ok(a.points - before < 0.5, 'contested: no more points');
  assert.equal(b.points, 0);
});

test('instagib: everyone carries the Hypersonic, and a hit kills through armor', () => {
  const sim = makeSim('arena', 'instagib');
  const a = sim.addPlayer('a');
  const b = sim.addPlayer('b');
  assert.equal(a.primary, 'hypersonic');
  b.protectedFor = 0;
  b.armor = 100;
  const events: never[] = [];
  sim.damage(b, 40, 'a', events, 'hypersonic');
  assert.equal(b.alive, false);
});

function serve(options: Partial<ServerOptions>) {
  const inbox = new Map<string, ServerMessage[]>();
  const server = new GameServer((id, msg) => {
    if (!inbox.has(id)) inbox.set(id, []);
    inbox.get(id)!.push(msg);
  }, options);
  const join = (id: string) => server.receive(id, { type: 'join', name: id, version: PROTOCOL_VERSION, spectate: false });
  const welcome = (id: string) => inbox.get(id)?.filter((m): m is WelcomeMessage => m.type === 'welcome').at(-1);
  return { server, join, welcome };
}

test('elimination: no respawns until one team is out, then the round goes to the other', () => {
  const { server, join } = serve({ maps: ['arena:elim'], minPlayers: 4 });
  join('a');
  const sim = server.sim;
  const red = [...sim.players.values()].filter((p) => p.team === 0);
  assert.ok(red.length >= 1);
  for (const p of red) {
    p.protectedFor = 0;
    sim.kill(p, null, 'fall', []);
  }
  for (let t = 0; t < 30; t++) server.tick();
  assert.deepEqual([...sim.teamScores], [0, 1], 'blue took the round');
  assert.ok(red.every((p) => !p.alive), 'nobody came back mid-round');
  for (let t = 0; t < (ELIM.between + 0.5) / DT; t++) server.tick();
  assert.ok([...sim.players.values()].every((p) => p.alive), 'everyone back for the next round');
  assert.equal(server.status().match.round, 2);
});

test('duel: two play, the third waits, and the loser goes back in line', () => {
  const { server, join, welcome } = serve({ maps: ['arena:duel'], minPlayers: 0, intermission: 1 });
  join('a');
  join('b');
  join('c');
  assert.equal(welcome('c')?.spectator, true, 'c waits');
  server.sim.players.get('a')!.kills = 10; // a wins
  for (let t = 0; t < 3 / DT; t++) server.tick();
  assert.equal(welcome('b')?.spectator, true, 'b lost and waits');
  assert.equal(welcome('c')?.spectator, false, 'c is up');
  assert.equal(welcome('a')?.spectator, false, 'the winner stays');
});
