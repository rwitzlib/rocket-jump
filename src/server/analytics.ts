import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODES, WEAPONS, type GameMode } from '../shared/config';
import { MAPS } from '../shared/map';
import { blankTally, type MatchReport, type WeaponTally } from '../shared/server';

// What people do, counted per day, to see what matters: how many come and from where, how long they
// stay, how many leave in the first two minutes, which modes and maps they play, what the menus get
// used for, where on each map people die, and how each weapon does in the hands of people (never
// bots), to see which are too strong or too weak. Nothing personal is kept: players are counted by a
// hash, never an address, and where they're from is a country (from Cloudflare), a time zone and a
// language. Saved next to the profiles (DATA_DIR), shown at /stats behind STATS_KEY.

const KEEP_DAYS = 60;
const SAVE_DELAY = 10_000;
const EARLY = 120; // seconds: a session shorter than this is someone who left early
const CELL = 4; // meters per heatmap cell
const MAX_KEYS = 300; // distinct referrers, time zones... per day; the rest count as "other"
const MAX_SEEN = 500_000; // players remembered, to tell new ones from returning ones

/** Things the page reports (POST /event): anything else is ignored. */
export const CLIENT_EVENTS = [
  'visit',
  'touch-device',
  'gamepad',
  'training-start',
  'training-complete',
  'practice-start',
  'online-start',
  'editor-open',
  'editor-test',
  'editor-host',
  'profile-open',
  'clip-saved',
  'settings-open',
] as const;
export type ClientEvent = (typeof CLIENT_EVENTS)[number];

/** Where a visit came from: each part null when unknown. */
export interface Origin {
  country: string | null;
  lang: string | null;
  tz: string | null;
  ref: string | null;
}

/** A weapon's day: its tally summed over people, plus how people did in matches where it was their main weapon. */
interface WeaponDay extends WeaponTally {
  main: number; // matches where it did most of someone's damage
  wins: number;
  placeSum: number; // 1 first .. 0 last, summed over the `placed` matches
  placed: number;
  mainKills: number;
  mainDeaths: number;
}

interface MatchBucket {
  matches: number;
  finished: number;
  people: number; // summed over matches
  seconds: number;
}

/** One map, mode and kind of game (with other people, or one person against bots). */
interface Fights {
  match: MatchBucket;
  weapons: Record<string, WeaponDay>;
  matchups: Record<string, Record<string, number>>;
}

interface Day {
  sessions: number;
  seconds: number; // total time connected
  early: number; // sessions that ended inside EARLY seconds
  players: string[]; // hashed, unique
  newPlayers: number; // of those, seen here for the first time
  peak: number; // most connected at once
  hours: number[]; // sessions by the UTC hour they started
  modes: Record<string, number>; // sessions by the mode they joined into
  maps: Record<string, number>;
  earlyMaps: Record<string, number>; // early leavers by the map they joined into
  matches: number;
  suspects: number;
  events: Record<string, number>;
  from: { country: Record<string, number>; lang: Record<string, number>; tz: Record<string, number>; ref: Record<string, number> }; // visits
  sessionCountry: Record<string, number>;
  fights: Record<string, Fights>; // "map|mode|pvp" or "map|mode|bots"
}

interface SaveFile {
  days: Record<string, Day>;
  heat: Record<string, Record<string, number>>; // map -> "x,z" cell -> deaths
  seen: Record<string, string>; // hashed player -> first day
}

const today = () => new Date().toISOString().slice(0, 10);
const blankDay = (): Day => ({
  sessions: 0,
  seconds: 0,
  early: 0,
  players: [],
  newPlayers: 0,
  peak: 0,
  hours: new Array<number>(24).fill(0),
  modes: {},
  maps: {},
  earlyMaps: {},
  matches: 0,
  suspects: 0,
  events: {},
  from: { country: {}, lang: {}, tz: {}, ref: {} },
  sessionCountry: {},
  fights: {},
});
const blankWeapon = (): WeaponDay => ({ ...blankTally(), main: 0, wins: 0, placeSum: 0, placed: 0, mainKills: 0, mainDeaths: 0 });

/** Counts one more under `key`, keeping at most MAX_KEYS of them. */
function bump(r: Record<string, number>, key: string, n = 1) {
  if (!Object.hasOwn(r, key) && Object.keys(r).length >= MAX_KEYS) key = 'other';
  r[key] = (r[key] ?? 0) + n;
}

/** Adds every number in `from` onto `to`. */
function addInto<T extends object>(to: T, from: Partial<T>) {
  for (const [k, v] of Object.entries(from)) if (typeof v === 'number') (to as Record<string, number>)[k] = ((to as Record<string, number>)[k] ?? 0) + v;
}

