import { isTyping } from './input';

// Frame-time overlay (toggle with P) plus console logging of long frames, for tracking down hitches.
// Frame times come from rAF timestamps, so they include GPU/compositor stalls, not just our JS.

const HISTORY = 240; // frames shown in the graph
const HITCH_MS = 34; // anything slower than ~2 frames at 60 Hz counts as a hitch
const GRAPH_MAX_MS = 50;

interface LoafScript {
  invoker?: string;
  sourceURL?: string;
  sourceFunctionName?: string;
  duration: number;
}

interface LoafEntry extends PerformanceEntry {
  blockingDuration: number;
  scripts: LoafScript[];
}

export class PerfOverlay {
  private readonly el: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly label: HTMLDivElement;
  private readonly gpu: HTMLDivElement;
  private readonly times = new Float32Array(HISTORY);
  private head = 0;
  private hitches = 0;
  private visible = false;
  private lastLabel = 0;

  constructor(gpuName: string) {
    console.info(`[perf] rendering on: ${gpuName}`);
    this.el = document.createElement('div');
    this.el.id = 'perf';
    this.gpu = document.createElement('div');
    this.gpu.textContent = `GPU: ${gpuName}`;
    this.label = document.createElement('div');
    this.canvas = document.createElement('canvas');
    this.canvas.width = HISTORY;
    this.canvas.height = 60;
    this.el.append(this.gpu, this.label, this.canvas);
    this.el.hidden = true;
    document.body.append(this.el);

    document.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyP' || isTyping(e.target)) return;
      this.visible = !this.visible;
      this.el.hidden = !this.visible;
    });

    // Long Animation Frames API (Chromium): tells us *what* ran during a slow frame.
    if (PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as LoafEntry[]) {
          if (entry.duration < 60) continue;
          const scripts = entry.scripts
            .filter((s) => s.duration > 5)
            .map((s) => `${s.sourceFunctionName || s.invoker || '?'} (${Math.round(s.duration)}ms) ${s.sourceURL ?? ''}`);
          console.warn(
            `[perf] long frame ${Math.round(entry.duration)}ms, blocking ${Math.round(entry.blockingDuration)}ms`,
            scripts.length ? scripts : '(no script attribution: likely GC, GPU, or browser work)',
          );
        }
      }).observe({ type: 'long-animation-frame', buffered: false });
    }
  }

  /** Call once per rendered frame with the raw (unclamped) frame time in ms. */
  frame(ms: number, now: number) {
    this.times[this.head] = ms;
    this.head = (this.head + 1) % HISTORY;
    if (ms > HITCH_MS) this.hitches++;
    if (!this.visible) return;

    if (now - this.lastLabel > 250) {
      this.lastLabel = now;
      let sum = 0;
      let worst = 0;
      for (const t of this.times) {
        sum += t;
        worst = Math.max(worst, t);
      }
      const avg = sum / HISTORY;
      this.label.textContent =
        `${(1000 / avg).toFixed(0)} fps · avg ${avg.toFixed(1)}ms · worst ${worst.toFixed(0)}ms · hitches ${this.hitches}`;
    }

    const ctx = this.canvas.getContext('2d')!;
    const { width, height } = this.canvas;
    ctx.clearRect(0, 0, width, height);
    const yFor = (msValue: number) => height - (Math.min(msValue, GRAPH_MAX_MS) / GRAPH_MAX_MS) * height;
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    for (const ref of [16.7, 33.3]) {
      ctx.beginPath();
      ctx.moveTo(0, yFor(ref));
      ctx.lineTo(width, yFor(ref));
      ctx.stroke();
    }
    for (let i = 0; i < HISTORY; i++) {
      const t = this.times[(this.head + i) % HISTORY];
      ctx.fillStyle = t > HITCH_MS ? '#ff5c5c' : t > 20 ? '#ffc04d' : '#7cf0a0';
      ctx.fillRect(i, yFor(t), 1, height - yFor(t));
    }
  }
}
