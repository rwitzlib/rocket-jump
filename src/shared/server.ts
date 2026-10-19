import { DT, MATCH, NET, PROTOCOL_VERSION, TEAMS, type GameMode } from './config';
import { Bot, type BotSkill } from './bot';
import { MAPS } from './map';
import { parseRotation, scoreLimit, timeLimit, type RotationEntry } from './modes';
import {
  compareScores,
  MAX_NAME,
  toWireEvent,
  type ClientMessage,
  type CrateState,
  type FlagState,
  type InputFrame,
  type MatchState,
  type RemotePlayerState,
  type ProjectileState,
  type ScoreEntry,
  type ServerMessage,
  type WireEvent,
} from './protocol';
import { GameSim, type PlayerSim, type SimEvent } from './sim';
import { EMPTY_INPUT, type PlayerInput } from './types';

// The authoritative game server, independent of any transport. Whatever carries the bytes (the
// in-page loopback, or WebSockets in src/server/main.ts) calls receive/disconnect and tick, and
// delivers what comes out of `send`. A client's first message must be `join`.
//
// It runs back-to-back matches: each rotation entry is a map and a mode (deathmatch, team
// deathmatch, capture the flag or a race). A match ends at its score limit or when time runs out,
// then comes an intermission on the results and the next entry in the rotation. Bots fill in so a
// lone player always has someone to fight, and step aside as people join (they sit out races).
// People can also watch: spectators get snapshots but have no player.

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
  spectator: boolean; // watching: no player in the sim
  waiting: boolean; // watching only because the server was full: let in when a place comes free
}

interface Stats {
  streak: number;
  bestStreak: number;
  airshots: number;
}

export interface ServerOptions {
  /** Rotation: map names in MAPS, each optionally with a mode, like "temple:ctf". */
  maps: string[];
  /** The mode for rotation entries that don't name one. */
  mode: GameMode;
  /** Seconds per match. Null: the mode's own (CTF and races run differently from deathmatch). */
  timeLimit: number | null;
  /** Null: each map's own (MapDef.fragLimit), else MATCH.fragLimit. Team deathmatch scales it up. */
  fragLimit: number | null;
  intermission: number;
  /** Bots fill the game up to this many players while anyone is connected. 0 for no bots. */
  minPlayers: number;
  maxPlayers: number;
  /** People allowed to watch on top of maxPlayers. Someone joining a full server watches until there's room. */
  maxSpectators: number;
  /** How good bots are. 'auto' starts easy and follows how the people on the server are doing. */
  botSkill: BotSkill | 'auto';
}

