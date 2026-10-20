import type { GameMode } from './config';
import type { DeathCause } from './projectile';

// Progression for online play: experience and levels, lifetime stats, daily and weekly challenges,
// and the cosmetics levels unlock. Everything here is plain data and pure functions; the dedicated
// server keeps profiles (src/server/store.ts) and the game server reports what happened (StatEvent).
//
// There are no accounts. A browser makes up a secret key the first time it plays online and sends it
// when joining; the server knows the profile by a hash of it. Lose the key (clear site data) and the
// profile is gone, which is the price of no sign-up.

// --- levels -----------------------------------------------------------------------------------

/** Total XP to reach a level: 100 for level 2, 300 for 3, 600 for 4... 50 L (L - 1). */
export const xpForLevel = (level: number) => 50 * level * (level - 1);

export function levelOf(xp: number): number {
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level++;
  return level;
}

/** XP for each thing, before challenges. */
export const XP = {
  kill: 10,
  airshot: 15, // on top of the kill
  capture: 50,
  lap: 5,
  bestLap: 15, // a new personal best, on top of the lap
  matchPlayed: 25,
  matchWon: 75, // on top of playing it
  podium: 25, // second or third
};

// --- cosmetics --------------------------------------------------------------------------------

/** Armor colors, worn outside team modes (teams wear their team's). `auto` picks one from your id. */
export const TINTS = [
  { id: 'auto', name: 'Random', color: 0, level: 1 },
  { id: 'blue', name: 'Blue', color: 0x3d9cf0, level: 1 },
  { id: 'orange', name: 'Orange', color: 0xf0a830, level: 1 },
  { id: 'purple', name: 'Purple', color: 0xa860f0, level: 3 },
  { id: 'green', name: 'Green', color: 0x40c878, level: 5 },
  { id: 'pink', name: 'Pink', color: 0xf05a80, level: 7 },
  { id: 'teal', name: 'Teal', color: 0x30c8d0, level: 9 },
  { id: 'white', name: 'Arctic', color: 0xe4eaf2, level: 12 },
  { id: 'black', name: 'Stealth', color: 0x30343e, level: 15 },
  { id: 'gold', name: 'Gold', color: 0xe8b830, level: 20 },
] as const;

/** Rocket trails: the flame's two colors and the smoke's. */
export const TRAILS = [
  { id: 'classic', name: 'Classic', fire: [0xffd080, 0xff5010], smoke: [0xd8d4d0, 0x8a8682], level: 1 },
  { id: 'ember', name: 'Ember', fire: [0xff9060, 0xd01010], smoke: [0x8a6a60, 0x3a2a28], level: 2 },
  { id: 'toxic', name: 'Toxic', fire: [0xd0ff80, 0x30c020], smoke: [0xa0d090, 0x507040], level: 4 },
  { id: 'plasma', name: 'Plasma', fire: [0xe0c0ff, 0x8030ff], smoke: [0xb0a0e0, 0x504080], level: 6 },
  { id: 'frost', name: 'Frost', fire: [0xe0fcff, 0x40b0ff], smoke: [0xe8f4ff, 0x9ab8d0], level: 8 },
  { id: 'gold', name: 'Gilded', fire: [0xfff0a0, 0xe0a010], smoke: [0xe8d8a0, 0x9a8040], level: 11 },
  { id: 'void', name: 'Void', fire: [0xff60e0, 0x200830], smoke: [0x302030, 0x100810], level: 14 },
  { id: 'rainbow', name: 'Rainbow', fire: [0xffffff, 0xff0000], smoke: [0xf0f0f0, 0xb0b0b0], level: 25 },
] as const;

export type TintId = (typeof TINTS)[number]['id'];
export type TrailId = (typeof TRAILS)[number]['id'];

/** What a player wears, as it goes over the wire: "tint/trail". */
export interface Look {
  tint: TintId;
  trail: TrailId;
}

export const DEFAULT_LOOK: Look = { tint: 'auto', trail: 'classic' };

export const encodeLook = (look: Look) => `${look.tint}/${look.trail}`;

export function decodeLook(text: string | undefined): Look {
  const [tint, trail] = (text ?? '').split('/');
  return {
    tint: TINTS.find((t) => t.id === tint)?.id ?? 'auto',
    trail: TRAILS.find((t) => t.id === trail)?.id ?? 'classic',
  };
}

/** A look this level may wear; anything locked goes back to the default. */
export function allowedLook(look: Look, level: number): Look {
  const tint = TINTS.find((t) => t.id === look.tint && t.level <= level)?.id ?? 'auto';
  const trail = TRAILS.find((t) => t.id === look.trail && t.level <= level)?.id ?? 'classic';
  return { tint, trail };
}

/** Cosmetics that unlock on reaching exactly this level, for the level-up message. */
export function unlocksAt(level: number): string[] {
  return [...TINTS.filter((t) => t.level === level).map((t) => `${t.name} armor`), ...TRAILS.filter((t) => t.level === level).map((t) => `${t.name} trail`)];
}

// --- what the game server reports -------------------------------------------------------------

