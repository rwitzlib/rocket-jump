import type { Loopback } from './loopback';
import type { NetClient } from './netclient';

// Netcode debug panel for loopback mode (toggle with N). The keys change the fake network live,
// so you can feel how the game holds up at different pings.

const LOSS_STEPS = [0, 0.01, 0.05, 0.1];

export class NetOverlay {
  private readonly el: HTMLDivElement;
  private visible = true;
  private lastUpdate = 0;
  private lastBytes = { up: 0, down: 0, packets: 0 };

  constructor(
    private readonly loopback: Loopback,
    private readonly client: NetClient,
  ) {
    this.el = document.createElement('div');
    this.el.id = 'net';
    document.body.append(this.el);

    const c = loopback.conditions;
    document.addEventListener('keydown', (e) => {
      switch (e.code) {
        case 'KeyN':
          this.visible = !this.visible;
          this.el.hidden = !this.visible;
          break;
        case 'BracketLeft':
          c.ping = Math.max(0, c.ping - 20);
          break;
        case 'BracketRight':
          c.ping += 20;
          break;
        case 'Semicolon':
          c.jitter = Math.max(0, c.jitter - 5);
          break;
        case 'Quote':
          c.jitter += 5;
          break;
        case 'KeyL':
          c.loss = LOSS_STEPS[(LOSS_STEPS.indexOf(c.loss) + 1) % LOSS_STEPS.length] ?? 0;
          break;
      }
    });
  }

  update(now: number) {
    if (!this.visible || now - this.lastUpdate < 500) return;
    const seconds = (now - this.lastUpdate) / 1000;
    this.lastUpdate = now;

    const { up, down, conditions: c } = this.loopback;
    const s = this.client.stats;
    const upRate = (up.bytes - this.lastBytes.up) / seconds / 1000;
    const downRate = (down.bytes - this.lastBytes.down) / seconds / 1000;
    const snapRate = (down.packets - this.lastBytes.packets) / seconds;
    this.lastBytes = { up: up.bytes, down: down.bytes, packets: down.packets };

    this.el.textContent = [
      `LOOPBACK  ping ${c.ping}ms  jitter ${c.jitter}ms  loss ${Math.round(c.loss * 100)}%`,
      `  [ ] ping   ; ' jitter   L loss   N hide`,
      `server tick ${s.serverTick}  snapshots ${snapRate.toFixed(0)}/s  down ${downRate.toFixed(1)} kB/s  up ${upRate.toFixed(1)} kB/s`,
      `prediction  ${s.pending} unacked  last error ${(s.lastError * 100).toFixed(1)}cm  corrections ${s.corrections}`,
      `server input  queued ${s.serverInput.queued}  starved ${s.serverInput.starved}  dropped ${s.serverInput.dropped}`,
      `interpolation  delay ${s.renderDelayMs.toFixed(0)}ms  underruns ${s.underruns}  out of order ${s.outOfOrder}`,
    ].join('\n');
  }
}
