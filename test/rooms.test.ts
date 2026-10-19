import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTOCOL_VERSION } from '../src/shared/config';
import type { ServerMessage } from '../src/shared/protocol';
import { MAIN_ROOM, parseRoomRequest, Rooms } from '../src/shared/rooms';
import './helpers';

// Rooms: opening them, finding them by code, listing the public ones, closing empty ones.

const request = (extra: object = {}) => parseRoomRequest({ name: 'Rob room', mode: 'ctf', map: 'temple', bots: 4, skill: 'hard', ...extra })!;

test('room requests are checked and filled in', () => {
  assert.equal(parseRoomRequest({ mode: 'nope', map: 'temple' }), null);
  assert.equal(parseRoomRequest({ mode: 'ffa', map: 'nowhere' }), null);
  assert.equal(parseRoomRequest('ctf'), null);
  const r = parseRoomRequest({ mode: 'tdm', map: 'rotation', bots: 99, skill: 'godlike', name: '\u0000'.repeat(3) })!;
  assert.deepEqual(r, { name: 'Team Deathmatch room', mode: 'tdm', map: 'rotation', bots: 0, skill: 'auto', private: false });
});

test('a room opens with a code, and plays what was asked for', () => {
  const rooms = new Rooms(() => {}, { maps: ['arena'] });
  const room = rooms.create(request());
  assert.ok(!('error' in room));
  assert.match(room.code, /^[A-HJKMNP-Z2-9]{5}$/);
  assert.equal(rooms.get(room.code.toLowerCase()), room, 'codes work in any case');
  assert.equal(rooms.get('main'), rooms.main);
  assert.equal(rooms.get('MAIN'), rooms.main);
  assert.equal(room.server.mapName, 'temple');
  assert.equal(room.server.mode, 'ctf');
});

test('private rooms are left out of the list; the main room comes first', () => {
  const rooms = new Rooms(() => {}, { maps: ['arena'] });
  const open = rooms.create(request({ name: 'Open' }));
  rooms.create(request({ name: 'Secret', private: true }));
  const list = rooms.list();
  assert.deepEqual(list.map((r) => r.name), ['Main', 'Open']);
  assert.equal(list[0].code, MAIN_ROOM);
  assert.ok(!('error' in open) && list[1].code === open.code);
});

test('there is a limit on rooms', () => {
  const rooms = new Rooms(() => {}, {}, { maxRooms: 2, idleTimeout: 120 });
  assert.ok(!('error' in rooms.create(request())));
  assert.ok('error' in rooms.create(request()));
});

test('an empty room closes after a while; the main one never does; a busy one stays', () => {
  const rooms = new Rooms(() => {}, {}, { maxRooms: 8, idleTimeout: 1 });
  const empty = rooms.create(request());
  const busy = rooms.create(request());
  assert.ok(!('error' in empty) && !('error' in busy));
  busy.server.receive('p1', { type: 'join', name: 'p1', version: PROTOCOL_VERSION, spectate: false });
  for (let t = 0; t < 90; t++) rooms.tick();
  assert.equal(rooms.get(empty.code), undefined);
  assert.equal(rooms.get(busy.code), busy);
  assert.equal(rooms.get(MAIN_ROOM), rooms.main);
});

test('messages from every room reach their own clients', () => {
  const inbox = new Map<string, ServerMessage[]>();
  const rooms = new Rooms((id, msg) => inbox.set(id, [...(inbox.get(id) ?? []), msg]), { maps: ['arena'], minPlayers: 0 });
  const other = rooms.create(request({ bots: 0 }));
  assert.ok(!('error' in other));
  rooms.main.server.receive('a', { type: 'join', name: 'a', version: PROTOCOL_VERSION, spectate: false });
  other.server.receive('b', { type: 'join', name: 'b', version: PROTOCOL_VERSION, spectate: false });
  for (let t = 0; t < 10; t++) rooms.tick();
  const welcome = (id: string) => inbox.get(id)?.find((m) => m.type === 'welcome');
  assert.equal(welcome('a')?.type === 'welcome' && welcome('a')?.map, 'arena');
  assert.equal(welcome('b')?.type === 'welcome' && welcome('b')?.map, 'temple');
  assert.ok(inbox.get('b')!.some((m) => m.type === 'snapshot'));
});
