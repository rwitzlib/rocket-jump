// Shared setup for the tests: Rapier, a sim on a map, and ways to step and place players.

import RAPIER from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three';
import type { GameMode } from '../src/shared/config';
import { MAPS } from '../src/shared/map';
import { GameSim, type PlayerSim, type SimEvent } from '../src/shared/sim';
import { EMPTY_INPUT, type PlayerInput } from '../src/shared/types';

await RAPIER.init();

/** A sim on a map, with its colliders ready for ray casts (they need one physics step). */
export function makeSim(map = 'arena', mode: GameMode = 'ffa'): GameSim {
  const sim = new GameSim(MAPS[map], mode);
  sim.world.step();
  return sim;
}

export const input = (overrides: Partial<PlayerInput> = {}): PlayerInput => ({ ...EMPTY_INPUT, ...overrides });

/** Steps the sim `ticks` times with these inputs (by player id), collecting every event. */
export function run(sim: GameSim, ticks: number, inputs: Record<string, Partial<PlayerInput>> = {}): SimEvent[] {
  const map = new Map(Object.entries(inputs).map(([id, i]) => [id, input(i)]));
  const events: SimEvent[] = [];
  for (let t = 0; t < ticks; t++) events.push(...sim.step(map));
  return events;
}

/** Puts a player somewhere, standing still, without spawn protection. */
export function place(p: PlayerSim, x: number, y: number, z: number) {
  p.pos.set(x, y, z);
  p.prevPos.copy(p.pos);
  p.vel.set(0, 0, 0);
  p.collider.setTranslation(p.pos);
  p.body.setNextKinematicTranslation(p.pos);
  p.protectedFor = 0;
}

/** Steps until the player stands on something, up to 2 s. */
export function settle(sim: GameSim, p: PlayerSim) {
  for (let t = 0; t < 120 && !p.grounded; t++) sim.step(new Map());
  for (let t = 0; t < 10; t++) sim.step(new Map());
}

export const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
