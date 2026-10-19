import type { ClientMessage, ServerMessage } from '../../shared/protocol';
import type { Transport } from './transport';

/** The real thing: JSON over a WebSocket to the server at /ws on the page's own host. */
export class WsTransport implements Transport {
  onMessage: (msg: ServerMessage) => void = () => {};
  onClose: (reason: string) => void = () => {};
  received = 0;
  private readonly ws: WebSocket;
  private closed = false;
  private outbox: string[] = [];

  constructor(url = WsTransport.defaultUrl()) {
    this.ws = new WebSocket(url);
    this.ws.onopen = () => {
      for (const data of this.outbox) this.ws.send(data);
      this.outbox = [];
    };
    this.ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      this.received += e.data.length;
      try {
        this.onMessage(JSON.parse(e.data));
      } catch (err) {
        console.error('Bad message from server', err);
      }
    };
    this.ws.onclose = (e) => {
      if (this.closed) return;
      this.closed = true;
      this.onClose(e.reason || (e.code === 1006 ? "Couldn't reach the server." : 'Disconnected from the server.'));
    };
  }

  static defaultUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  send(msg: ClientMessage) {
    const data = JSON.stringify(msg);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
    else if (this.ws.readyState === WebSocket.CONNECTING) this.outbox.push(data);
  }

  update() {}

  close() {
    this.closed = true;
    this.ws.close();
  }
}
