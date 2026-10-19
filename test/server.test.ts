import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTOCOL_VERSION } from '../src/shared/config';
import type { ServerMessage, WelcomeMessage } from '../src/shared/protocol';
import { GameServer, type ServerOptions } from '../src/shared/server';
import './helpers';

// The server's rules: who gets in, who watches, bots and teams, and matches moving on.

function serve(options: Partial<ServerOptions>) {
  const inbox = new Map<string, ServerMessage[]>();
  const server = new GameServer((id, msg) => {
    if (!inbox.has(id)) inbox.set(id, []);
    inbox.get(id)!.push(msg);
  }, options);
  const join = (id: string, spectate = false) => server.receive(id, { type: 'join', name: id, version: PROTOCOL_VERSION, spectate });
  const welcome = (id: string) => inbox.get(id)?.filter((m): m is WelcomeMessage => m.type === 'welcome').at(-1);
  const rejected = (id: string) => inbox.get(id)?.some((m) => m.type === 'rejected') ?? false;
  return { server, join, welcome, rejected, inbox };
}

test('an old client is told to reload', () => {
  const { server, rejected } = serve({});
  server.receive('old', { type: 'join', name: 'old', version: PROTOCOL_VERSION - 1, spectate: false });
  assert.ok(rejected('old'));
});

test('a full server lets you watch, then in when a place comes free', () => {
  const { server, join, welcome } = serve({ maxPlayers: 1, minPlayers: 0 });
  join('a');
  join('b');
  assert.equal(welcome('a')?.spectator, false);
  assert.equal(welcome('b')?.spectator, true);
  assert.ok(!server.sim.players.has('b'));
  server.disconnect('a');
  assert.equal(welcome('b')?.spectator, false, 'let in');
  assert.ok(server.sim.players.has('b'));
});

test('watching and joining again', () => {
  const { server, join, welcome } = serve({ minPlayers: 4 });
  join('a');
  server.receive('a', { type: 'spectate', on: true });
  assert.equal(welcome('a')?.spectator, true);
  assert.equal(server.sim.players.size, 4, 'bots stay to be watched');
  assert.ok(!server.sim.players.has('a'));
  server.receive('a', { type: 'spectate', on: false });
  assert.equal(welcome('a')?.spectator, false);
  assert.equal(server.sim.players.size, 4, 'a bot made room');
});

test('bots fill in, step aside, and sit out races', () => {
  const { server, join } = serve({ minPlayers: 4, maps: ['arena:race', 'arena'] });
  join('a');
  assert.equal(server.sim.players.size, 1, 'no bots in a race');
  const ffa = serve({ minPlayers: 4 });
  ffa.join('a');
  ffa.join('b');
  assert.equal(ffa.server.sim.players.size, 4);
  ffa.server.disconnect('b');
  ffa.server.disconnect('a');
  assert.equal(ffa.server.sim.players.size, 0, 'bots leave with the last person');
});

test('teams are kept even', () => {
  const { server, join } = serve({ minPlayers: 6, mode: 'tdm' });
  join('a');
  join('b');
  join('c');
  const count = [0, 0];
  for (const p of server.sim.players.values()) count[p.team]++;
  assert.deepEqual(count, [3, 3]);
  server.disconnect('a');
  server.disconnect('b');
  const after = [0, 0];
  for (const p of server.sim.players.values()) after[p.team]++;
  assert.ok(Math.abs(after[0] - after[1]) <= 1, `teams ${after}`);
});

test('the rotation moves on to the next map and mode after the results', () => {
  const { server, join, welcome } = serve({ minPlayers: 0, maps: ['arena', 'temple:ctf'], timeLimit: 2, intermission: 1 });
  join('a');
  assert.equal(welcome('a')?.mode, 'ffa');
  for (let t = 0; t < 4 * 60; t++) server.tick();
  assert.equal(welcome('a')?.map, 'temple');
  assert.equal(welcome('a')?.mode, 'ctf');
  assert.equal(server.sim.players.get('a')?.team === 0 || server.sim.players.get('a')?.team === 1, true, 'on a team');
});

test('chat is rate limited', () => {
  const { server, join, inbox } = serve({ minPlayers: 0 });
  join('a');
  for (let i = 0; i < 5; i++) server.receive('a', { type: 'chat', text: `hi ${i}` });
  const lines = inbox.get('a')!.filter((m) => m.type === 'chat' && m.id === 'a');
  assert.equal(lines.length, 1);
});
