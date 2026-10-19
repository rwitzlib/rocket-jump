// Checks the binary wire format against a real match and measures what it saves. A bot-only
// match runs with one listening client; every snapshot is encoded (delta-coded against one the
// client acknowledged a few snapshots earlier, as over a real connection), decoded, and compared
// with the original. Sizes are reported raw and deflated (the WebSocket compresses everything).
//
//   npx tsx scripts/wire-check.ts [map] [bots] [seconds] [mode]
//   npx tsx scripts/wire-check.ts citadel 11 60 ctf

import RAPIER from '@dimforge/rapier3d-compat';
import { constants, createDeflateRaw } from 'node:zlib';
import { MODES, PROTOCOL_VERSION, type GameMode } from '../src/shared/config';
import type { ServerMessage, SnapshotMessage } from '../src/shared/protocol';
import { GameServer } from '../src/shared/server';
import { WireDecoder, WireEncoder } from '../src/shared/wire';

await RAPIER.init();

const map = process.argv[2] ?? 'citadel';
const bots = Number(process.argv[3] ?? 11);
const seconds = Number(process.argv[4] ?? 60);
const mode = (process.argv[5] && process.argv[5] in MODES ? process.argv[5] : 'ffa') as GameMode;
const ACK_LAG = 4; // snapshots between sending one and hearing it arrived: about 130 ms

const snapshots: SnapshotMessage[] = [];
const server = new GameServer(
  (_, msg: ServerMessage) => {
    if (msg.type === 'snapshot') snapshots.push(msg);
  },
  { maps: [map], mode, minPlayers: bots + 1, botSkill: 'normal' },
);
server.receive('c1', { type: 'join', name: 'listener', version: PROTOCOL_VERSION, spectate: false });
for (let t = 0; t < seconds * 60; t++) server.tick();

/** Deflate with a shared context across messages, like permessage-deflate with context takeover. */
function deflater() {
  const z = createDeflateRaw({ level: 1 });
  let total = 0;
  z.on('data', (chunk: Buffer) => (total += chunk.length));
  return {
    async push(data: string | Uint8Array) {
      await new Promise<void>((done) => {
        z.write(data);
        z.flush(constants.Z_SYNC_FLUSH, () => done());
      });
    },
    get total() {
      return total;
    },
  };
}

const encoder = new WireEncoder();
const decoder = new WireDecoder();
const jsonZ = deflater();
const binZ = deflater();
let jsonBytes = 0;
let binBytes = 0;
let mismatches = 0;
let full = 0;

/** Equal, allowing for the precision each value is sent at. */
function close(a: unknown, b: unknown, path: string): string | null {
  if (typeof a === 'number' && typeof b === 'number') {
    const tolerance = /pickups|items/.test(path) ? 0.051 : /projectiles.*\.pos/.test(path) ? 0.0006 : Math.max(2e-6, Math.abs(a) * 2e-7);
    return Math.abs(a - b) <= tolerance ? null : `${path}: ${a} vs ${b}`;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = close(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const va = (a as Record<string, unknown>)[k];
      const vb = (b as Record<string, unknown>)[k];
      if (va === undefined && vb === undefined) continue;
      const d = close(va, vb, `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  // The unowned blast's '' owner comes back as null.
  if ((a === '' && b === null) || a === b) return null;
  return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

for (let i = 0; i < snapshots.length; i++) {
  const msg = snapshots[i];
  if (i >= ACK_LAG) encoder.ack(snapshots[i - ACK_LAG].tick);
  const bytes = encoder.encode(msg) as Uint8Array;
  if (bytes[0] === 1 && bytes.length > 1) {
    // (a full snapshot has no baseline: its second varint is 0)
  }
  const json = JSON.stringify(msg);
  jsonBytes += json.length;
  binBytes += bytes.length;
  await jsonZ.push(json);
  await binZ.push(bytes);
  const decoded = decoder.decode(bytes);
  const diff = close(JSON.parse(json), JSON.parse(JSON.stringify(decoded)), 'snapshot');
  if (diff) {
    if (mismatches < 5) console.log(`tick ${msg.tick}: ${diff}`);
    mismatches++;
  }
  if (i < ACK_LAG) full++;
}

const n = snapshots.length;
const perSecond = (bytes: number) => ((bytes / n) * 30) / 1000;
console.log(`${map} ${mode}, ${bots} bots + 1 client, ${n} snapshots, acked ${ACK_LAG} behind`);
console.log(`JSON     ${(jsonBytes / n).toFixed(0)} B/snapshot  ${perSecond(jsonBytes).toFixed(1)} kB/s raw, ${perSecond(jsonZ.total).toFixed(1)} kB/s deflated`);
console.log(`binary   ${(binBytes / n).toFixed(0)} B/snapshot  ${perSecond(binBytes).toFixed(1)} kB/s raw, ${perSecond(binZ.total).toFixed(1)} kB/s deflated`);
console.log(`deflated binary is ${(jsonZ.total / binZ.total).toFixed(1)}x smaller than deflated JSON`);
console.log(mismatches ? `${mismatches} snapshots decoded differently` : 'every snapshot decoded to what was sent');
process.exit(mismatches ? 1 : 0);