/** What the page sends with a visit, checked: a time zone, a referring site, a campaign. */
export function cleanOrigin(body: Record<string, unknown> | null, country: string | null, acceptLanguage: string | undefined): Origin {
  const tz = typeof body?.tz === 'string' && body.tz.length <= 40 && /^(UTC|[A-Z][A-Za-z_]+(\/[A-Za-z0-9_+-]+){1,2})$/.test(body.tz) ? body.tz : null;
  const lang = /^\s*([a-z]{2,3})\b/i.exec(acceptLanguage ?? '')?.[1].toLowerCase() ?? null;
  const utm = typeof body?.utm === 'string' && /^[A-Za-z0-9_.-]{1,30}$/.test(body.utm) ? body.utm.toLowerCase() : null;
  const host = typeof body?.ref === 'string' ? body.ref.toLowerCase().replace(/^www\./, '') : '';
  const ref = utm ? `utm:${utm}` : /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && host.length <= 60 ? host : null;
  return { country, lang, tz, ref };
}

export class Analytics {
  private data: SaveFile = { days: {}, heat: {}, seen: {} };
  private readonly file: string | null;
  private timer: NodeJS.Timeout | null = null;

  constructor(dir: string | null) {
    this.file = dir ? join(dir, 'rocket-jump-analytics.json') : null;
    if (this.file && existsSync(this.file)) {
      try {
        const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<SaveFile>;
        // (Days saved before a field existed get it blank.)
        const days = Object.fromEntries(Object.entries(saved.days ?? {}).map(([k, d]) => [k, { ...blankDay(), ...d }]));
        this.data = { days, heat: saved.heat ?? {}, seen: saved.seen ?? {} };
      } catch {
        // start over
      }
    }
  }

  /** Someone, counted without saying who: a short hash of what identifies them. */
  static who(id: string): string {
    return createHash('sha256').update(`rj-analytics:${id}`).digest('hex').slice(0, 12);
  }

