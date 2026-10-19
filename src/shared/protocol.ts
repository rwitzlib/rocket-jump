import { Vector3 } from 'three';
import type { Vec3Tuple } from './map';
import type { MissilePhase, PlayerState, ProjectileKind, SimEvent } from './sim';
import type { PlayerInput, WeaponId } from './types';
import type { VehicleState } from './vehicle';

// Messages between client and server. Plain JSON-able data for now; a compact binary encoding can
// replace this later without touching the code on either side of it.

/** One tick of input, numbered by the client so the server can acknowledge it. */
export interface InputFrame {
  seq: number;
  input: PlayerInput;
}

export interface InputMessage {
  type: 'input';
  frames: InputFrame[]; // the newest few inputs, oldest first
}

/** The first thing a client sends. The server answers with `welcome`, or `rejected`. */
export interface JoinMessage {
  type: 'join';
  name: string;
  version: number; // PROTOCOL_VERSION
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

export type ClientMessage = InputMessage | JoinMessage | PongMessage | ChatSendMessage;

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
}

export type MatchPhase = 'playing' | 'intermission';

export interface MatchState {
  id: number; // goes up by one every match
  phase: MatchPhase;
  timeLeft: number; // seconds left in this phase
  fragLimit: number;
  map: string;
  nextMap: string;
  winnerId: string | null; // set during intermission
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

/** Sent on joining, and again whenever the server changes map. */
export interface WelcomeMessage {
  type: 'welcome';
  id: string;
  tick: number;
  map: string;
  match: MatchState;
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
  scores: ScoreEntry[]; // everyone, including the recipient
  match: MatchState;
  events: WireEvent[]; // the last NET.eventWindow ticks of events; clients skip ones they've seen
  input: { queued: number; starved: number; dropped: number }; // the recipient's input stream health, for debugging
}

export type ServerMessage = WelcomeMessage | SnapshotMessage | RejectedMessage | PingMessage | ChatMessage;

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
      return { type: 'join', name: cleanText(m.name, MAX_NAME), version: finite(m.version, 0, 1e6) };
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
      return { type: 'input', frames };
    }
  }
  return null;
}

const tuple = (v: Vector3): Vec3Tuple => [v.x, v.y, v.z];

export function toWireEvent(e: SimEvent, tick: number): WireEvent {
  if (e.type === 'explosion' || e.type === 'bounce' || e.type === 'vehicleDestroyed') return { ...e, pos: tuple(e.pos), normal: tuple(e.normal), tick };
  return { ...e, tick };
}

export function fromWireEvent(w: WireEvent): SimEvent {
  const { tick: _, ...e } = w;
  if (e.type === 'explosion' || e.type === 'bounce' || e.type === 'vehicleDestroyed') return { ...e, pos: new Vector3(...e.pos), normal: new Vector3(...e.normal) };
  return e;
}
