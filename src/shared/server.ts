import { DT, DUEL, ELIM, MATCH, NET, PROTOCOL_VERSION, TEAMS, type GameMode } from './config';
import { Bot, type BotSkill } from './bot';
import { CUSTOM_PREFIX } from './custommap';
import { MAPS } from './map';
import { AimWatch } from './anticheat';
import { isOffensive, maskChat, VOTE_KICK, votePasses } from './moderation';
import { DEFAULT_LOOK, encodeLook, type StatEvent } from './progress';
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
  token: string; // secret, from the welcome: lets a dropped connection take this player back
  away: number; // seconds left to reconnect after the connection dropped; 0 while connected
  lastVote: number; // ms timestamp of the last vote this person called
  profile: string | null; // secret profile key: their stats are kept (online)
  look: string; // what they wear: "tint/trail"
  level: number; // their profile's level, for the scoreboard
  lapPath: number[]; // race: where they've been this lap (cm, every few ticks), for a record ghost
  lastLap: number; // their lap clock last tick
  aim: AimWatch; // looking for aimbot-like snaps onto targets
}

/** A vote to kick someone, while it's open. */
interface KickVote {
  target: string;
  name: string;
  yes: Set<string>;
  no: Set<string>;
  endsAt: number; // ms timestamp
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
  /**
   * Seconds a player whose connection drops is kept in the game (standing still), so they can come
   * back with their score and place. 0: gone at once.
   */
  reconnectGrace: number;
}

const BOT_NAMES = ['Rocko', 'Splash', 'Boomer', 'Hookshot', 'Gibs', 'Strafe', 'Kaboom', 'Ricochet', 'Nitro', 'Zipline', 'Frag', 'Dropkick', 'Skyhook', 'Blastoff'];
const PING_INTERVAL = 2000; // ms
const SKILL_CHECK = 20; // seconds between bot skill adjustments
const SKILL_LADDER: BotSkill[] = ['easy', 'normal', 'hard'];
const CHAT_INTERVAL = 600; // ms a player must wait between chat lines

