import { DT } from '../../shared/config';
import type { ClientMessage, ServerMessage } from '../../shared/protocol';
import { GameServer, type ServerOptions } from '../../shared/server';
import type { Transport } from './transport';

// Runs the real GameServer inside the page, with a fake network in between that adds latency,
// jitter and packet loss. Messages are JSON-encoded on the way through, exactly like a real
// transport would, so anything that isn't plain data breaks here first. It's also how practice
// games against bots run: the same server, with a perfect network.

export interface NetConditions {
  ping: number; // round trip, ms
  jitter: number; // extra random one-way delay, 0..jitter ms
  loss: number; // chance each packet is dropped, 0..1
}

/** One direction of the fake network: unreliable, unordered datagrams (what UDP/WebRTC would give us). */
class Link {
  bytes = 0;
  packets = 0;
  private queue: { at: number; data: string }[] = [];

  constructor(private readonly conditions: NetConditions) {}

  send(data: string) {
    const { ping, jitter, loss } = this.conditions;
    if (Math.random() < loss) return;
    const at = performance.now() + ping / 2 + Math.random() * jitter;
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].at > at) i--;
    this.queue.splice(i, 0, { at, data });
  }

  deliver(now: number, handler: (data: string) => void) {
    while (this.queue.length && this.queue[0].at <= now) {
      const { data } = this.queue.shift()!;
      this.bytes += data.length;
      this.packets++;
      handler(data);
    }
  }
}

export class Loopback implements Transport {
  readonly server: GameServer;
  readonly up: Link;
  readonly down: Link;
  onMessage: (msg: ServerMessage) => void = () => {};
  onClose: (reason: string) => void = () => {};
  private accumulator = 0;
  private last = performance.now();

  constructor(
    readonly conditions: NetConditions,
    readonly clientId: string,
    options: Partial<ServerOptions>,
  ) {
    this.up = new Link(conditions);
    this.down = new Link(conditions);
    this.server = new GameServer((_, msg) => this.down.send(JSON.stringify(msg)), options);
  }

  get received() {
    return this.down.bytes;
  }

  close() {
    this.server.disconnect(this.clientId);
    this.server.sim.world.free();
  }

  send(msg: ClientMessage) {
    this.up.send(JSON.stringify(msg));
  }

  /** Call every frame: delivers due packets and runs the server's own 60 Hz clock. */
  update(now: number) {
    this.up.deliver(now, (data) => this.server.receive(this.clientId, JSON.parse(data)));

    this.accumulator += Math.min(Math.max((now - this.last) / 1000, 0), 0.25);
    this.last = now;
    while (this.accumulator >= DT) {
      this.server.tick();
      this.accumulator -= DT;
    }

    this.down.deliver(now, (data) => this.onMessage(JSON.parse(data)));
  }
}
