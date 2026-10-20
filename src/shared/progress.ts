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
  // Premium: bought rather than earned (see PREMIUM). Prices in US cents.
  { id: 'crimson', name: 'Crimson', color: 0xc8202c, level: 1, price: 199 },
  { id: 'neon', name: 'Neon', color: 0x9cff3a, level: 1, price: 199 },
  { id: 'midnight', name: 'Midnight', color: 0x283a9a, level: 1, price: 199 },
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
  // Premium.
  { id: 'sunburst', name: 'Sunburst', fire: [0xfff4b0, 0xff3d7f], smoke: [0xffc0d8, 0xa05070], level: 1, price: 299 },
  { id: 'aurora', name: 'Aurora', fire: [0xc0fff0, 0x20e0a0], smoke: [0xb0e0ff, 0x6040a0], level: 1, price: 299 },
  { id: 'inferno', name: 'Inferno', fire: [0xffffff, 0xff2000], smoke: [0x404040, 0x101010], level: 1, price: 299 },
  // Premium, and more than a recolor: these draw their own shapes (see the client's effects).
  { id: 'lightning', name: 'Lightning', fire: [0xffffff, 0x5a9cff], smoke: [0xc8d8ff, 0x4a5a90], level: 1, price: 499 },
  { id: 'bubbles', name: 'Bubbles', fire: [0xe8ffff, 0x60d8ff], smoke: [0xe0f8ff, 0x90c8e8], level: 1, price: 299 },
] as const;

/** Explosions: how your blasts look. `color` is the menu's swatch. */
export const EXPLOSIONS = [
  { id: 'classic', name: 'Classic', color: 0xff8a30, level: 1 },
  { id: 'smoky', name: 'Smoky', color: 0x6a6460, level: 2 },
  { id: 'firecracker', name: 'Firecracker', color: 0xff4040, level: 5 },
  { id: 'flashpop', name: 'Flashpop', color: 0xfff4d0, level: 9 },
  // Premium.
  { id: 'thunderclap', name: 'Thunderclap', color: 0x5a9cff, level: 1, price: 499 },
  { id: 'bubblepop', name: 'Bubble Pop', color: 0x60d8ff, level: 1, price: 299 },
] as const;

/**
 * Sets: a trail and an explosion that go together, sold as one for less than the two. Buying one
 * owns the set's sku, which counts as owning each skin in it (see ownedSkus), so a refund takes
 * both back.
 */
export const SETS = [
  { id: 'storm', name: 'Storm', skus: ['trail:lightning', 'explosion:thunderclap'], price: 749 },
  { id: 'bubbles', name: 'Bubble', skus: ['trail:bubbles', 'explosion:bubblepop'], price: 449 },
] as const;

/**
 * Premium skins, the ones sold in the shop: a level doesn't unlock them, buying one does (with a
 * Discord sign-in, so it isn't lost with the browser's key). A profile's `owned` lists their skus.
 */
export interface PremiumSkin {
  sku: string; // "tint:crimson"
  kind: 'tint' | 'trail' | 'explosion' | 'set';
  id: string;
  name: string; // "Crimson armor"
  price: number; // US cents
  /** A set's skins. */
  skus?: readonly string[];
}

const priced = <T extends object>(item: T): item is T & { price: number } => 'price' in item;

export const PREMIUM: PremiumSkin[] = [
  ...TINTS.filter(priced).map((t) => ({ sku: `tint:${t.id}`, kind: 'tint' as const, id: t.id, name: `${t.name} armor`, price: t.price })),
  ...TRAILS.filter(priced).map((t) => ({ sku: `trail:${t.id}`, kind: 'trail' as const, id: t.id, name: `${t.name} trail`, price: t.price })),
  ...EXPLOSIONS.filter(priced).map((t) => ({ sku: `explosion:${t.id}`, kind: 'explosion' as const, id: t.id, name: `${t.name} explosion`, price: t.price })),
  ...SETS.map((s) => ({ sku: `set:${s.id}`, kind: 'set' as const, id: s.id, name: `${s.name} set`, price: s.price, skus: s.skus })),
];

/** The skus a profile's purchases let it wear: what it bought, and what's in the sets it bought. */
export function ownedSkus(owned: readonly string[] = []): string[] {
  const sets = PREMIUM.filter((s) => s.skus && owned.includes(s.sku));
  return [...new Set([...owned, ...sets.flatMap((s) => s.skus!)])];
}

