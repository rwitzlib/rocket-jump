import { MAPS, PLAYABLE_MAPS } from '../shared/map';
import { EXPLOSIONS, TINTS, TRAILS, type LapRecord, type Look, type ProfileView } from '../shared/progress';
import { formatLap } from './objectives';

// The player's online profile, as the menu shows it: level and XP, lifetime stats, the day's and
// week's challenges, the skins their level has unlocked, and the race records on every map. The
// server keeps it all; this browser only holds the secret key that says whose it is.

const KEY = 'rocket-jump:profile';

/** This browser's profile key, made the first time it's asked for. Null if storage is blocked. */
export function profileKey(): string | null {
  try {
    let key = localStorage.getItem(KEY);
    if (!key || !/^[a-f0-9]{32}$/.test(key)) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      key = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(KEY, key);
    }
    return key;
  } catch {
    return null;
  }
}

async function post<T>(base: string, path: string, body: object): Promise<T> {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as T;
}

export const fetchProfile = (base: string, key: string) => post<ProfileView>(base, '/profile', { key });
export const wearLook = (base: string, key: string, look: Look) => post<ProfileView>(base, '/profile/look', { key, ...look });

export interface Board {
  map: string;
  laps: LapRecord[];
  ghost?: { name: string; time: number; path: number[] };
}

