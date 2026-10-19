// Headless balance check: runs a bot-only match as fast as the CPU allows and reports the pace
// of play (kills per minute, the leader's score, what kills people, how many airshots), and how a
// stand-in for a new player (a "novice" bot: slow, inaccurate) fares against bots of a given skill.
//
//   npx tsx scripts/balance.ts [map] [bots] [minutes] [skill] [mode]
//   npx tsx scripts/balance.ts arena 3 8 easy
//   npx tsx scripts/balance.ts temple 7 10 normal ctf      (team modes also report team scores and flag play)
//
// Bots aren't people, but they're a cheap way to see whether the frag limit and time limit fit a
// map, whether newcomers get stomped, and whether a change makes one weapon or death cause dominate.

import RAPIER from '@dimforge/rapier3d-compat';
import type { BotSkill } from '../src/shared/bot';
import { DT, MATCH, MODES, PROTOCOL_VERSION, type GameMode } from '../src/shared/config';
import { GameServer } from '../src/shared/server';
import type { SimEvent } from '../src/shared/sim';

await RAPIER.init();

const map = process.argv[2] ?? 'arena';
const bots = Number(process.argv[3] ?? 3);
const minutes = Number(process.argv[4] ?? MATCH.timeLimit / 60);
const skill = (process.argv[5] ?? 'normal') as BotSkill;
const mode = (process.argv[6] && process.argv[6] in MODES ? process.argv[6] : 'ffa') as GameMode;

const server = new GameServer(() => {}, { maps: [map], mode, minPlayers: 0, timeLimit: minutes * 60, fragLimit: 10000, botSkill: skill });
// The server idles while nobody is connected, so someone joins to watch.
server.receive('spectator', { type: 'join', name: 'spectator', version: PROTOCOL_VERSION, spectate: true });
const novice = server.addBot('novice');
for (let i = 0; i < bots; i++) server.addBot(skill);

const causes = new Map<string, number>();
let kills = 0;
let suicides = 0;
let airshots = 0;
let shots = 0;
let damage = 0;
const flags = new Map<string, number>();
const laps: number[] = [];
const step = server.sim.step.bind(server.sim);
server.sim.step = (inputs) => {
  const events: SimEvent[] = step(inputs);
  for (const e of events) {
    if (e.type === 'fired') shots++;
    if (e.type === 'damaged' && e.sourceId !== e.playerId) damage += e.amount;
    if (e.type === 'flag') flags.set(e.action, (flags.get(e.action) ?? 0) + 1);
    if (e.type === 'lap') laps.push(e.time);
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
let played = ticks;
for (let t = 0; t < ticks; t++) {
  server.tick();
  // Capture the flag ends at its capture limit whatever the frag limit: stop there.
  if (server.status().match.phase !== 'playing') {
    played = t + 1;
    break;
  }
}
const ms = performance.now() - t0;
if (played < ticks) console.log(`(the match was won after ${((played * DT) / 60).toFixed(1)} min)`);

const players = [...server.sim.players.values()];
const scores = players.map((p) => p.kills).sort((a, b) => b - a);
const n = server.sim.players.get(novice)!;
console.log(`${map}, novice + ${bots} ${skill} bots, ${minutes} min (simulated in ${(ms / 1000).toFixed(1)} s)`);
console.log(`kills ${kills} (${(kills / minutes).toFixed(1)}/min), deaths with no killer ${suicides}, airshot kills ${airshots}`);
console.log(`shots ${shots}, damage dealt ${Math.round(damage)} (${(damage / Math.max(1, shots)).toFixed(1)} per shot)`);
console.log(`causes ${[...causes].map(([c, k]) => `${c} ${k}`).join(', ')}`);
console.log(`final scores ${scores.join(' ')}; leader at ${((scores[0] / minutes) * 8).toFixed(0)} per 8 min`);
if (MODES[mode].teams) console.log(`teams: red ${server.sim.teamScores[0]}, blue ${server.sim.teamScores[1]}; flags ${[...flags].map(([a, k]) => `${a} ${k}`).join(', ') || 'none'}`);
if (mode === 'race') console.log(`laps ${laps.length}${laps.length ? `, best ${Math.min(...laps).toFixed(2)} s` : ''}`);
console.log(`novice: ${n.kills} kills, ${n.deaths} deaths (${(n.kills / Math.max(1, n.deaths)).toFixed(2)} K/D), place ${scores.indexOf(n.kills) + 1} of ${players.length}`);
