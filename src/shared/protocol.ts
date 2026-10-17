import { Vector3 } from 'three';
import type { Vec3Tuple } from './map';
import type { PlayerState, SimEvent } from './sim';
import type { PlayerInput } from './types';

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

export type ClientMessage = InputMessage;

export interface RemotePlayerState {
  id: string;
  pos: Vec3Tuple;
  yaw: number;
  pitch: number;
  anchor: Vec3Tuple | null; // grapple anchor, when attached
}

export interface RocketState {
  id: number;
  ownerId: string;
  pos: Vec3Tuple;
  dir: Vec3Tuple;
}

/** Position then rotation quaternion: [x, y, z, qx, qy, qz, qw]. */
export type CrateState = number[];

type WireOf<E> = E extends { pos: Vector3; normal: Vector3 } ? Omit<E, 'pos' | 'normal'> & { pos: Vec3Tuple; normal: Vec3Tuple } : E;
export type WireEvent = WireOf<SimEvent> & { tick: number };

export interface WelcomeMessage {
  type: 'welcome';
  id: string;
  tick: number;
}

export interface SnapshotMessage {
  type: 'snapshot';
  tick: number; // server tick this snapshot describes (state after that tick)
  ack: number; // last input seq the server has simulated for the recipient
  you: PlayerState | null; // the recipient's own player, full precision, for reconciliation
  players: RemotePlayerState[]; // everyone else
  rockets: RocketState[];
  crates: CrateState[];
  events: WireEvent[]; // the last NET.eventWindow ticks of events; clients skip ones they've seen
  input: { queued: number; starved: number; dropped: number }; // the recipient's input stream health, for debugging
}

export type ServerMessage = WelcomeMessage | SnapshotMessage;

const tuple = (v: Vector3): Vec3Tuple => [v.x, v.y, v.z];

export function toWireEvent(e: SimEvent, tick: number): WireEvent {
  if (e.type === 'explosion') return { ...e, pos: tuple(e.pos), normal: tuple(e.normal), tick };
  return { ...e, tick };
}

export function fromWireEvent(w: WireEvent): SimEvent {
  const { tick: _, ...e } = w;
  if (e.type === 'explosion') return { ...e, pos: new Vector3(...e.pos), normal: new Vector3(...e.normal) };
  return e;
}