  private day(): Day {
    const key = today();
    let d = this.data.days[key];
    if (!d) {
      d = this.data.days[key] = blankDay();
      // Forget old days.
      const keys = Object.keys(this.data.days).sort();
      for (const old of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete this.data.days[old];
    }
    return d;
  }

  /** A connection ended: how long it lasted, where it went first, and where it came from. */
  session(who: string, seconds: number, mode: string, map: string, country: string | null = null) {
    const d = this.day();
    d.sessions++;
    d.seconds += Math.round(seconds);
    if (seconds < EARLY) {
      d.early++;
      bump(d.earlyMaps, map);
    }
    d.hours[new Date(Date.now() - seconds * 1000).getUTCHours()]++;
    const id = Analytics.who(who);
    if (!d.players.includes(id)) {
      d.players.push(id);
      if (!Object.hasOwn(this.data.seen, id)) {
        d.newPlayers++;
        this.data.seen[id] = today();
        const seen = Object.keys(this.data.seen);
        if (seen.length > MAX_SEEN) for (const old of seen.slice(0, seen.length - MAX_SEEN)) delete this.data.seen[old];
      }
    }
    bump(d.modes, mode);
    bump(d.maps, map);
    bump(d.sessionCountry, country ?? '??');
    this.changed();
  }

  /** How many are connected right now, for the day's peak. */
  connected(n: number) {
    const d = this.day();
    if (n <= d.peak) return;
    d.peak = n;
    this.changed();
  }

  match() {
    this.day().matches++;
    this.changed();
  }

  suspect() {
    this.day().suspects++;
    this.changed();
  }

  event(name: ClientEvent, origin?: Origin) {
    const d = this.day();
    d.events[name] = (d.events[name] ?? 0) + 1;
    if (name === 'visit' && origin) {
      bump(d.from.country, origin.country ?? '??');
      bump(d.from.lang, origin.lang ?? '??');
      bump(d.from.tz, origin.tz ?? '??');
      bump(d.from.ref, origin.ref ?? '(direct)');
    }
    this.changed();
  }

  death(map: string, x: number, z: number) {
    if (map.startsWith('custom-')) return;
    const heat = (this.data.heat[map] ??= {});
    const cell = `${Math.round(x / CELL)},${Math.round(z / CELL)}`;
    heat[cell] = (heat[cell] ?? 0) + 1;
    this.changed();
  }

  /** A match's fighting (see GameServer.onMatchReport): each weapon's numbers, and how people did with their main one. */
  fights(r: MatchReport) {
    if (!r.people.length) return;
    const key = `${r.map}|${r.mode}|${r.people.length >= 2 ? 'pvp' : 'bots'}`;
    const f = (this.day().fights[key] ??= { match: { matches: 0, finished: 0, people: 0, seconds: 0 }, weapons: {}, matchups: {} });
    f.match.matches++;
    if (r.finished) f.match.finished++;
    f.match.people += r.people.length;
    f.match.seconds += r.seconds;
    for (const person of r.people) {
      for (const [weapon, t] of Object.entries(person.weapons)) addInto((f.weapons[weapon] ??= blankWeapon()), t);
      // Their main weapon: the one that did most of their damage (or, with none, the one they held longest).
      const [main] = Object.entries(person.weapons)
        .filter(([w]) => w in WEAPONS)
        .sort(([, a], [, b]) => b.damage - a.damage || b.held - a.held);
      if (!main || (main[1].damage === 0 && main[1].held < 30)) continue;
      const w = f.weapons[main[0]];
      w.main++;
      w.mainKills += person.kills;
      w.mainDeaths += person.deaths;
      if (person.won) w.wins++;
      if (person.place !== null) {
        w.placeSum += person.place;
        w.placed++;
      }
    }
    for (const [killer, row] of Object.entries(r.matchups)) for (const [victim, n] of Object.entries(row)) bump((f.matchups[killer] ??= {}), victim, n);
    this.changed();
  }

  /** The numbers for the stats page, over the last `filter.days` days and the maps, modes and games it picks. */
  view(filter: StatsFilter) {
    const dates = Object.keys(this.data.days).sort().reverse().slice(0, filter.days);
    const days = dates.map((date) => [date, this.data.days[date]] as const);
    const sum = (f: (d: Day) => number) => days.reduce((n, [, d]) => n + f(d), 0);
    const merge = (f: (d: Day) => Record<string, number>) => {
      const out: Record<string, number> = {};
      for (const [, d] of days) for (const [k, v] of Object.entries(f(d))) out[k] = (out[k] ?? 0) + v;
      return out;
    };

    const players = new Set<string>();
    for (const [, d] of days) for (const p of d.players) players.add(p);
    const sessions = sum((d) => d.sessions);
    const visits = sum((d) => d.events.visit ?? 0);
    const totals = {
      players: players.size,
      newPlayers: sum((d) => d.newPlayers),
      sessions,
      visits,
      avgMinutes: sessions ? sum((d) => d.seconds) / sessions / 60 : 0,
      early: sessions ? sum((d) => d.early) / sessions : 0,
      matches: sum((d) => d.matches),
      peak: Math.max(0, ...days.map(([, d]) => d.peak)),
      suspects: sum((d) => d.suspects),
    };
    const daily = days.map(([date, d]) => ({ date, players: d.players.length, newPlayers: d.newPlayers, sessions: d.sessions, visits: d.events.visit ?? 0, peak: d.peak, avgMinutes: d.sessions ? d.seconds / d.sessions / 60 : 0, early: d.sessions ? d.early / d.sessions : 0, matches: d.matches, suspects: d.suspects }));
    const hours = new Array<number>(24).fill(0);
    for (const [, d] of days) d.hours.forEach((n, h) => (hours[h] += n));
    const audience = {
      country: merge((d) => d.from.country),
      sessionCountry: merge((d) => d.sessionCountry),
      tz: merge((d) => d.from.tz),
      lang: merge((d) => d.from.lang),
      ref: merge((d) => d.from.ref),
      events: merge((d) => d.events),
    };

    // The fighting, filtered.
    const weapons: Record<string, WeaponDay> = {};
    const matchups: Record<string, Record<string, number>> = {};
    const maps: Record<string, MatchBucket & { sessions: number; early: number }> = {};
    const options = { maps: new Set<string>(), modes: new Set<string>() };
    for (const [, d] of days) {
      for (const [key, f] of Object.entries(d.fights)) {
        const [map, mode, kind] = key.split('|');
        options.maps.add(map);
        options.modes.add(mode);
        if ((filter.mode && mode !== filter.mode) || (filter.games !== 'all' && kind !== filter.games)) continue;
        // (The map table shows every map; the weapons, only the one picked.)
        addInto((maps[`${map}|${mode}`] ??= { matches: 0, finished: 0, people: 0, seconds: 0, sessions: 0, early: 0 }), f.match);
        if (filter.map && map !== filter.map) continue;
        for (const [w, t] of Object.entries(f.weapons)) addInto((weapons[w] ??= blankWeapon()), t);
        for (const [k, row] of Object.entries(f.matchups)) for (const [v, n] of Object.entries(row)) (matchups[k] ??= {})[v] = ((matchups[k] ??= {})[v] ?? 0) + n;
      }
    }
    const sessionsByMap = merge((d) => d.maps);
    const earlyByMap = merge((d) => d.earlyMaps);
    return { filter, dates, totals, daily, hours, audience, weapons: weaponRows(weapons), matchups, maps: mapRows(maps, sessionsByMap, earlyByMap), sessionsByMode: merge((d) => d.modes), options: { maps: [...options.maps].sort(), modes: [...options.modes].sort() } };
  }

  /** The heatmap for one map: cells (CELL meters) and their deaths. */
  heat(map: string) {
    return { cell: CELL, cells: this.data.heat[map] ?? {} };
  }

  /** Each map's ten deadliest cells. */
  hottest() {
    return Object.fromEntries(
      Object.entries(this.data.heat).map(([map, cells]) => [
        map,
        Object.entries(cells)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 10)
          .map(([cell, deaths]) => ({ at: cell.split(',').map((v) => Number(v) * CELL), deaths })),
      ]),
    );
  }