/** Whether buying a sku would add nothing: it's owned, or (a set) everything in it is. */
export function hasAll(sku: string, owned: readonly string[] = []): boolean {
  const have = ownedSkus(owned);
  const skus = PREMIUM.find((s) => s.sku === sku)?.skus;
  return have.includes(sku) || (!!skus && skus.every((s) => have.includes(s)));
}

/** Whether a skin can be worn with these purchases: free ones always, premium ones once bought. */
const wearable = (kind: Exclude<PremiumSkin['kind'], 'set'>, item: object & { id: string }, owned: readonly string[]) => !priced(item) || ownedSkus(owned).includes(`${kind}:${item.id}`);

export const formatPrice = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export type TintId = (typeof TINTS)[number]['id'];
export type TrailId = (typeof TRAILS)[number]['id'];
export type ExplosionId = (typeof EXPLOSIONS)[number]['id'];

/** What a player wears (their skins), as it goes over the wire: "tint/trail/explosion". */
export interface Look {
  tint: TintId;
  trail: TrailId;
  explosion: ExplosionId;
}

export const DEFAULT_LOOK: Look = { tint: 'auto', trail: 'classic', explosion: 'classic' };

export const encodeLook = (look: Look) => `${look.tint}/${look.trail}/${look.explosion}`;

export function decodeLook(text: string | undefined): Look {
  const [tint, trail, explosion] = (text ?? '').split('/');
  return {
    tint: TINTS.find((t) => t.id === tint)?.id ?? 'auto',
    trail: TRAILS.find((t) => t.id === trail)?.id ?? 'classic',
    explosion: EXPLOSIONS.find((t) => t.id === explosion)?.id ?? 'classic',
  };
}

/**
 * A look this level (and these purchases) may wear; anything locked, not bought (or refunded), or
 * missing (from before it existed) goes back to the default.
 */
export function allowedLook(look: Partial<Look>, level: number, owned: readonly string[] = []): Look {
  const tint = TINTS.find((t) => t.id === look.tint && t.level <= level && wearable('tint', t, owned))?.id ?? 'auto';
  const trail = TRAILS.find((t) => t.id === look.trail && t.level <= level && wearable('trail', t, owned))?.id ?? 'classic';
  const explosion = EXPLOSIONS.find((t) => t.id === look.explosion && t.level <= level && wearable('explosion', t, owned))?.id ?? 'classic';
  return { tint, trail, explosion };
}

/** Skins that unlock on reaching exactly this level, for the level-up message. */
export function unlocksAt(level: number): string[] {
  return [
    ...TINTS.filter((t) => t.level === level && !priced(t)).map((t) => `${t.name} armor`),
    ...TRAILS.filter((t) => t.level === level && !priced(t)).map((t) => `${t.name} trail`),
    ...EXPLOSIONS.filter((t) => t.level === level && level > 1 && !priced(t)).map((t) => `${t.name} explosion`),
  ];
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
  /** The Discord account it's tied to, once they sign in (optional: only buying needs it). */
  account?: { provider: 'discord'; id: string; name: string };
  /** Premium skins bought, by sku. */
  owned?: string[];
}

/** The look a profile wears right now, as far as its level and purchases allow. */
export const wornLook = (p: Profile): Look => allowedLook(p.look, levelOf(p.xp), p.owned);

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
  /** Who they're signed in as, if they are. */
  account: { provider: 'discord'; name: string } | null;
  owned: string[];
  /** What this server offers: Discord sign-in, and the shop (both need setting up). */
  signIn?: boolean;
  shop?: boolean;
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
    look: allowedLook(p.look, level, p.owned),
    bestLaps: p.bestLaps,
    daily: list(p.daily.period, p.daily.progress, false),
    weekly: list(p.weekly.period, p.weekly.progress, true),
    dailyEnds: day + 86400000,
    weeklyEnds: new Date(weekKey(now)).getTime() + 7 * 86400000,
    account: p.account ? { provider: p.account.provider, name: p.account.name } : null,
    owned: ownedSkus(p.owned), // (with what's in their sets)
  };
}

/** One line on a map's race leaderboard. */
export interface LapRecord {
  id: string; // profile id
  name: string;
  time: number;
  when: number;
}