export type StatEvent =
  | { type: 'kill'; airshot: boolean; cause: DeathCause; streak: number }
  | { type: 'death' }
  | { type: 'capture' }
  | { type: 'lap'; map: string; time: number; best: boolean; path: number[] }
  | { type: 'match'; mode: GameMode; won: boolean; place: number; players: number };

// --- challenges -------------------------------------------------------------------------------

export interface ChallengeDef {
  id: string;
  text: (n: number) => string;
  /** How much an event counts toward it (0 for none). */
  counts: (e: StatEvent) => number;
  daily: number; // target for a daily one
  weekly: number;
}

/** Kills in one life for the streak challenge (counted separately: the kill that brings a streak to this). */
const STREAK = 5;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const killWith = (causes: DeathCause[]) => (e: StatEvent) => (e.type === 'kill' && causes.includes(e.cause) ? 1 : 0);

export const CHALLENGES: ChallengeDef[] = [
  { id: 'kills', text: (n) => `Get ${n} kills`, counts: (e) => (e.type === 'kill' ? 1 : 0), daily: 15, weekly: 100 },
  { id: 'airshots', text: (n) => `Kill ${plural(n, 'player')} in midair`, counts: (e) => (e.type === 'kill' && e.airshot ? 1 : 0), daily: 3, weekly: 20 },
  { id: 'matches', text: (n) => `Finish ${plural(n, 'match', 'matches')}`, counts: (e) => (e.type === 'match' ? 1 : 0), daily: 3, weekly: 15 },
  { id: 'wins', text: (n) => `Win ${plural(n, 'match', 'matches')} (or be on the winning team)`, counts: (e) => (e.type === 'match' && e.won ? 1 : 0), daily: 1, weekly: 6 },
  { id: 'captures', text: (n) => `Capture ${plural(n, 'flag')}`, counts: (e) => (e.type === 'capture' ? 1 : 0), daily: 1, weekly: 6 },
  { id: 'laps', text: (n) => `Fly ${plural(n, 'race lap')}`, counts: (e) => (e.type === 'lap' ? 1 : 0), daily: 5, weekly: 30 },
  { id: 'grenades', text: (n) => `Get ${plural(n, 'grenade kill')}`, counts: killWith(['grenade']), daily: 3, weekly: 20 },
  { id: 'hypersonic', text: (n) => `Get ${plural(n, 'Hypersonic kill')}`, counts: killWith(['hypersonic']), daily: 3, weekly: 20 },
  { id: 'seekers', text: (n) => `Get ${plural(n, 'kill')} with a heat seeker`, counts: killWith(['javelin', 'stinger']), daily: 2, weekly: 12 },
  { id: 'falls', text: (n) => `Knock ${plural(n, 'player')} off the map`, counts: killWith(['fall']), daily: 3, weekly: 20 },
  { id: 'streak', text: (n) => (n === 1 ? `Get ${STREAK} kills without dying` : `Get ${STREAK} kills without dying, ${n} times`), counts: () => 0, daily: 1, weekly: 5 },
];
const streakCounts = (e: StatEvent) => (e.type === 'kill' && e.streak === STREAK ? 1 : 0);

export const CHALLENGE_XP = { daily: 150, weekly: 600 };
const PER_PERIOD = 3;

