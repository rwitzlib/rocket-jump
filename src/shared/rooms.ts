import type { BotSkill } from './bot';
import { DT, MODES, type GameMode } from './config';
import { MAPS } from './map';
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
  const mode = typeof r.mode === 'string' && r.mode in MODES ? (r.mode as GameMode) : null;
  const map = typeof r.map === 'string' && (r.map === 'rotation' || r.map in MAPS) ? r.map : null;
  if (!mode || !map) return null;
  const bots = ROOM_BOTS.includes(r.bots as (typeof ROOM_BOTS)[number]) ? (r.bots as number) : 0;
  const skill = (['easy', 'normal', 'hard', 'auto'] as const).find((s) => s === r.skill) ?? 'auto';
  const name = cleanText(r.name, MAX_ROOM_NAME) || `${MODES[mode].name} room`;
  return { name, mode, map, bots, skill, private: r.private === true };
}

export class Rooms {
  private readonly rooms = new Map<string, Room>();
  readonly main: Room;

  constructor(
    /** Delivers a message to a client, whichever room it's in (client ids are unique across rooms). */
    private readonly send: (clientId: string, msg: ServerMessage) => void,
    /** The main room's settings; opened rooms share its player limits and intermission. */
    private readonly mainOptions: Partial<ServerOptions>,
    readonly limits = { maxRooms: 8, idleTimeout: 120 },
  ) {
    this.main = { code: MAIN_ROOM, name: 'Main', server: new GameServer(send, mainOptions), public: true, main: true, idle: 0 };
    this.rooms.set(MAIN_ROOM, this.main);
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
      code = Array.from({ length: CODE_LENGTH }, () => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)]).join('');
    } while (this.rooms.has(code));
    const maps = req.map === 'rotation' ? Object.keys(MAPS).map((m) => `${m}:${req.mode}`) : [`${req.map}:${req.mode}`];
    const server = new GameServer(this.send, {
      maxPlayers: this.mainOptions.maxPlayers,
      maxSpectators: this.mainOptions.maxSpectators,
      intermission: this.mainOptions.intermission,
      maps,
      mode: req.mode,
      minPlayers: req.bots,
      botSkill: req.skill,
    });
    const room: Room = { code, name: req.name, server, public: !req.private, main: false, idle: 0 };
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
    return { code: r.code, name: r.name, mode: s.mode, map: s.map, players: s.players.length, maxPlayers: s.maxPlayers, spectators: s.spectators.length, bots: s.bots, phase: s.match.phase, main: r.main };
  }

  /** One tick of every room. Rooms that have sat empty long enough close (never the main one). */
  tick() {
    for (const [code, r] of this.rooms) {
      r.server.tick();
      r.idle = r.server.playerCount ? 0 : r.idle + DT;
      if (!r.main && r.idle > this.limits.idleTimeout) {
        r.server.sim.world.free();
        this.rooms.delete(code);
      }
    }
  }
}
