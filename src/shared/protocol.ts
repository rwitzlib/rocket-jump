import { Vector3 } from 'three';
import type { GameMode } from './config';
import type { MapDef, Vec3Tuple } from './map';
import type { MissilePhase, PlayerState, ProjectileKind, SimEvent } from './sim';
import type { Gain } from './progress';
import type { PlayerInput, WeaponId } from './types';
import type { VehicleState } from './vehicle';

// Messages between client and server, as plain data. On the wire, snapshots and inputs are a
// compact delta-coded binary format and the rest JSON (see wire.ts); the code on either side only
// ever sees these shapes.

/** One tick of input, numbered by the client so the server can acknowledge it. */
export interface InputFrame {
  seq: number;
  input: PlayerInput;
}

export interface InputMessage {
  type: 'input';
  frames: InputFrame[]; // the newest few inputs, oldest first
  snap?: number; // the newest snapshot tick the client has: the server codes the next ones against it
}

/** A spectator sends no inputs, so it acknowledges snapshots with these instead. */
export interface AckMessage {
  type: 'ack';
  tick: number;
}

/** The first thing a client sends. The server answers with `welcome`, or `rejected`. */
export interface JoinMessage {
  type: 'join';
  name: string;
  version: number; // PROTOCOL_VERSION
  spectate: boolean; // watch instead of play
  resume?: string; // the token from an earlier welcome: take back that player after a dropped connection
  profile?: string; // the browser's secret profile key, for XP and stats (online only)
}

/** Switch between watching and playing. */
export interface SpectateMessage {
  type: 'spectate';
  on: boolean;
}

/** Answers the server's ping, so it can measure each player's round trip. */
export interface PongMessage {
  type: 'pong';
  t: number;
}

export interface ChatSendMessage {
  type: 'chat';
  text: string;
}

export type ClientMessage = InputMessage | JoinMessage | PongMessage | ChatSendMessage | SpectateMessage | AckMessage;

export interface RemotePlayerState {
  id: string;
  pos: Vec3Tuple;
  yaw: number;
  pitch: number;
  anchor: Vec3Tuple | null; // grapple anchor, when attached
  alive: boolean;
  protected: boolean; // spawn protection
  grounded: boolean; // only drives the remote player's animation
  primary: WeaponId; // which weapon their model carries
  vehicle: number; // -1 on foot
  seat: number;
  team: number; // -1 outside team modes
  overdrive: boolean; // glowing with the overdrive
  flag: number; // the team whose flag they carry, -1 for none
}

export interface ScoreEntry {
  id: string;
  name: string;
  kills: number;
  deaths: number;
  ping: number; // ms round trip; 0 for bots
  bot: boolean;
  airshots: number; // kills on players in midair, this match
  bestStreak: number; // most kills in one life, this match
  team: number; // -1 outside team modes
  captures: number; // capture the flag
  bestLap: number; // race: seconds, 0 for none yet
  look: string; // cosmetics: "tint/trail" (see progress.ts)
  points: number; // king of the hill: seconds on the hill
  level: number; // profile level, 0 for none (bots, practice)
}

export type MatchPhase = 'playing' | 'intermission';

export interface MatchState {
  id: number; // goes up by one every match
  mode: GameMode;
  phase: MatchPhase;
  timeLeft: number; // seconds left in this phase
  scoreLimit: number; // kills (deathmatch), team kills (TDM) or captures (CTF) to win; 0 for none (race)
  teamScores: [number, number]; // red, blue
  map: string;
  nextMap: string;
  nextMode: GameMode;
  winnerId: string | null; // set during intermission
  winnerTeam: number; // set during intermission in team modes; -1 for a draw
  hill: number; // king of the hill: which spot the hill is on (-1 in other modes)
  round: number; // elimination: the round under way (0 in other modes)
  roundLeft: number; // elimination: seconds left in the round, or (between rounds, negative) until the next
}

/** A capture-the-flag flag: where its foot is, who has it, and whether it's at its base. */
export interface FlagState {
  pos: Vec3Tuple;
  carrier: string | null;
  atHome: boolean;
}

export interface ProjectileState {
  id: number;
  kind: ProjectileKind;
  ownerId: string;
  shot: number; // seq of the owner's input that fired it, so the owner can match its predicted copy
  pos: Vec3Tuple;
  vel: Vec3Tuple;
  life: number;
  traveled: number;
  target: string | null; // a seeker missile's target: drives its steering, and the target's missile warning
  phase: MissilePhase;
  apex: number;
  from: number;
  power: number;
}

/** Position then rotation quaternion: [x, y, z, qx, qy, qz, qw]. */
export type CrateState = number[];

type WireOf<E> = E extends { pos: Vector3; normal: Vector3 } ? Omit<E, 'pos' | 'normal'> & { pos: Vec3Tuple; normal: Vec3Tuple } : E;
export type WireEvent = WireOf<SimEvent> & { tick: number };

/** Sent on joining, and again whenever the server changes map or mode, or you start or stop spectating. */
export interface WelcomeMessage {
  type: 'welcome';
  id: string;
  tick: number;
  map: string;
  mode: GameMode;
  spectator: boolean;
  match: MatchState;
  token?: string; // proves who you are when reconnecting after a dropped connection (JoinMessage.resume)
  custom?: MapDef; // the map itself, when it's one made in the editor (clients don't have it)
}

export interface RejectedMessage {
  type: 'rejected';
  reason: string;
}

export interface PingMessage {
  type: 'ping';
  t: number;
}

/** A player's chat line, or (no `id`) a server notice like someone joining. */
export interface ChatMessage {
  type: 'chat';
  id: string | null;
  name: string;
  text: string;
}