/** "2026-10-19" for a date, in UTC: everyone's day turns over together. */
export const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The Monday that starts this UTC week, as a day key. */
export function weekKey(t: number): string {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7; // Monday 0
  return dayKey(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** The period's challenges, the same for everybody: three picked by the date. */
export function challengesFor(period: string): ChallengeDef[] {
  const pool = [...CHALLENGES];
  const out: ChallengeDef[] = [];
  let h = hash(period);
  while (out.length < PER_PERIOD) {
    out.push(pool.splice(h % pool.length, 1)[0]);
    h = hash(`${h}`);
  }
  return out;
}

export const challengeText = (def: ChallengeDef, target: number) => def.text(target);

// --- profiles ---------------------------------------------------------------------------------

export interface Stats {
  kills: number;
  deaths: number;
  airshots: number;
  captures: number;
  matches: number;
  wins: number;
  laps: number;
  bestStreak: number;
}

export interface Profile {
  id: string; // public: a hash of the secret key
  name: string;
  created: number;
  seen: number;
  xp: number;
  stats: Stats;
  look: Look;
  /** Progress on the current day's and week's challenges, by position in challengesFor(period). */
  daily: { period: string; progress: number[] };
  weekly: { period: string; progress: number[] };
  bestLaps: Record<string, number>; // map -> seconds
}

export function newProfile(id: string, name: string, now: number): Profile {
  return {
    id,
    name,
    created: now,
    seen: now,
    xp: 0,
    stats: { kills: 0, deaths: 0, airshots: 0, captures: 0, matches: 0, wins: 0, laps: 0, bestStreak: 0 },
    look: { ...DEFAULT_LOOK },
    daily: { period: dayKey(now), progress: [0, 0, 0] },
    weekly: { period: weekKey(now), progress: [0, 0, 0] },
    bestLaps: {},
  };
}

/** What one event earned, to tell the player. */
export interface Gain {
  xp: number;
  reasons: string[]; // "Airshot +25"
  level: number; // after
  levelUp: boolean;
  unlocked: string[];
  completed: string[]; // challenge descriptions
}

/** Moves a profile's challenges on to the current day and week, if they've turned over. */
export function rollChallenges(p: Profile, now: number) {
  if (p.daily.period !== dayKey(now)) p.daily = { period: dayKey(now), progress: [0, 0, 0] };
  if (p.weekly.period !== weekKey(now)) p.weekly = { period: weekKey(now), progress: [0, 0, 0] };
}

/** Applies one event to a profile: stats, XP, challenges. Says what it earned. */
export function applyStat(p: Profile, e: StatEvent, now: number): Gain {
  rollChallenges(p, now);
  const before = levelOf(p.xp);
  const reasons: string[] = [];
  let xp = 0;
  const earn = (amount: number, why: string) => {
    xp += amount;
    reasons.push(`${why} +${amount}`);
  };
  const s = p.stats;
  switch (e.type) {
    case 'kill':
      s.kills++;
      s.bestStreak = Math.max(s.bestStreak, e.streak);
      earn(XP.kill, 'Kill');
      if (e.airshot) {
        s.airshots++;
        earn(XP.airshot, 'Airshot');
      }
      break;
    case 'death':
      s.deaths++;
      break;
    case 'capture':
      s.captures++;
      earn(XP.capture, 'Capture');
      break;
    case 'lap': {
      s.laps++;
      earn(XP.lap, 'Lap');
      const best = p.bestLaps[e.map];
      if (!best || e.time < best) {
        p.bestLaps[e.map] = e.time;
        if (best) earn(XP.bestLap, 'Personal best');
      }
      break;
    }
    case 'match':
      s.matches++;
      earn(XP.matchPlayed, 'Match');
      if (e.won) {
        s.wins++;
        earn(XP.matchWon, 'Victory');
      } else if (e.place >= 2 && e.place <= 3 && e.players >= 4 && e.mode !== 'tdm' && e.mode !== 'ctf') earn(XP.podium, 'Podium');
      break;
  }
  const completed: string[] = [];
  for (const [period, slot, reward] of [
    [p.daily.period, p.daily, CHALLENGE_XP.daily],
    [p.weekly.period, p.weekly, CHALLENGE_XP.weekly],
  ] as const) {
    const weekly = slot === p.weekly;
    challengesFor(period).forEach((def, i) => {
      const target = weekly ? def.weekly : def.daily;
      const was = slot.progress[i] ?? 0;
      if (was >= target) return;
      const step = def.id === 'streak' ? streakCounts(e) : def.counts(e);
      if (!step) return;
      slot.progress[i] = Math.min(target, was + step);
      if (slot.progress[i] >= target) {
        completed.push(`${weekly ? 'Weekly' : 'Daily'}: ${challengeText(def, target)}`);
        earn(reward, weekly ? 'Weekly challenge' : 'Daily challenge');
      }
    });
  }
  p.xp += xp;
  const level = levelOf(p.xp);
  const unlocked: string[] = [];
  for (let l = before + 1; l <= level; l++) unlocked.push(...unlocksAt(l));
  return { xp, reasons, level, levelUp: level > before, unlocked, completed };
}

/** A profile as the menu shows it: no secrets in it, challenges spelled out. */
export interface ProfileView {
  id: string;
  name: string;
  xp: number;
  level: number;
  levelXp: number; // XP into this level
  levelSize: number; // XP this level takes
  stats: Stats;
  look: Look;
  bestLaps: Record<string, number>;
  daily: { text: string; progress: number; target: number }[];
  weekly: { text: string; progress: number; target: number }[];
  dailyEnds: number; // ms timestamp
  weeklyEnds: number;
}

export function viewProfile(p: Profile, now: number): ProfileView {
  rollChallenges(p, now);
  const level = levelOf(p.xp);
  const list = (period: string, progress: number[], weekly: boolean) =>
    challengesFor(period).map((def, i) => {
      const target = weekly ? def.weekly : def.daily;
      return { text: challengeText(def, target), progress: progress[i] ?? 0, target };
    });
  const day = new Date(dayKey(now)).getTime();
  return {
    id: p.id,
    name: p.name,
    xp: p.xp,
    level,
    levelXp: p.xp - xpForLevel(level),
    levelSize: xpForLevel(level + 1) - xpForLevel(level),
    stats: p.stats,
    look: p.look,
    bestLaps: p.bestLaps,
    daily: list(p.daily.period, p.daily.progress, false),
    weekly: list(p.weekly.period, p.weekly.progress, true),
    dailyEnds: day + 86400000,
    weeklyEnds: new Date(weekKey(now)).getTime() + 7 * 86400000,
  };
}

/** One line on a map's race leaderboard. */
export interface LapRecord {
  id: string; // profile id
  name: string;
  time: number;
  when: number;
}
