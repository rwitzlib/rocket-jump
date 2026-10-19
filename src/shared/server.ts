import { DT, MATCH, NET, PROTOCOL_VERSION } from './config';
import { Bot } from './bot';
import { MAPS } from './map';
import {
  MAX_NAME,
  toWireEvent,
  type ClientMessage,
  type CrateState,
  type InputFrame,
  type MatchState,
  type RemotePlayerState,
  type ProjectileState,
  type ScoreEntry,
  type ServerMessage,
  type WireEvent,
} from './protocol';
import { GameSim, type SimEvent } from './sim';
import { EMPTY_INPUT, type PlayerInput } from './types';

// The authoritative game server, independent of any transport. Whatever carries the bytes (the
// in-page loopback, or WebSockets in src/server/main.ts) calls receive/disconnect and tick, and
// delivers what comes out of `send`. A client's first message must be `join`.
//
// It runs back-to-back deathmatches: first to the frag limit, or the most kills when time runs
// out, then an intermission on the results and the next map in the rotation. Bots fill in so a
// lone player always has someone to fight, and step aside as people join.

interface Connection {
  name: string;
  queue: InputFrame[]; // received but not yet simulated, sorted by seq
  lastProcessed: number;
  lastInput: PlayerInput;
  buffering: boolean;
  starved: number; // ticks where no input had arrived yet, so the last one was repeated
  dropped: number; // inputs thrown away because the queue grew too long
  ping: number; // ms, smoothed
  lastChat: number; // ms timestamp, for rate limiting
}

interface Stats {
  streak: number;
  bestStreak: number;
  airshots: number;
}

export interface ServerOptions {
  /** Map rotation, by name in MAPS. */
  maps: string[];
  timeLimit: number;
  fragLimit: number;
  intermission: number;
  /** Bots fill the game up to this many players while anyone is connected. 0 for no bots. */
  minPlayers: number;
  maxPlayers: number;
}

const BOT_NAMES = ['Rocko', 'Splash', 'Boomer', 'Hookshot', 'Gibs', 'Strafe', 'Kaboom', 'Ricochet', 'Nitro', 'Zipline', 'Frag', 'Dropkick', 'Skyhook', 'Blastoff'];
const PING_INTERVAL = 2000; // ms
const CHAT_INTERVAL = 600; // ms a player must wait between chat lines

const now = () => performance.now();

export class GameServer {
  sim: GameSim;
  readonly options: ServerOptions;
  private readonly connections = new Map<string, Connection>();
  private readonly bots = new Map<string, { bot: Bot; name: string }>();
  private readonly stats = new Map<string, Stats>();
  private readonly inputs = new Map<string, PlayerInput>();
  private recentEvents: WireEvent[] = [];
  private mapIndex = 0;
  private nextBot = 1;
  private lastPing = 0;
  private match: MatchState;

  constructor(
    private readonly send: (clientId: string, msg: ServerMessage) => void,
    options: Partial<ServerOptions> = {},
  ) {
    this.options = {
      maps: ['arena'],
      timeLimit: MATCH.timeLimit,
      fragLimit: MATCH.fragLimit,
      intermission: MATCH.intermission,
      minPlayers: MATCH.minPlayers,
      maxPlayers: MATCH.maxPlayers,
      ...options,
    };
    this.options.maps = this.options.maps.filter((m) => MAPS[m]);
    if (!this.options.maps.length) this.options.maps = ['arena'];
    this.sim = new GameSim(MAPS[this.mapName]);
    this.match = this.newMatch(1);
  }

  get mapName(): string {
    return this.options.maps[this.mapIndex % this.options.maps.length];
  }

  get playerCount(): number {
    return this.connections.size;
  }

  /** Who's playing, for a status page. */
  status() {
    return {
      map: this.mapName,
      players: [...this.connections.values()].map((c) => c.name),
      bots: this.bots.size,
      maxPlayers: this.options.maxPlayers,
      match: { ...this.match, timeLeft: Math.round(this.match.timeLeft) },
    };
  }

  disconnect(id: string) {
    const conn = this.connections.get(id);
    if (!conn) return;
    this.connections.delete(id);
    this.inputs.delete(id);
    this.stats.delete(id);
    this.sim.removePlayer(id);
    this.notice(`${conn.name} left`);
    this.fillBots();
  }

