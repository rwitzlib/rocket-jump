import type { ClientMessage, JoinMessage, ServerMessage } from '../../shared/protocol';
import type { Transport } from './transport';
import { WsTransport } from './wsclient';

// A WebSocket that survives a dropped connection. When the link goes (Wi-Fi blinks, a phone
// changes network, the server restarts for a deploy), it keeps trying for a while, and each new
// connection rejoins with the token from the last welcome so the server hands back the same
// player, score and all. A server that no longer knows the token (it restarted) lets us in fresh.
// The game above never sees the gap, apart from `onReconnecting`.

const GIVE_UP_AFTER = 30000; // ms of trying before it's a real disconnect
const RETRY_DELAYS = [250, 1000, 2000, 3000]; // ms between attempts, the last repeating

/** Close codes the server uses to turn someone away on purpose: no point coming back. */
const FINAL_CODES = new Set([4403, 4404]);

export class ReconnectingTransport implements Transport {
  onMessage: (msg: ServerMessage) => void = () => {};
  onClose: (reason: string) => void = () => {};
  /** Called with true when the link drops and we start trying again, false once we're back. */
  onReconnecting: (on: boolean) => void = () => {};
  private inner!: WsTransport;
  private token: string | null = null;
  private closed = false;
  private reconnecting = false;
  private attempts = 0;
  private since = 0;
  private timer = 0;
  private receivedBefore = 0;

  constructor(
    private readonly url: string,
    /** The join to send on reconnecting (fresh, as the player's name may have changed meanwhile). */
    private readonly join: () => JoinMessage,
  ) {
    this.connect();
  }

  get received(): number {
    return this.receivedBefore + this.inner.received;
  }

  private connect() {
    if (this.inner) this.receivedBefore += this.inner.received;
    const ws = new WsTransport(this.url);
    this.inner = ws;
    ws.onMessage = (msg) => {
      if (msg.type === 'welcome') {
        if (msg.token) this.token = msg.token;
        if (this.reconnecting) {
          this.reconnecting = false;
          this.attempts = 0;
          this.onReconnecting(false);
        }
      }
      this.onMessage(msg);
    };
    ws.onClose = (reason) => {
      if (ws !== this.inner || this.closed) return;
      // Never got in, turned away, or nothing to resume: that's the end of it.
      if ((!this.token && !this.reconnecting) || FINAL_CODES.has(ws.closeCode)) {
        this.closed = true;
        this.onClose(reason);
        return;
      }
      if (!this.reconnecting) {
        this.reconnecting = true;
        this.since = performance.now();
        this.onReconnecting(true);
      }
      if (performance.now() - this.since > GIVE_UP_AFTER) {
        this.closed = true;
        this.onClose("Lost the connection to the server, and couldn't get it back.");
        return;
      }
      const delay = RETRY_DELAYS[Math.min(this.attempts++, RETRY_DELAYS.length - 1)];
      this.timer = window.setTimeout(() => {
        if (this.closed) return;
        this.connect();
        this.inner.send({ ...this.join(), ...(this.token ? { resume: this.token } : {}) });
      }, delay);
    };
  }

  send(msg: ClientMessage) {
    // While the link is down, inputs and the rest would only pile up stale: drop them.
    if (!this.reconnecting) this.inner.send(msg);
  }

  update() {}

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.inner.close();
  }
}
