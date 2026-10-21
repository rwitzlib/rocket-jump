import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vector3 } from 'three';
import { DT } from '../src/shared/config';
import { MAPS } from '../src/shared/map';
import { GameSim } from '../src/shared/sim';
import { input, makeSim, place, run, settle, v } from './helpers';

// Moving solids (MapDef.movers), on Skyreach's turning ring of runestones: you can stand on it and
// ride it round, hook it, and the client's prediction puts it where the server does.

const RING = 0; // Skyreach's only mover
const ABOVE_SLAB = v(16, 2.5, 0); // over the first slab, in the ring's own frame

/** A player dropped onto the ring and standing there. */
function onRing(sim: GameSim) {
  const p = sim.addPlayer('a');
  const at = sim.movers.toWorld(RING, sim.tick, ABOVE_SLAB, new Vector3());
  place(p, at.x, at.y, at.z);
  settle(sim, p);
  return p;
}

test('Skyreach has the ring as a mover, one solid ring', () => {
  const ring = MAPS.skyreach.movers?.[RING];
  assert.ok(ring && ring.rings?.length === 1 && ring.spin);
});

test('you can stand on the ring, and it carries you round', () => {
  const sim = makeSim('skyreach');
  const p = onRing(sim);
  assert.ok(p.grounded, 'landed on the ring');
  const start = p.pos.clone();
  const local = sim.movers.toLocal(RING, sim.tick, p.pos, new Vector3());
  run(sim, 300); // 5 s: the ring turns about 0.4 rad
  assert.ok(p.grounded && p.alive, 'still standing on it');
  assert.ok(p.pos.distanceTo(start) > 4, `carried ${p.pos.distanceTo(start).toFixed(2)} m`);
  const now = sim.movers.toLocal(RING, sim.tick, p.pos, new Vector3());
  assert.ok(now.distanceTo(local) < 0.3, `slid ${now.distanceTo(local).toFixed(2)} m along the ring`);
});

test('walking a full lap round the ring stays on the ground, level all the way round', () => {
  const sim = makeSim('skyreach');
  const p = onRing(sim);
  const local = new Vector3();
  const ahead = new Vector3();
  let traveled = 0;
  let lowest = Infinity;
  let highest = -Infinity;
  let airborne = 0;
  let last = sim.movers.toLocal(RING, sim.tick, p.pos, new Vector3());
  // Up to 20 s of walking, steering at a spot a little ahead on the slabs' center line.
  for (let i = 0; i < 1200 && traveled < Math.PI * 2; i++) {
    sim.movers.toLocal(RING, sim.tick, p.pos, local);
    const a = Math.atan2(local.z, local.x) + 0.15;
    sim.movers.toWorld(RING, sim.tick, ahead.set(Math.cos(a) * 16, local.y, Math.sin(a) * 16), ahead).sub(p.pos);
    run(sim, 1, { a: { forward: 1, yaw: Math.atan2(-ahead.x, -ahead.z) } });
    sim.movers.toLocal(RING, sim.tick, p.pos, local);
    if (i > 10) {
      if (!p.grounded) airborne++;
      lowest = Math.min(lowest, local.y);
      highest = Math.max(highest, local.y);
    }
    let turned = Math.atan2(local.z, local.x) - Math.atan2(last.z, last.x);
    if (turned < -Math.PI) turned += Math.PI * 2;
    traveled += turned;
    last.copy(local);
  }
  assert.ok(p.alive, 'still up there');
  assert.ok(traveled >= Math.PI * 2, `walked ${((traveled / (Math.PI * 2)) * 100).toFixed(0)}% of a lap`);
  assert.equal(airborne, 0, 'left the ground at a joint');
  // (The controller floats a couple of centimeters over whatever it stands on, give or take.)
  assert.ok(highest - lowest < 0.04, `feet rose and fell ${(highest - lowest).toFixed(3)} m`);
});

test('shots and rays hit the ring where it is now, not where it started', () => {
  const sim = makeSim('skyreach');
  const down = v(0, -1, 0);
  const normal = new Vector3();
  const top = () => sim.movers.toWorld(RING, sim.tick, v(16, 0.8, 0), new Vector3()).y;
  const startTop = top();
  // π s: the bob at its highest (and the ring a quarter radian round).
  run(sim, Math.round(Math.PI / DT));
  const above = sim.movers.toWorld(RING, sim.tick, v(16, 5, 0), new Vector3());
  const dist = sim.castLevel(above, down, 10, normal);
  assert.ok(dist !== null && Math.abs(above.y - dist - top()) < 0.05, 'hit its top where it is now');
  assert.ok(top() - startTop > 0.5, `and that's ${(top() - startTop).toFixed(2)} m above where it started`);
});

test('a grapple hooks the ring and the anchor rides along with it', () => {
  const sim = makeSim('skyreach');
  const p = sim.addPlayer('a');
  const under = sim.movers.toWorld(RING, sim.tick, v(16, -10, 0), new Vector3());
  place(p, under.x, under.y, under.z);
  const hold = { grapple: true, pitch: Math.PI / 2 - 0.01 };
  run(sim, 1, { a: hold });
  const hook = p.grapple?.hook;
  assert.equal(hook?.kind, 'mover');
  run(sim, 60, { a: hold });
  assert.ok(p.grapple && hook?.kind === 'mover');
  const expected = sim.movers.toWorld(RING, sim.tick - 1, hook.local, new Vector3());
  assert.ok(p.grapple.anchor.distanceTo(expected) < 1e-6, 'anchor follows the ring');
  assert.ok(p.grapple.anchor.distanceTo(under) > 0.5, 'and has moved with it');
});

test('prediction and replay at the server tick match the server on the ring', () => {
  const server = makeSim('skyreach');
  const client = makeSim('skyreach');
  const sp = onRing(server);
  const cp = client.addPlayer('a');
  // The client picks up from the server's state, like after a snapshot.
  const snap = () => ({ pos: sp.pos.clone(), vel: sp.vel.clone(), grounded: sp.grounded });
  const restore = (s: ReturnType<typeof snap>) => {
    place(cp, s.pos.x, s.pos.y, s.pos.z);
    cp.vel.copy(s.vel);
    cp.grounded = s.grounded;
  };
  restore(snap());
  const walk = (i: number) => input({ forward: i % 40 < 20 ? 1 : -1, yaw: 0 });
  const start = server.tick;
  const saved: ReturnType<typeof snap>[] = [];
  for (let i = 0; i < 90; i++) {
    saved.push(snap());
    server.step(new Map([['a', walk(i)]]));
    client.predict(cp, walk(i), start + i);
  }
  assert.ok(cp.pos.distanceTo(sp.pos) < 1e-3, `prediction off by ${cp.pos.distanceTo(sp.pos).toFixed(4)} m`);
  // A correction from 30 ticks back, replayed.
  restore(saved[60]);
  for (let i = 60; i < 90; i++) client.replay(cp, walk(i), start + i);
  assert.ok(cp.pos.distanceTo(sp.pos) < 1e-3, `replay off by ${cp.pos.distanceTo(sp.pos).toFixed(4)} m`);
  assert.ok(sp.alive && sp.pos.y > 30, 'still up on the ring');
});
