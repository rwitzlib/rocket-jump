import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GRAPPLE } from '../src/shared/config';
import { makeSim, place, run, settle } from './helpers';

// Movement and weapons on foot: the feel of the game rests on these numbers staying put.

/** Highest point reached over `ticks` after the first tick's input, then nothing. */
function apex(fire: boolean): number {
  const sim = makeSim();
  const p = sim.addPlayer('a');
  place(p, 0, 1, 40);
  settle(sim, p);
  const start = p.pos.y;
  let top = start;
  run(sim, 1, { a: { jump: true, fire, pitch: -Math.PI / 2 + 0.01 } });
  for (let t = 0; t < 180; t++) {
    run(sim, 1);
    top = Math.max(top, p.pos.y);
  }
  return top - start;
}

test('a plain jump rises about 1.2 m', () => {
  const h = apex(false);
  assert.ok(h > 1 && h < 1.5, `jumped ${h.toFixed(2)} m`);
});

test('a rocket jump goes several times higher, and costs no health', () => {
  const jump = apex(false);
  const rocket = apex(true);
  assert.ok(rocket > jump * 3, `rocket jump ${rocket.toFixed(2)} m against a jump of ${jump.toFixed(2)} m`);
  const sim = makeSim();
  const p = sim.addPlayer('a');
  place(p, 0, 1, 40);
  settle(sim, p);
  run(sim, 60, { a: { fire: true, pitch: -Math.PI / 2 + 0.01 } });
  assert.equal(p.health, 100);
});

test('the same inputs always give the same result', () => {
  const trace = () => {
    const sim = makeSim();
    const p = sim.addPlayer('a');
    place(p, 0, 1, 40);
    settle(sim, p);
    const out: number[] = [];
    for (let t = 0; t < 240; t++) {
      run(sim, 1, { a: { forward: 1, right: Math.sin(t / 10), jump: t % 40 < 20, fire: t === 30, yaw: t / 50, pitch: t === 30 ? -1.5 : 0 } });
      out.push(p.pos.x, p.pos.y, p.pos.z);
    }
    return out;
  };
  assert.deepEqual(trace(), trace());
});

test('the grapple attaches in range, pulls you in, and lets go on release', () => {
  const sim = makeSim();
  const p = sim.addPlayer('a');
  place(p, 0, 1, 40);
  settle(sim, p);
  // The pull runs through a mystery box: a two-handed weapon from it would put the grapple away.
  for (const box of sim.pickups) box.respawnIn = 1e9;
  // The tower is 8 m wide at the center: aim at it, about 34 m away.
  const events = run(sim, 1, { a: { grapple: true, yaw: 0, pitch: 0.2 } });
  assert.ok(events.some((e) => e.type === 'grapple' && e.attached), 'hooked the tower');
  const before = p.pos.z;
  run(sim, 60, { a: { grapple: true, yaw: 0, pitch: 0.2 } });
  assert.ok(p.pos.z < before - 5, `pulled ${(before - p.pos.z).toFixed(1)} m toward it`);
  const released = run(sim, 1, { a: { grapple: false } });
  assert.ok(released.some((e) => e.type === 'grapple' && !e.attached));
  assert.equal(p.grapple, null);
  assert.ok(Math.abs(p.grappleCooldown - GRAPPLE.cooldown) < 0.05, "the cooldown starts on release");
});

test('a rocket to the chest kills, and is credited', () => {
  const sim = makeSim();
  const a = sim.addPlayer('a');
  const b = sim.addPlayer('b');
  place(a, 0, 1, 20);
  place(b, 0, 1, 10);
  settle(sim, a);
  settle(sim, b);
  a.protectedFor = b.protectedFor = 0;
  const events = run(sim, 90, { a: { fire: true, yaw: 0, pitch: 0 } });
  const killed = events.find((e) => e.type === 'killed');
  assert.ok(killed && killed.type === 'killed', 'someone died');
  assert.equal(killed.playerId, 'b');
  assert.equal(killed.killerId, 'a');
  assert.equal(a.kills, 1);
  assert.equal(b.deaths, 1);
});

test('falling off the map within 5 s of a hit is the hitter\'s kill', () => {
  const sim = makeSim('skyreach');
  const a = sim.addPlayer('a');
  const b = sim.addPlayer('b');
  place(a, 0, 1, 0);
  place(b, 35, -60, 0); // already falling, between islands
  b.lastAttacker = 'a';
  b.sinceAttacked = 1;
  b.protectedFor = 0;
  const events = run(sim, 240);
  const killed = events.find((e) => e.type === 'killed');
  assert.ok(killed && killed.type === 'killed');
  assert.equal(killed.cause, 'fall');
  assert.equal(killed.killerId, 'a');
});

test('walking up a ramp keeps about your flat-ground speed', () => {
  const walk = (x: number, z: number) => {
    const sim = makeSim();
    const p = sim.addPlayer('a');
    place(p, x, 6, z);
    settle(sim, p);
    run(sim, 40, { a: { forward: 1, yaw: Math.PI } });
    const z0 = p.pos.z;
    run(sim, 10, { a: { forward: 1, yaw: Math.PI } });
    return ((p.pos.z - z0) * 60) / 10;
  };
  const flat = walk(0, 40);
  const ramp = walk(-20, 26); // the arena ramp rising toward +z
  assert.ok(ramp > flat * 0.95, `${ramp.toFixed(2)} m/s up the ramp against ${flat.toFixed(2)} m/s on the flat`);
});