const BOT_NAMES = ['Rocko', 'Splash', 'Boomer', 'Hookshot', 'Gibs', 'Strafe', 'Kaboom', 'Ricochet', 'Nitro', 'Zipline', 'Frag', 'Dropkick', 'Skyhook', 'Blastoff'];
const PING_INTERVAL = 2000; // ms
const SKILL_CHECK = 20; // seconds between bot skill adjustments
const SKILL_LADDER: BotSkill[] = ['easy', 'normal', 'hard'];
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
  private readonly rotation: RotationEntry[];
  private mapIndex = 0;
  private nextBot = 1;
  private lastPing = 0;
  private skill: BotSkill = 'easy';
  private nextSkillCheck = SKILL_CHECK;
  private match: MatchState;

  constructor(
    private readonly send: (clientId: string, msg: ServerMessage) => void,
    options: Partial<ServerOptions> = {},
  ) {
    this.options = {
      maps: ['arena'],
      mode: MATCH.mode,
      timeLimit: null,
      fragLimit: null,
      intermission: MATCH.intermission,
      minPlayers: MATCH.minPlayers,
      maxPlayers: MATCH.maxPlayers,
      maxSpectators: 8,
      botSkill: 'auto',
      ...options,
    };
    this.rotation = parseRotation(this.options.maps, this.options.mode);
    if (!this.rotation.length) this.rotation.push({ map: 'arena', mode: this.options.mode });
    this.options.maps = this.rotation.map((r) => `${r.map}:${r.mode}`);
    this.sim = new GameSim(MAPS[this.mapName], this.mode);
    this.match = this.newMatch(1);
    if (this.options.botSkill !== 'auto') this.skill = this.options.botSkill;
  }

  private entry(offset = 0): RotationEntry {
    return this.rotation[(this.mapIndex + offset) % this.rotation.length];
  }

  get mapName(): string {
    return this.entry().map;
  }

  get mode(): GameMode {
    return this.entry().mode;
  }

  /** People connected, playing or watching. */
  get playerCount(): number {
    return this.connections.size;
  }

  /** People playing (not watching). */
  private get people(): number {
    let n = 0;
    for (const c of this.connections.values()) if (!c.spectator) n++;
    return n;
  }

  /** Who's playing, for a status page. */
  status() {
    const conns = [...this.connections.values()];
    return {
      map: this.mapName,
      mode: this.mode,
      players: conns.filter((c) => !c.spectator).map((c) => c.name),
      spectators: conns.filter((c) => c.spectator).map((c) => c.name),
      bots: this.bots.size,
      botSkill: this.skill,
      maxPlayers: this.options.maxPlayers,
      rotation: this.options.maps,
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
    if (!conn.spectator) this.admitWaiting();
    this.fillBots();
  }

  receive(id: string, msg: ClientMessage) {
    if (msg.type === 'join') {
      this.join(id, msg.name, msg.version, msg.spectate);
      return;
    }
    const conn = this.connections.get(id);
    if (!conn) return;
    switch (msg.type) {
      case 'input':
        if (conn.spectator) break;
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
      case 'spectate':
        this.setSpectating(id, conn, msg.on);
        break;
    }
  }

  private join(id: string, rawName: string, version: number, spectate: boolean) {
    if (this.connections.has(id)) return; // a resent join
    if (version !== PROTOCOL_VERSION) {
      this.send(id, { type: 'rejected', reason: 'The game has been updated. Reload the page to get the new version.' });
      return;
    }
    const full = this.people >= this.options.maxPlayers;
    const watchers = this.connections.size - this.people;
    if ((full || spectate) && watchers >= this.options.maxSpectators) {
      this.send(id, { type: 'rejected', reason: `The server is full (${this.options.maxPlayers} players). Try again in a bit.` });
      return;
    }
    // Someone arriving at an empty server gets a fresh match rather than the tail of an old one.
    if (this.connections.size === 0) {
      this.startMatch(false);
      if (this.options.botSkill === 'auto') this.skill = 'easy';
    }

    const name = this.uniqueName(rawName || `Player ${Math.floor(Math.random() * 900 + 100)}`);
    const conn: Connection = {
      name,
      queue: [],
      lastProcessed: 0,
      lastInput: EMPTY_INPUT,
      buffering: true,
      starved: 0,
      dropped: 0,
      ping: 0,
      lastChat: -Infinity,
      spectator: spectate || full,
      waiting: full && !spectate,
    };
    this.connections.set(id, conn);
    this.stats.set(id, { streak: 0, bestStreak: 0, airshots: 0 });
    if (!conn.spectator) this.addToSim(id);
    this.send(id, this.welcome(id));
    this.send(id, { type: 'ping', t: now() });
    if (conn.waiting) this.tell(id, `The server is full, so you're watching for now. You'll be let in when a place comes free.`);
    this.notice(conn.spectator ? `${name} is watching` : `${name} joined${this.teamSuffix(id)}`);
    this.fillBots();
  }

  /** Start or stop watching. Playing again needs a free place. */
  private setSpectating(id: string, conn: Connection, on: boolean) {
    if (on === conn.spectator) return;
    if (!on && this.people >= this.options.maxPlayers) {
      conn.waiting = true;
      this.tell(id, `The server is full (${this.options.maxPlayers} players). You'll be let in when a place comes free.`);
      return;
    }
    conn.spectator = on;
    conn.waiting = false;
    conn.queue = [];
    conn.buffering = true;
    if (on) {
      this.sim.removePlayer(id);
      this.inputs.delete(id);
    } else this.addToSim(id);
    this.send(id, this.welcome(id));
    this.notice(on ? `${conn.name} is watching` : `${conn.name} joined${this.teamSuffix(id)}`);
    if (on) this.admitWaiting();
    this.fillBots();
  }

  /** A place came free: whoever has been waiting longest to play gets it. */
  private admitWaiting() {
    if (this.people >= this.options.maxPlayers) return;
    for (const [id, conn] of this.connections) {
      if (!conn.waiting) continue;
      this.setSpectating(id, conn, false);
      return;
    }
  }

  /** " (Red)" in team modes, so everyone knows which side a newcomer took. */
  private teamSuffix(id: string): string {
    const team = this.sim.players.get(id)?.team ?? -1;
    return team >= 0 ? ` (${TEAMS[team].name})` : '';
  }

  /** Puts a person or bot into the game, on the smaller team in team modes. */
  private addToSim(id: string): PlayerSim {
    return this.sim.addPlayer(id, this.sim.teams ? this.smallerTeam() : -1);
  }

  /** The team with fewer players; on a tie, the one behind. */
  private smallerTeam(): number {
    const count = [0, 0];
    for (const p of this.sim.players.values()) if (p.team >= 0) count[p.team]++;
    if (count[0] !== count[1]) return count[0] < count[1] ? 0 : 1;
    const [red, blue] = this.sim.teamScores;
    return red !== blue ? (red < blue ? 0 : 1) : Math.random() < 0.5 ? 0 : 1;
  }

  /** Fresh, even teams for a new match: people spread first, then bots fill in. -1 for everyone outside team modes. */
  private assignTeams() {
    const ids = [...this.sim.players.keys()];
    const people = ids.filter((id) => this.connections.has(id)).sort(() => Math.random() - 0.5);
    const bots = ids.filter((id) => !this.connections.has(id));
    const count = [0, 0];
    for (const id of [...people, ...bots]) {
      const team = count[0] <= count[1] ? 0 : 1;
      count[team]++;
      this.sim.players.get(id)!.team = this.sim.teams ? team : -1;
    }
  }

  private welcome(id: string): ServerMessage {
    const spectator = this.connections.get(id)?.spectator ?? false;
    return { type: 'welcome', id, tick: this.sim.tick, map: this.mapName, mode: this.mode, spectator, match: { ...this.match } };
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
    for (const id of this.connections.keys()) this.tell(id, text);
  }

  /** A server line in one person's chat. */
  private tell(id: string, text: string) {
    this.send(id, { type: 'chat', id: null, name: '', text });
  }

  addBot(skill: BotSkill = this.skill): string {
    const id = `bot${this.nextBot++}`;
    const used = new Set([...this.bots.values()].map((b) => b.name));
    const free = BOT_NAMES.filter((n) => !used.has(n) && ![...this.connections.values()].some((c) => c.name === n));
    const name = free.length ? free[Math.floor(Math.random() * free.length)] : `Bot ${this.nextBot}`;
    this.bots.set(id, { bot: new Bot(skill), name });
    this.stats.set(id, { streak: 0, bestStreak: 0, airshots: 0 });
    this.addToSim(id);
    return id;
  }

  private removeBot(id: string) {
    this.bots.delete(id);
    this.stats.delete(id);
    this.inputs.delete(id);
    this.sim.removePlayer(id);
  }

  /**
   * Bots make up the numbers while anyone is here (playing or watching), and leave when the last
   * person does. They join the smaller team, and leave from the bigger one. They sit out races.
   */
  private fillBots() {
    const people = this.people;
    const want = this.connections.size === 0 || this.mode === 'race' ? 0 : Math.max(0, this.options.minPlayers - people);
    while (this.bots.size < want) this.addBot();
    while (this.bots.size > want) {
      // The one with the fewest kills leaves (from the bigger team), so the leaderboard barely changes.
      const count = [0, 0];
      for (const p of this.sim.players.values()) if (p.team >= 0) count[p.team]++;
      const bigger = count[0] === count[1] ? -1 : count[0] > count[1] ? 0 : 1;
      let worst: string | null = null;
      let worstKills = Infinity;
      for (const id of this.bots.keys()) {
        const p = this.sim.players.get(id);
        if (bigger >= 0 && p && p.team !== bigger) continue;
        const kills = p?.kills ?? 0;
        if (kills < worstKills) {
          worst = id;
          worstKills = kills;
        }
      }
      this.removeBot(worst ?? this.bots.keys().next().value!);
    }
    this.balanceTeams();
  }

  /** People leaving can leave one team two or more short: a bot changes sides (at its next respawn spot). */
  private balanceTeams() {
    if (!this.sim.teams) return;
    for (;;) {
      const count = [0, 0];
      for (const p of this.sim.players.values()) if (p.team >= 0) count[p.team]++;
      if (Math.abs(count[0] - count[1]) < 2) return;
      const bigger = count[0] > count[1] ? 0 : 1;
      const bot = [...this.bots.keys()].map((id) => this.sim.players.get(id)).find((p) => p?.team === bigger);
      if (!bot) return;
      bot.team = 1 - bigger;
      this.sim.respawn(bot);
    }
  }

  private newMatch(id: number): MatchState {
    const map = MAPS[this.mapName];
    return {
      id,
      mode: this.mode,
      phase: 'playing',
      timeLeft: timeLimit(this.mode, this.options.timeLimit),
      scoreLimit: scoreLimit(map, this.mode, this.options.fragLimit),
      teamScores: [0, 0],
      map: this.mapName,
      nextMap: this.entry(1).map,
      nextMode: this.entry(1).mode,
      winnerId: null,
      winnerTeam: -1,
    };
  }

  /** Starts the next match, on the next entry in the rotation if `advance`. */
  private startMatch(advance: boolean) {
    const oldMap = this.mapName;
    const oldMode = this.mode;
    if (advance) this.mapIndex = (this.mapIndex + 1) % this.rotation.length;
    this.match = this.newMatch(this.match.id + 1);
    for (const s of this.stats.values()) Object.assign(s, { streak: 0, bestStreak: 0, airshots: 0 });

    if (this.mapName !== oldMap) {
      const tick = this.sim.tick;
      this.sim.world.free();
      this.sim = new GameSim(MAPS[this.mapName], this.mode);
      this.sim.tick = tick; // ticks keep counting up, so clients never see time run backwards
      this.recentEvents = [];
      for (const [id, conn] of this.connections) if (!conn.spectator) this.sim.addPlayer(id);
      for (const id of this.bots.keys()) this.sim.addPlayer(id);
      this.assignTeams();
      this.sim.resetForMatch(); // respawn everyone now they have teams
    } else {
      this.sim.mode = this.mode;
      this.assignTeams();
      this.sim.resetForMatch(this.mode);
    }
    this.fillBots(); // races have none, other modes want them back
    if (this.mapName !== oldMap || this.mode !== oldMode) {
      for (const id of this.connections.keys()) this.send(id, this.welcome(id));
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
      if (conn.spectator) continue;
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
    this.adaptBots();
    if (this.sim.tick % NET.snapshotInterval === 0) this.broadcast();
  }

  /**
   * With botSkill 'auto', bots get better while the people here are winning and ease off while
   * they're losing: someone new still gets kills, and someone good still gets a fight.
   */
  private adaptBots() {
    if (this.options.botSkill !== 'auto' || this.match.phase !== 'playing') return;
    this.nextSkillCheck -= DT;
    if (this.nextSkillCheck > 0) return;
    this.nextSkillCheck = SKILL_CHECK;
    let kills = 0;
    let deaths = 0;
    for (const id of this.connections.keys()) {
      const p = this.sim.players.get(id);
      if (!p) continue;
      kills += p.kills;
      deaths += p.deaths;
    }
    if (kills + deaths < 4) return; // too early to tell
    const ratio = (kills + 1) / (deaths + 1);
    const level = SKILL_LADDER.indexOf(this.skill);
    const next = ratio < 0.6 ? Math.max(0, level - 1) : ratio > 1.6 ? Math.min(SKILL_LADDER.length - 1, level + 1) : level;
    if (next === level) return;
    this.skill = SKILL_LADDER[next];
    for (const b of this.bots.values()) b.bot.skill = this.skill;
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
      m.teamScores = [this.sim.teamScores[0], this.sim.teamScores[1]];
      const leader = this.leader();
      let over = m.timeLeft === 0;
      if (m.scoreLimit > 0) {
        if (this.sim.teams) over ||= Math.max(...m.teamScores) >= m.scoreLimit;
        else over ||= leader !== null && (this.sim.players.get(leader)?.kills ?? 0) >= m.scoreLimit;
      }
      if (over) {
        m.phase = 'intermission';
        m.timeLeft = this.options.intermission;
        m.winnerId = leader;
        const [red, blue] = m.teamScores;
        m.winnerTeam = !this.sim.teams || red === blue ? -1 : red > blue ? 0 : 1;
      }
    } else if (m.timeLeft === 0) {
      this.startMatch(true);
    }
  }

  /** The best player by what the mode scores (kills, captures, lap time), or null if nobody has scored yet. */
  private leader(): string | null {
    const scores = this.scores();
    const best = scores.sort(compareScores(this.mode))[0];
    if (!best) return null;
    if (this.mode === 'race') return best.bestLap > 0 ? best.id : null;
    if (this.mode === 'ctf') return best.captures > 0 || best.kills > 0 ? best.id : null;
    return best.kills > 0 ? best.id : null;
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

  private scores(): ScoreEntry[] {
    const scores: ScoreEntry[] = [];
    for (const p of this.sim.players.values()) {
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
        team: p.team,
        captures: p.captures,
        bestLap: Math.round(p.bestLap * 1000) / 1000,
      });
    }
    return scores;
  }

  private broadcast() {
    const sim = this.sim;
    const players: RemotePlayerState[] = [];
    for (const p of sim.players.values()) {
      const a = p.grapple?.anchor;
      players.push({
        id: p.id,
        pos: [r3(p.pos.x), r3(p.pos.y), r3(p.pos.z)],
        yaw: r3(p.yaw),
        pitch: r3(p.pitch),
        anchor: a ? [r3(a.x), r3(a.y), r3(a.z)] : null,
        alive: p.alive,
        protected: p.protectedFor > 0,
        grounded: p.grounded,
        primary: p.primary,
        vehicle: p.vehicle,
        seat: p.seat,
        team: p.team,
        overdrive: p.overdrive > 0,
        flag: p.flag,
      });
    }
    const scores = this.scores();
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
    const items = sim.items.map((b) => b.respawnIn);
    const flags: FlagState[] = sim.mode === 'ctf' ? sim.flags.map((f) => ({ pos: [r3(f.pos.x), r3(f.pos.y), r3(f.pos.z)], carrier: f.carrier, atHome: f.atHome })) : [];
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
        you: conn.spectator ? null : (sim.players.get(id)?.capture() ?? null),
        players: players.filter((p) => p.id !== id),
        projectiles,
        crates,
        vehicles,
        pickups,
        items,
        flags,
        scores,
        match,
        events: this.recentEvents.slice(), // a copy: whatever sends it may keep it (as a delta baseline)
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