  receive(id: string, msg: ClientMessage) {
    if (msg.type === 'join') {
      this.join(id, msg.name, msg.version);
      return;
    }
    const conn = this.connections.get(id);
    if (!conn) return;
    switch (msg.type) {
      case 'input':
        // Packets can arrive late, twice, or out of order: keep each new seq once, in order.
        for (const frame of msg.frames) {
          if (frame.seq <= conn.lastProcessed) continue;
          const q = conn.queue;
          let i = q.length;
          while (i > 0 && q[i - 1].seq > frame.seq) i--;
          if (i > 0 && q[i - 1].seq === frame.seq) continue;
          q.splice(i, 0, frame);
        }
        // A client flooding inputs only fills its own queue, which nextInput trims.
        if (conn.queue.length > 64) conn.queue.splice(0, conn.queue.length - 64);
        break;
      case 'pong': {
        const rtt = now() - msg.t;
        if (rtt >= 0 && rtt < 10000) conn.ping = conn.ping ? conn.ping * 0.7 + rtt * 0.3 : rtt;
        break;
      }
      case 'chat': {
        const t = now();
        if (t - conn.lastChat < CHAT_INTERVAL) return;
        conn.lastChat = t;
        for (const other of this.connections.keys()) this.send(other, { type: 'chat', id, name: conn.name, text: msg.text });
        break;
      }
    }
  }

  private join(id: string, rawName: string, version: number) {
    if (this.connections.has(id)) return; // a resent join
    if (version !== PROTOCOL_VERSION) {
      this.send(id, { type: 'rejected', reason: 'The game has been updated. Reload the page to get the new version.' });
      return;
    }
    if (this.connections.size >= this.options.maxPlayers) {
      this.send(id, { type: 'rejected', reason: `The server is full (${this.options.maxPlayers} players). Try again in a bit.` });
      return;
    }
    // Someone arriving at an empty server gets a fresh match rather than the tail of an old one.
    if (this.connections.size === 0) this.startMatch(false);

    const name = this.uniqueName(rawName || `Player ${Math.floor(Math.random() * 900 + 100)}`);
    this.connections.set(id, {
      name,
      queue: [],
      lastProcessed: 0,
      lastInput: EMPTY_INPUT,
      buffering: true,
      starved: 0,
      dropped: 0,
      ping: 0,
      lastChat: 0,
    });
    this.stats.set(id, { streak: 0, bestStreak: 0, airshots: 0 });
    this.sim.addPlayer(id);
    this.send(id, this.welcome(id));
    this.send(id, { type: 'ping', t: now() });
    this.notice(`${name} joined`);
    this.fillBots();
  }

  private welcome(id: string): ServerMessage {
    return { type: 'welcome', id, tick: this.sim.tick, map: this.mapName, match: { ...this.match } };
  }