export async function fetchBoard(base: string, map: string, ghost = false): Promise<Board> {
  const res = await fetch(`${base}/leaderboard?map=${encodeURIComponent(map)}${ghost ? '&ghost=1' : ''}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as Board;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
};

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

const until = (t: number) => {
  const h = Math.max(0, Math.round((t - Date.now()) / 3600000));
  return h >= 48 ? `${Math.round(h / 24)} days left` : `${h} h left`;
};

/** The Profile window in the menu. */
export class ProfilePanel {
  private readonly root = document.querySelector<HTMLElement>('#profile')!;
  private readonly body = document.querySelector<HTMLElement>('#profile-body')!;
  private tab = 'overview';
  private view: ProfileView | null = null;
  private boardMap = PLAYABLE_MAPS[0];

  constructor(
    private readonly base: () => string,
    /** Says the profile's level wherever the page shows it (the menu badge). */
    private readonly onLevel: (level: number) => void,
  ) {
    for (const tab of this.root.querySelectorAll<HTMLElement>('.tab')) {
      tab.addEventListener('click', () => {
        this.tab = tab.dataset.tab!;
        for (const t of this.root.querySelectorAll<HTMLElement>('.tab')) t.classList.toggle('active', t === tab);
        this.render();
      });
    }
  }

  /** Opens it and fetches the latest. */
  async open() {
    this.root.hidden = false;
    this.body.replaceChildren(el('p', 'hint', 'Loading…'));
    await this.refresh();
  }

  async refresh() {
    const key = profileKey();
    if (!key) {
      this.body.replaceChildren(el('p', 'error', "This browser won't keep site data, so there's no profile to show."));
      return;
    }
    try {
      this.view = await fetchProfile(this.base(), key);
      this.onLevel(this.view.level);
      this.render();
    } catch {
      this.body.replaceChildren(el('p', 'error', "Couldn't reach the server for your profile. It's kept there, for online play."));
    }
  }

  private render() {
    const v = this.view;
    if (!v) return;
    if (this.tab === 'overview') this.body.replaceChildren(...this.overview(v));
    else if (this.tab === 'challenges') this.body.replaceChildren(...this.challenges(v));
    else if (this.tab === 'skins') this.body.replaceChildren(...this.skins(v));
    else void this.records();
  }

  private overview(v: ProfileView): HTMLElement[] {
    const head = el('div', 'profile-head');
    head.append(el('div', 'level-badge', String(v.level)), el('div', 'profile-name', v.name || 'Not played online yet'));
    const bar = el('div', 'xp-bar');
    const fill = el('div', 'xp-fill');
    fill.style.width = `${Math.round((v.levelXp / v.levelSize) * 100)}%`;
    bar.append(fill);
    const xp = el('p', 'hint', `${v.levelXp} / ${v.levelSize} XP to level ${v.level + 1} · ${v.xp} XP in all`);
    const s = v.stats;
    const grid = el('div', 'stat-grid');
    const kd = s.deaths ? (s.kills / s.deaths).toFixed(2) : String(s.kills);
    for (const [label, value] of [
      ['Kills', s.kills],
      ['Deaths', s.deaths],
      ['K/D', kd],
      ['Airshots', s.airshots],
      ['Best streak', s.bestStreak],
      ['Matches', s.matches],
      ['Wins', s.wins],
      ['Captures', s.captures],
      ['Race laps', s.laps],
    ] as const) {
      const cell = el('div', 'stat');
      cell.append(el('b', '', String(value)), el('span', '', label));
      grid.append(cell);
    }
    const note = el('p', 'hint', 'XP, stats and challenges count in online games. Your profile is tied to this browser.');
    return [head, bar, xp, grid, note];
  }

  private challenges(v: ProfileView): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const [title, list, ends, reward] of [
      ['Today', v.daily, v.dailyEnds, 150],
      ['This week', v.weekly, v.weeklyEnds, 600],
    ] as const) {
      const h = el('h3', '', `${title} `);
      h.append(el('small', 'hint', `${until(ends)} · ${reward} XP each`));
      out.push(h);
      for (const c of list) {
        const row = el('div', `challenge${c.progress >= c.target ? ' done' : ''}`);
        const bar = el('div', 'xp-bar small');
        const fill = el('div', 'xp-fill');
        fill.style.width = `${Math.round((c.progress / c.target) * 100)}%`;
        bar.append(fill);
        row.append(el('span', '', c.text), el('span', 'count', `${Math.min(c.progress, c.target)}/${c.target}`), bar);
        out.push(row);
      }
    }
    return out;
  }

  private skins(v: ProfileView): HTMLElement[] {
    const pick = async (look: Look) => {
      const key = profileKey();
      if (!key) return;
      try {
        this.view = await wearLook(this.base(), key, look);
        this.render();
      } catch {
        // stays as it was
      }
    };
    const section = (title: string, items: readonly { id: string; name: string; level: number; color: number }[], current: string, wear: (id: string) => Look) => {
      const wrap = el('div', 'looks');
      for (const item of items) {
        const locked = item.level > v.level;
        const b = el('button', `look${item.id === current ? ' worn' : ''}${locked ? ' locked' : ''}`);
        const swatch = el('span', 'swatch');
        swatch.style.background = item.id === 'auto' ? 'conic-gradient(#3d9cf0, #f0a830, #a860f0, #40c878, #f05a80, #3d9cf0)' : item.id === 'rainbow' ? 'linear-gradient(90deg, red, orange, yellow, lime, cyan, blue, violet)' : hex(item.color);
        b.append(swatch, el('span', '', locked ? `Level ${item.level}` : item.name));
        b.title = locked ? `${item.name}: unlocks at level ${item.level}` : item.name;
        b.disabled = locked;
        b.addEventListener('click', () => void pick(wear(item.id)));
        wrap.append(b);
      }
      return [el('h3', '', title), wrap];
    };
    return [
      ...section('Armor', TINTS, v.look.tint, (id) => ({ ...v.look, tint: id as Look['tint'] })),
      ...section(
        'Rocket trail',
        TRAILS.map((t) => ({ ...t, color: t.fire[1] })),
        v.look.trail,
        (id) => ({ ...v.look, trail: id as Look['trail'] }),
      ),
      ...section(
        'Explosions',
        EXPLOSIONS,
        v.look.explosion,
        (id) => ({ ...v.look, explosion: id as Look['explosion'] }),
      ),
      el('p', 'hint', 'Armor color shows outside team games. Everyone sees your trail. More explosions are on the way.'),
    ];
  }

  private async records() {
    const picker = el('select', 'board-map');
    for (const name of PLAYABLE_MAPS) picker.append(new Option(MAPS[name].title, name));
    picker.value = this.boardMap;
    picker.addEventListener('change', () => {
      this.boardMap = picker.value;
      void this.records();
    });
    const table = el('table', 'board');
    this.body.replaceChildren(picker, el('p', 'hint', 'Loading…'));
    try {
      const board = await fetchBoard(this.base(), this.boardMap);
      if (!board.laps.length) {
        this.body.replaceChildren(picker, el('p', 'hint', 'No laps yet. Race here online to set the first record.'));
        return;
      }
      board.laps.forEach((lap, i) => {
        const row = el('tr', lap.id === this.view?.id ? 'mine' : '');
        row.append(el('td', '', String(i + 1)), el('td', '', lap.name), el('td', 'time', formatLap(lap.time)));
        table.append(row);
      });
      const mine = this.view?.bestLaps[this.boardMap];
      this.body.replaceChildren(picker, table, el('p', 'hint', mine ? `Your best here: ${formatLap(mine)}. The record lap's ghost flies with you in online races.` : "The record lap's ghost flies with you in online races."));
    } catch {
      this.body.replaceChildren(picker, el('p', 'error', "Couldn't reach the server for the records."));
    }
  }
}