  private changed() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.save(), SAVE_DELAY);
  }

  save() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    try {
      mkdirSync(join(this.file, '..'), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (err) {
      console.error('Could not save analytics', err);
    }
  }
}

export interface StatsFilter {
  days: number;
  map: string; // '' for all
  mode: string; // '' for all
  games: 'all' | 'pvp' | 'bots';
}

/** The stats page's filter from its query string. */
export function parseFilter(q: URLSearchParams): StatsFilter {
  const days = Number(q.get('days'));
  const games = q.get('games');
  const word = (v: string | null) => (v && /^[a-z0-9-]{1,40}$/.test(v) ? v : '');
  return { days: [1, 7, 14, 30, 60].includes(days) ? days : 30, map: word(q.get('map')), mode: word(q.get('mode')), games: games === 'pvp' || games === 'bots' ? games : 'all' };
}

// --- the weapon balance verdict ------------------------------------------------------------------

/** Below these, a weapon's numbers are too thin to call it strong or weak. */
const ENOUGH = { heldMinutes: 30, mains: 20 };
const STRONG = 1.15;
const WEAK = 0.87;

const OTHER_CAUSES: Record<string, string> = { vehicle: 'Vehicle blast', ram: 'Run over', fall: 'Fall / hazard' };

/** Each weapon's numbers made comparable: per minute held, per shot, per match as someone's main. */
function weaponRows(weapons: Record<string, WeaponDay>) {
  const primaries = (Object.keys(WEAPONS) as (keyof typeof WEAPONS)[]).filter((w) => WEAPONS[w].slot === 'primary');
  const all = primaries.map((w) => weapons[w] ?? blankWeapon());
  const held = all.reduce((n, w) => n + w.held, 0);
  const kills = all.reduce((n, w) => n + w.kills, 0);
  const allKills = Object.values(weapons).reduce((n, w) => n + w.kills, 0);
  const kpm = held ? kills / (held / 60) : 0;
  const placed = all.reduce((n, w) => n + w.placed, 0);
  const place = placed ? all.reduce((n, w) => n + w.placeSum, 0) / placed : 0;
  const rows = primaries.map((id) => {
    const w = weapons[id] ?? blankWeapon();
    const minutes = w.held / 60;
    const k = minutes ? w.kills / minutes : 0;
    const avgPlace = w.placed ? w.placeSum / w.placed : null;
    const ratios: number[] = [];
    if (minutes >= ENOUGH.heldMinutes && kpm) ratios.push(k / kpm);
    if (w.placed >= ENOUGH.mains && place && avgPlace !== null) ratios.push(avgPlace / place);
    const power = ratios.length ? ratios.reduce((a, b) => a + b) / ratios.length : null;
    return {
      id,
      name: WEAPONS[id].name,
      heldMinutes: minutes,
      useShare: held ? w.held / held : 0,
      pickups: w.pickups,
      shots: w.shots,
      hitsPerShot: w.shots ? w.hits / w.shots : null,
      damagePerMinute: minutes ? w.damage / minutes : null,
      killsPerMinute: minutes ? k : null,
      killShare: allKills ? w.kills / allKills : 0,
      kills: w.kills,
      airshots: w.kills ? w.airshots / w.kills : null,
      killDistance: w.kills ? w.distance / w.kills : null,
      deaths: w.deaths,
      suicides: w.suicides,
      main: w.main,
      winRate: w.main ? w.wins / w.main : null,
      avgPlace,
      killsPerMatch: w.main ? w.mainKills / w.main : null,
      kd: w.main ? w.mainKills / Math.max(1, w.mainDeaths) : null,
      power,
      verdict: power === null ? 'needs data' : power >= STRONG ? 'strong' : power <= WEAK ? 'weak' : 'balanced',
    };
  });
  const other = Object.entries(OTHER_CAUSES).map(([id, name]) => {
    const w = weapons[id] ?? blankWeapon();
    return { id, name, kills: w.kills, killShare: allKills ? w.kills / allKills : 0, deaths: w.deaths, suicides: w.suicides, damage: w.damage };
  });
  return { rows, other, baseline: { killsPerMinute: kpm, avgPlace: placed ? place : null, heldMinutes: held / 60, kills: allKills } };
}

function mapRows(maps: Record<string, MatchBucket & { sessions: number; early: number }>, sessions: Record<string, number>, early: Record<string, number>) {
  const rows = Object.entries(maps).map(([key, m]) => {
    const [map, mode] = key.split('|');
    return { map, mode, matches: m.matches, finished: m.matches ? m.finished / m.matches : 0, people: m.matches ? m.people / m.matches : 0, minutes: m.matches ? m.seconds / m.matches / 60 : 0 };
  });
  rows.sort((a, b) => b.matches - a.matches);
  const joins = Object.entries(sessions)
    .map(([map, n]) => ({ map, sessions: n, early: n ? (early[map] ?? 0) / n : 0 }))
    .sort((a, b) => b.sessions - a.sessions);
  return { rows, joins };
}

