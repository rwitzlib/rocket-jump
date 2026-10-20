import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTOCOL_VERSION, THUNDER } from '../src/shared/config';
import type { SnapshotMessage } from '../src/shared/protocol';
import { GameServer } from '../src/shared/server';
import { WireDecoder, WireEncoder } from '../src/shared/wire';
import { makeSim, place, run, settle } from './helpers';

// The Thunder Gun: a cone of air that throws people far for little damage, kicks the shooter back
// hard enough to jump with, and has one shot before each reload.

/** Two players on the arena floor, `a` holding a Thunder Gun and looking down -Z at `b`, `gap` meters off. */
function duel(gap: number, side = 0) {
  const sim = makeSim();
  const a = sim.addPlayer('a');
  const b = sim.addPlayer('b');
  place(a, 0, 1, 30);
  place(b, side, 1, 30 - gap);
  settle(sim, a);
  settle(sim, b);
  a.protectedFor = b.protectedFor = 0;
  a.primary = 'thunder';
  return { sim, a, b };
}

test('a shot at your feet is a jump about as big as a rocket jump', () => {
  const height = (weapon: 'rocket' | 'thunder') => {
    const sim = makeSim();
    const p = sim.addPlayer('a');
    place(p, 0, 1, 40);
    settle(sim, p);
    p.primary = weapon;
    const start = p.pos.y;
    let top = start;
    run(sim, 1, { a: { jump: true, fire: true, pitch: -Math.PI / 2 + 0.01 } });
    for (let t = 0; t < 180; t++) {
      run(sim, 1);
      top = Math.max(top, p.pos.y);
    }
    return { rise: top - start, health: p.health };
  };
  const rocket = height('rocket');
  const thunder = height('thunder');
  assert.ok(thunder.rise > rocket.rise * 0.8, `thunder jump ${thunder.rise.toFixed(2)} m against a rocket jump of ${rocket.rise.toFixed(2)} m`);
  assert.equal(thunder.health, 100);
});

test('someone close in front is thrown far for light damage, and the shooter is kicked back', () => {
  const { sim, a, b } = duel(5);
  const events = run(sim, 1, { a: { fire: true, yaw: 0, pitch: 0 } });
  assert.ok(b.vel.z < -25, `thrown away at ${b.vel.z.toFixed(1)} m/s`);
  assert.ok(b.vel.y > 5, 'and up');
  assert.ok(a.vel.z > THUNDER.recoil * 0.9, 'the shooter is kicked back');
  assert.ok(b.health < 100 && b.health > 60, `took ${100 - b.health}`);
  assert.equal(a.health, 100);
  const knock = events.find((e) => e.type === 'knockback' && e.playerId === 'b');
  assert.ok(knock && knock.type === 'knockback' && knock.strength < 0.9, 'never counts as a direct hit');
});

test('the push falls off with distance, and nothing outside the cone is touched', () => {
  const near = duel(4);
  run(near.sim, 1, { a: { fire: true, yaw: 0, pitch: 0 } });
  const far = duel(13);
  run(far.sim, 1, { a: { fire: true, yaw: 0, pitch: 0 } });
  assert.ok(far.b.vel.length() > 5, 'still reaches near the end of the cone');
  assert.ok(far.b.vel.length() < near.b.vel.length() * 0.75, 'but weaker');

  for (const { gap, side, why } of [
    { gap: THUNDER.range + 4, side: 0, why: 'out of range' },
    { gap: 4, side: 6, why: 'off to the side' },
    { gap: -5, side: 0, why: 'behind' },
  ]) {
    const { sim, b } = duel(gap, side);
    run(sim, 1, { a: { fire: true, yaw: 0, pitch: 0 } });
    assert.equal(b.health, 100, why);
    assert.ok(Math.hypot(b.vel.x, b.vel.z) < 0.5, `${why}: not pushed`);
  }
});

test('one shot in the mag, then a reload', () => {
  const { sim } = duel(40);
  const shots = (seconds: number) =>
    run(sim, Math.round(seconds * 60), { a: { fire: true, yaw: 0, pitch: 0 } }).filter((e) => e.type === 'fired').length;
  assert.equal(shots(THUNDER.reload - 0.2), 1, 'holding fire through the reload fires once');
  assert.equal(shots(0.4), 1, 'and again once it has reloaded');
});

test('Thunder Gun blasts decode to what was sent', () => {
  const out: SnapshotMessage[] = [];
  const server = new GameServer((_, msg) => msg.type === 'snapshot' && out.push(msg), { maps: ['arena'], mode: 'ffa', minPlayers: 6, botSkill: 'hard' });
  server.receive('c1', { type: 'join', name: 'listener', version: PROTOCOL_VERSION, spectate: false });
  for (let t = 0; t < 20 * 60; t++) {
    // Every bot keeps a Thunder Gun.
    for (const p of server.sim.players.values()) if (p.id !== 'c1') p.primary = 'thunder';
    server.tick();
  }
  const encoder = new WireEncoder();
  const decoder = new WireDecoder();
  let blasts = 0;
  out.forEach((msg, i) => {
    if (i) encoder.ack(out[i - 1].tick);
    const back = decoder.decode(encoder.encode(msg) as Uint8Array) as SnapshotMessage;
    for (const [k, e] of msg.events.entries()) {
      if (e.type !== 'thunder') continue;
      const got = back.events[k];
      assert.ok(got.type === 'thunder' && got.playerId === e.playerId);
      e.dir.forEach((x, j) => assert.ok(Math.abs(x - got.dir[j]) < 1e-5));
      blasts++;
    }
  });
  assert.ok(blasts > 3, `bots fired ${blasts} times`);
});
