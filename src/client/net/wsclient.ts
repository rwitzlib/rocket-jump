import type { ClientMessage, ServerMessage } from '../../shared/protocol';
import { encodeClientMessage, WireDecoder, type Bytes } from '../../shared/wire';
import type { Transport } from './transport';

/** The real thing: a WebSocket to the server at /ws on the page's own host (binary snapshots and inputs, JSON for the rest). */
export class WsTransport implements Transport {
  onMessage: (msg: ServerMessage) => void = () => {};
  onClose: (reason: string) => void = () => {};
  received = 0;
  /** The WebSocket close code, once closed: 1006 for a dropped link, 4xxx for the server turning us away. */
  closeCode = 0;
  private readonly ws: WebSocket;
  private readonly decoder = new WireDecoder();
  private closed = false;
  private outbox: (string | Bytes)[] = [];

  constructor(url = WsTransport.defaultUrl()) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      for (const data of this.outbox) this.ws.send(data);
      this.outbox = [];
    };
    this.ws.onmessage = (e) => {
      const data = typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer);
      this.received += data.length;
      let msg: ServerMessage;
      try {
        msg = this.decoder.decode(data);
      } catch (err) {
        // A snapshot whose baseline we no longer have: the next one will do.
        console.warn('Unreadable message from server', err);
        return;
      }
      this.onMessage(msg);
    };
    this.ws.onclose = (e) => {
      if (this.closed) return;
      this.closed = true;
      this.closeCode = e.code;
      this.onClose(e.reason || (e.code === 1006 ? "Couldn't reach the server." : 'Disconnected from the server.'));
    };
  }

  static defaultUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  send(msg: ClientMessage) {
    const data = encodeClientMessage(msg);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
    else if (this.ws.readyState === WebSocket.CONNECTING) this.outbox.push(data);
  }

  update() {}

  close() {
    this.closed = true;
    this.ws.close();
  }
}