// --- the page ------------------------------------------------------------------------------------

type View = ReturnType<Analytics['view']>;

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const pct = (v: number | null, digits = 0) => (v === null ? '–' : `${(v * 100).toFixed(digits)}%`);
const fixed = (v: number | null, digits = 1) => (v === null ? '–' : v.toFixed(digits));
const int = (v: number) => Math.round(v).toLocaleString('en-US');
const mapTitle = (m: string) => esc(Object.hasOwn(MAPS, m) ? MAPS[m].title : m);
const modeName = (m: string) => esc(Object.hasOwn(MODES, m) ? MODES[m as GameMode].name : m);
const weaponName = (w: string) => esc(w in WEAPONS ? WEAPONS[w as keyof typeof WEAPONS].name : (OTHER_CAUSES[w] ?? w));

const regions = new Intl.DisplayNames(['en'], { type: 'region' });
/** A country's name, from its two-letter code. */
function countryName(c: string): string {
  if (c === '??') return 'Unknown <small>(needs Cloudflare)</small>';
  try {
    return `${esc(regions.of(c) ?? c)} <small>${esc(c)}</small>`;
  } catch {
    return esc(c);
  }
}

/** The top entries of a count, as a bar list. */
function topList(r: Record<string, number>, label: (k: string) => string = esc, limit = 12): string {
  const entries = Object.entries(r).sort(([, a], [, b]) => b - a);
  if (!entries.length) return '<p class="muted">Nothing yet.</p>';
  const total = entries.reduce((n, [, v]) => n + v, 0);
  const top = entries.slice(0, limit).map(([k, v]) => [label(k), v] as const);
  const rest = entries.slice(limit).reduce((n, [, v]) => n + v, 0);
  if (rest) top.push([`<i>${entries.length - limit} more</i>`, rest]);
  const most = entries[0][1];
  return `<ul class="bars">${top
    .map(([k, v]) => `<li><span class="lbl">${k}</span><span class="track"><span style="width:${Math.min(100, (v / most) * 100).toFixed(1)}%"></span></span><span class="val">${int(v)} <small>${pct(v / total)}</small></span></li>`)
    .join('')}</ul>`;
}

/** A column chart: one or two stacked series per column. */
function columns(points: { label: string; a: number; b?: number; title: string }[], legend: [string, string?]): string {
  if (!points.length) return '<p class="muted">Nothing yet.</p>';
  const w = 720;
  const h = 160;
  const max = Math.max(1, ...points.map((p) => p.a + (p.b ?? 0)));
  const step = w / points.length;
  const bar = Math.max(2, step * 0.7);
  const every = Math.ceil(points.length / 12);
  const cols = points
    .map((p, i) => {
      const x = i * step + (step - bar) / 2;
      const ha = (p.a / max) * (h - 20);
      const hb = ((p.b ?? 0) / max) * (h - 20);
      return `<g><title>${esc(p.title)}</title><rect x="${x.toFixed(1)}" y="${(h - ha).toFixed(1)}" width="${bar.toFixed(1)}" height="${ha.toFixed(1)}" class="sa" rx="1.5"/>${hb ? `<rect x="${x.toFixed(1)}" y="${(h - ha - hb).toFixed(1)}" width="${bar.toFixed(1)}" height="${hb.toFixed(1)}" class="sb" rx="1.5"/>` : ''}${i % every === 0 ? `<text x="${(x + bar / 2).toFixed(1)}" y="${h + 14}" text-anchor="middle">${esc(p.label)}</text>` : ''}</g>`;
    })
    .join('');
  const key = `<span class="key"><i class="sa"></i>${esc(legend[0])}</span>${legend[1] ? `<span class="key"><i class="sb"></i>${esc(legend[1])}</span>` : ''}`;
  return `<div class="legend">${key} <span class="muted">· most ${int(max)}</span></div><svg viewBox="0 0 ${w} ${h + 20}" class="chart" role="img">${cols}</svg>`;
}

