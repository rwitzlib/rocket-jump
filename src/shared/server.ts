import { NET } from './config';
import { Bot } from './bot';
import type { MapDef } from './map';
import {
  toWireEvent,
  type ClientMessage,
  type CrateState,
  type InputFrame,
  type RemotePlayerState,
  type RocketState,
  type ServerMessage,
  type WireEvent,
} from './protocol';
import { GameSim } from './sim';
import { EMPTY_INPUT, type PlayerInput } from './types';

// The authoritative game server, independent of any transport. Whatever carries the bytes
// (an in-page loopback today, WebSockets in Node later) calls connect/receive/disconnect and tick,
// and delivers what comes out of `send`.

interface Connection {
  queue: InputFrame[]; // received but not yet simulated, sorted by seq
  lastProcessed: number;
  lastInput: PlayerInput;
  buffering: boolean;
  starved: number; // ticks where no input had arrived yet, so the last one was repeated
  dropped: number; // inputs thrown away because the queue grew too long
}

export class GameServer {
  readonly sim: GameSim;
  private readonly connections = new Map<string, Connection>();
  private readonly bots = new Map<string, Bot>();
  private readonly inputs = new Map<string, PlayerInput>();
  private recentEvents: WireEvent[] = [];

  constructor(
    map: MapDef,
    private readonly send: (clientId: string, msg: ServerMessage) => void,
  ) {
    this.sim = new GameSim(map);
  }

  connect(id: string) {
    this.sim.addPlayer(id);
    this.connections.set(id, {
      queue: [],
      lastProcessed: 0,
      lastInput: EMPTY_INPUT,
      buffering: true,
      starved: 0,
      dropped: 0,
    });
    this.send(id, { type: 'welcome', id, tick: this.sim.tick });
  }

  disconnect(id: string) {
    this.connections.delete(id);
    this.inputs.delete(id);
    this.sim.removePlayer(id);
  }

  addBot(id: string) {
    this.sim.addPlayer(id);
    this.bots.set(id, new Bot());
  }

  receive(id: string, msg: ClientMessage) {
    const conn = this.connections.get(id);
    if (!conn || msg.type !== 'input') return;
    // Packets can arrive late, twice, or out of order: keep each new seq once, in order.
    for (const frame of msg.frames) {
      if (frame.seq <= conn.lastProcessed) continue;
      const q = conn.queue;
      let i = q.length;
      while (i > 0 && q[i - 1].seq > frame.seq) i--;
      if (i > 0 && q[i - 1].seq === frame.seq) continue;
      q.splice(i, 0, frame);
    }
  }

  tick() {
    for (const [id, conn] of this.connections) {
      this.inputs.set(id, this.nextInput(conn));
      const p = this.sim.players.get(id);
      if (p) p.seq = conn.lastProcessed;
    }
    for (const [id, bot] of this.bots) {
      const p = this.sim.players.get(id);
      if (p) this.inputs.set(id, bot.think(p));
    }

    const events = this.sim.step(this.inputs);
    for (const e of events) this.recentEvents.push(toWireEvent(e, this.sim.tick));
    const oldest = this.sim.tick - NET.eventWindow;
    if (this.recentEvents.length && this.recentEvents[0].tick <= oldest) {
      this.recentEvents = this.recentEvents.filter((e) => e.tick > oldest);
    }

    if (this.sim.tick % NET.snapshotInterval === 0) this.broadcast();
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
    for (const p of sim.players.values()) {
      const a = p.grapple?.anchor;
      players.push({ id: p.id, pos: [p.pos.x, p.pos.y, p.pos.z], yaw: p.yaw, pitch: p.pitch, anchor: a ? [a.x, a.y, a.z] : null });
    }
    const rockets: RocketState[] = sim.rockets.map((r) => ({
      id: r.id,
      ownerId: r.ownerId,
      shot: r.shot,
      pos: [r.pos.x, r.pos.y, r.pos.z],
      dir: [r.dir.x, r.dir.y, r.dir.z],
      life: r.life,
    }));
    const crates: CrateState[] = sim.crates.map((c) => {
      const t = c.translation();
      const q = c.rotation();
      return [t.x, t.y, t.z, q.x, q.y, q.z, q.w];
    });

    for (const [id, conn] of this.connections) {
      this.send(id, {
        type: 'snapshot',
        tick: sim.tick,
        ack: conn.lastProcessed,
        you: sim.players.get(id)?.capture() ?? null,
        players: players.filter((p) => p.id !== id),
        rockets,
        crates,
        events: this.recentEvents,
        input: { queued: conn.queue.length, starved: conn.starved, dropped: conn.dropped },
      });
    }
  }
}
