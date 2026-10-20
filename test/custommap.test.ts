import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CUSTOM_LIMITS, decodeMapCode, encodeMapCode, sanitizeMap } from '../src/shared/custommap';
import { MAPS } from '../src/shared/map';
import { parseRoomRequest, Rooms } from '../src/shared/rooms';
import './helpers';

// Maps from the editor: whatever arrives is made safe, survives a share code, and can host a room.

const tiny = {
  title: 'Tiny',
  boxes: [{ pos: [0, -0.5, 0], size: [40, 1, 40], color: 0x123456, mat: 'grid' }],
  spawns: [{ pos: [0, 1, 10], yaw: 0 }, { pos: [0, 1, -10], yaw: 3 }],
};

test('a custom map is checked and clamped', () => {
  assert.equal(sanitizeMap(null), null);
  assert.equal(sanitizeMap({ boxes: [], spawns: [] }), null, 'needs a box and a spawn');
  const map = sanitizeMap({
    ...tiny,
    title: '<script>alert(1)</script>',
    boxes: [...tiny.boxes, { pos: [1e9, NaN, 0], size: [-5, 1e9, 2], color: 'red', mat: 'lava' }, ...Array(2000).fill(tiny.boxes[0])],
    theme: 'nowhere',
  })!;
  assert.ok(map);
  assert.equal(map.boxes.length, CUSTOM_LIMITS.boxes);
  assert.ok(!map.title.includes('<'));
  const odd = map.boxes[1];
  assert.ok(Math.abs(odd.pos[0]) <= CUSTOM_LIMITS.extent && odd.pos[1] === 0, 'clamped');
  assert.ok(odd.size[0] > 0 && odd.size[1] <= CUSTOM_LIMITS.size);
  assert.equal(odd.mat, 'grid');
  assert.equal(map.theme, 'classic');
  assert.ok(map.killY < -0.5, 'falls kill below the floor');
});

test('a share code gives back the same map', async () => {
  const map = sanitizeMap(tiny)!;
  const code = await encodeMapCode(map);
  assert.match(code, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(await decodeMapCode(code), map);
  assert.equal(await decodeMapCode('not a code'), null);
});

test('a room opens on a custom map, and the map goes when the room does', () => {
  const rooms = new Rooms(() => {}, { minPlayers: 0 }, { maxRooms: 4, idleTimeout: 0.05 });
  const request = parseRoomRequest({ name: 'Mine', mode: 'ffa', map: 'custom', custom: tiny, bots: 0 });
  assert.ok(request?.custom);
  const room = rooms.create(request!);
  assert.ok(!('error' in room));
  const name = `custom-${room.code.toLowerCase()}`;
  assert.equal(MAPS[name]?.title, 'Tiny');
  assert.equal(room.server.mapName, name);
  for (let t = 0; t < 10; t++) rooms.tick();
  assert.equal(MAPS[name], undefined, 'gone with its room');
});
