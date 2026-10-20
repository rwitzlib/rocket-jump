import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vector3 } from 'three';
import { MAPS } from '../src/shared/map';
import { flagBases, raceCourse, teamSpawns } from '../src/shared/modes';
import { makeSim } from './helpers';

// Every map's data makes sense: things stand on floors, nothing is buried in a wall, both teams
// have somewhere to spawn, and the race loop is clear to fly through.

const DOWN = new Vector3(0, -1, 0);
const n = new Vector3();

for (const name of Object.keys(MAPS)) {
  test(`${name}: spawns, items and flags stand on something`, () => {
    const map = MAPS[name];
    const sim = makeSim(name);
    /** Meters from `[x, y, z]` down to the first floor (from a little above it), or null. */
    const drop = ([x, y, z]: number[], from = 0.5) => {
      const d = sim.castLevel(new Vector3(x, y + from, z), DOWN, 40, n);
      return d === null ? null : d - from;
    };
    for (const s of map.spawns) {
      const d = drop(s.pos);
      assert.ok(d !== null && d > -0.1 && d < 3, `spawn ${s.pos} is ${d} m above the floor`);
    }
    for (const item of map.items ?? []) {
      const d = drop(item.pos);
      assert.ok(d !== null && Math.abs(d) < 0.15, `${item.kind} at ${item.pos} is ${d} m off the floor`);
    }
    for (const flag of flagBases(map)) {
      const d = drop(flag);
      assert.ok(d !== null && Math.abs(d) < 0.15, `flag at ${flag} is ${d} m off the floor`);
    }
  });

  test(`${name}: both teams have their own spawns in capture the flag`, { skip: MAPS[name].tutorial }, () => {
    const map = MAPS[name];
    const red = teamSpawns(map, 0);
    const blue = teamSpawns(map, 1);
    assert.ok(red.length >= 2 && blue.length >= 2);
    assert.ok(red.some((s) => !blue.includes(s)), 'not all shared');
  });

  test(`${name}: the race loop is open air, starting on solid ground`, () => {
    const map = MAPS[name];
    const sim = makeSim(name);
    const course = raceCourse(map);
    assert.ok(course.rings.length >= 4, 'enough rings');
    const start = sim.castLevel(new Vector3(course.start.pos[0], course.start.pos[1] + 0.5, course.start.pos[2]), DOWN, 5, n);
    assert.ok(start !== null, 'the start is over a floor');
    for (const ring of course.rings) {
      // No solid within a meter of the ring's center, any way.
      for (const dir of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const d = sim.castLevel(new Vector3(...ring), new Vector3(...(dir as [number, number, number])), 1, n);
        assert.ok(d === null, `ring ${ring} is ${d?.toFixed(2)} m from a solid`);
      }
    }
  });
}