  private uniqueName(name: string): string {
    const taken = new Set([...this.connections.values()].map((c) => c.name.toLowerCase()));
    for (const b of this.bots.values()) taken.add(b.name.toLowerCase());
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; ; i++) {
      const candidate = `${name.slice(0, MAX_NAME - String(i).length - 1)} ${i}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  /** A server line in everyone's chat. */
  private notice(text: string) {
    for (const id of this.connections.keys()) this.send(id, { type: 'chat', id: null, name: '', text });
  }

  addBot(): string {
    const id = `bot${this.nextBot++}`;
    const used = new Set([...this.bots.values()].map((b) => b.name));
    const free = BOT_NAMES.filter((n) => !used.has(n) && ![...this.connections.values()].some((c) => c.name === n));
    const name = free.length ? free[Math.floor(Math.random() * free.length)] : `Bot ${this.nextBot}`;
    this.bots.set(id, { bot: new Bot(), name });
    this.stats.set(id, { streak: 0, bestStreak: 0, airshots: 0 });
    this.sim.addPlayer(id);
    return id;
  }

  private removeBot(id: string) {
    this.bots.delete(id);
    this.stats.delete(id);
    this.inputs.delete(id);
    this.sim.removePlayer(id);
  }

  /** Bots make up the numbers while anyone is here, and leave when the last person does. */
  private fillBots() {
    const people = this.connections.size;
    const want = people === 0 ? 0 : Math.max(0, this.options.minPlayers - people);
    while (this.bots.size < want) this.addBot();
    while (this.bots.size > want) {
      // The one with the fewest kills leaves, so the leaderboard barely changes.
      let worst: string | null = null;
      let worstKills = Infinity;
      for (const id of this.bots.keys()) {
        const kills = this.sim.players.get(id)?.kills ?? 0;
        if (kills < worstKills) {
          worst = id;
          worstKills = kills;
        }
      }
      this.removeBot(worst!);
    }
  }

  private newMatch(id: number): MatchState {
    const maps = this.options.maps;
    return {
      id,
      phase: 'playing',
      timeLeft: this.options.timeLimit,
      fragLimit: this.options.fragLimit,
      map: this.mapName,
      nextMap: maps[(this.mapIndex + 1) % maps.length],
      winnerId: null,
    };
  }

  /** Starts the next match, on the next map in the rotation if `advance`. */
  private startMatch(advance: boolean) {
    const oldMap = this.mapName;
    if (advance) this.mapIndex = (this.mapIndex + 1) % this.options.maps.length;
    this.match = this.newMatch(this.match.id + 1);
    for (const s of this.stats.values()) Object.assign(s, { streak: 0, bestStreak: 0, airshots: 0 });

    if (this.mapName !== oldMap) {
      const tick = this.sim.tick;
      this.sim.world.free();
      this.sim = new GameSim(MAPS[this.mapName]);
      this.sim.tick = tick; // ticks keep counting up, so clients never see time run backwards
      this.recentEvents = [];
      for (const id of [...this.connections.keys(), ...this.bots.keys()]) this.sim.addPlayer(id);
      for (const id of this.connections.keys()) this.send(id, this.welcome(id));
    } else {
      this.sim.resetForMatch();
    }
  }

  tick() {
    const t = now();
    if (t - this.lastPing > PING_INTERVAL) {
      this.lastPing = t;
      for (const id of this.connections.keys()) this.send(id, { type: 'ping', t });
    }
    // Nobody here: nothing to simulate.
    if (this.connections.size === 0) return;

    const frozen = this.match.phase === 'intermission';
    for (const [id, conn] of this.connections) {
      const input = this.nextInput(conn);
      // Between matches everyone can look around, but not move or shoot. Clients do the same, so prediction agrees.
      this.inputs.set(id, frozen ? freeze(input) : input);
      const p = this.sim.players.get(id);
      if (p) p.seq = conn.lastProcessed;
    }
    for (const [id, { bot }] of this.bots) {
      const p = this.sim.players.get(id);
      if (p) this.inputs.set(id, frozen ? freeze(EMPTY_INPUT) : bot.think(p, this.sim));
    }

    const events = this.sim.step(this.inputs);
    for (const e of events) {
      this.track(e);
      this.recentEvents.push(toWireEvent(e, this.sim.tick));
    }
    const oldest = this.sim.tick - NET.eventWindow;
    if (this.recentEvents.length && this.recentEvents[0].tick <= oldest) {
      this.recentEvents = this.recentEvents.filter((e) => e.tick > oldest);
    }

    this.updateMatch();
    if (this.sim.tick % NET.snapshotInterval === 0) this.broadcast();
  }

  /** Kill streaks and airshots, for the scoreboard and the end-of-match awards. */
  private track(e: SimEvent) {
    if (e.type !== 'killed' || this.match.phase !== 'playing') return;
    const victim = this.stats.get(e.playerId);
    if (victim) victim.streak = 0;
    const killer = e.killerId ? this.stats.get(e.killerId) : undefined;
    if (!killer) return;
    killer.streak++;
    killer.bestStreak = Math.max(killer.bestStreak, killer.streak);
    if (e.midair) killer.airshots++;
  }

  private updateMatch() {
    const m = this.match;
    m.timeLeft = Math.max(0, m.timeLeft - DT);
    if (m.phase === 'playing') {
      const leader = this.leader();
      const fragged = leader !== null && (this.sim.players.get(leader)?.kills ?? 0) >= m.fragLimit;
      if (fragged || m.timeLeft === 0) {
        m.phase = 'intermission';
        m.timeLeft = this.options.intermission;
        m.winnerId = leader;
      }
    } else if (m.timeLeft === 0) {
      this.startMatch(true);
    }
  }

  /** Most kills, then fewest deaths. */
  private leader(): string | null {
    let best: string | null = null;
    let bestKills = -1;
    let bestDeaths = Infinity;
    for (const p of this.sim.players.values()) {
      if (p.kills > bestKills || (p.kills === bestKills && p.deaths < bestDeaths)) {
        best = p.id;
        bestKills = p.kills;
        bestDeaths = p.deaths;
      }
    }
    return bestKills > 0 ? best : null;
  }

  /** One input per tick. A small buffer absorbs jitter; if it runs dry, the last input is repeated. */
  private nextInput(conn: Connection): PlayerInput {
    if (conn.buffering) {
      if (conn.queue.length < NET.jitterBuffer) return conn.lastInput;
      conn.buffering = false;
    }
    if (conn.queue.length > NET.maxInputQueue) {
      const excess = conn.queue.length - NET.jitterBuffer;
      conn.dropped += excess;
      conn.lastProcessed = conn.queue[excess - 1].seq;
      conn.queue.splice(0, excess);
    }
    const frame = conn.queue.shift();
    if (!frame) {
      conn.starved++;
      return conn.lastInput;
    }
    conn.lastProcessed = frame.seq;
    conn.lastInput = frame.input;
    return frame.input;
  }

  private broadcast() {
    const sim = this.sim;
    const players: RemotePlayerState[] = [];
    const scores: ScoreEntry[] = [];
    for (const p of sim.players.values()) {
      const a = p.grapple?.anchor;
      players.push({ id: p.id, pos: [r3(p.pos.x), r3(p.pos.y), r3(p.pos.z)], yaw: r3(p.yaw), pitch: r3(p.pitch), anchor: a ? [r3(a.x), r3(a.y), r3(a.z)] : null, alive: p.alive, protected: p.protectedFor > 0, grounded: p.grounded, primary: p.primary, vehicle: p.vehicle, seat: p.seat });
      const conn = this.connections.get(p.id);
      const stats = this.stats.get(p.id);
      scores.push({
        id: p.id,
        name: conn?.name ?? this.bots.get(p.id)?.name ?? p.id,
        kills: p.kills,
        deaths: p.deaths,
        ping: Math.round(conn?.ping ?? 0),
        bot: !conn,
        airshots: stats?.airshots ?? 0,
        bestStreak: stats?.bestStreak ?? 0,
      });
    }
    const projectiles: ProjectileState[] = sim.projectiles.map((r) => ({
      id: r.id,
      kind: r.kind,
      ownerId: r.ownerId,
      shot: r.shot,
      pos: [r.pos.x, r.pos.y, r.pos.z],
      vel: [r.vel.x, r.vel.y, r.vel.z],
      life: r.life,
      traveled: r.traveled,
      target: r.target,
      phase: r.phase,
      apex: r.apex,
      from: r.from,
      power: r.power,
    }));
    const pickups = sim.pickups.map((b) => b.respawnIn);
    const vehicles = sim.vehicles.map((v) => v.capture());
    const crates: CrateState[] = sim.crates.map((c) => {
      const t = c.translation();
      const q = c.rotation();
      return [r3(t.x), r3(t.y), r3(t.z), r4(q.x), r4(q.y), r4(q.z), r4(q.w)];
    });
    const match = { ...this.match, timeLeft: Math.round(this.match.timeLeft * 10) / 10 };

    for (const [id, conn] of this.connections) {
      this.send(id, {
        type: 'snapshot',
        tick: sim.tick,
        ack: conn.lastProcessed,
        you: sim.players.get(id)?.capture() ?? null,
        players: players.filter((p) => p.id !== id),
        projectiles,
        crates,
        vehicles,
        pickups,
        scores,
        match,
        events: this.recentEvents,
        input: { queued: conn.queue.length, starved: conn.starved, dropped: conn.dropped },
      });
    }
  }
}

// Other players and crates are only drawn, so millimeters are plenty; the recipient's own state (`you`) and
// projectiles, which prediction replays from, keep full precision.
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

/** Look only: what everyone's input becomes between matches. */
export function freeze(input: PlayerInput): PlayerInput {
  return { ...EMPTY_INPUT, yaw: input.yaw, pitch: input.pitch, view: input.view };
}
