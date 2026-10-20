import { MAPS, PLAYABLE_MAPS } from '../shared/map';
import { decodeLook, encodeLook, EXPLOSIONS, formatPrice, PREMIUM, TINTS, TRAILS, type LapRecord, type Look, type ProfileView } from '../shared/progress';
import { formatLap } from './objectives';
import { SkinPreview } from './skinpreview';

// The player's online profile, as the menu shows it: level and XP, lifetime stats, the day's and
// week's challenges, the skins their level has unlocked, and the race records on every map. The
// server keeps it all; this browser only holds the secret key that says whose it is.
//
// Signing in with Discord is optional and only needed to buy premium skins (Stripe Checkout). Both
// leave the page and come back to it: with #signin=CODE (swapped for the key this browser should
// keep) or ?purchase=SKU (the server grants it when Stripe says it's paid; we wait for that).

const KEY = 'rocket-jump:profile';
const WORN = 'rocket-jump:look';

/**
 * Keeps what the profile wears (and its level), as the server last said, so practice games (which
 * run in the page, with no server to ask) can dress you the same, offline too.
 */
export function rememberLook(view: Pick<ProfileView, 'look' | 'level'>) {
  try {
    localStorage.setItem(WORN, JSON.stringify({ look: encodeLook(view.look), level: view.level }));
  } catch {
    // storage blocked: practice shows the default look
  }
}

/** The look last remembered, or null if there's none. */
export function rememberedLook(): { look: Look; level: number } | null {
  try {
    const saved = JSON.parse(localStorage.getItem(WORN) ?? 'null') as { look?: string; level?: number } | null;
    return saved?.look ? { look: decodeLook(saved.look), level: saved.level ?? 1 } : null;
  } catch {
    return null;
  }
}

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

function setProfileKey(key: string) {
  try {
    localStorage.setItem(KEY, key);
  } catch {
    // storage blocked: nothing to keep it in
  }
}

/** Forgets this browser's key (signing out): the next one asked for is a fresh, anonymous profile. */
function forgetProfileKey() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // as above
  }
}

/** POSTs JSON; a failure throws with the server's message, if it gave one. */
async function post<T>(base: string, path: string, body: object): Promise<T> {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const error = await res
      .json()
      .then((b: { error?: string }) => b.error)
      .catch(() => undefined);
    throw new Error(error ?? `The server said ${res.status}.`);
  }
  return (await res.json()) as T;
}

/** This page, to come back to after Discord or Checkout. */
const here = () => `${location.origin}${location.pathname}`;

