import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NetClient } from '../src/client/net/netclient';
import { MAPS } from '../src/shared/map';
import { PROTOCOL_VERSION } from '../src/shared/config';
import { parseClientMessage, type ClientMessage, type ServerMessage } from '../src/shared/protocol';
import { GameServer } from '../src/shared/server';
import { GameSim } from '../src/shared/sim';
import type { PlayerInput } from '../src/shared/types';
import { decodeClientMessage, encodeClientMessage, WireDecoder, WireEncoder } from '../src/shared/wire';
import { input } from './helpers';

// Client prediction against the real server, through the real wire format, with latency: the
// client simulates its own player ahead of the server and should agree with it to the millimeter,
// through running, rocket jumps and grapples.

/** A client and a server joined by a fake link `delay` ticks long each way, stepped in lockstep. */
function connect(delay: number, bots: number) {
  const encoder = new WireEncoder();
  const decoder = new WireDecoder();
  const down: { at: number; data: string | Uint8Array }[] = [];
  const up: { at: number; data: string | Uint8Array }[] = [];
  let tick = 0;
  const server = new GameServer((_, msg) => down.push({ at: tick + delay, data: encoder.encode(msg) }), { maps: ['arena'], minPlayers: bots + 1, botSkill: 'normal' });
  const send = (msg: ClientMessage) => up.push({ at: tick + delay, data: encodeClientMessage(msg) });
  send({ type: 'join', name: 'tester', version: PROTOCOL_VERSION, spectate: false });
  const sim = new GameSim(MAPS.arena);
  let client: NetClient | null = null;
  let worst = 0;

  const deliver = () => {
    while (up.length && up[0].at <= tick) {
      const msg = parseClientMessage(decodeClientMessage(up.shift()!.data));
      if (msg?.type === 'input' && msg.snap) encoder.ack(msg.snap);
      if (msg) server.receive('c1', msg);
    }
    while (down.length && down[0].at <= tick) {
      const msg: ServerMessage = decoder.decode(down.shift()!.data);
      if (msg.type === 'welcome') client ??= new NetClient(sim, msg.id, send);
      if (msg.type === 'ping') send({ type: 'pong', t: msg.t });
      if (msg.type === 'snapshot' && client) {
        client.receive(msg);
        worst = Math.max(worst, client.stats.lastError);
      }
    }
  };

  /** One tick: the link delivers, the client predicts this input (once it's in) and draws a frame, the server steps. */
  const step = (i: Partial<PlayerInput>) => {
    deliver();
    client?.predict(input(i));
    client?.update(1 / 60, (tick * 1000) / 60); // what the game does every frame: places crates and other players
    server.tick();
    tick++;
  };
  return {
    step,
    get client() {
      return client;
    },
    get worst() {
      return worst;
    },
    resetWorst() {
      worst = 0;
    },
  };
}

for (const delay of [0, 3, 6]) {
  test(`prediction agrees with the server, ${delay} ticks of latency each way`, () => {
    const link = connect(delay, 2);
    for (let t = 0; t < 120; t++) link.step({}); // joined, spawned, protection over
    assert.ok(link.client, 'joined');
    link.resetWorst();
    let yaw = 0;
    for (let t = 0; t < 600; t++) {
      yaw += 0.01;
      const rocketJump = t % 120 === 30;
      link.step({
        forward: 1,
        right: Math.sin(t / 20),
        jump: t % 60 < 30,
        fire: rocketJump,
        pitch: rocketJump ? -1.5 : 0.25,
        yaw,
        grapple: t % 200 > 150,
      });
    }
    // Bots can shove us (their rockets): that's a real correction the client couldn't know about.
    // Anything else should agree to well under a centimeter.
    assert.ok(link.client!.stats.corrections < 40, `${link.client!.stats.corrections} corrections`);
  });
}

test('with nobody else around, the client and server agree exactly', () => {
  const link = connect(4, 0);
  for (let t = 0; t < 120; t++) link.step({});
  link.resetWorst();
  for (let t = 0; t < 600; t++) {
    const rocketJump = t % 90 === 10;
    link.step({ forward: 1, right: Math.cos(t / 15), jump: t % 50 < 25, fire: rocketJump, pitch: rocketJump ? -1.5 : 0.3, yaw: t / 80, grapple: t % 150 > 100 });
  }
  assert.ok(link.worst < 0.001, `worst correction ${(link.worst * 1000).toFixed(2)} mm`);
});
