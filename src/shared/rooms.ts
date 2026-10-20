import type { BotSkill } from './bot';
import { DT, MODES, type GameMode } from './config';
import { PLAYABLE_MAPS } from './map';
import { CUSTOM_PREFIX, sanitizeMap } from './custommap';
import type { MapDef } from './map';
import { MAPS } from './map';
import type { StatEvent } from './progress';
import { cleanText, type ServerMessage } from './protocol';
import { GameServer, type ServerOptions } from './server';

// Rooms: one server process hosts several games at once. The main room plays the server's own
// rotation and is always there. Anyone can open another one from the menu, public (listed in the
// server browser) or private (joined only by its code, or an invite link with the code in it).
// A room nobody is in closes after a couple of minutes. Each room is a GameServer of its own; this
// keeps the list, makes up codes, and ticks them all.

export const MAX_ROOM_NAME = 32;
/** Room codes: no 0/O or 1/I/L to misread when someone says one out loud. */
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
export const MAIN_ROOM = 'main';
/** Bots fill a room up to one of these (0: none). */
export const ROOM_BOTS = [0, 4, 6, 8] as const;

/** What someone asks for when opening a room. */
export interface RoomRequest {
  name: string;
  mode: GameMode;
  map: string; // a map name, or 'rotation' for every map in turn
  bots: number; // fill up to this many players with bots
  skill: BotSkill | 'auto';
  private: boolean;
  /** A map from the editor (map is then 'custom'). */
  custom?: MapDef;
}

/** A room as the server browser lists it. */
export interface RoomInfo {
  code: string;
  name: string;
  mode: GameMode;
  map: string;
  players: number;
  maxPlayers: number;
  spectators: number;
  bots: number;
  phase: string;
  main: boolean;
  mapTitle: string;
}

export interface Room {
  readonly code: string;
  readonly name: string;
  readonly server: GameServer;
  readonly public: boolean;
  readonly main: boolean;
  idle: number; // seconds with nobody connected
}

/** A room request from the wire, checked and filled in, or null if it makes no sense. */
export function parseRoomRequest(data: unknown): RoomRequest | null {
  if (!data || typeof data !== 'object') return null;
  const r = data as Record<string, unknown>;
  const mode = typeof r.mode === 'string' && Object.hasOwn(MODES, r.mode) ? (r.mode as GameMode) : null;
  const custom = r.map === 'custom' ? sanitizeMap(r.custom) : null;
  const map = typeof r.map === 'string' && (r.map === 'rotation' || PLAYABLE_MAPS.includes(r.map) || custom) ? r.map : null;
  if (!mode || !map) return null;
  const bots = ROOM_BOTS.includes(r.bots as (typeof ROOM_BOTS)[number]) ? (r.bots as number) : 0;
  const skill = (['easy', 'normal', 'hard', 'auto'] as const).find((s) => s === r.skill) ?? 'auto';
  const name = cleanText(r.name, MAX_ROOM_NAME) || `${MODES[mode].name} room`;
  return { name, mode, map, bots, skill, private: r.private === true, ...(custom ? { custom } : {}) };
}

export class Rooms {
  private readonly rooms = new Map<string, Room>();
  readonly main: Room;
  /** Someone was voted out of a room. */
  onKick: (room: Room, id: string) => void = () => {};
  onSuspect: (room: Room, id: string, name: string, detail: { hits: number; snaps: number }) => void = () => {};
  onDeath: (map: string, x: number, z: number, cause: string) => void = () => {};
  onMatchOver: (mode: GameMode, map: string, people: number) => void = () => {};
  /** A room's tick threw: for the server's log. The room carries on. */
  onError: (room: Room, err: unknown) => void = () => {};
  /** Something for a player's profile happened in a room. */
  onStat: (room: Room, id: string, profile: string, name: string, e: StatEvent) => void = () => {};

