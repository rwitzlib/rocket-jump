import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CTF, ITEMS } from '../src/shared/config';
import type { GameSim, PlayerSim, SimEvent } from '../src/shared/sim';
import { makeSim, place, run } from './helpers';

// The rules of each mode, and items: played out in a sim with players placed by hand.

/** Deals damage the way a hit does (the sim's own damage path), returning the events. */
function hurt(sim: GameSim, p: PlayerSim, amount: number, from: string) {
  const events: SimEvent[] = [];
  (sim as unknown as { damage: (p: PlayerSim, n: number, from: string, ev: SimEvent[], cause: string) => void }).damage(p, amount, from, events, 'rocket');
  return events;
}

test('capture the flag: take it, carry it home, score', () => {
  const sim = makeSim('arena', 'ctf');
  const red = sim.addPlayer('red', 0);
  const [redBase, blueBase] = sim.flags.map((f) => f.home);
  place(red, blueBase.x, blueBase.y + 0.9, blueBase.z);
  let events = run(sim, 2);
  assert.ok(events.some((e) => e.type === 'flag' && e.action === 'taken' && e.team === 1));
  assert.equal(red.flag, 1);
  place(red, redBase.x, redBase.y + 0.9, redBase.z);
  events = run(sim, 2);
  assert.ok(events.some((e) => e.type === 'flag' && e.action === 'captured'));
  assert.deepEqual(sim.teamScores, [1, 0]);
  assert.equal(red.captures, 1);
  assert.ok(sim.flags[1].atHome, 'their flag went home');
});

test('capture the flag: no capture while your own flag is away', () => {
  const sim = makeSim('arena', 'ctf');
  const red = sim.addPlayer('red', 0);
  const blue = sim.addPlayer('blue', 1);
  const [redBase, blueBase] = sim.flags.map((f) => f.home);
  place(red, blueBase.x, blueBase.y + 0.9, blueBase.z);
  place(blue, redBase.x, redBase.y + 0.9, redBase.z);
  run(sim, 2); // both flags taken
  place(blue, 0, 1, 0);
  place(red, redBase.x, redBase.y + 0.9, redBase.z);
  run(sim, 5);
  assert.deepEqual(sim.teamScores, [0, 0]);
  assert.equal(red.flag, 1, 'still carrying');
});

test('capture the flag: a dropped flag can be returned by its team, or goes home by itself', () => {
  const sim = makeSim('arena', 'ctf');
  const red = sim.addPlayer('red', 0);
  const blue = sim.addPlayer('blue', 1);
  const blueBase = sim.flags[1].home;
  place(red, blueBase.x, blueBase.y + 0.9, blueBase.z);
  run(sim, 2);
  place(red, 0, 1, 20);
  run(sim, 30);
  hurt(sim, red, 500, 'blue');
  assert.equal(red.alive, false);
  const flag = sim.flags[1];
  assert.ok(!flag.atHome && !flag.carrier, 'dropped');
  place(blue, flag.pos.x, flag.pos.y + 0.9, flag.pos.z);
  const events = run(sim, 2);
  assert.ok(events.some((e) => e.type === 'flag' && e.action === 'returned' && e.playerId === 'blue'));
  assert.ok(flag.atHome);

  // Now drop it again and leave it.
  place(blue, 0, 1, -30);
  place(red, blueBase.x, blueBase.y + 0.9, blueBase.z);
  run(sim, 240); // red respawns meanwhile (3.5 s): walk them in again
  place(red, blueBase.x, blueBase.y + 0.9, blueBase.z);
  run(sim, 2);
  place(red, 0, 1, 20);
  run(sim, 2);
  hurt(sim, red, 500, 'blue');
  assert.ok(!sim.flags[1].atHome);
  run(sim, Math.ceil(CTF.returnTime * 60) + 2);
  assert.ok(sim.flags[1].atHome, 'went home by itself');
});

test('team deathmatch: no damage from teammates, kills score for the team', () => {
  const sim = makeSim('arena', 'tdm');
  const a = sim.addPlayer('a', 0);
  const b = sim.addPlayer('b', 0);
  const c = sim.addPlayer('c', 1);
  for (const p of [a, b, c]) place(p, 0, 1, 30);
  hurt(sim, b, 80, 'a');
  assert.equal(b.health, 100, 'teammate unhurt');
  hurt(sim, c, 200, 'a');
  assert.equal(c.alive, false);
  assert.deepEqual(sim.teamScores, [1, 0]);
});

test('armor soaks two thirds of a hit; health packs go over 100 and drain back', () => {
  const sim = makeSim();
  const p = sim.addPlayer('p');
  place(p, 0, 1, 30);
  p.armor = 50;
  hurt(sim, p, 60, 'x');
  assert.equal(p.armor, 10);
  assert.equal(p.health, 80);

  const health = sim.items.find((i) => i.kind === 'health')!;
  p.health = 100;
  place(p, health.pos.x, health.pos.y, health.pos.z);
  run(sim, 1);
  assert.ok(p.health > 100 + ITEMS.health.amount - 0.1, `health ${p.health}`);
  assert.ok(health.respawnIn > 0, 'taken');
  place(p, 0, 1, 30);
  run(sim, 600);
  const expected = 100 + ITEMS.health.amount - ITEMS.health.decay * 10;
  assert.ok(Math.abs(p.health - expected) < 0.5, `drained to ${p.health.toFixed(1)}, expected about ${expected}`);
});

test('the overdrive doubles damage against others', () => {
  const sim = makeSim();
  const a = sim.addPlayer('a');
  const b = sim.addPlayer('b');
  place(a, 0, 1, 25);
  place(b, 0, 1, 15);
  run(sim, 30);
  a.overdrive = 10;
  b.protectedFor = 0;
  b.health = 400; // room to show the full hit (damage is reported as what was taken)
  const events = run(sim, 60, { a: { fire: true } });
  const hit = events.find((e) => e.type === 'damaged' && e.playerId === 'b');
  assert.ok(hit && hit.type === 'damaged');
  assert.ok(hit.amount > 100, `hit for ${hit.amount}`);
});

test('race: rings in order, the gate times the lap, falling restarts', () => {
  const sim = makeSim('arena', 'race');
  const p = sim.addPlayer('p');
  const rings = sim.course.rings;
  const through = (i: number) => {
    const [x, y, z] = rings[i];
    place(p, x, y - 0.5, z - 1.5);
    p.prevPos.set(x, y - 0.5, z + 1.5);
  };
  // Skipping ahead counts for nothing.
  through(2);
  run(sim, 1);
  assert.equal(p.checkpoint, 0);
  const events: SimEvent[] = [];
  for (const i of [...rings.keys(), 0]) {
    through(i);
    events.push(...run(sim, 1));
    run(sim, 30);
  }
  const lap = events.find((e) => e.type === 'lap');
  assert.ok(lap && lap.type === 'lap', 'a lap');
  assert.ok(lap.time > 0 && p.bestLap === lap.time);
  assert.equal(events.filter((e) => e.type === 'checkpoint').length, rings.length - 1);
  // Racers are ghosts: a rocket at someone else does nothing.
  const q = sim.addPlayer('q');
  place(q, 0, 1, 10);
  place(p, 0, 1, 20);
  run(sim, 60, { p: { fire: true } });
  assert.equal(q.health, 100);
});
