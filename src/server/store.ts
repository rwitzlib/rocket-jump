import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { allowedLook, applyStat, levelOf, newProfile, PREMIUM, type Gain, type LapRecord, type Look, type Profile, type StatEvent } from '../shared/progress';

// Where profiles and race records live: in memory, written to one JSON file in DATA_DIR a few
// seconds after anything changes (and on shutdown). Without DATA_DIR nothing survives a restart,
// which is fine for a local server. A JSON file is plenty at this scale: a profile is under a
// kilobyte, and the whole file is rewritten in one go, atomically (write, then rename).
//
// Signing in (with Discord, src/server/auth.ts) ties a profile to an account. Signing in to the same
// account from another browser gives that browser a new key, kept as an alias for the profile: the
// server only ever holds hashes of keys, so it can't hand back the first browser's. Purchases
// (src/server/shop.ts) are kept here too, so a refund or dispute can find what it paid for.

const SAVE_DELAY = 5000; // ms
const BOARD_SIZE = 20;
const FORGET_AFTER = 60 * 86400000; // profiles that never earned anything go after 60 days unseen
const HANDLED_EVENTS = 2000;
/** A checkout nobody finished is forgotten after this (Stripe's own sessions expire after a day). */
const STALE_CHECKOUT = 2 * 86400000;

interface Board {
  laps: LapRecord[]; // best first, one per profile
  /** The record lap's path, for its ghost: x, y, z in centimeters every few ticks. */
  ghost: { id: string; time: number; path: number[] } | null;
}

export type PurchaseStatus = 'pending' | 'paid' | 'failed' | 'refunded' | 'disputed';

/** One Checkout Session for a premium skin. */
export interface Purchase {
  session: string; // Checkout Session id
  profile: string;
  sku: string;
  status: PurchaseStatus;
  paymentIntent: string | null;
  created: number;
}

interface SaveFile {
  version: 1;
  profiles: Profile[];
  boards: Record<string, Board>;
  /** Hashes of extra keys (other browsers signed in to an account) -> profile id. */
  aliases?: Record<string, string>;
  purchases?: Purchase[];
  /** Stripe events already handled, newest last (Stripe can send one more than once). */
  events?: string[];
}

/** A new secret key, like the ones browsers make (src/client/profile.ts). */
export const newKey = () => randomBytes(16).toString('hex');

export class Store {
  private readonly profiles = new Map<string, Profile>();
  private readonly boards = new Map<string, Board>();
  private readonly aliases = new Map<string, string>();
  private readonly accounts = new Map<string, string>(); // Discord id -> profile id
  private readonly purchases = new Map<string, Purchase>(); // by Checkout Session id
  private readonly events: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly file: string | null;

