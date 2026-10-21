import { MODES, type GameMode } from './config';
import type { Vec3Tuple } from './map';
import type { ClientMessage, FlagState, MatchState, ProjectileState, RemotePlayerState, ScoreEntry, ServerMessage, SnapshotMessage, WireEvent } from './protocol';
import type { HookState, PlayerState } from './sim';
import type { WeaponId } from './types';
import type { VehicleState } from './vehicle';

// The binary wire format for the two messages that make up nearly all the traffic: snapshots
// (server to client, 30 a second) and inputs (client to server, 60 a second). Everything else
// (joins, chat, pings, welcomes) stays JSON text.
//
// Snapshots are delta compressed. Each client acknowledges the newest snapshot it has (in its
// input messages, or an `ack` while spectating), and the server encodes the next one against that
// baseline: every record (a player, a crate, a score line) carries a bitmask of the fields that
// changed since the baseline, positions are sent as millimeter offsets from where they were, and
// events the baseline already carried aren't repeated. Nothing has to arrive for this to work:
// with no usable baseline (just joined, a new map, a lost acknowledgement) a snapshot goes out in
// full. Values are quantized where they're only drawn (millimeters, milliradians) and sent at full
// precision where a client predicts from them (its own player, projectiles, a vehicle it drives):
// prediction replays from them, and a cooldown or a position a hair off can tip a tick boundary
// and grow into a visible correction.

const SNAPSHOT = 1;
const INPUT = 2;
const ACK = 3;
const KEEP = 64; // snapshots each side remembers as possible baselines (2 s)

/** Encoded bytes, backed by a plain ArrayBuffer (what WebSocket.send takes). */
export type Bytes = Uint8Array<ArrayBuffer>;

// --- bytes --------------------------------------------------------------------------------------

export class ByteWriter {
  private buf: Bytes = new Uint8Array(1024);
  private view = new DataView(this.buf.buffer);
  length = 0;

  private reserve(n: number) {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number) {
    this.reserve(1);
    this.buf[this.length++] = v & 0xff;
  }