const now = () => performance.now();
/** Race paths are kept a sample every this many ticks. */
export const LAP_SAMPLE = 3;

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
  private vote: KickVote | null = null;
  /** Elimination: seconds until the next round starts, 0 while one is being fought. */
  private betweenRounds = 0;
  /** Someone was voted out: the transport closes their connection (and can keep them out a while). */
  onKick: (id: string) => void = () => {};
  /** Someone's aim looks inhuman (see anticheat.ts): for the server's log, and a person to look at. */
  onSuspect: (id: string, name: string, detail: { hits: number; snaps: number }) => void = () => {};
  /** A match finished (for the server's numbers). */
  onMatchOver: (mode: GameMode, map: string, people: number) => void = () => {};
  /** Someone died here, for the death heatmaps. */
  onDeath: (map: string, x: number, z: number, cause: string) => void = () => {};
  /** Something that counts toward a player's profile happened (only for people who sent a profile key). */
  onStat: (id: string, profile: string, name: string, e: StatEvent) => void = () => {};

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
      reconnectGrace: 0,
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

  /** How many people may play at once: two in a duel, the server's limit otherwise. */
  private get cap(): number {
    return this.mode === 'duel' ? Math.min(DUEL.players, this.options.maxPlayers) : this.options.maxPlayers;
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
      maxPlayers: this.cap,
      rotation: this.options.maps,
      match: { ...this.match, timeLeft: Math.round(this.match.timeLeft) },
    };
  }

  /** The connection is gone. A player is held for a while to reconnect, if the server allows it. */
  disconnect(id: string) {
    const conn = this.connections.get(id);
    if (!conn) return;
    if (this.options.reconnectGrace > 0 && !conn.spectator && conn.away === 0) {
      conn.away = this.options.reconnectGrace;
      conn.queue = [];
      conn.buffering = true;
      conn.lastInput = freeze(conn.lastInput); // stand still until they're back
      this.notice(`${conn.name} lost connection`);
      return;
    }
    this.remove(id);
  }

  /**
   * The player this token belongs to, if they're still here: dropped and held for them, or not yet
   * noticed to be gone (a dead link the server hasn't timed out). The transport carries on the new
   * connection under that id. Null if there's none (it timed out, or the server restarted).
   */
  resume(token: string): string | null {
    for (const [id, c] of this.connections) if (c.token === token) return id;
    return null;
  }

  /** Gone for good: out of the game, and out of any vote. */
  private remove(id: string) {
    const conn = this.connections.get(id);
    if (!conn) return;
    if (this.vote?.target === id) this.vote = null;
    this.vote?.yes.delete(id);
    this.vote?.no.delete(id);
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
      const conn = this.connections.get(id);
      if (conn && msg.profile) conn.profile = msg.profile;
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
        if (msg.text.startsWith('/')) {
          this.command(id, conn, msg.text.slice(1));
          break;
        }
        const text = maskChat(msg.text);
        for (const other of this.connections.keys()) this.send(other, { type: 'chat', id, name: conn.name, text });
        break;
      }
      case 'spectate':
        this.setSpectating(id, conn, msg.on);
        break;
    }
  }

  private join(id: string, rawName: string, version: number, spectate: boolean) {
    const held = this.connections.get(id);
    if (held) {
      // Back after a dropped connection (the transport matched their token), or a resent join.
      if (held.away > 0) this.notice(`${held.name} is back`);
      held.away = 0;
      held.queue = [];
      held.buffering = true;
      this.send(id, this.welcome(id));
      this.send(id, { type: 'ping', t: now() });
      return;
    }
    if (version !== PROTOCOL_VERSION) {
      this.send(id, { type: 'rejected', reason: 'The game has been updated. Reload the page to get the new version.' });
      return;
    }
    const full = this.people >= this.cap;
    const watchers = this.connections.size - this.people;
    if ((full || spectate) && watchers >= this.options.maxSpectators) {
      this.send(id, { type: 'rejected', reason: `The server is full (${this.cap} players). Try again in a bit.` });
      return;
    }
    // Someone arriving at an empty server gets a fresh match rather than the tail of an old one.
    if (this.connections.size === 0) {
      this.startMatch(false);
      if (this.options.botSkill === 'auto') this.skill = 'easy';
    }

    const name = this.uniqueName(rawName && !isOffensive(rawName) ? rawName : `Player ${Math.floor(Math.random() * 900 + 100)}`);
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
      token: randomToken(),
      away: 0,
      lastVote: -Infinity,
      profile: null,
      look: encodeLook(DEFAULT_LOOK),
      level: 0,
      lapPath: [],
      lastLap: -1,
      aim: new AimWatch(),
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
    if (!on && this.people >= this.cap) {
      conn.waiting = true;
      this.tell(id, this.mode === 'duel' ? "It's a duel: you're next in line to play the winner." : `The server is full (${this.cap} players). You'll be let in when a place comes free.`);
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
    if (this.people >= this.cap) return;
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
    const p = this.sim.addPlayer(id, this.sim.teams ? this.smallerTeam() : -1);
    // Elimination: arriving once a round is under way, you sit it out.
    if (this.mode === 'elim' && this.match?.phase === 'playing' && this.betweenRounds === 0 && this.match.roundLeft < ELIM.roundTime - 5) this.sim.bench(p);
    return p;
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
    const conn = this.connections.get(id);
    const spectator = conn?.spectator ?? false;
    const custom = this.mapName.startsWith(CUSTOM_PREFIX) ? { custom: MAPS[this.mapName] } : {};
    return { type: 'welcome', id, tick: this.sim.tick, map: this.mapName, mode: this.mode, spectator, match: { ...this.match }, token: conn?.token, ...custom };
  }

  // --- chat commands and vote kicks -------------------------------------------------------------

  /** A chat line starting with a slash. */
  private command(id: string, conn: Connection, line: string) {
    const [word, ...rest] = line.trim().split(' ');
    const arg = rest.join(' ').trim();
    switch (word.toLowerCase()) {
      case 'votekick':
      case 'kick':
        this.callVote(id, conn, arg);
        break;
      case 'yes':
      case 'no': {
        const vote = this.vote;
        if (!vote) return this.tell(id, 'There is no vote on.');
        if (vote.target === id) return this.tell(id, "You don't get a say in your own kick.");
        const yes = word.toLowerCase() === 'yes';
        (yes ? vote.yes : vote.no).add(id);
        (yes ? vote.no : vote.yes).delete(id);
        this.tell(id, `You voted ${yes ? 'yes' : 'no'}.`);
        this.checkVote();
        break;
      }
      case 'help':
        this.tell(id, "/votekick name: vote someone out of the game · /yes, /no: vote · /mute name, /unmute name: hide or show someone's chat (only for you)");
        break;
      default:
        this.tell(id, `There's no /${word} command. /help lists them.`);
    }
  }

  /** People who'd have a say in kicking `target`: everyone connected but them. */
  private voters(target: string): string[] {
    return [...this.connections].filter(([id, c]) => id !== target && c.away === 0).map(([id]) => id);
  }

  /** Someone by name: exactly, or the only one whose name starts that way. */
  private findByName(name: string): string | null {
    const want = name.toLowerCase();
    if (!want) return null;
    const people = [...this.connections].filter(([, c]) => c.away === 0);
    const exact = people.find(([, c]) => c.name.toLowerCase() === want);
    if (exact) return exact[0];
    const starts = people.filter(([, c]) => c.name.toLowerCase().startsWith(want));
    return starts.length === 1 ? starts[0][0] : null;
  }

  private callVote(id: string, conn: Connection, name: string) {
    const t = now();
    if (this.vote) return this.tell(id, `There's already a vote on to kick ${this.vote.name}: /yes or /no.`);
    if (t - conn.lastVote < VOTE_KICK.cooldown * 1000) return this.tell(id, 'You called a vote a moment ago. Give it a minute.');
    const target = this.findByName(name);
    if (!target) return this.tell(id, name ? `Nobody (or more than one person) here is called "${name}". Bots can't be kicked.` : 'Who? /votekick and their name.');
    if (target === id) return this.tell(id, "You can't vote yourself out. Leave from the Esc menu.");
    if (this.voters(target).length < VOTE_KICK.minVoters) return this.tell(id, 'There are too few people here for a vote.');
    conn.lastVote = t;
    const targetName = this.connections.get(target)!.name;
    this.vote = { target, name: targetName, yes: new Set([id]), no: new Set(), endsAt: t + VOTE_KICK.duration * 1000 };
    this.notice(`${conn.name} wants ${targetName} kicked. Type /yes or /no in chat (${VOTE_KICK.duration} s).`);
    this.checkVote();
  }

  /** Passes the vote once a majority says yes; fails it once that can't happen or time runs out. */
  private checkVote() {
    const vote = this.vote;
    if (!vote) return;
    const voters = this.voters(vote.target);
    const yes = voters.filter((v) => vote.yes.has(v)).length;
    const no = voters.filter((v) => vote.no.has(v)).length;
    if (votePasses(yes, voters.length)) {
      this.vote = null;
      this.kick(vote.target);
    } else if (!votePasses(voters.length - no, voters.length) || now() > vote.endsAt) {
      this.vote = null;
      this.notice(`The vote to kick ${vote.name} failed (${yes} yes, ${no} no).`);
    }
  }

  private kick(id: string) {
    const conn = this.connections.get(id);
    if (!conn) return;
    this.send(id, { type: 'rejected', reason: 'You were voted out of that game. You can go back in a few minutes, or play somewhere else.' });
    this.onKick(id);
    this.remove(id);
    this.notice(`${conn.name} was kicked by vote.`);
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

  /** What a player wears and their level (the transport looks these up from their profile). */
  setLook(id: string, look: string, level: number) {
    const conn = this.connections.get(id);
    if (!conn) return;
    conn.look = look;
    conn.level = level;
  }

  /** Reports a profile event for a person, if they have a profile. */
  private stat(id: string, e: StatEvent) {
    const conn = this.connections.get(id);
    if (conn?.profile) this.onStat(id, conn.profile, conn.name, e);
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
    // A duel wants just one opponent.
    const fill = this.mode === 'duel' ? Math.min(this.options.minPlayers, DUEL.players) : this.options.minPlayers;
    const want = this.connections.size === 0 || this.mode === 'race' ? 0 : Math.max(0, fill - people);
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
      hill: this.mode === 'koth' ? 0 : -1,
      round: this.mode === 'elim' ? 1 : 0,
      roundLeft: this.mode === 'elim' ? ELIM.roundTime : 0,
    };
  }

  /** Starts the next match, on the next entry in the rotation if `advance`. */
  private startMatch(advance: boolean) {
    const oldMap = this.mapName;
    const oldMode = this.mode;
    // A duel's loser steps out for the next challenger: who that is, before the scores reset.
    const ranked = this.scores().sort(compareScores(this.mode));
    const loser = ranked.filter((s) => !s.bot).at(-1)?.id ?? null;
    this.betweenRounds = 0;
    if (advance) this.mapIndex = (this.mapIndex + 1) % this.rotation.length;
    this.match = this.newMatch(this.match.id + 1);
    for (const s of this.stats.values()) Object.assign(s, { streak: 0, bestStreak: 0, airshots: 0 });
    for (const c of this.connections.values()) c.aim.reset();

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
    if (this.mode === 'duel') this.nextChallenger(advance && oldMode === 'duel' ? loser : null);
  }

  /**
   * Duel: two play, the rest wait their turn. After a duel the loser goes to the back of the line
   * and whoever has waited longest steps in. Anyone over two (the rotation just came to a duel)
   * waits too.
   */
  private nextChallenger(loser: string | null) {
    const waiting = [...this.connections.values()].some((c) => c.waiting);
    const out: string[] = [];
    if (loser && waiting) out.push(loser);
    const playing = [...this.connections].filter(([, c]) => !c.spectator).map(([id]) => id);
    while (playing.length - out.length > this.cap) out.push(playing.filter((id) => !out.includes(id)).at(-1)!);
    for (const id of out) {
      const conn = this.connections.get(id)!;
      this.setSpectating(id, conn, true);
      conn.waiting = true;
      // To the back of the line.
      this.connections.delete(id);
      this.connections.set(id, conn);
      this.tell(id, id === loser ? 'You lost the duel. You go back in line; the next challenger is up.' : "It's a duel: you're in line to play the winner.");
    }
    while (this.people < this.cap && [...this.connections.values()].some((c) => c.waiting)) this.admitWaiting();
  }

  /**
   * Elimination: a round ends when one team has nobody left standing (or the round runs out of time:
   * the team with more people up takes it). A few seconds later, everyone's back for the next.
   */
  private stepRound() {
    const m = this.match;
    if (this.betweenRounds > 0) {
      this.betweenRounds = Math.max(0, this.betweenRounds - DT);
      m.roundLeft = -this.betweenRounds;
      if (this.betweenRounds === 0) {
        m.round++;
        m.roundLeft = ELIM.roundTime;
        this.sim.newRound();
      }
      return;
    }
    const members = [0, 0];
    const alive = [0, 0];
    for (const p of this.sim.players.values()) {
      if (p.team < 0) continue;
      members[p.team]++;
      if (p.alive) alive[p.team]++;
    }
    if (!members[0] || !members[1]) return; // nobody to fight: the round waits
    m.roundLeft = Math.max(0, m.roundLeft - DT);
    let winner: number | null = null;
    if (!alive[0] || !alive[1]) winner = alive[0] ? 0 : alive[1] ? 1 : -1;
    else if (m.roundLeft === 0) winner = alive[0] === alive[1] ? -1 : alive[0] > alive[1] ? 0 : 1;
    if (winner === null) return;
    if (winner >= 0) this.sim.teamScores[winner]++;
    this.notice(winner < 0 ? `Round ${m.round} is a draw.` : `${TEAMS[winner].name} takes round ${m.round}!`);
    this.betweenRounds = ELIM.between;
    m.roundLeft = -this.betweenRounds;
  }

  tick() {
    const t = now();
    if (t - this.lastPing > PING_INTERVAL) {
      this.lastPing = t;
      for (const id of this.connections.keys()) this.send(id, { type: 'ping', t });
    }
    // Dropped players get a while to come back, then they're gone.
    for (const [id, conn] of this.connections) {
      if (conn.away > 0 && (conn.away -= DT) <= 0) this.remove(id);
    }
    if (this.vote && now() > this.vote.endsAt) this.checkVote();
    // Nobody here: nothing to simulate.
    if (this.connections.size === 0) return;

    const frozen = this.match.phase === 'intermission';
    for (const [id, conn] of this.connections) {
      if (conn.spectator) continue;
      const input = this.nextInput(conn);
      // Between matches everyone can look around, but not move or shoot. Clients do the same, so prediction agrees.
      this.inputs.set(id, frozen ? freeze(input) : input);
      conn.aim.look(input.yaw, input.pitch);
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
    if (this.mode === 'race') this.recordLaps();
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

  /** Kill streaks and airshots, for the scoreboard and the end-of-match awards; and profile stats. */
  private track(e: SimEvent) {
    if (this.match.phase !== 'playing') return;
    if (e.type === 'flag' && e.action === 'captured' && e.playerId) this.stat(e.playerId, { type: 'capture' });
    if (e.type === 'lap') {
      const conn = this.connections.get(e.playerId);
      // The lap's path, if we saw all of it: the ghost a record lap leaves for everyone to chase.
      const path = conn && conn.lapPath.length >= (e.time / DT / LAP_SAMPLE) * 3 * 0.9 ? conn.lapPath : [];
      this.stat(e.playerId, { type: 'lap', map: this.mapName, time: Math.round(e.time * 1000) / 1000, best: e.best, path });
      if (conn) conn.lapPath = [];
    }
    if (e.type === 'damaged' && e.sourceId !== e.playerId && e.amount >= 20) {
      const shooter = this.connections.get(e.sourceId);
      if (shooter?.aim.hit()) this.onSuspect(e.sourceId, shooter.name, { hits: shooter.aim.hits, snaps: shooter.aim.snaps });
    }
    if (e.type !== 'killed') return;
    const where = this.sim.players.get(e.playerId)?.pos;
    if (where) this.onDeath(this.mapName, where.x, where.z, e.cause);
    const victim = this.stats.get(e.playerId);
    if (victim) victim.streak = 0;
    this.stat(e.playerId, { type: 'death' });
    const killer = e.killerId ? this.stats.get(e.killerId) : undefined;
    if (!killer || e.killerId === e.playerId) return;
    killer.streak++;
    killer.bestStreak = Math.max(killer.bestStreak, killer.streak);
    if (e.midair) killer.airshots++;
    this.stat(e.killerId!, { type: 'kill', airshot: e.midair, cause: e.cause, streak: killer.streak });
  }

  /** Race: everyone's path through their lap under way, a sample every few ticks. */
  private recordLaps() {
    for (const [id, conn] of this.connections) {
      const p = this.sim.players.get(id);
      if (!p || !conn.profile) continue;
      if (p.lapTime < 0 || p.lapTime < conn.lastLap) conn.lapPath = [];
      conn.lastLap = p.lapTime;
      if (p.lapTime >= 0 && Math.round(p.lapTime / DT) % LAP_SAMPLE === 0 && conn.lapPath.length < 3 * 60 * 60 * 5) {
        conn.lapPath.push(Math.round(p.pos.x * 100), Math.round(p.pos.y * 100), Math.round(p.pos.z * 100));
      }
    }
  }

  /** The match is over: everyone who played it gets it on their record. */
  private matchOver() {
    const scores = this.scores().sort(compareScores(this.mode));
    const people = scores.filter((s) => !s.bot).length;
    this.onMatchOver(this.mode, this.mapName, people);
    scores.forEach((s, i) => {
      const conn = this.connections.get(s.id);
      if (!conn?.profile || conn.spectator || this.mode === 'race') return;
      const won = this.sim.teams ? s.team >= 0 && s.team === this.match.winnerTeam : this.match.winnerId === s.id;
      this.stat(s.id, { type: 'match', mode: this.mode, won, place: i + 1, players: Math.max(people, scores.length) });
    });
  }

  private updateMatch() {
    const m = this.match;
    m.timeLeft = Math.max(0, m.timeLeft - DT);
    if (m.phase === 'playing') {
      if (this.mode === 'elim') this.stepRound();
      if (this.mode === 'koth') m.hill = this.sim.rules.hillIndex;
      m.teamScores = [this.sim.teamScores[0], this.sim.teamScores[1]];
      const leader = this.leader();
      let over = m.timeLeft === 0;
      if (m.scoreLimit > 0) {
        const top = leader ? this.sim.players.get(leader) : undefined;
        if (this.sim.teams) over ||= Math.max(...m.teamScores) >= m.scoreLimit;
        else if (this.mode === 'koth') over ||= (top?.points ?? 0) >= m.scoreLimit;
        else over ||= (top?.kills ?? 0) >= m.scoreLimit;
      }
      if (over) {
        m.phase = 'intermission';
        m.timeLeft = this.options.intermission;
        m.winnerId = leader;
        const [red, blue] = m.teamScores;
        m.winnerTeam = !this.sim.teams || red === blue ? -1 : red > blue ? 0 : 1;
        this.matchOver();
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
    if (this.mode === 'koth') return best.points > 0 || best.kills > 0 ? best.id : null;
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
        look: conn?.look ?? encodeLook(DEFAULT_LOOK),
        points: Math.floor(p.points),
        level: conn?.level ?? 0,
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

/** A hard-to-guess token for reconnecting. */
function randomToken(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Look only: what everyone's input becomes between matches. */
export function freeze(input: PlayerInput): PlayerInput {
  return { ...EMPTY_INPUT, yaw: input.yaw, pitch: input.pitch, view: input.view };
}
