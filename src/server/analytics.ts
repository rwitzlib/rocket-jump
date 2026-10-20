import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// What people do, counted per day, to see what matters: how many come, how long they stay, how many
// leave in the first two minutes, which modes and maps they play, what the menus get used for, and
// where on each map people die. Nothing personal is kept: players are counted by a hash, never an
// address. Saved next to the profiles (DATA_DIR), shown at /stats?key=STATS_KEY.

const KEEP_DAYS = 60;
const SAVE_DELAY = 10_000;
const EARLY = 120; // seconds: a session shorter than this is someone who left early
const CELL = 4; // meters per heatmap cell

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

interface Day {
  sessions: number;
  seconds: number; // total time connected
  early: number; // sessions that ended inside EARLY seconds
  players: string[]; // hashed, unique
  modes: Record<string, number>; // sessions by the mode they joined into
  maps: Record<string, number>;
  matches: number;
  suspects: number;
  events: Record<string, number>;
}

interface SaveFile {
  days: Record<string, Day>;
  heat: Record<string, Record<string, number>>; // map -> "x,z" cell -> deaths
}

const today = () => new Date().toISOString().slice(0, 10);
const blankDay = (): Day => ({ sessions: 0, seconds: 0, early: 0, players: [], modes: {}, maps: {}, matches: 0, suspects: 0, events: {} });

export class Analytics {
  private data: SaveFile = { days: {}, heat: {} };
  private readonly file: string | null;
  private timer: NodeJS.Timeout | null = null;

  constructor(dir: string | null) {
    this.file = dir ? join(dir, 'rocket-jump-analytics.json') : null;
    if (this.file && existsSync(this.file)) {
      try {
        this.data = JSON.parse(readFileSync(this.file, 'utf8')) as SaveFile;
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

  /** A connection ended: how long it lasted, and where it went first. */
  session(who: string, seconds: number, mode: string, map: string) {
    const d = this.day();
    d.sessions++;
    d.seconds += Math.round(seconds);
    if (seconds < EARLY) d.early++;
    const id = Analytics.who(who);
    if (!d.players.includes(id)) d.players.push(id);
    d.modes[mode] = (d.modes[mode] ?? 0) + 1;
    d.maps[map] = (d.maps[map] ?? 0) + 1;
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

  event(name: ClientEvent) {
    const d = this.day();
    d.events[name] = (d.events[name] ?? 0) + 1;
    this.changed();
  }

  death(map: string, x: number, z: number) {
    if (map.startsWith('custom-')) return;
    const heat = (this.data.heat[map] ??= {});
    const cell = `${Math.round(x / CELL)},${Math.round(z / CELL)}`;
    heat[cell] = (heat[cell] ?? 0) + 1;
    this.changed();
  }

  /** Everything, summed up for the stats page. */
  report() {
    const days = Object.entries(this.data.days)
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, d]) => ({
        date,
        sessions: d.sessions,
        players: d.players.length,
        avgMinutes: d.sessions ? Math.round((d.seconds / d.sessions / 60) * 10) / 10 : 0,
        leftEarly: d.sessions ? `${Math.round((d.early / d.sessions) * 100)}%` : '–',
        matches: d.matches,
        suspects: d.suspects,
        modes: d.modes,
        maps: d.maps,
        events: d.events,
      }));
    const hottest = Object.fromEntries(
      Object.entries(this.data.heat).map(([map, cells]) => [
        map,
        Object.entries(cells)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 10)
          .map(([cell, deaths]) => ({ at: cell.split(',').map((v) => Number(v) * CELL), deaths })),
      ]),
    );
    return { days, hottest };
  }

  /** The heatmap for one map: cells (CELL meters) and their deaths. */
  heat(map: string) {
    return { cell: CELL, cells: this.data.heat[map] ?? {} };
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

const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const pairs = (r: Record<string, number>) =>
  Object.entries(r)
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `${esc(k)} ${v}`)
    .join(', ');

/** A plain page of the numbers, for the server's owner. */
export function statsPage(report: ReturnType<Analytics['report']>, extra: { profiles: number; rooms: number; connected: number }): string {
  const rows = report.days
    .map(
      (d) =>
        `<tr><td>${esc(d.date)}</td><td>${d.players}</td><td>${d.sessions}</td><td>${d.avgMinutes}</td><td>${esc(d.leftEarly)}</td><td>${d.matches}</td><td>${d.suspects}</td><td>${pairs(d.modes)}</td><td>${pairs(d.maps)}</td><td>${pairs(d.events)}</td></tr>`,
    )
    .join('');
  const heat = Object.entries(report.hottest)
    .map(([map, cells]) => `<li><b>${esc(map)}</b>: ${cells.map((c) => `(${c.at.join(', ')}) ${c.deaths}`).join(' · ')}</li>`)
    .join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rocket Jump stats</title>
<style>body{font:14px system-ui,sans-serif;background:#0b0f16;color:#eef2f7;margin:16px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #2a3242;padding:6px;text-align:left;vertical-align:top}th{color:#8a94a6}h1{font-size:20px}.wrap{overflow-x:auto}</style>
<h1>Rocket Jump: who plays, and how</h1>
<p>${extra.connected} connected now · ${extra.rooms} rooms open · ${extra.profiles} profiles</p>
<div class="wrap"><table><tr><th>Day (UTC)</th><th>Players</th><th>Sessions</th><th>Avg min</th><th>Left in 2 min</th><th>Matches</th><th>Aim flags</th><th>Modes</th><th>Maps</th><th>Menu events</th></tr>${rows}</table></div>
<h2>Where people die most (x, z in meters)</h2><ul>${heat}</ul>`;
}