export const fetchProfile = (base: string, key: string) => post<ProfileView>(base, '/profile', { key });
export const wearLook = (base: string, key: string, look: Look) => post<ProfileView>(base, '/profile/look', { key, ...look });
const startSignIn = (base: string, key: string) => post<{ url: string }>(base, '/auth/discord', { key, returnTo: here() });
const claimSignIn = (base: string, code: string, key: string) => post<{ key: string | null; name: string }>(base, '/auth/claim', { code, key });
const signOut = (base: string, key: string) => post<{ ok: boolean }>(base, '/auth/signout', { key });
const startCheckout = (base: string, key: string, sku: string) => post<{ url: string }>(base, '/shop/checkout', { key, sku, returnTo: here() });

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
  /** A line under the skins: how a sign-in or purchase went. */
  private notice: { text: string; error?: boolean } | null = null;
  private busy = false;
  /** The character beside the Skins tab: made the first time the tab opens. */
  private preview: SkinPreview | null = null;

  constructor(
    private readonly base: () => string,
    /** Says the profile's level wherever the page shows it (the menu badge). */
    private readonly onLevel: (level: number) => void,
  ) {
    for (const tab of this.root.querySelectorAll<HTMLElement>('.tab')) {
      tab.addEventListener('click', () => {
        this.select(tab.dataset.tab!);
        this.render();
      });
    }
  }

  private select(name: string) {
    this.tab = name;
    for (const t of this.root.querySelectorAll<HTMLElement>('.tab')) t.classList.toggle('active', t.dataset.tab === name);
  }

  /**
   * Back from signing in or from Checkout (the page's address says which): finishes up and opens
   * the Skins tab to show how it went. Call once, when the page loads.
   */
  async handleReturn() {
    const hash = new URLSearchParams(location.hash.slice(1));
    const query = new URLSearchParams(location.search);
    const code = hash.get('signin');
    const failed = hash.get('signin-error');
    const purchase = query.get('purchase');
    if (!code && !failed && !purchase) return;
    // Tidy the address so a reload doesn't do it again.
    query.delete('purchase');
    history.replaceState(null, '', `${location.pathname}${query.size ? `?${query}` : ''}`);
    this.select('skins');
    if (failed) this.notice = { text: failed === 'denied' ? 'Sign-in cancelled.' : "Couldn't sign in with Discord. Try again in a moment.", error: true };
    const key = profileKey();
    if (code && key) {
      try {
        // (Only this browser's key, the one that started the sign-in, can claim it.)
        const result = await claimSignIn(this.base(), code, key);
        if (result.key) setProfileKey(result.key);
        this.notice = { text: `Signed in as ${result.name}.${result.key ? ' Your profile from that account is loaded.' : ''}` };
      } catch (err) {
        this.notice = { text: (err as Error).message, error: true };
      }
    }
    if (purchase === 'cancelled') this.notice = { text: 'Purchase cancelled: nothing was charged.' };
    await this.open(true);
    if (purchase && purchase !== 'cancelled') await this.awaitPurchase(purchase);
  }

  /** Stripe tells the server a payment went through a moment after the page comes back: wait for it. */
  private async awaitPurchase(sku: string) {
    const name = PREMIUM.find((s) => s.sku === sku)?.name ?? 'your skin';
    for (let i = 0; i < 20; i++) {
      if (this.view?.owned.includes(sku)) {
        this.notice = { text: `Thanks! ${name} is yours. Click it to wear it.` };
        this.render();
        return;
      }
      this.notice = { text: `Payment received. Waiting for ${name} to arrive…` };
      this.render();
      await new Promise((r) => setTimeout(r, 1500));
      await this.refresh();
    }
    this.notice = { text: `${name} hasn't arrived yet. Some payment methods take a while: it'll show up here once the payment clears.` };
    this.render();
  }

  private async signIn() {
    const key = profileKey();
    if (!key || this.busy) return;
    this.busy = true;
    try {
      location.href = (await startSignIn(this.base(), key)).url;
    } catch (err) {
      this.notice = { text: (err as Error).message, error: true };
      this.render();
    } finally {
      this.busy = false;
    }
  }

  private async signOut() {
    const key = profileKey();
    if (!key || !confirm('Sign out? This browser starts a fresh profile; sign in again to get yours back.')) return;
    await signOut(this.base(), key).catch(() => {});
    forgetProfileKey();
    this.notice = { text: 'Signed out.' };
    await this.refresh();
  }

  private async buy(sku: string) {
    const key = profileKey();
    if (!key || this.busy) return;
    this.busy = true;
    this.notice = { text: 'Opening checkout…' };
    this.render();
    try {
      location.href = (await startCheckout(this.base(), key, sku)).url;
    } catch (err) {
      this.notice = { text: (err as Error).message, error: true };
      this.render();
    } finally {
      this.busy = false;
    }
  }

  /** Who they're signed in as, or the button to sign in (when this server can). */
  private accountBar(v: ProfileView): HTMLElement | null {
    if (!v.signIn && !v.account) return null;
    const bar = el('div', 'account-bar');
    if (v.account) {
      const who = el('span', '', 'Signed in with Discord as ');
      who.append(el('b', '', v.account.name));
      const out = el('button', 'ghost', 'Sign out');
      out.addEventListener('click', () => void this.signOut());
      bar.append(who, out);
    } else {
      const button = el('button', 'discord', 'Sign in with Discord');
      button.addEventListener('click', () => void this.signIn());
      bar.append(el('span', 'hint', v.shop ? 'Optional. Sign in to buy premium skins and keep them on any browser.' : 'Optional. Keeps your profile safe if this browser forgets it.'), button);
    }
    return bar;
  }

  /** Opens it and fetches the latest. */
  async open(keepNotice = false) {
    if (!keepNotice) this.notice = null;
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
      rememberLook(this.view);
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
    else if (this.tab === 'skins') this.showSkins(v);
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
    const note = el('p', 'hint', v.account ? `XP, stats and challenges count in online games. Your profile is tied to your Discord account (${v.account.name}).` : 'XP, stats and challenges count in online games. Your profile is tied to this browser.');
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

  /** The skins, with the character wearing them alongside. */
  private showSkins(v: ProfileView) {
    this.preview ??= new SkinPreview();
    this.preview.wear(v.look);
    const side = el('div', 'skins-side');
    side.append(this.preview.canvas, el('p', 'hint', 'Hover a skin to try it on.'));
    const list = el('div', 'skins-list');
    list.append(...this.skins(v));
    const layout = el('div', 'skins-layout');
    layout.append(list, side);
    this.body.replaceChildren(layout);
    this.preview.start();
  }

  private skins(v: ProfileView): HTMLElement[] {
    const pick = async (look: Look) => {
      const key = profileKey();
      if (!key) return;
      try {
        this.view = await wearLook(this.base(), key, look);
        rememberLook(this.view);
        this.render();
      } catch {
        // stays as it was
      }
    };
    const section = (title: string, kind: 'tint' | 'trail' | 'explosion', items: readonly { id: string; name: string; level: number; color: number; price?: number }[], current: string, wear: (id: string) => Look) => {
      const wrap = el('div', 'looks');
      for (const item of items) {
        const sku = `${kind}:${item.id}`;
        const premium = item.price !== undefined;
        const owned = v.owned.includes(sku);
        // Premium skins show only where they can be bought (or once they have been).
        if (premium && !owned && !v.shop) continue;
        const forSale = premium && !owned;
        const locked = item.level > v.level;
        const b = el('button', `look${item.id === current ? ' worn' : ''}${locked ? ' locked' : ''}${premium ? ' premium' : ''}`);
        const swatch = el('span', 'swatch');
        swatch.style.background = item.id === 'auto' ? 'conic-gradient(#3d9cf0, #f0a830, #a860f0, #40c878, #f05a80, #3d9cf0)' : item.id === 'rainbow' ? 'linear-gradient(90deg, red, orange, yellow, lime, cyan, blue, violet)' : hex(item.color);
        b.append(swatch, el('span', '', locked ? `Level ${item.level}` : item.name));
        if (forSale) b.append(el('span', 'price', formatPrice(item.price!)));
        else if (premium) b.append(el('span', 'owned-tag', '★'));
        b.title = locked ? `${item.name}: unlocks at level ${item.level}` : forSale ? (v.account ? `Buy ${item.name} for ${formatPrice(item.price!)}` : `${item.name}: sign in with Discord to buy it`) : item.name;
        b.disabled = locked;
        // Trying it on: the character wears it while it's hovered (or focused), bought or not.
        const tryOn = () => this.preview?.wear(wear(item.id));
        const takeOff = () => this.preview?.wear(this.view?.look ?? v.look);
        b.addEventListener('pointerenter', tryOn);
        b.addEventListener('focus', tryOn);
        b.addEventListener('pointerleave', takeOff);
        b.addEventListener('blur', takeOff);
        b.addEventListener('click', () => {
          if (!forSale) void pick(wear(item.id));
          else if (v.account) void this.buy(sku);
          else void this.signIn();
        });
        wrap.append(b);
      }
      return [el('h3', '', title), wrap];
    };
    const bar = this.accountBar(v);
    const notice = this.notice ? [el('p', `shop-note${this.notice.error ? ' error' : ''}`, this.notice.text)] : [];
    return [
      ...(bar ? [bar] : []),
      ...notice,
      ...section('Armor', 'tint', TINTS, v.look.tint, (id) => ({ ...v.look, tint: id as Look['tint'] })),
      ...section(
        'Rocket trail',
        'trail',
        TRAILS.map((t) => ({ ...t, color: t.fire[1] })),
        v.look.trail,
        (id) => ({ ...v.look, trail: id as Look['trail'] }),
      ),
      ...section(
        'Explosions',
        'explosion',
        EXPLOSIONS,
        v.look.explosion,
        (id) => ({ ...v.look, explosion: id as Look['explosion'] }),
      ),
      el('p', 'hint', `Armor color shows outside team games. Everyone sees your trail and explosion. ${v.shop ? ' Gold-edged skins are premium: buying one keeps the servers running.' : ''}`),
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
