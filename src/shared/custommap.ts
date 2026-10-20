import type { BoxDef, ItemDef, MapDef, SpawnDef, SurfaceKind, Vec3Tuple } from './map';

// Maps people make in the editor. They travel as plain JSON (to a server when someone opens a room
// on one, to everyone who joins it), so everything is checked and clamped here, the same way on
// both ends: whatever arrives, what comes out is a sane MapDef or nothing.

export const CUSTOM_PREFIX = 'custom-';

export const CUSTOM_LIMITS = {
  boxes: 800,
  crates: 60,
  spawns: 32,
  pickups: 30,
  items: 40,
  rings: 16,
  hills: 8,
  extent: 400, // no point further than this from the middle
  size: 400, // no box bigger than this on a side
  title: 32,
};

export const SURFACES: SurfaceKind[] = [
  'grid', 'tile', 'stone', 'brick', 'plank', 'metal', 'grass', 'dirt', 'sand', 'concrete', 'rock', 'container', 'hazard', 'roof', 'snow', 'carved', 'steps', 'doors',
];

/** The sky and light a custom map can pick (names in client/themes.ts). */
export const MAP_THEMES = ['classic', 'harbor', 'jungle', 'dusk', 'foundry', 'night', 'desert'];

const num = (v: unknown, lo: number, hi: number, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
const round = (v: number) => Math.round(v * 1000) / 1000;
const E = CUSTOM_LIMITS.extent;

function vec(v: unknown, lo = -E, hi = E): Vec3Tuple | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  return [round(num(v[0], lo, hi)), round(num(v[1], lo, hi)), round(num(v[2], lo, hi))];
}

const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const color = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffff ? v : 0x8a94a6);
const surface = (v: unknown): SurfaceKind => (SURFACES.includes(v as SurfaceKind) ? (v as SurfaceKind) : 'grid');

function box(raw: unknown): BoxDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const pos = vec(r.pos);
  const size = vec(r.size, 0.1, CUSTOM_LIMITS.size);
  if (!pos || !size) return null;
  const out: BoxDef = { pos, size, color: color(r.color), mat: surface(r.mat) };
  const rot = vec(r.rot, -Math.PI * 2, Math.PI * 2);
  if (rot && rot.some((a) => a !== 0)) out.rot = rot;
  if (r.top && typeof r.top === 'object') {
    const t = r.top as Record<string, unknown>;
    out.top = { mat: surface(t.mat), color: color(t.color) };
  }
  return out;
}

/** A map from anywhere, made safe to build and play, or null if it can't be (no floor to stand on). */
export function sanitizeMap(raw: unknown): MapDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const boxes = list(r.boxes, CUSTOM_LIMITS.boxes).map(box).filter((b): b is BoxDef => !!b);
  const spawns = list(r.spawns, CUSTOM_LIMITS.spawns)
    .map((s): SpawnDef | null => {
      const o = (s ?? {}) as Record<string, unknown>;
      const pos = vec(o.pos);
      return pos ? { pos, yaw: num(o.yaw, -Math.PI * 4, Math.PI * 4) } : null;
    })
    .filter((s): s is SpawnDef => !!s);
  if (!boxes.length || !spawns.length) return null;
  const points = (v: unknown, max: number) => list(v, max).map((p) => vec(p)).filter((p): p is Vec3Tuple => !!p);
  const items = list(r.items, CUSTOM_LIMITS.items)
    .map((i): ItemDef | null => {
      const o = (i ?? {}) as Record<string, unknown>;
      const pos = vec(o.pos);
      const kind = o.kind === 'health' || o.kind === 'armor' || o.kind === 'overdrive' ? o.kind : null;
      return pos && kind ? { kind, pos } : null;
    })
    .filter((i): i is ItemDef => !!i);
  const flags = points(r.flags, 2);
  const race = r.race && typeof r.race === 'object' ? (r.race as Record<string, unknown>) : null;
  const raceStart = race ? vec(race.start) : null;
  const rings = race ? points(race.rings, CUSTOM_LIMITS.rings) : [];
  const lowest = Math.min(...boxes.map((b) => b.pos[1] - b.size[1] / 2), ...spawns.map((s) => s.pos[1]));
  const title = typeof r.title === 'string' ? r.title.replace(/[^\p{L}\p{N} '\-!.,]/gu, '').trim().slice(0, CUSTOM_LIMITS.title) : '';
  return {
    title: title || 'Custom map',
    blurb: 'A map made in the editor.',
    fragLimit: Math.round(num(r.fragLimit, 5, 50, 20)),
    boxes,
    crates: points(r.crates, CUSTOM_LIMITS.crates),
    spawns,
    pickups: points(r.pickups, CUSTOM_LIMITS.pickups),
    items,
    ...(flags.length === 2 ? { flags: [flags[0], flags[1]] as [Vec3Tuple, Vec3Tuple] } : {}),
    ...(raceStart && rings.length >= 2 ? { race: { start: raceStart, rings } } : {}),
    ...(Array.isArray(r.hills) ? { hills: points(r.hills, CUSTOM_LIMITS.hills) } : {}),
    killY: num(r.killY, -E, lowest - 1, Math.min(-20, lowest - 10)),
    theme: MAP_THEMES.includes(r.theme as string) ? (r.theme as string) : 'classic',
  };
}

// --- share codes ------------------------------------------------------------------------------

const toBase64Url = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (text: string) => {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** A map as a compact text code: compressed JSON, base64url. */
export async function encodeMapCode(map: MapDef): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(map));
  return toBase64Url(await pipe(json, new CompressionStream('deflate-raw')));
}

/** A map back from its code, checked; null if the code is broken. */
export async function decodeMapCode(code: string): Promise<MapDef | null> {
  try {
    const json = await pipe(fromBase64Url(code.trim()), new DecompressionStream('deflate-raw'));
    return sanitizeMap(JSON.parse(new TextDecoder().decode(json)));
  } catch {
    return null;
  }
}