function select(name: string, current: string, options: [string, string][]): string {
  return `<label>${esc(name === 'games' ? 'Games' : name[0].toUpperCase() + name.slice(1))}<select name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
}

const tile = (label: string, value: string, note = '') => `<div class="tile"><div class="tl">${esc(label)}</div><div class="tv">${value}</div>${note ? `<div class="tn">${note}</div>` : ''}</div>`;

/** Strong / weak / balanced, as a badge with how far off the average the weapon is. */
function verdict(r: View['weapons']['rows'][number]): string {
  const off = r.power === null ? '' : ` ${r.power >= 1 ? '+' : ''}${Math.round((r.power - 1) * 100)}%`;
  return `<span class="badge ${r.verdict.replace(' ', '-')}">${esc(r.verdict)}${off}</span>`;
}

/** A cell for a rate, tinted by how far it sits from the average. */
function vsAvg(v: number | null, avg: number | null, text: string): string {
  if (v === null || !avg) return `<td>${text}</td>`;
  const r = v / avg;
  const cls = r >= STRONG ? 'hi' : r <= WEAK ? 'lo' : '';
  return `<td class="${cls}" title="${Math.round(r * 100)}% of the average">${text}</td>`;
}

/** The stats page, for the server's owner. */
export function statsPage(v: View, extra: { profiles: number; rooms: number; connected: number; hottest: ReturnType<Analytics['hottest']> }): string {
  const f = v.filter;
  const t = v.totals;
  const w = v.weapons;
  const daily = [...v.daily].reverse();
  const filterForm = `<form method="get" class="filters">
${select('days', String(f.days), [['1', 'Today'], ['7', 'Last 7 days'], ['14', 'Last 14 days'], ['30', 'Last 30 days'], ['60', 'Last 60 days']])}
${select('map', f.map, [['', 'All maps'], ...v.options.maps.map((m): [string, string] => [m, Object.hasOwn(MAPS, m) ? MAPS[m].title : m])])}
${select('mode', f.mode, [['', 'All modes'], ...v.options.modes.map((m): [string, string] => [m, Object.hasOwn(MODES, m) ? MODES[m as GameMode].name : m])])}
${select('games', f.games, [['all', 'All games'], ['pvp', 'With other people'], ['bots', 'Alone against bots']])}
<button>Show</button></form>`;

  const weaponTable = `<div class="wrap"><table class="num">
<thead><tr><th>Weapon</th><th>Verdict</th><th title="Share of all time people spent holding a primary">Use</th><th>Kills / min held</th><th>Damage / min held</th><th title="Hits that did damage per shot fired (the Thunder Gun can hit several at once)">Hits / shot</th><th>Kill share</th><th>Airshots</th><th title="Mean distance from killer to victim">Kill range</th><th title="Matches where this weapon did most of someone's damage">Main in</th><th>Win rate</th><th title="Where they finished: 100% first, 0% last">Avg place</th><th>Kills / match</th><th>K/D</th><th>Self-kills</th><th>Pickups</th></tr></thead>
<tbody>${w.rows
    .map(
      (r) =>
        `<tr><th>${esc(r.name)}</th><td>${verdict(r)}</td><td>${pct(r.useShare)} <small>${int(r.heldMinutes)} min</small></td>${vsAvg(r.killsPerMinute, w.baseline.killsPerMinute, fixed(r.killsPerMinute, 2))}<td>${fixed(r.damagePerMinute, 0)}</td><td>${pct(r.hitsPerShot)} <small>${int(r.shots)}</small></td><td>${pct(r.killShare)} <small>${int(r.kills)}</small></td><td>${pct(r.airshots)}</td><td>${r.killDistance === null ? '–' : `${r.killDistance.toFixed(0)} m`}</td><td>${int(r.main)}</td><td>${pct(r.winRate)}</td>${vsAvg(r.avgPlace, w.baseline.avgPlace, pct(r.avgPlace))}<td>${fixed(r.killsPerMatch)}</td><td>${fixed(r.kd, 2)}</td><td>${int(r.suicides)}</td><td>${int(r.pickups)}</td></tr>`,
    )
    .join('')}</tbody>
<tfoot><tr><th>All primaries</th><td></td><td>${int(w.baseline.heldMinutes)} min</td><td>${fixed(w.baseline.killsPerMinute, 2)}</td><td colspan="7"></td><td>${pct(w.baseline.avgPlace)}</td><td colspan="4"></td></tr></tfoot>
</table></div>`;

  const otherCauses = `<ul class="plain">${w.other.map((o) => `<li><b>${esc(o.name)}</b>: ${int(o.kills)} kills by people (${pct(o.killShare)}), killed people ${int(o.deaths)} times, ${int(o.suicides)} self-inflicted</li>`).join('')}</ul>`;

  const ids = w.rows.map((r) => r.id);
  const matchupTable = `<div class="wrap"><table class="num matrix"><thead><tr><th>Killed with ↓ / holding →</th>${ids.map((id) => `<th>${weaponName(id)}</th>`).join('')}</tr></thead><tbody>${ids
    .map((k) => {
      const row = v.matchups[k] ?? {};
      const total = ids.reduce((n, id) => n + (row[id] ?? 0), 0);
      return `<tr><th>${weaponName(k)}</th>${ids
        .map((id) => {
          const n = row[id] ?? 0;
          const back = v.matchups[id]?.[k] ?? 0;
          // How this pairing goes: kills one way against the other.
          const edge = n + back >= 10 ? n / (n + back) : null;
          return `<td class="${edge === null || k === id ? '' : edge >= 0.6 ? 'hi' : edge <= 0.4 ? 'lo' : ''}" title="${int(n)} kills with ${esc(weaponName(k))} on someone holding ${esc(weaponName(id))}; ${int(back)} the other way">${n ? int(n) : '·'}${edge !== null && k !== id ? ` <small>${pct(edge)}</small>` : ''}</td>`;
        })
        .join('')}<td class="muted">${int(total)}</td></tr>`;
    })
    .join('')}</tbody></table></div>`;

  const mapTable = `<div class="wrap"><table class="num"><thead><tr><th>Map</th><th>Mode</th><th>Matches</th><th>Played to the end</th><th>People / match</th><th>Minutes / match</th></tr></thead><tbody>${
    v.maps.rows.map((m) => `<tr><th>${mapTitle(m.map)}</th><td class="l">${modeName(m.mode)}</td><td>${int(m.matches)}</td><td>${pct(m.finished)}</td><td>${fixed(m.people)}</td><td>${fixed(m.minutes)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No matches yet.</td></tr>'
  }</tbody></table></div>`;
  const joinTable = `<div class="wrap"><table class="num"><thead><tr><th>Joined into</th><th>Sessions</th><th>Left in 2 min</th></tr></thead><tbody>${v.maps.joins.map((m) => `<tr><th>${mapTitle(m.map)}</th><td>${int(m.sessions)}</td><td class="${m.early > t.early * 1.25 && m.sessions >= 20 ? 'warn' : ''}" title="Average: ${pct(t.early)}">${pct(m.early)}</td></tr>`).join('')}</tbody></table></div>`;

  const dayRows = v.daily
    .map((d) => `<tr><th>${esc(d.date)}</th><td>${int(d.visits)}</td><td>${int(d.players)}</td><td>${int(d.newPlayers)}</td><td>${int(d.sessions)}</td><td>${fixed(d.avgMinutes)}</td><td>${pct(d.early)}</td><td>${int(d.peak)}</td><td>${int(d.matches)}</td><td>${int(d.suspects)}</td></tr>`)
    .join('');

  const heat = Object.entries(extra.hottest)
    .filter(([map]) => !f.map || map === f.map)
    .map(([map, cells]) => `<li><b>${mapTitle(map)}</b>: ${cells.map((c) => `(${c.at.join(', ')}) ${c.deaths}`).join(' · ')}</li>`)
    .join('');

  const filtered = [f.map && mapTitle(f.map), f.mode && modeName(f.mode), f.games === 'pvp' ? 'games with other people' : f.games === 'bots' ? 'one person against bots' : ''].filter(Boolean).join(', ');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rocket Jump stats</title>
<style>
:root{--bg:#0b0f16;--panel:#131a25;--line:#243044;--text:#eef2f7;--muted:#8a94a6;--a:#4c9aff;--b:#ffb347;--hi:#ff6b5b;--lo:#5bc0ff;--ok:#5fd38d}
*{box-sizing:border-box}body{font:14px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--text);margin:0;padding:16px;max-width:1400px;margin-inline:auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}h3{font-size:14px;margin:0 0 8px;color:var(--muted);font-weight:600}
.muted,small{color:var(--muted)}small{font-size:11px}
.filters{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:end;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:14px 0}
.filters label{display:flex;flex-direction:column;font-size:12px;color:var(--muted);gap:3px}
select,button{font:inherit;background:#0e141e;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:5px 8px}button{background:var(--a);border-color:var(--a);color:#fff;cursor:pointer;padding:5px 16px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px}.tl{font-size:12px;color:var(--muted)}.tv{font-size:24px;font-weight:650;margin-top:2px}.tn{font-size:11px;color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px;min-width:0}
.wrap{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top;white-space:nowrap}thead th{color:var(--muted);font-weight:600;font-size:12px;position:sticky;top:0;background:var(--panel)}tbody th,tfoot th{font-weight:600}
table.num td{text-align:right;font-variant-numeric:tabular-nums}tfoot td,tfoot th{color:var(--muted);border-bottom:0}
td.hi{color:var(--hi);font-weight:600}td.lo{color:var(--lo);font-weight:600}td.warn{color:var(--b);font-weight:600}table.num td.l{text-align:left}
.matrix td{text-align:center}
.badge{display:inline-block;border-radius:99px;padding:1px 8px;font-size:12px;font-weight:600;border:1px solid currentColor}.badge.strong{color:var(--hi)}.badge.weak{color:var(--lo)}.badge.balanced{color:var(--ok)}.badge.needs-data{color:var(--muted)}
.bars{list-style:none;margin:0;padding:0;display:grid;gap:4px}.bars li{display:grid;grid-template-columns:minmax(80px,40%) 1fr auto;gap:8px;align-items:center}.lbl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.track{background:#0e141e;border-radius:3px;height:8px;overflow:hidden}.track span{display:block;height:100%;background:var(--a);border-radius:3px}.val{font-variant-numeric:tabular-nums;text-align:right}
.chart{width:100%;height:auto;display:block}.chart text{fill:var(--muted);font-size:10px}.sa{fill:var(--a);background:var(--a)}.sb{fill:var(--b);background:var(--b)}
.legend{font-size:12px;margin-bottom:6px;display:flex;gap:12px;flex-wrap:wrap}.key i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}
.plain{margin:6px 0;padding-left:18px}.note{font-size:12px;color:var(--muted);max-width:900px}
</style>
<h1>Rocket Jump stats</h1>
<p class="muted">${int(extra.connected)} connected now · ${int(extra.rooms)} rooms open · ${int(extra.profiles)} profiles · ${v.dates.length ? `${esc(v.dates.at(-1))} to ${esc(v.dates[0])} (UTC)` : 'no days yet'}</p>
${filterForm}

<div class="tiles">
${tile('Players', int(t.players), `${int(t.newPlayers)} new · ${t.players ? pct(1 - Math.min(1, t.newPlayers / t.players)) : '–'} returning`)}
${tile('Visits', int(t.visits), t.visits ? `${pct(Math.min(1, t.players / t.visits))} went on to play online` : '')}
${tile('Sessions', int(t.sessions), `${fixed(t.avgMinutes)} min on average`)}
${tile('Left in 2 min', pct(t.early))}
${tile('Peak online', int(t.peak))}
${tile('Matches', int(t.matches), 'with a person in them')}
${tile('Aim flags', int(t.suspects))}
</div>

<h2>Weapon balance${filtered ? ` <small>· ${filtered}</small>` : ''}</h2>
<p class="note">People only (bots' kills and shots aren't counted, though being killed by a bot is). The verdict weighs <b>kills per minute held</b> (so a weapon isn't rated on how often it's picked up) and <b>average place</b> in matches where it was someone's main weapon, each against the average of all primaries; it needs ${ENOUGH.heldMinutes} minutes held or ${ENOUGH.mains} matches as a main. Red is ${Math.round((STRONG - 1) * 100)}%+ above average, blue ${Math.round((1 - WEAK) * 100)}%+ below. Rocket is everyone's starting weapon, so it's held the most and fought with by newer players: compare the others with each other first. Duel and Instagib skew heavily, so filter by mode for a fair read.</p>
${weaponTable}
<div class="grid" style="margin-top:14px">
<div class="card"><h3>Kill share</h3>${topList(Object.fromEntries([...w.rows, ...w.other].filter((r) => r.kills).map((r) => [r.name, r.kills])))}</div>
<div class="card"><h3>Other ways people die</h3>${otherCauses}</div>
</div>
<h2>Matchups</h2>
<p class="note">Kills with one weapon (rows) on someone holding another (columns); the small figure is how that pairing goes both ways, shown once there are 10 kills between them. Red: the row's weapon wins it 60%+ of the time.</p>
${matchupTable}

<h2>Players over time</h2>
<div class="grid">
<div class="card"><h3>Players a day</h3>${columns(daily.map((d) => ({ label: d.date.slice(5), a: d.players - d.newPlayers, b: d.newPlayers, title: `${d.date}: ${d.players} players, ${d.newPlayers} new` })), ['Returning', 'New'])}</div>
<div class="card"><h3>When sessions start (UTC hour)</h3>${columns(v.hours.map((n, h) => ({ label: String(h), a: n, title: `${h}:00 UTC: ${n} sessions` })), ['Sessions'])}</div>
</div>

<h2>Where people come from</h2>
<div class="grid">
<div class="card"><h3>Country (visits)</h3>${topList(v.audience.country, countryName)}</div>
<div class="card"><h3>Country (online sessions)</h3>${topList(v.audience.sessionCountry, countryName)}</div>
<div class="card"><h3>Time zone (visits)</h3>${topList(v.audience.tz, (k) => (k === '??' ? 'Unknown' : esc(k.replace(/_/g, ' '))))}</div>
<div class="card"><h3>Came from</h3>${topList(v.audience.ref, (k) => (k.startsWith('utm:') ? `<b>${esc(k.slice(4))}</b> <small>campaign</small>` : esc(k)))}</div>
<div class="card"><h3>Browser language</h3>${topList(v.audience.lang, (k) => (k === '??' ? 'Unknown' : esc(k)))}</div>
<div class="card"><h3>What people did in the menus</h3>${topList(v.audience.events, esc, 16)}</div>
</div>

<h2>Maps and modes</h2>
<div class="grid">
<div class="card" style="grid-column:1/-1;padding:0;border:0">${mapTable}</div>
<div class="card" style="padding:0;border:0">${joinTable}</div>
<div class="card"><h3>Sessions by mode joined</h3>${topList(v.sessionsByMode, modeName)}</div>
</div>

<h2>Day by day</h2>
<div class="wrap"><table class="num"><thead><tr><th>Day (UTC)</th><th>Visits</th><th>Players</th><th>New</th><th>Sessions</th><th>Avg min</th><th>Left in 2 min</th><th>Peak</th><th>Matches</th><th>Aim flags</th></tr></thead><tbody>${dayRows}</tbody></table></div>

<h2>Where people die most <small>(x, z in meters)</small></h2><ul class="plain">${heat || '<li class="muted">Nothing yet.</li>'}</ul>
<p class="note">JSON: add <code>format=json</code> to this page's address.</p>
</html>`;
}