export interface SnapshotMessage {
  type: 'snapshot';
  tick: number; // server tick this snapshot describes (state after that tick)
  ack: number; // last input seq the server has simulated for the recipient
  you: PlayerState | null; // the recipient's own player, full precision, for reconciliation
  players: RemotePlayerState[]; // everyone else
  projectiles: ProjectileState[];
  crates: CrateState[];
  vehicles: VehicleState[];
  pickups: number[]; // each mystery box's respawnIn: 0 while it's there to take
  items: number[]; // each item's respawnIn, likewise
  flags: FlagState[]; // red's then blue's (capture the flag only; empty otherwise)
  scores: ScoreEntry[]; // everyone, including the recipient
  match: MatchState;
  events: WireEvent[]; // the last NET.eventWindow ticks of events; clients skip ones they've seen
  input: { queued: number; starved: number; dropped: number }; // the recipient's input stream health, for debugging
}

/** What you just earned online: XP, a level, unlocks, finished challenges. */
export interface ProgressMessage {
  type: 'progress';
  gain: Gain;
  xp: number; // total, after
}

export type ServerMessage = WelcomeMessage | SnapshotMessage | RejectedMessage | PingMessage | ChatMessage | ProgressMessage;

export const MAX_NAME = 16;
export const MAX_CHAT = 120;

/** Printable, trimmed, no runs of spaces, at most `max` characters. */
export function cleanText(text: unknown, max: number): string {
  if (typeof text !== 'string') return '';
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const finite = (v: unknown, lo: number, hi: number, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

/**
 * Whatever a client sent, as a well-formed message, or null. The server never trusts the wire:
 * a modified client could send anything, and one NaN in an input would poison the physics.
 */
export function parseClientMessage(data: unknown): ClientMessage | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as Record<string, unknown>;
  switch (m.type) {
    case 'join':
      return {
        type: 'join',
        name: cleanText(m.name, MAX_NAME),
        version: finite(m.version, 0, 1e6),
        spectate: m.spectate === true,
        ...(typeof m.resume === 'string' && /^[a-z0-9]{8,40}$/.test(m.resume) ? { resume: m.resume } : {}),
        ...(typeof m.profile === 'string' && /^[a-f0-9]{32}$/.test(m.profile) ? { profile: m.profile } : {}),
      };
    case 'spectate':
      return { type: 'spectate', on: m.on === true };
    case 'ack':
      return Number.isSafeInteger(m.tick) && (m.tick as number) >= 0 ? { type: 'ack', tick: m.tick as number } : null;
    case 'pong':
      return { type: 'pong', t: finite(m.t, 0, Number.MAX_SAFE_INTEGER) };
    case 'chat': {
      const text = cleanText(m.text, MAX_CHAT);
      return text ? { type: 'chat', text } : null;
    }
    case 'input': {
      if (!Array.isArray(m.frames)) return null;
      const frames: InputFrame[] = [];
      for (const f of m.frames.slice(0, 8)) {
        if (!f || typeof f !== 'object' || !Number.isSafeInteger(f.seq) || f.seq < 0) continue;
        const i = (f.input ?? {}) as Record<string, unknown>;
        const input: PlayerInput = {
          forward: finite(i.forward, -1, 1),
          right: finite(i.right, -1, 1),
          jump: i.jump === true,
          fire: i.fire === true,
          grapple: i.grapple === true,
          use: i.use === true,
          down: i.down === true,
          yaw: finite(i.yaw, -1e6, 1e6) % (Math.PI * 2),
          pitch: finite(i.pitch, -Math.PI / 2, Math.PI / 2),
        };
        if (i.view !== undefined) input.view = finite(i.view, 0, 1e12);
        frames.push({ seq: f.seq, input });
      }
      const snap = Number.isSafeInteger(m.snap) && (m.snap as number) >= 0 ? (m.snap as number) : undefined;
      return { type: 'input', frames, snap };
    }
  }
  return null;
}

const tuple = (v: Vector3): Vec3Tuple => [v.x, v.y, v.z];

/**
 * Best first, by what wins the mode: kills (then fewest deaths) in deathmatch, captures then kills
 * in capture the flag, the fastest lap in a race (no lap yet goes last).
 */
export function compareScores(mode: GameMode): (a: ScoreEntry, b: ScoreEntry) => number {
  if (mode === 'race') return (a, b) => (a.bestLap || Infinity) - (b.bestLap || Infinity) || a.name.localeCompare(b.name);
  if (mode === 'ctf') return (a, b) => b.captures - a.captures || b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name);
  if (mode === 'koth') return (a, b) => b.points - a.points || b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name);
  return (a, b) => b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name);
}

/** What a player's place is decided by, for the HUD: kills, captures, or a lap time. */
export function hasScored(mode: GameMode, s: ScoreEntry): boolean {
  if (mode === 'koth') return s.points > 0 || s.kills > 0;
  return mode === 'race' ? s.bestLap > 0 : mode === 'ctf' ? s.captures > 0 || s.kills > 0 : s.kills > 0;
}

export function toWireEvent(e: SimEvent, tick: number): WireEvent {
  if (e.type === 'explosion' || e.type === 'bounce' || e.type === 'vehicleDestroyed') return { ...e, pos: tuple(e.pos), normal: tuple(e.normal), tick };
  return { ...e, tick };
}

export function fromWireEvent(w: WireEvent): SimEvent {
  const { tick: _, ...e } = w;
  if (e.type === 'explosion' || e.type === 'bounce' || e.type === 'vehicleDestroyed') return { ...e, pos: new Vector3(...e.pos), normal: new Vector3(...e.normal) };
  return e;
}
