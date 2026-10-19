import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTOCOL_VERSION } from '../src/shared/config';
import { parseClientMessage, type ClientMessage, type ServerMessage, type SnapshotMessage } from '../src/shared/protocol';
import { GameServer } from '../src/shared/server';
import { decodeClientMessage, encodeClientMessage, WireDecoder, WireEncoder } from '../src/shared/wire';
import './helpers';

// The wire format: what goes in comes out, delta-coded or not, and anything malformed is refused.

/** A short bot match's snapshots, as one listening client gets them. */
function snapshots(map: string, mode: 'ffa' | 'ctf', seconds: number): SnapshotMessage[] {
  const out: SnapshotMessage[] = [];
  const server = new GameServer((_, msg) => msg.type === 'snapshot' && out.push(msg), { maps: [map], mode, minPlayers: 6, botSkill: 'hard' });
  server.receive('c1', { type: 'join', name: 'listener', version: PROTOCOL_VERSION, spectate: false });
  for (let t = 0; t < seconds * 60; t++) server.tick();
  return out;
}

/** Equal, allowing for 32-bit floats and respawn timers sent to the tenth. */
function assertClose(a: unknown, b: unknown, path = 'snapshot') {
  if (typeof a === 'number' && typeof b === 'number') {
    // (Respawn timers go to the tenth, other players' projectiles to the millimeter.)
    const tolerance = /pickups|items/.test(path) ? 0.051 : /projectiles.*\.pos/.test(path) ? 0.0006 : Math.max(2e-6, Math.abs(a) * 2e-7);
    assert.ok(Math.abs(a - b) <= tolerance, `${path}: sent ${a}, got ${b}`);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    assert.equal(b.length, a.length, `${path}: length`);
    a.forEach((x, i) => assertClose(x, b[i], `${path}[${i}]`));
  } else if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      assertClose((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
    }
  } else if (!(a === '' && b === null)) assert.equal(b, a, path);
}

for (const [map, mode] of [['citadel', 'ffa'], ['arena', 'ctf']] as const) {
  test(`snapshots of a ${mode} match on ${map} decode to what was sent, full and delta-coded`, () => {
    const sent = snapshots(map, mode, 15);
    const encoder = new WireEncoder();
    const decoder = new WireDecoder();
    let deltas = 0;
    sent.forEach((msg, i) => {
      if (i >= 3) encoder.ack(sent[i - 3].tick); // the client's acks run a few snapshots behind
      const bytes = encoder.encode(msg) as Uint8Array;
      if (i >= 3) deltas++;
      assertClose(JSON.parse(JSON.stringify(msg)), JSON.parse(JSON.stringify(decoder.decode(bytes))));
    });
    assert.ok(deltas > 100);
  });
}

test('delta-coded snapshots are much smaller than JSON', () => {
  const sent = snapshots('citadel', 'ffa', 10);
  const encoder = new WireEncoder();
  let json = 0;
  let binary = 0;
  sent.forEach((msg, i) => {
    if (i) encoder.ack(sent[i - 1].tick);
    json += JSON.stringify(msg).length;
    binary += (encoder.encode(msg) as Uint8Array).length;
  });
  assert.ok(binary * 8 < json, `binary ${binary} B against JSON ${json} B`);
});

test('a snapshot whose baseline the client never got is refused, and the next full one works', () => {
  const sent = snapshots('arena', 'ffa', 2);
  const encoder = new WireEncoder();
  const first = encoder.encode(sent[0]);
  encoder.ack(sent[0].tick);
  const delta = encoder.encode(sent[1]);
  assert.throws(() => new WireDecoder().decode(delta as Uint8Array));
  const decoder = new WireDecoder();
  decoder.decode(first as Uint8Array);
  assert.equal((decoder.decode(delta as Uint8Array) as SnapshotMessage).tick, sent[1].tick);
});

test('a welcome starts the coding over on both sides', () => {
  const sent = snapshots('arena', 'ffa', 1);
  const encoder = new WireEncoder();
  encoder.encode(sent[0]);
  encoder.ack(sent[0].tick);
  const welcome: ServerMessage = { type: 'welcome', id: 'c1', tick: 1, map: 'arena', mode: 'ffa', spectator: false, match: sent[0].match };
  assert.equal(typeof encoder.encode(welcome), 'string');
  const after = encoder.encode(sent[1]) as Uint8Array;
  const decoder = new WireDecoder();
  assert.equal((decoder.decode(after) as SnapshotMessage).tick, sent[1].tick, 'full again: decodes with no history');
});

test('inputs round-trip exactly, so prediction matches the server', () => {
  const msg: ClientMessage = {
    type: 'input',
    snap: 1234,
    frames: [
      { seq: 100, input: { forward: 1, right: -1, jump: true, fire: false, grapple: true, use: false, down: true, yaw: Math.fround(2.345), pitch: Math.fround(-0.4), view: 98765.43 } },
      { seq: 101, input: { forward: 0, right: 0, jump: false, fire: true, grapple: false, use: true, down: false, yaw: Math.fround(-1), pitch: 0 } },
    ],
  };
  const decoded = parseClientMessage(decodeClientMessage(encodeClientMessage(msg)));
  assert.deepEqual(decoded, msg);
});

test('chat, joins and acks survive the trip too', () => {
  for (const msg of [
    { type: 'chat', text: 'gg' },
    { type: 'join', name: 'Rob', version: PROTOCOL_VERSION, spectate: true },
    { type: 'ack', tick: 42 },
    { type: 'spectate', on: false },
  ] as ClientMessage[]) {
    assert.deepEqual(parseClientMessage(decodeClientMessage(encodeClientMessage(msg))), msg);
  }
});

test('garbage from a client is refused or made harmless', () => {
  assert.equal(decodeClientMessage(new Uint8Array([2, 0x80, 0x80, 0x80])), null, 'truncated binary');
  assert.equal(decodeClientMessage(new Uint8Array([99])), null, 'unknown message');
  assert.equal(decodeClientMessage('{not json'), null);
  assert.equal(parseClientMessage({ type: 'nope' }), null);
  assert.equal(parseClientMessage(null), null);
  const input = parseClientMessage({ type: 'input', frames: [{ seq: 5, input: { forward: 9, yaw: NaN, pitch: 99, jump: 'yes' } }, { seq: -1 }] });
  assert.ok(input && input.type === 'input');
  assert.equal(input.frames.length, 1, 'a negative seq is dropped');
  const i = input.frames[0].input;
  assert.equal(i.forward, 1);
  assert.equal(i.yaw, 0);
  assert.equal(i.pitch, Math.PI / 2);
  assert.equal(i.jump, false);
  const join = parseClientMessage({ type: 'join', name: '  a\u0000‮b  c '.repeat(5), version: PROTOCOL_VERSION });
  assert.ok(join && join.type === 'join');
  assert.ok(join.name.length <= 16 && !/[\u0000‮]/.test(join.name));
});
