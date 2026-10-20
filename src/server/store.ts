import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { allowedLook, applyStat, levelOf, newProfile, type Gain, type LapRecord, type Look, type Profile, type StatEvent } from '../shared/progress';

// Where profiles and race records live: in memory, written to one JSON file in DATA_DIR a few
// seconds after anything changes (and on shutdown). Without DATA_DIR nothing survives a restart,
// which is fine for a local server. A JSON file is plenty at this scale: a profile is under a
// kilobyte, and the whole file is rewritten in one go, atomically (write, then rename).

const SAVE_DELAY = 5000; // ms
const BOARD_SIZE = 20;
const FORGET_AFTER = 60 * 86400000; // profiles that never earned anything go after 60 days unseen

interface Board {
  laps: LapRecord[]; // best first, one per profile
  /** The record lap's path, for its ghost: x, y, z in centimeters every few ticks. */
  ghost: { id: string; time: number; path: number[] } | null;
}

interface SaveFile {
  version: 1;
  profiles: Profile[];
  boards: Record<string, Board>;
}

export class Store {
  private readonly profiles = new Map<string, Profile>();
  private readonly boards = new Map<string, Board>();
  private timer: NodeJS.Timeout | null = null;
  private readonly file: string | null;

  constructor(dir: string | null) {
    this.file = dir ? join(dir, 'rocket-jump.json') : null;
    if (!this.file || !existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as SaveFile;
      const now = Date.now();
      for (const p of data.profiles ?? []) if (p.xp > 0 || now - p.seen < FORGET_AFTER) this.profiles.set(p.id, p);
      for (const [map, board] of Object.entries(data.boards ?? {})) this.boards.set(map, board);
    } catch (err) {
      console.error('Could not read the saved profiles; starting empty', err);
    }
  }

  get profileCount(): number {
    return this.profiles.size;
  }

  /** The public id for a secret key. */
  static idOf(key: string): string {
    return createHash('sha256').update(`rocket-jump:${key}`).digest('hex').slice(0, 20);
  }

  /** The profile for this key, made on first sight. */
  profile(key: string, name = ''): Profile {
    const id = Store.idOf(key);
    let p = this.profiles.get(id);
    const now = Date.now();
    if (!p) {
      p = newProfile(id, name || 'Player', now);
      this.profiles.set(id, p);
    }
    if (name) p.name = name;
    p.seen = now;
    this.changed();
    return p;
  }

  /** Only an existing profile (for reads): undefined if this key has never played online. */
  find(key: string): Profile | undefined {
    return this.profiles.get(Store.idOf(key));
  }

  apply(key: string, name: string, e: StatEvent): Gain {
    const p = this.profile(key, name);
    const gain = applyStat(p, e, Date.now());
    if (e.type === 'lap') this.addLap(p, e.map, e.time, e.path);
    this.changed();
    return gain;
  }

  /** Puts on a look, as far as the profile's level allows. */
  setLook(key: string, look: Look): Look {
    const p = this.profile(key);
    p.look = allowedLook(look, levelOf(p.xp));
    this.changed();
    return p.look;
  }

  /** The fastest laps on a map, best first. */
  board(map: string): { laps: LapRecord[]; ghost: Board['ghost'] } {
    const b = this.boards.get(map);
    return { laps: b?.laps ?? [], ghost: b?.ghost ?? null };
  }

  /** Where this profile's best lap ranks on a map (1 = the record), or 0 if it's not on the board. */
  rank(map: string, id: string): number {
    return (this.boards.get(map)?.laps.findIndex((l) => l.id === id) ?? -1) + 1;
  }

  private addLap(p: Profile, map: string, time: number, path: number[]) {
    let b = this.boards.get(map);
    if (!b) this.boards.set(map, (b = { laps: [], ghost: null }));
    const mine = b.laps.find((l) => l.id === p.id);
    if (mine && mine.time <= time) {
      mine.name = p.name;
      return;
    }
    if (mine) b.laps.splice(b.laps.indexOf(mine), 1);
    b.laps.push({ id: p.id, name: p.name, time, when: Date.now() });
    b.laps.sort((x, y) => x.time - y.time);
    b.laps.length = Math.min(b.laps.length, BOARD_SIZE);
    if (b.laps[0].id === p.id && b.laps[0].time === time && path.length) b.ghost = { id: p.id, time, path };
  }

  private changed() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.save(), SAVE_DELAY);
  }

  /** Writes everything out now. */
  save() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    const data: SaveFile = { version: 1, profiles: [...this.profiles.values()], boards: Object.fromEntries(this.boards) };
    try {
      mkdirSync(join(this.file, '..'), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify(data));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (err) {
      console.error('Could not save profiles', err);
    }
  }
}
