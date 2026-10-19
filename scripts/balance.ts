// Headless balance check: runs a bot-only match as fast as the CPU allows and reports the pace
// of play: kills per minute, the leader's score at the end, what kills people, how many airshots.
//
//   npx tsx scripts/balance.ts [map] [bots] [minutes]
//
// Bots aren't people, but they're a cheap way to see whether the frag limit and time limit fit a
// map, and to notice when a change makes one weapon or death cause dominate.

import RAPIER from '@dimforge/rapier3d-compat';
import { DT, MATCH, PROTOCOL_VERSION } from '../src/shared/config';
import { GameServer } from '../src/shared/server';
import type { SimEvent } from '../src/shared/sim';

await RAPIER.init();

const map = process.argv[2] ?? 'arena';
const bots = Number(process.argv[3] ?? 6);
const minutes = Number(process.argv[4] ?? MATCH.timeLimit / 60);

const server = new GameServer(() => {}, { maps: [map], minPlayers: 0, timeLimit: minutes * 60, fragLimit: 10000 });
// The server idles while nobody is connected, so a spectator joins and then leaves the arena.
server.receive('spectator', { type: 'join', name: 'spectator', version: PROTOCOL_VERSION });
server.sim.removePlayer('spectator');
for (let i = 0; i < bots; i++) server.addBot();

const causes = new Map<string, number>();
let kills = 0;
let suicides = 0;
let airshots = 0;
let shots = 0;
let damage = 0;
const step = server.sim.step.bind(server.sim);
server.sim.step = (inputs) => {
  const events: SimEvent[] = step(inputs);
  for (const e of events) {
    if (e.type === 'fired') shots++;
    if (e.type === 'damaged' && e.sourceId !== e.playerId) damage += e.amount;
    if (e.type !== 'killed') continue;
    causes.set(e.cause, (causes.get(e.cause) ?? 0) + 1);
    if (e.killerId && e.killerId !== e.playerId) kills++;
    else suicides++;
    if (e.midair) airshots++;
  }
  return events;
};

const t0 = performance.now();
const ticks = Math.round((minutes * 60) / DT);
for (let t = 0; t < ticks; t++) server.tick();
const ms = performance.now() - t0;

const scores = [...server.sim.players.values()].map((p) => p.kills).sort((a, b) => b - a);
console.log(`${map}, ${bots} bots, ${minutes} min (simulated in ${(ms / 1000).toFixed(1)} s, ${(ms / ticks).toFixed(2)} ms/tick)`);
console.log(`kills ${kills} (${(kills / minutes).toFixed(1)}/min), deaths with no killer ${suicides}, airshot kills ${airshots}`);
console.log(`shots ${shots}, damage dealt ${Math.round(damage)} (${(damage / Math.max(1, shots)).toFixed(1)} per shot)`);
console.log(`causes ${[...causes].map(([c, n]) => `${c} ${n}`).join(', ')}`);
console.log(`final scores ${scores.join(' ')}; leader at ${((scores[0] / minutes) * 8).toFixed(0)} per 8 min`);
