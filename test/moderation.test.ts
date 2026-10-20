import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DT, PROTOCOL_VERSION } from '../src/shared/config';
import { isOffensive, maskChat } from '../src/shared/moderation';
import type { ChatMessage, ServerMessage, WelcomeMessage } from '../src/shared/protocol';
import { GameServer, type ServerOptions } from '../src/shared/server';
import './helpers';

// Reconnecting after a dropped connection, vote kicks and the word filter.

function serve(options: Partial<ServerOptions>) {
  const inbox = new Map<string, ServerMessage[]>();
  const server = new GameServer((id, msg) => {
    if (!inbox.has(id)) inbox.set(id, []);
    inbox.get(id)!.push(msg);
  }, options);
  const join = (id: string, name = id) => server.receive(id, { type: 'join', name, version: PROTOCOL_VERSION, spectate: false });
  const welcome = (id: string) => inbox.get(id)?.filter((m): m is WelcomeMessage => m.type === 'welcome').at(-1);
  const said = (id: string) => (inbox.get(id) ?? []).filter((m): m is ChatMessage => m.type === 'chat').map((m) => m.text);
  const chat = (id: string, text: string) => server.receive(id, { type: 'chat', text });
  return { server, join, welcome, said, chat, inbox };
}

test('a dropped player is held, and comes back as themselves with their token', () => {
  const { server, join, welcome } = serve({ minPlayers: 0, reconnectGrace: 10 });
  join('a');
  const token = welcome('a')!.token!;
  assert.ok(token);
  server.sim.players.get('a')!.kills = 3;
  server.disconnect('a');
  assert.ok(server.sim.players.has('a'), 'held');
  assert.equal(server.resume('nonsense'), null);
  assert.equal(server.resume(token), 'a');
  server.receive('a', { type: 'join', name: 'a', version: PROTOCOL_VERSION, spectate: false, resume: token });
  assert.equal(server.sim.players.get('a')!.kills, 3, 'kept their score');
  assert.equal(welcome('a')!.token, token);
});

test('a dropped player is let go once the grace runs out', () => {
  const { server, join } = serve({ minPlayers: 0, reconnectGrace: 1 });
  join('a');
  join('b');
  server.disconnect('a');
  for (let t = 0; t < 1.2 / DT; t++) server.tick();
  assert.ok(!server.sim.players.has('a'));
});

test('without a grace, a dropped player leaves at once', () => {
  const { server, join } = serve({ minPlayers: 0 });
  join('a');
  server.disconnect('a');
  assert.ok(!server.sim.players.has('a'));
});

test('a vote kick needs a majority of the others, and kicks', () => {
  const { server, join, chat, inbox } = serve({ minPlayers: 0 });
  const kicked: string[] = [];
  server.onKick = (id) => kicked.push(id);
  for (const id of ['a', 'b', 'c', 'troll']) join(id);
  chat('a', '/votekick tro');
  assert.equal(kicked.length, 0, 'one of three is not a majority');
  chat('troll', '/yes');
  chat('b', '/yes');
  assert.deepEqual(kicked, ['troll']);
  assert.ok(!server.sim.players.has('troll'));
  assert.ok(inbox.get('troll')!.some((m) => m.type === 'rejected'));
});

test('a vote fails once enough say no', () => {
  const { server, join, chat, said } = serve({ minPlayers: 0 });
  for (const id of ['a', 'b', 'c', 'd']) join(id);
  chat('a', '/votekick d');
  chat('b', '/no');
  chat('c', '/no');
  assert.ok(server.sim.players.has('d'));
  assert.ok(said('a').some((t) => t.includes('failed')));
});

test('two people are too few for a vote', () => {
  const { join, chat, said } = serve({ minPlayers: 0 });
  join('a');
  join('b');
  chat('a', '/votekick b');
  assert.ok(said('a').some((t) => t.includes('too few')));
});

test('names and chat are filtered', () => {
  assert.ok(isOffensive('xXn1gg3rXx'));
  assert.ok(!isOffensive('Spicy Sniper'));
  assert.equal(maskChat('nice shot'), 'nice shot');
  assert.notEqual(maskChat('f.u.c.k off'), 'f.u.c.k off');
  const { join, server } = serve({ minPlayers: 0 });
  join('a', 'sh1tlord');
  assert.ok(!server.status().players[0].toLowerCase().includes('sh'), 'renamed');
});