  constructor(
    /** Delivers a message to a client, whichever room it's in (client ids are unique across rooms). */
    private readonly send: (clientId: string, msg: ServerMessage) => void,
    /** The main room's settings; opened rooms share its player limits and intermission. */
    private readonly mainOptions: Partial<ServerOptions>,
    readonly limits = { maxRooms: 8, idleTimeout: 120 },
  ) {
    this.main = { code: MAIN_ROOM, name: 'Main', server: new GameServer(send, mainOptions), public: true, main: true, idle: 0 };
    this.hook(this.main);
    this.rooms.set(MAIN_ROOM, this.main);
  }

  private hook(room: Room) {
    room.server.onKick = (id) => this.onKick(room, id);
    room.server.onStat = (id, profile, name, e) => this.onStat(room, id, profile, name, e);
    room.server.onSuspect = (id, name, detail) => this.onSuspect(room, id, name, detail);
    room.server.onDeath = (map, x, z, cause) => this.onDeath(map, x, z, cause);
    room.server.onMatchOver = (mode, map, people) => this.onMatchOver(mode, map, people);
  }

  get count(): number {
    return this.rooms.size;
  }

  /** The room with this code (any case), or undefined. */
  get(code: string): Room | undefined {
    return this.rooms.get(code.toLowerCase() === MAIN_ROOM ? MAIN_ROOM : code.toUpperCase());
  }

  /** Opens a room, or says why it can't. */
  create(req: RoomRequest): Room | { error: string } {
    if (this.rooms.size >= this.limits.maxRooms) return { error: 'The server has as many rooms as it can run. Join one of them, or try again later.' };
    let code: string;
    do {
      code = randomCode();
    } while (this.rooms.has(code));
    // A map from the editor joins the list of maps while its room is open.
    const custom = req.custom ? `${CUSTOM_PREFIX}${code.toLowerCase()}` : null;
    if (custom) MAPS[custom] = req.custom!;
    const maps = req.map === 'rotation' ? PLAYABLE_MAPS.map((m) => `${m}:${req.mode}`) : [`${custom ?? req.map}:${req.mode}`];
    const server = new GameServer(this.send, {
      maxPlayers: this.mainOptions.maxPlayers,
      maxSpectators: this.mainOptions.maxSpectators,
      intermission: this.mainOptions.intermission,
      reconnectGrace: this.mainOptions.reconnectGrace,
      maps,
      mode: req.mode,
      minPlayers: req.bots,
      botSkill: req.skill,
      botRewards: false,
    });
    const room: Room = { code, name: req.name, server, public: !req.private, main: false, idle: 0 };
    this.hook(room);
    this.rooms.set(code, room);
    return room;
  }

  /** The public rooms, main first, then the busiest. */
  list(): RoomInfo[] {
    return [...this.rooms.values()]
      .filter((r) => r.public)
      .map((r) => this.info(r))
      .sort((a, b) => Number(b.main) - Number(a.main) || b.players - a.players || a.name.localeCompare(b.name));
  }

  info(r: Room): RoomInfo {
    const s = r.server.status();
    return { code: r.code, name: r.name, mode: s.mode, map: s.map, mapTitle: MAPS[s.map]?.title ?? s.map, players: s.players.length, maxPlayers: s.maxPlayers, spectators: s.spectators.length, bots: s.bots, phase: s.match.phase, main: r.main };
  }

  /** One tick of every room. Rooms that have sat empty long enough close (never the main one). */
  tick() {
    for (const [code, r] of this.rooms) {
      // One room going wrong mustn't take the others (and the process) down with it.
      try {
        r.server.tick();
      } catch (err) {
        this.onError(r, err);
      }
      r.idle = r.server.playerCount ? 0 : r.idle + DT;
      if (!r.main && r.idle > this.limits.idleTimeout) {
        r.server.sim.world.free();
        this.rooms.delete(code);
        delete MAPS[`${CUSTOM_PREFIX}${code.toLowerCase()}`];
      }
    }
  }
}

/** A room code from a secure random source, so private rooms' codes can't be predicted. */
function randomCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  // (256 isn't a multiple of the 31 letters, but the skew is under 1%: fine for a room code.)
  return Array.from(bytes, (b) => CODE_LETTERS[b % CODE_LETTERS.length]).join('');
}