  /** Unsigned LEB128: 7 bits a byte, small numbers in one. */
  uv(v: number) {
    v = Math.max(0, Math.floor(v));
    while (v >= 0x80) {
      this.u8((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    this.u8(v);
  }

  /** Signed, zigzagged: small magnitudes either side of zero stay short. */
  sv(v: number) {
    v = Math.round(v);
    this.uv(v >= 0 ? v * 2 : -v * 2 - 1);
  }

  f64(v: number) {
    this.reserve(8);
    this.view.setFloat64(this.length, v, true);
    this.length += 8;
  }

  f32(v: number) {
    this.reserve(4);
    this.view.setFloat32(this.length, v, true);
    this.length += 4;
  }

  str(s: string) {
    const bytes = new TextEncoder().encode(s);
    this.uv(bytes.length);
    this.reserve(bytes.length);
    this.buf.set(bytes, this.length);
    this.length += bytes.length;
  }

  bytes(b: Uint8Array) {
    this.reserve(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
  }

  finish(): Bytes {
    return this.buf.slice(0, this.length);
  }
}

export class ByteReader {
  private readonly view: DataView;
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get done() {
    return this.pos >= this.buf.length;
  }

  u8(): number {
    if (this.pos >= this.buf.length) throw new RangeError('read past the end');
    return this.buf[this.pos++];
  }

  uv(): number {
    let v = 0;
    let scale = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.u8();
      v += (b & 0x7f) * scale;
      if (b < 0x80) return v;
      scale *= 0x80;
    }
    throw new RangeError('varint too long');
  }

  sv(): number {
    const v = this.uv();
    return v % 2 ? -(v + 1) / 2 : v / 2;
  }

  f64(): number {
    if (this.pos + 8 > this.buf.length) throw new RangeError('read past the end');
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  f32(): number {
    if (this.pos + 4 > this.buf.length) throw new RangeError('read past the end');
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  str(): string {
    const n = this.uv();
    if (this.pos + n > this.buf.length || n > 4096) throw new RangeError('bad string');
    const s = new TextDecoder().decode(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }
}

// --- records ------------------------------------------------------------------------------------

/**
 * How a field goes over the wire.
 * u/i: whole numbers (unsigned / signed). b: boolean. f: 32-bit float. d / d3: one or three 64-bit
 * floats, for what a client predicts from: a hair's difference there grows into a visible correction. s: string. id: a player id,
 * or null, as an index into the snapshot's id table. ids: a list of those. mm / mm3: meters to the
 * millimeter (delta-coded against the baseline). mrad: an angle to the milliradian (likewise).
 * q4: a quaternion component to 1/10000. tenths: a number to 0.1. v3: three floats. Arrays of
 * strings: one of those values, by index.
 */
type Kind = 'u' | 'i' | 'b' | 'f' | 'd' | 'd3' | 's' | 'id' | 'ids' | 'mm' | 'mm3' | 'mrad' | 'q4' | 'tenths' | 'v3' | readonly string[];
type Schema = readonly (readonly [string, Kind])[];

const WEAPONS: readonly WeaponId[] = ['rocket', 'grenade', 'hypersonic', 'javelin', 'stinger', 'grapple', 'thunder'];
const GAME_MODES = Object.keys(MODES) as GameMode[];

/** Quantized integer form of a numeric field, for delta coding and comparing. */
function quant(kind: Kind, v: number): number {
  switch (kind) {
    case 'mm':
    case 'mrad':
      return Math.round(v * 1000);
    case 'q4':
      return Math.round(v * 10000);
    case 'tenths':
      return Math.round(v * 10);
    default:
      return v;
  }
}

/** Whether two values of a field encode the same. */
function same(kind: Kind, a: unknown, b: unknown): boolean {
  if (kind === 'mm3') return (a as number[]).every((v, i) => quant('mm', v) === quant('mm', (b as number[])[i]));
  if (kind === 'v3') return (a as number[]).every((v, i) => Math.fround(v) === Math.fround((b as number[])[i]));
  if (kind === 'd3') return (a as number[]).every((v, i) => v === (b as number[])[i]);
  if (kind === 'ids') return (a as unknown[]).length === (b as unknown[]).length && (a as unknown[]).every((v, i) => v === (b as unknown[])[i]);
  if (kind === 'f') return Math.fround(a as number) === Math.fround(b as number);
  if (kind === 'mm' || kind === 'mrad' || kind === 'q4' || kind === 'tenths') return quant(kind, a as number) === quant(kind, b as number);
  return a === b;
}

/** Writes and reads one snapshot: owns the id table its records point into. */
class Codec {
  ids: (string | null)[] = [];
  private index = new Map<string, number>();

  constructor(table: (string | null)[]) {
    this.setTable(table);
  }

  setTable(table: (string | null)[]) {
    this.ids = [...table];
    this.index = new Map(this.ids.map((id, i) => [id ?? '', i]));
  }

  idIndex(id: string | null): number {
    if (id === null) return 0;
    let i = this.index.get(id);
    if (i === undefined) {
      i = this.ids.length;
      this.ids.push(id);
      this.index.set(id, i);
    }
    return i;
  }

  idAt(i: number): string | null {
    if (i >= this.ids.length) throw new RangeError('bad id');
    return this.ids[i];
  }

  write(w: ByteWriter, kind: Kind, v: unknown, base: unknown) {
    if (Array.isArray(kind)) {
      w.uv(Math.max(0, kind.indexOf(v as string)));
      return;
    }
    switch (kind) {
      case 'u':
        w.uv(v as number);
        return;
      case 'i':
        w.sv(v as number);
        return;
      case 'b':
        w.u8(v ? 1 : 0);
        return;
      case 'f':
        w.f32(v as number);
        return;
      case 'd':
        w.f64(v as number);
        return;
      case 'd3':
        for (const c of v as number[]) w.f64(c);
        return;
      case 's':
        w.str(v as string);
        return;
      case 'id':
        w.uv(this.idIndex(v as string | null));
        return;
      case 'ids':
        w.uv((v as (string | null)[]).length);
        for (const id of v as (string | null)[]) w.uv(this.idIndex(id));
        return;
      case 'v3':
        for (const c of v as number[]) w.f32(c);
        return;
      case 'mm3':
        (v as number[]).forEach((c, i) => w.sv(quant('mm', c) - (base ? quant('mm', (base as number[])[i]) : 0)));
        return;
      default:
        w.sv(quant(kind, v as number) - (base === undefined ? 0 : quant(kind, base as number)));
    }
  }

  read(r: ByteReader, kind: Kind, base: unknown): unknown {
    if (Array.isArray(kind)) {
      const i = r.uv();
      if (i >= kind.length) throw new RangeError('bad enum');
      return kind[i];
    }
    switch (kind) {
      case 'u':
        return r.uv();
      case 'i':
        return r.sv();
      case 'b':
        return r.u8() === 1;
      case 'f':
        return r.f32();
      case 'd':
        return r.f64();
      case 'd3':
        return [r.f64(), r.f64(), r.f64()];
      case 's':
        return r.str();
      case 'id':
        return this.idAt(r.uv());
      case 'ids': {
        const n = r.uv();
        if (n > 16) throw new RangeError('bad list');
        return Array.from({ length: n }, () => this.idAt(r.uv()));
      }
      case 'v3':
        return [r.f32(), r.f32(), r.f32()];
      case 'mm3': {
        const b = base as number[] | undefined;
        return [0, 1, 2].map((i) => (r.sv() + (b ? quant('mm', b[i]) : 0)) / 1000);
      }
      default: {
        const scale = kind === 'q4' ? 10000 : kind === 'tenths' ? 10 : 1000;
        return (r.sv() + (base === undefined ? 0 : quant(kind, base as number))) / scale;
      }
    }
  }

  /** A record as a mask of the fields that differ from `base`, then those fields. No base: every field. */
  writeRecord(w: ByteWriter, schema: Schema, rec: object, base: object | undefined) {
    const r = rec as Record<string, unknown>;
    const b = base as Record<string, unknown> | undefined;
    let mask = 0;
    schema.forEach(([name, kind], i) => {
      if (!b || !same(kind, r[name], b[name])) mask += 2 ** i;
    });
    w.uv(mask);
    schema.forEach(([name, kind], i) => {
      if (Math.floor(mask / 2 ** i) % 2) this.write(w, kind, r[name], b?.[name]);
    });
  }

  readRecord<T>(r: ByteReader, schema: Schema, base: object | undefined): T {
    const b = base as Record<string, unknown> | undefined;
    const out: Record<string, unknown> = b ? { ...b } : {};
    const mask = r.uv();
    schema.forEach(([name, kind], i) => {
      if (Math.floor(mask / 2 ** i) % 2) out[name] = this.read(r, kind, b?.[name]);
      else if (!b) throw new RangeError(`missing ${name}`);
    });
    return out as T;
  }
}

// --- schemas ------------------------------------------------------------------------------------

const PLAYER: Schema = [
  ['pos', 'mm3'],
  ['yaw', 'mrad'],
  ['pitch', 'mrad'],
  ['anchor', 'mm3'], // [0,0,0] stands in for none: see `anchored`
  ['anchored', 'b'],
  ['alive', 'b'],
  ['protected', 'b'],
  ['grounded', 'b'],
  ['primary', WEAPONS],
  ['vehicle', 'i'],
  ['seat', 'i'],
  ['team', 'i'],
  ['overdrive', 'b'],
  ['flag', 'i'],
];

/** The recipient's own projectiles: full precision, it predicts them. */
const PROJECTILE: Schema = [
  ['kind', WEAPONS],
  ['ownerId', 'id'],
  ['shot', 'u'],
  ['pos', 'd3'],
  ['vel', 'd3'],
  ['life', 'd'],
  ['traveled', 'd'],
  ['target', 'id'],
  ['phase', ['climb', 'turn', 'terminal']],
  ['apex', 'd'],
  ['from', 'i'],
  ['power', 'd'],
];

/** Everyone else's: only drawn (and hooked), so millimeters and 32-bit floats do. */
const DRAWN_PROJECTILE: Schema = PROJECTILE.map(([name, kind]) => [name, kind === 'd3' ? (name === 'pos' ? 'mm3' : 'v3') : kind === 'd' ? 'f' : kind] as const);

const CRATE: Schema = [
  ['pos', 'mm3'],
  ['qx', 'q4'],
  ['qy', 'q4'],
  ['qz', 'q4'],
  ['qw', 'q4'],
];

const VEHICLE: Schema = [
  ['pos', 'd3'],
  ['vel', 'd3'],
  ['yaw', 'd'],
  ['pitch', 'd'],
  ['roll', 'd'],
  ['grounded', 'b'],
  ['health', 'd'],
  ['alive', 'b'],
  ['respawnIn', 'd'],
  ['seats', 'ids'],
  ['fireCooldown', 'd'],
  ['missileCooldown', 'd'],
  ['podSide', 'i'],
  ['throttle', 'd'],
  ['steer', 'd'],
];

const SCORE: Schema = [
  ['name', 's'],
  ['kills', 'u'],
  ['deaths', 'u'],
  ['ping', 'u'],
  ['bot', 'b'],
  ['airshots', 'u'],
  ['bestStreak', 'u'],
  ['team', 'i'],
  ['captures', 'u'],
  ['bestLap', 'f'],
  ['look', 's'],
  ['level', 'u'],
  ['points', 'u'],
];

const MATCH: Schema = [
  ['id', 'u'],
  ['mode', GAME_MODES],
  ['phase', ['playing', 'intermission']],
  ['timeLeft', 'tenths'],
  ['scoreLimit', 'u'],
  ['red', 'u'],
  ['blue', 'u'],
  ['map', 's'],
  ['nextMap', 's'],
  ['nextMode', GAME_MODES],
  ['winnerId', 'id'],
  ['winnerTeam', 'i'],
  ['hill', 'i'],
  ['round', 'u'],
  ['roundLeft', 'tenths'],
];

const FLAG: Schema = [
  ['pos', 'mm3'],
  ['carrier', 'id'],
  ['atHome', 'b'],
];

/** The recipient's own player: full precision, it predicts from this. The grapple is written separately. */
const YOU: Schema = [
  ['pos', 'd3'],
  ['vel', 'd3'],
  ['grounded', 'b'],
  ['fireCooldown', 'd'],
  ['drum', 'u'],
  ['reloading', 'b'],
  ['grappleCooldown', 'd'],
  ['grappleUsed', 'b'],
  ['lockTarget', 'id'],
  ['lockProgress', 'd'],
  ['yaw', 'd'],
  ['pitch', 'd'],
  ['health', 'd'],
  ['alive', 'b'],
  ['respawnIn', 'd'],
  ['protectedFor', 'd'],
  ['primary', WEAPONS],
  ['secondary', WEAPONS],
  ['vehicle', 'i'],
  ['seat', 'i'],
  ['team', 'i'],
  ['armor', 'd'],
  ['overdrive', 'd'],
  ['flag', 'i'],
  ['checkpoint', 'u'],
  ['lapTime', 'd'],
];

const CAUSES = ['rocket', 'grenade', 'hypersonic', 'javelin', 'stinger', 'fall', 'vehicle', 'ram', 'thunder'] as const;
/** Every event type's fields after `type` and `tick`. The order of this table is the wire's type numbering. */
const EVENTS: Record<WireEvent['type'], Schema> = {
  fired: [['playerId', 'id'], ['weapon', WEAPONS]],
  explosion: [['pos', 'v3'], ['normal', 'v3'], ['surface', 'b'], ['ownerId', 'id'], ['shot', 'u'], ['radius', 'f']],
  bounce: [['pos', 'v3'], ['normal', 'v3'], ['ownerId', 'id'], ['shot', 'u'], ['speed', 'f']],
  pickup: [['playerId', 'id'], ['weapon', WEAPONS], ['box', 'u']],
  grapple: [['playerId', 'id'], ['attached', 'b']],
  grappleMiss: [['playerId', 'id']],
  jumped: [['playerId', 'id']],
  landed: [['playerId', 'id'], ['impactSpeed', 'f']],
  knockback: [['playerId', 'id'], ['strength', 'f'], ['sourceId', 'id'], ['shot', 'u']],
  respawn: [['playerId', 'id'], ['yaw', 'f']],
  damaged: [['playerId', 'id'], ['sourceId', 'id'], ['amount', 'f'], ['midair', 'b']],
  killed: [['playerId', 'id'], ['killerId', 'id'], ['cause', CAUSES], ['midair', 'b'], ['distance', 'f'], ['killerHealth', 'u']],
  item: [['playerId', 'id'], ['kind', ['health', 'armor', 'overdrive']], ['index', 'u']],
  flag: [['team', 'u'], ['action', ['taken', 'dropped', 'returned', 'captured']], ['playerId', 'id']],
  checkpoint: [['playerId', 'id'], ['index', 'u'], ['time', 'f']],
  lap: [['playerId', 'id'], ['time', 'f'], ['best', 'b']],
  hill: [['playerId', 'id'], ['contested', 'b']],
  entered: [['playerId', 'id'], ['vehicle', 'u'], ['seat', 'u']],
  exited: [['playerId', 'id'], ['vehicle', 'u']],
  vehicleHit: [['vehicle', 'u'], ['sourceId', 'id'], ['amount', 'f']],
  vehicleDestroyed: [['vehicle', 'u'], ['pos', 'v3'], ['normal', 'v3']],
  rammed: [['playerId', 'id'], ['vehicle', 'u'], ['speed', 'f']],
  thunder: [['playerId', 'id'], ['pos', 'v3'], ['dir', 'v3']],
};
const EVENT_TYPES = Object.keys(EVENTS) as WireEvent['type'][];

const HOOKS = ['player', 'crate', 'rocket', 'vehicle', 'mover'] as const;

// Plain shapes the schemas describe, converted to and from the protocol's own.
const playerRecord = (p: RemotePlayerState) => ({ ...p, anchor: p.anchor ?? [0, 0, 0], anchored: !!p.anchor });
const fromPlayerRecord = (r: ReturnType<typeof playerRecord>): RemotePlayerState => {
  const { anchored, ...p } = r;
  return { ...p, anchor: anchored ? r.anchor : null };
};
const crateRecord = (c: number[]) => ({ pos: [c[0], c[1], c[2]], qx: c[3], qy: c[4], qz: c[5], qw: c[6] });
const matchRecord = (m: MatchState) => ({ ...m, red: m.teamScores[0], blue: m.teamScores[1] });

// --- snapshots ----------------------------------------------------------------------------------

interface Sent {
  msg: SnapshotMessage;
  ids: (string | null)[];
}

/** Writes one snapshot, delta-coded against `base` when there is one. */
function writeSnapshot(msg: SnapshotMessage, base: Sent | undefined, self: string | null): { bytes: Bytes; ids: (string | null)[] } {
  // The id table starts as the baseline's, so indexes stay put and an unchanged table needn't be
  // sent; new ids go on the end. (It's started afresh once it has grown long.)
  const codec = new Codec(base && base.ids.length < 64 ? base.ids : [null]);
  const startIds = codec.ids.length;
  const body = new ByteWriter();
  const b = base?.msg;

  // The recipient's own player.
  body.u8(msg.you ? 1 : 0);
  if (msg.you) {
    codec.writeRecord(body, YOU, msg.you, b?.you ?? undefined);
    const g = msg.you.grapple;
    body.u8(g ? 1 : 0);
    if (g) {
      for (const c of [...g.anchor, ...g.normal, g.length]) body.f64(c);
      const h = g.hook;
      body.uv(h ? HOOKS.indexOf(h.kind) + 1 : 0);
      if (h?.kind === 'player') {
        body.uv(codec.idIndex(h.id));
        for (const c of h.offset) body.f64(c);
      } else if (h?.kind === 'crate' || h?.kind === 'mover') {
        body.uv(h.index);
        for (const c of [...h.local, ...h.localNormal]) body.f64(c);
      } else if (h?.kind === 'rocket') {
        body.uv(codec.idIndex(h.ownerId));
        body.uv(h.shot);
      } else if (h?.kind === 'vehicle') {
        body.uv(h.index);
        for (const c of h.local) body.f64(c);
      }
    }
  }

  // Other players, matched to the baseline by id.
  body.uv(msg.players.length);
  for (const p of msg.players) {
    body.uv(codec.idIndex(p.id));
    const old = b?.players.find((o) => o.id === p.id);
    codec.writeRecord(body, PLAYER, playerRecord(p), old && playerRecord(old));
  }

  // Projectiles by id. Full precision (the owner predicts from them), but what a rocket in flight
  // keeps (its kind, owner, heading) isn't repeated.
  body.uv(msg.projectiles.length);
  for (const p of msg.projectiles) {
    body.uv(p.id);
    const own = p.ownerId === self;
    body.u8(own ? 1 : 0);
    codec.writeRecord(body, own ? PROJECTILE : DRAWN_PROJECTILE, p, b?.projectiles.find((o) => o.id === p.id));
  }

  // Crates, vehicles and flags by position in their list: a resting one costs a byte.
  body.uv(msg.crates.length);
  msg.crates.forEach((c, i) => codec.writeRecord(body, CRATE, crateRecord(c), b?.crates[i] && crateRecord(b.crates[i])));
  body.uv(msg.vehicles.length);
  msg.vehicles.forEach((v, i) => codec.writeRecord(body, VEHICLE, v, b?.vehicles[i]));
  body.uv(msg.flags.length);
  msg.flags.forEach((f, i) => codec.writeRecord(body, FLAG, f, b?.flags[i]));

  // Mystery boxes and items: just whether each is there, and when it's back, to the tenth.
  for (const list of [msg.pickups, msg.items] as const) {
    const old = list === msg.pickups ? b?.pickups : b?.items;
    const unchanged = !!old && old.length === list.length && list.every((v, i) => quant('tenths', v) === quant('tenths', old[i]));
    body.u8(unchanged ? 1 : 0);
    if (unchanged) continue;
    body.uv(list.length);
    for (const v of list) body.uv(quant('tenths', v));
  }

  // Scores by id; the match.
  body.uv(msg.scores.length);
  for (const s of msg.scores) {
    body.uv(codec.idIndex(s.id));
    codec.writeRecord(body, SCORE, s, b?.scores.find((o) => o.id === s.id));
  }
  codec.writeRecord(body, MATCH, matchRecord(msg.match), b && matchRecord(b.match));

  // Events the baseline didn't already carry.
  const events = b ? msg.events.filter((e) => e.tick > b.tick) : msg.events;
  body.uv(events.length);
  for (const e of events) {
    body.uv(EVENT_TYPES.indexOf(e.type));
    body.uv(msg.tick - e.tick);
    codec.writeRecord(body, EVENTS[e.type], e, undefined);
  }
  body.uv(msg.input.queued);
  body.uv(msg.input.starved);
  body.uv(msg.input.dropped);

  const head = new ByteWriter();
  head.u8(SNAPSHOT);
  head.uv(msg.tick);
  head.uv(b ? msg.tick - b.tick : 0);
  head.uv(msg.ack);
  // The id table: only what's new since the baseline's.
  const reused = base && base.ids.length < 64 ? startIds : 0;
  head.uv(reused);
  head.uv(codec.ids.length - reused);
  for (const id of codec.ids.slice(reused)) head.str(id ?? '');
  head.bytes(body.finish());
  return { bytes: head.finish(), ids: codec.ids };
}

function readSnapshot(bytes: Uint8Array, baselines: Map<number, Sent>): Sent {
  const r = new ByteReader(bytes);
  if (r.u8() !== SNAPSHOT) throw new Error('not a snapshot');
  const tick = r.uv();
  const back = r.uv();
  const ack = r.uv();
  const base = back ? baselines.get(tick - back) : undefined;
  if (back && !base) throw new Error(`baseline ${tick - back} is gone`);
  const b = base?.msg;
  const reused = r.uv();
  const added = r.uv();
  if (reused > (base?.ids.length ?? 0) || added > 256) throw new RangeError('bad id table');
  const table: (string | null)[] = reused ? base!.ids.slice(0, reused) : [];
  for (let i = 0; i < added; i++) {
    const s = r.str();
    table.push(table.length === 0 ? null : s);
  }
  const codec = new Codec(table);

  let you: PlayerState | null = null;
  if (r.u8()) {
    you = { ...codec.readRecord<Omit<PlayerState, 'grapple'>>(r, YOU, b?.you ?? undefined), grapple: null };
    if (r.u8()) {
      const [ax, ay, az, nx, ny, nz, length] = Array.from({ length: 7 }, () => r.f64());
      const kind = r.uv();
      let hook: HookState | null = null;
      const v3 = (): Vec3Tuple => [r.f64(), r.f64(), r.f64()];
      if (kind === 1) hook = { kind: 'player', id: codec.idAt(r.uv())!, offset: v3() };
      else if (kind === 2) hook = { kind: 'crate', index: r.uv(), local: v3(), localNormal: v3() };
      else if (kind === 3) hook = { kind: 'rocket', ownerId: codec.idAt(r.uv())!, shot: r.uv() };
      else if (kind === 4) hook = { kind: 'vehicle', index: r.uv(), local: v3() };
      else if (kind === 5) hook = { kind: 'mover', index: r.uv(), local: v3(), localNormal: v3() };
      you.grapple = { anchor: [ax, ay, az], normal: [nx, ny, nz], length, hook };
    }
  }

  const count = (max: number) => {
    const n = r.uv();
    if (n > max) throw new RangeError('bad count');
    return n;
  };
  const players: RemotePlayerState[] = [];
  for (let n = count(256); n > 0; n--) {
    const id = codec.idAt(r.uv())!;
    const old = b?.players.find((o) => o.id === id);
    players.push(fromPlayerRecord({ ...codec.readRecord<ReturnType<typeof playerRecord>>(r, PLAYER, old && playerRecord(old)), id }));
  }
  const projectiles: ProjectileState[] = [];
  for (let n = count(4096); n > 0; n--) {
    const id = r.uv();
    const schema = r.u8() ? PROJECTILE : DRAWN_PROJECTILE;
    projectiles.push({ ...codec.readRecord<ProjectileState>(r, schema, b?.projectiles.find((o) => o.id === id)), id });
  }
  const crates: number[][] = [];
  for (let i = 0, n = count(4096); i < n; i++) {
    const c = codec.readRecord<ReturnType<typeof crateRecord>>(r, CRATE, b?.crates[i] && crateRecord(b.crates[i]));
    crates.push([...c.pos, c.qx, c.qy, c.qz, c.qw]);
  }
  const vehicles: VehicleState[] = [];
  for (let i = 0, n = count(256); i < n; i++) vehicles.push(codec.readRecord<VehicleState>(r, VEHICLE, b?.vehicles[i]));
  const flags: FlagState[] = [];
  for (let i = 0, n = count(8); i < n; i++) flags.push(codec.readRecord<FlagState>(r, FLAG, b?.flags[i]));
  const lists: number[][] = [];
  for (const old of [b?.pickups, b?.items]) {
    if (r.u8()) lists.push([...old!]);
    else lists.push(Array.from({ length: count(1024) }, () => r.uv() / 10));
  }
  const scores: ScoreEntry[] = [];
  for (let n = count(256); n > 0; n--) {
    const id = codec.idAt(r.uv())!;
    scores.push({ ...codec.readRecord<ScoreEntry>(r, SCORE, b?.scores.find((o) => o.id === id)), id });
  }
  const m = codec.readRecord<ReturnType<typeof matchRecord>>(r, MATCH, b && matchRecord(b.match));
  const { red, blue, ...matchRest } = m;
  const match: MatchState = { ...matchRest, teamScores: [red, blue] };
  // Events: the new ones, after the ones the baseline had that are still in the window.
  const events: WireEvent[] = b ? b.events.filter((e) => e.tick > tick - 6) : [];
  for (let n = count(4096); n > 0; n--) {
    const type = EVENT_TYPES[r.uv()];
    if (!type) throw new RangeError('bad event');
    const eventTick = tick - r.uv();
    events.push({ ...codec.readRecord<object>(r, EVENTS[type], undefined), type, tick: eventTick } as WireEvent);
  }
  const input = { queued: r.uv(), starved: r.uv(), dropped: r.uv() };
  const msg: SnapshotMessage = { type: 'snapshot', tick, ack, you, players, projectiles, crates, vehicles, pickups: lists[0], items: lists[1], flags, scores, match, events, input };
  return { msg, ids: codec.ids };
}

/**
 * The server's side for one client: encodes its snapshots against the newest one it has
 * acknowledged, and everything else as JSON.
 */
export class WireEncoder {
  /** Who this client is (from its welcome): its own projectiles go at full precision. */
  private self: string | null = null;
  private readonly sent = new Map<number, Sent>();
  private acked = -1;

  /** The client has this snapshot: newer ones can be coded against it. */
  ack(tick: number) {
    if (tick <= this.acked || !this.sent.has(tick)) return;
    this.acked = tick;
    for (const t of this.sent.keys()) if (t < tick) this.sent.delete(t);
  }

  /** Forget every baseline: the client is starting over (a new map). */
  reset() {
    this.sent.clear();
    this.acked = -1;
  }

  encode(msg: ServerMessage): string | Bytes {
    if (msg.type === 'welcome') {
      this.reset();
      this.self = msg.id;
    }
    if (msg.type !== 'snapshot') return JSON.stringify(msg);
    const base = this.sent.get(this.acked);
    const { bytes, ids } = writeSnapshot(msg, base, this.self);
    this.sent.set(msg.tick, { msg, ids });
    if (this.sent.size > KEEP) this.sent.delete(this.sent.keys().next().value!);
    return bytes;
  }
}

/** The client's side: decodes snapshots against the ones it has, and remembers them as baselines. */
export class WireDecoder {
  private readonly got = new Map<number, Sent>();

  decode(data: string | Uint8Array): ServerMessage {
    if (typeof data === 'string') {
      const msg = JSON.parse(data) as ServerMessage;
      if (msg.type === 'welcome') this.got.clear();
      return msg;
    }
    const sent = readSnapshot(data, this.got);
    this.got.set(sent.msg.tick, sent);
    if (this.got.size > KEEP) this.got.delete(this.got.keys().next().value!);
    return sent.msg;
  }
}

// --- client messages ----------------------------------------------------------------------------

const BUTTONS = ['jump', 'fire', 'grapple', 'use', 'down'] as const;

/** Inputs (and spectators' acks) go binary; the rest as JSON. */
export function encodeClientMessage(msg: ClientMessage): string | Bytes {
  if (msg.type === 'ack') {
    const w = new ByteWriter();
    w.u8(ACK);
    w.uv(msg.tick);
    return w.finish();
  }
  if (msg.type !== 'input') return JSON.stringify(msg);
  const w = new ByteWriter();
  w.u8(INPUT);
  w.uv(msg.snap ?? 0);
  w.uv(msg.frames.length);
  let seq = 0;
  for (const { seq: s, input } of msg.frames) {
    w.uv(s - seq); // the first absolute, then the step from the one before
    seq = s;
    w.sv(input.forward * 127);
    w.sv(input.right * 127);
    let bits = 0;
    BUTTONS.forEach((b, i) => {
      if (input[b]) bits |= 1 << i;
    });
    if (input.view !== undefined) bits |= 1 << BUTTONS.length;
    w.u8(bits);
    w.f32(input.yaw);
    w.f32(input.pitch);
    if (input.view !== undefined) w.uv(Math.round(input.view * 100));
  }
  return w.finish();
}

/**
 * Whatever a client sent, as the plain object it stands for: binary inputs and acks decoded, text
 * parsed as JSON. Null if it can't be read. It still goes through parseClientMessage after this.
 */
export function decodeClientMessage(data: string | Uint8Array): unknown {
  try {
    if (typeof data === 'string') return JSON.parse(data);
    const r = new ByteReader(data);
    const type = r.u8();
    if (type === ACK) return { type: 'ack', tick: r.uv() };
    if (type !== INPUT) return null;
    const snap = r.uv();
    const n = r.uv();
    if (n > 8) return null;
    const frames = [];
    let seq = 0;
    for (let i = 0; i < n; i++) {
      seq += r.uv();
      const forward = r.sv() / 127;
      const right = r.sv() / 127;
      const bits = r.u8();
      const input: Record<string, unknown> = { forward, right, yaw: r.f32(), pitch: r.f32() };
      BUTTONS.forEach((b, k) => (input[b] = (bits & (1 << k)) !== 0));
      if (bits & (1 << BUTTONS.length)) input.view = r.uv() / 100;
      frames.push({ seq, input });
    }
    return { type: 'input', frames, snap };
  } catch {
    return null;
  }
}
