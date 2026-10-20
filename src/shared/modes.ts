import { CTF, DUEL, ELIM, KOTH, MATCH, MODES, RACE, TDM, type GameMode } from './config';
import { MAPS, type MapDef, type SpawnDef, type Vec3Tuple } from './map';

// What each game mode needs from a map, worked out from its data: flag bases for capture the flag,
// the checkpoint loop for a race, which spawns belong to which team. Maps can spell these out
// (MapDef.flags, MapDef.race); otherwise they're derived from the spawns and mystery boxes.

/** One entry in a server's rotation: a map, and the mode to play on it. */
export interface RotationEntry {
  map: string;
  mode: GameMode;
}

/** "dockyard" or "temple:ctf". Unknown maps are dropped; an unknown mode falls back to `mode`. */
export function parseRotation(entries: string[], mode: GameMode = MATCH.mode): RotationEntry[] {
  return entries
    .map((e) => e.trim().split(':'))
    .filter(([map]) => Object.hasOwn(MAPS, map))
    .map(([map, m]) => ({ map, mode: m && Object.hasOwn(MODES, m) ? (m as GameMode) : mode }));
}

export const isTeamMode = (mode: GameMode) => MODES[mode].teams;

/** Kills (or captures) to win this mode on this map. 0: no limit (a race runs on time). */
export function scoreLimit(map: MapDef, mode: GameMode, override: number | null): number {
  if (mode === 'race') return 0;
  if (mode === 'ctf') return CTF.captureLimit;
  if (mode === 'koth') return KOTH.scoreLimit;
  if (mode === 'duel') return override ?? DUEL.fragLimit;
  if (mode === 'elim') return ELIM.roundLimit;
  const frags = override ?? map.fragLimit ?? MATCH.fragLimit;
  return mode === 'tdm' ? Math.round(frags * TDM.fragScale) : frags;
}

/** Seconds a match lasts: the server's setting if it has one, else the mode's. */
export function timeLimit(mode: GameMode, override: number | null): number {
  if (override !== null) return override;
  if (mode === 'ctf') return CTF.timeLimit;
  if (mode === 'race') return RACE.timeLimit;
  if (mode === 'koth') return KOTH.timeLimit;
  if (mode === 'elim') return ELIM.timeLimit;
  return MATCH.timeLimit;
}

/** Modes with no mystery boxes or items on the map. */
export const noPickups = (mode: GameMode) => mode === 'race' || mode === 'instagib';

/**
 * King of the hill: the spots the hill moves between. The map's own, or the mystery boxes' (which
 * maps put in places worth fighting over), on the floor under each.
 */
export function hillSpots(map: MapDef): Vec3Tuple[] {
  if (map.hills?.length) return map.hills;
  const spots = map.pickups.map((p): Vec3Tuple => [p[0], p[1] - 1.4, p[2]]);
  return spots.length ? spots : [map.spawns[0].pos];
}

const dist2 = (a: Vec3Tuple, b: Vec3Tuple) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** Each team's flag base: the map's own, or the two spawns farthest apart. Team 0 (red) first. */
export function flagBases(map: MapDef): [Vec3Tuple, Vec3Tuple] {
  if (map.flags) return map.flags;
  let best: [Vec3Tuple, Vec3Tuple] = [map.spawns[0].pos, map.spawns[0].pos];
  let bestDist = -1;
  for (const a of map.spawns) {
    for (const b of map.spawns) {
      const d = dist2(a.pos, b.pos);
      if (d > bestDist) {
        bestDist = d;
        best = [a.pos, b.pos];
      }
    }
  }
  return best;
}

/** Which team's half a point is in: the nearer flag base. -1 when it's (nearly) even. */
export function sideOf(map: MapDef, pos: Vec3Tuple): number {
  const [red, blue] = flagBases(map);
  const a = Math.sqrt(dist2(pos, red));
  const b = Math.sqrt(dist2(pos, blue));
  if (Math.abs(a - b) < 4) return -1;
  return a < b ? 0 : 1;
}

/** Spawns a team may use in capture the flag: their own half, plus any in the middle. */
export function teamSpawns(map: MapDef, team: number): SpawnDef[] {
  const own = map.spawns.filter((s) => {
    const side = sideOf(map, s.pos);
    return side === team || side === -1;
  });
  return own.length ? own : map.spawns;
}

export interface RaceCourse {
  start: SpawnDef; // where racers spawn, facing the first ring
  rings: Vec3Tuple[]; // ring 0 is the start/finish gate; the lap is 0, 1, ... n-1 and back through 0
}

/**
 * The race loop: the map's own, or one through every mystery box (the spots maps put up high or out
 * of the way), visited nearest-first from the first spawn.
 */
export function raceCourse(map: MapDef): RaceCourse {
  if (map.race) {
    const start = map.race.start;
    const gate = map.race.rings[0];
    return { start: { pos: start, yaw: Math.atan2(start[0] - gate[0], start[2] - gate[2]) }, rings: map.race.rings };
  }
  const start = map.spawns[0];
  const left = map.pickups.map((p): Vec3Tuple => [p[0], p[1] + 0.6, p[2]]);
  const gate: Vec3Tuple = [start.pos[0] - Math.sin(start.yaw) * 6, start.pos[1] + 1.2, start.pos[2] - Math.cos(start.yaw) * 6];
  const rings: Vec3Tuple[] = [gate];
  let at = gate;
  while (left.length) {
    let next = 0;
    for (let i = 1; i < left.length; i++) if (dist2(at, left[i]) < dist2(at, left[next])) next = i;
    at = left.splice(next, 1)[0];
    rings.push(at);
  }
  return { start, rings };
}