  constructor(dir: string | null) {
    this.file = dir ? join(dir, 'rocket-jump.json') : null;
    if (!this.file || !existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as SaveFile;
      const now = Date.now();
      // (A profile with an account or a purchase is never forgotten.)
      for (const p of data.profiles ?? []) if (p.xp > 0 || p.account || p.owned?.length || now - p.seen < FORGET_AFTER) this.profiles.set(p.id, p);
      for (const [map, board] of Object.entries(data.boards ?? {})) this.boards.set(map, board);
      for (const [alias, id] of Object.entries(data.aliases ?? {})) if (this.profiles.has(id)) this.aliases.set(alias, id);
      for (const p of this.profiles.values()) if (p.account) this.accounts.set(p.account.id, p.id);
      for (const purchase of data.purchases ?? []) this.purchases.set(purchase.session, purchase);
      this.events.push(...(data.events ?? []));
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

  /** The profile id a key stands for: its own, or the one it's an alias of. */
  idFor(key: string): string {
    const id = Store.idOf(key);
    return this.aliases.get(id) ?? id;
  }

  /** The profile for this key, made on first sight. */
  profile(key: string, name = ''): Profile {
    return this.byId(this.idFor(key), name);
  }

  private byId(id: string, name = ''): Profile {
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
    return this.profiles.get(this.idFor(key));
  }

  profileById(id: string): Profile | undefined {
    return this.profiles.get(id);
  }

  apply(key: string, name: string, e: StatEvent): Gain {
    const p = this.profile(key, name);
    const gain = applyStat(p, e, Date.now());
    if (e.type === 'lap') this.addLap(p, e.map, e.time, e.path);
    this.changed();
    return gain;
  }

  /**
   * Puts on a look, as far as the profile's level and purchases allow. Only on a profile that exists
   * (null otherwise): made-up keys mustn't be able to fill the store.
   */
  setLook(key: string, look: Look): Look | null {
    const p = this.find(key);
    if (!p) return null;
    p.look = allowedLook(look, levelOf(p.xp), p.owned);
    this.changed();
    return p.look;
  }

  // --- accounts -------------------------------------------------------------------------------

  /**
   * Signs the profile with this id (the browser that asked) in to a Discord account. The first time,
   * the account takes that profile, progress and all. After that, the account's profile is the one:
   * a browser that was playing as someone else gets a new key for it (returned), and whatever that
   * browser had played anonymously stays behind under its old key.
   */
  signIn(from: string, discord: { id: string; name: string }): { key: string | null; profile: Profile } {
    const account = { provider: 'discord' as const, id: discord.id, name: discord.name };
    const linked = this.accounts.get(discord.id);
    let p: Profile;
    let key: string | null = null;
    if (linked && this.profiles.has(linked)) {
      p = this.profiles.get(linked)!;
      if (linked !== from) key = this.addAlias(linked);
    } else {
      p = this.byId(from);
      if (p.account) {
        // This browser's profile belongs to another account: start the new account afresh.
        key = newKey();
        p = this.byId(Store.idOf(key), discord.name);
      }
      this.accounts.set(discord.id, p.id);
    }
    p.account = account;
    this.changed();
    return { key, profile: p };
  }

  private addAlias(id: string): string {
    const key = newKey();
    this.aliases.set(Store.idOf(key), id);
    return key;
  }

  /** Signing out on a browser: a key that was only an alias stops working. */
  signOut(key: string) {
    if (this.aliases.delete(Store.idOf(key))) this.changed();
  }

  // --- purchases ------------------------------------------------------------------------------

  purchase(session: string): Purchase | undefined {
    return this.purchases.get(session);
  }

  /** A Checkout Session was opened for a skin. */
  addPurchase(session: string, profile: string, sku: string) {
    const now = Date.now();
    // (Abandoned checkouts would otherwise pile up for ever. A late payment for one still counts:
    // settlePurchase works from the session's own metadata.)
    for (const [id, x] of this.purchases) if (x.status === 'pending' && !x.paymentIntent && now - x.created > STALE_CHECKOUT) this.purchases.delete(id);
    this.purchases.set(session, { session, profile, sku, status: 'pending', paymentIntent: null, created: now });
    this.changed();
  }

  /** How many checkouts this profile has opened since then, finished or not. */
  checkoutsSince(profile: string, since: number): number {
    let n = 0;
    for (const x of this.purchases.values()) if (x.profile === profile && x.created >= since) n++;
    return n;
  }

  /**
   * What Stripe says about a Checkout Session: paid (the skin is theirs), failed, or still pending.
   * The session's own metadata says who and what, so this works even for a session this store
   * never saw opened (a server without DATA_DIR that restarted meanwhile).
   */
  settlePurchase(session: string, profile: string, sku: string, status: 'pending' | 'paid' | 'failed', paymentIntent: string | null): Purchase {
    let purchase = this.purchases.get(session);
    if (!purchase) this.purchases.set(session, (purchase = { session, profile, sku, status, paymentIntent, created: Date.now() }));
    purchase.paymentIntent = paymentIntent ?? purchase.paymentIntent;
    // Once refunded or disputed it stays so, whatever order the events come in.
    if (purchase.status === 'refunded' || purchase.status === 'disputed') return purchase;
    purchase.status = status;
    if (status === 'paid') {
      const p = this.byId(purchase.profile);
      if (!PREMIUM.some((s) => s.sku === purchase.sku)) console.error('Paid for a skin that no longer exists', purchase);
      p.owned = [...new Set([...(p.owned ?? []), purchase.sku])];
    }
    this.changed();
    return purchase;
  }

  /** A payment was refunded or disputed: the skin it bought goes (and comes off, if worn). */
  revokePurchase(paymentIntent: string, status: 'refunded' | 'disputed'): Purchase | undefined {
    const purchase = [...this.purchases.values()].find((x) => x.paymentIntent === paymentIntent);
    if (!purchase) return undefined;
    purchase.status = status;
    const p = this.profiles.get(purchase.profile);
    // (Another purchase of the same skin that's still good keeps it.)
    const stillPaid = [...this.purchases.values()].some((x) => x.profile === purchase.profile && x.sku === purchase.sku && x.status === 'paid');
    if (p && !stillPaid) {
      p.owned = (p.owned ?? []).filter((s) => s !== purchase.sku);
      p.look = allowedLook(p.look, levelOf(p.xp), p.owned);
    }
    this.changed();
    return purchase;
  }

  /** Handling a Stripe event failed: it may be handled when Stripe sends it again. */
  forgetEvent(id: string) {
    const i = this.events.lastIndexOf(id);
    if (i >= 0) this.events.splice(i, 1);
  }

  /** Whether a Stripe event was handled already; marks it handled. */
  seenEvent(id: string): boolean {
    if (this.events.includes(id)) return true;
    this.events.push(id);
    if (this.events.length > HANDLED_EVENTS) this.events.splice(0, this.events.length - HANDLED_EVENTS);
    this.changed();
    return false;
  }

  // --- race records ---------------------------------------------------------------------------

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
    const data: SaveFile = {
      version: 1,
      profiles: [...this.profiles.values()],
      boards: Object.fromEntries(this.boards),
      aliases: Object.fromEntries(this.aliases),
      purchases: [...this.purchases.values()],
      events: this.events,
    };
    try {
      mkdirSync(join(this.file, '..'), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify(data));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (err) {
      console.error('Could not save profiles', err);
    }
  }
}
