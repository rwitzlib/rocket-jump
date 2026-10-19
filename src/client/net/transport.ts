import type { ClientMessage, ServerMessage } from '../../shared/protocol';

/** Carries messages to and from a GameServer: a WebSocket, or the in-page loopback. */
export interface Transport {
  send(msg: ClientMessage): void;
  onMessage: (msg: ServerMessage) => void;
  /** The connection is gone for good, with a reason to show. */
  onClose: (reason: string) => void;
  /** Called every frame; the loopback runs its server and fake network here. */
  update(now: number): void;
  close(): void;
  /** Bytes received so far, for the debug overlay. */
  readonly received: number;
}
