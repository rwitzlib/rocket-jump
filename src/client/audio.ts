import type * as THREE from 'three';

// Procedural sound: every effect is synthesized into an AudioBuffer at startup, so there are no
// asset files. Positional sounds go through HRTF panners driven by the camera.

type SoundName =
  | 'fire'
  | 'grenadeFire'
  | 'hypersonicFire'
  | 'bounce'
  | 'pickup'
  | 'lockTone'
  | 'explosion'
  | 'grappleFire'
  | 'grappleAttach'
  | 'grappleRelease'
  | 'grappleMiss'
  | 'jump'
  | 'land'
  | 'hit'
  | 'kill';

interface Flying {
  id: number;
  kind: string;
  pos: THREE.Vector3;
}

interface PlayOptions {
  at?: THREE.Vector3; // omit for non-positional (your own weapon, UI)
  volume?: number;
  rate?: number;
}

interface Loop {
  source: AudioBufferSourceNode;
  gain: GainNode;
  panner: PannerNode;
  seen: number;
}

const MUTE_KEY = 'rocket-jump:muted';

// --- tiny synthesis helpers -------------------------------------------------------------------

type Synth = (t: number, i: number) => number;

function render(ctx: BaseAudioContext, seconds: number, fn: Synth): AudioBuffer {
  const rate = ctx.sampleRate;
  const buffer = ctx.createBuffer(1, Math.ceil(seconds * rate), rate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = fn(i / rate, i);
  let peak = 0;
  for (const v of data) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < data.length; i++) data[i] /= peak;
  return buffer;
}

/** One-pole lowpass whose cutoff can change per sample. */
function lowpass(sampleRate: number) {
  let y = 0;
  return (x: number, cutoff: number) => {
    y += (1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate)) * (x - y);
    return y;
  };
}

/** Sine oscillator with a frequency that can change per sample (phase-continuous). */
function sweep(sampleRate: number) {
  let phase = 0;
  return (freq: number) => {
    phase += (2 * Math.PI * freq) / sampleRate;
    return Math.sin(phase);
  };
}

const noise = () => Math.random() * 2 - 1;
const env = (t: number, attack: number, decay: number) =>
  t < attack ? t / attack : Math.exp(-(t - attack) / decay);

function synthesize(ctx: BaseAudioContext): Record<SoundName | 'noise', AudioBuffer> {
  const sr = ctx.sampleRate;
  const build = (seconds: number, make: () => Synth) => render(ctx, seconds, make());

  return {
    noise: build(2, () => noise),

    fire: build(0.6, () => {
      const lp = lowpass(sr);
      const osc = sweep(sr);
      return (t) =>
        osc(40 + 140 * Math.exp(-t * 18)) * env(t, 0.002, 0.12) * 0.9 +
        lp(noise(), 300 + 3500 * Math.exp(-t * 14)) * env(t, 0.001, 0.09) * 1.4;
    }),

    // A hollow thoonk: a low pop with a short air rush, much softer than the rocket's roar.
    grenadeFire: build(0.4, () => {
      const lp = lowpass(sr);
      const osc = sweep(sr);
      return (t) =>
        osc(70 + 220 * Math.exp(-t * 30)) * env(t, 0.001, 0.07) * 1.2 + lp(noise(), 600 + 1800 * Math.exp(-t * 25)) * env(t, 0.001, 0.05) * 0.8;
    }),

    // Hypersonic launch: a sharp supersonic crack over a falling electric whine and a short thump.
    hypersonicFire: build(0.5, () => {
      const lp = lowpass(sr);
      const whine = sweep(sr);
      const thump = sweep(sr);
      return (t) =>
        lp(noise(), 9000) * env(t, 0.0005, 0.02) * 1.6 +
        whine(600 + 3400 * Math.exp(-t * 9)) * env(t, 0.002, 0.12) * 0.35 +
        thump(55 + 110 * Math.exp(-t * 30)) * env(t, 0.002, 0.06) * 0.9;
    }),

    // An unarmed grenade hitting something: a dull knock with a short metallic ring.
    bounce: build(0.25, () => {
      const lp = lowpass(sr);
      const partials = [1240, 2310, 3470];
      return (t) => {
        let ring = 0;
        partials.forEach((f, k) => (ring += Math.sin(2 * Math.PI * f * t) * Math.exp(-t * (30 + k * 12))));
        return ring * 0.4 + lp(noise(), 1500) * env(t, 0.0005, 0.01) * 1.4;
      };
    }),

    // Taking a mystery box: a quick rising arpeggio.
    pickup: build(0.6, () => {
      const notes = [660, 880, 1100, 1320];
      return (t) => {
        let out = 0;
        notes.forEach((f, k) => {
          const start = k * 0.06;
          if (t >= start) out += (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t)) * env(t - start, 0.003, 0.12);
        });
        return out;
      };
    }),

    explosion: build(2.2, () => {
      const lp = lowpass(sr);
      const lp2 = lowpass(sr);
      const sub = sweep(sr);
      return (t) => {
        const crack = lp2(noise(), 6000) * env(t, 0.0005, 0.015);
        const body = lp(noise(), 120 + 2400 * Math.exp(-t * 5)) * env(t, 0.004, 0.45) * 2.5;
        const boom = sub(28 + 60 * Math.exp(-t * 6)) * env(t, 0.003, 0.35) * 1.2;
        return Math.tanh((crack + body + boom) * 1.6);
      };
    }),

    grappleFire: build(0.22, () => {
      const osc = sweep(sr);
      const lp = lowpass(sr);
      return (t) =>
        osc(2400 - 7000 * t) * env(t, 0.002, 0.05) * 0.35 + lp(noise(), 5000) * env(t, 0.001, 0.06) * 0.5;
    }),

    grappleAttach: build(0.5, () => {
      const lp = lowpass(sr);
      const partials = [523, 1187, 1873, 2711];
      return (t) => {
        let ring = 0;
        partials.forEach((f, k) => (ring += Math.sin(2 * Math.PI * f * t) * Math.exp(-t * (9 + k * 5))));
        return ring * 0.35 + lp(noise(), 2500) * env(t, 0.0005, 0.012) * 1.5;
      };
    }),

    grappleRelease: build(0.15, () => {
      const osc = sweep(sr);
      return (t) => osc(600 + 3000 * t) * env(t, 0.002, 0.035);
    }),

    grappleMiss: build(0.25, () => {
      const osc = sweep(sr);
      return (t) => osc(900 - 2400 * t) * env(t, 0.002, 0.06) * 0.6;
    }),

    jump: build(0.18, () => {
      const lp = lowpass(sr);
      return (t) => lp(noise(), 900) * env(t, 0.01, 0.045);
    }),

    land: build(0.35, () => {
      const lp = lowpass(sr);
      const osc = sweep(sr);
      return (t) =>
        osc(45 + 70 * Math.exp(-t * 20)) * env(t, 0.002, 0.07) + lp(noise(), 700) * env(t, 0.001, 0.05) * 1.3;
    }),

    // Hit confirmation for the shooter: a short, bright tick that cuts through explosions.
    // Seeker lock-on beep; played faster and higher once locked, low for an incoming-missile warning.
    lockTone: build(0.07, () => {
      const osc = sweep(sr);
      return (t) => osc(1050) * env(t, 0.003, 0.025);
    }),

    hit: build(0.12, () => {
      const osc = sweep(sr);
      return (t) => osc(1750) * env(t, 0.001, 0.025) + osc(3500) * env(t, 0.001, 0.012) * 0.3;
    }),

    // Kill confirmation: two rising tones.
    kill: build(0.4, () => {
      const osc = sweep(sr);
      return (t) => osc(t < 0.09 ? 880 : 1320) * (t < 0.09 ? env(t, 0.002, 0.04) : env(t - 0.09, 0.002, 0.09));
    }),
  };
}

// --- engine ----------------------------------------------------------------------------------

export class GameAudio {
  private readonly ctx = new AudioContext();
  private readonly master = this.ctx.createGain();
  private readonly buffers = synthesize(this.ctx);
  private readonly rocketLoops = new Map<number, Loop>();
  private frameNo = 0;
  private muted = false;

  constructor() {
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      // storage unavailable (private mode etc.): just default to unmuted
    }
    this.master.gain.value = this.muted ? 0 : 0.7;

    // A gentle compressor keeps stacked explosions from clipping.
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 6;
    this.master.connect(comp).connect(this.ctx.destination);
  }

  /** Browsers only allow audio after a user gesture; call this from one. */
  resume() {
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.7, this.ctx.currentTime, 0.02);
    try {
      localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    } catch {
      // ignore
    }
    return this.muted;
  }

  play(name: SoundName, opts: PlayOptions = {}) {
    if (this.ctx.state !== 'running') return;
    const source = this.ctx.createBufferSource();
    source.buffer = this.buffers[name];
    source.playbackRate.value = (opts.rate ?? 1) * (0.94 + Math.random() * 0.12);
    const gain = this.ctx.createGain();
    gain.gain.value = opts.volume ?? 1;
    source.connect(gain);
    if (opts.at) gain.connect(this.panner(opts.at)).connect(this.master);
    else gain.connect(this.master);
    source.start();
  }

  // Per-frame updates assign `.value` directly rather than scheduling automation events
  // (setValueAtTime etc.): queuing ~a dozen events per frame makes the audio thread's timelines
  // grow and the main thread contend with it, which shows up as periodic hitches.
  update(camera: THREE.Camera, projectiles: readonly Flying[]) {
    const l = this.ctx.listener;
    const e = camera.matrixWorld.elements;
    // Camera looks down its local -Z; up is local +Y.
    if (l.positionX) {
      l.positionX.value = e[12];
      l.positionY.value = e[13];
      l.positionZ.value = e[14];
      l.forwardX.value = -e[8];
      l.forwardY.value = -e[9];
      l.forwardZ.value = -e[10];
      l.upX.value = e[4];
      l.upY.value = e[5];
      l.upZ.value = e[6];
    } else {
      l.setPosition(e[12], e[13], e[14]);
      l.setOrientation(-e[8], -e[9], -e[10], e[4], e[5], e[6]);
    }

    this.syncRocketLoops(projectiles);
  }

  /** Rockets and missiles hiss as they fly; grenades are silent until they hit something. */
  private syncRocketLoops(projectiles: readonly Flying[]) {
    const frame = ++this.frameNo;
    for (const r of projectiles) {
      if (r.kind === 'grenade') continue;
      let loop = this.rocketLoops.get(r.id);
      if (!loop) {
        if (this.ctx.state !== 'running') continue;
        const source = this.ctx.createBufferSource();
        source.buffer = this.buffers.noise;
        source.loop = true;
        source.loopStart = Math.random();
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 900;
        filter.Q.value = 1.5;
        const gain = this.ctx.createGain();
        gain.gain.value = 0.5;
        const panner = this.panner(r.pos);
        source.connect(filter).connect(gain).connect(panner).connect(this.master);
        source.start(0, source.loopStart);
        loop = { source, gain, panner, seen: frame };
        this.rocketLoops.set(r.id, loop);
      }
      loop.seen = frame;
      this.setPannerPosition(loop.panner, r.pos);
    }
    for (const [id, loop] of this.rocketLoops) {
      if (loop.seen === frame) continue;
      loop.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
      loop.source.stop(this.ctx.currentTime + 0.05);
      this.rocketLoops.delete(id);
    }
  }

  private panner(at: THREE.Vector3): PannerNode {
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 4;
    p.rolloffFactor = 1.2;
    this.setPannerPosition(p, at);
    return p;
  }

  private setPannerPosition(p: PannerNode, at: THREE.Vector3) {
    if (p.positionX) {
      p.positionX.value = at.x;
      p.positionY.value = at.y;
      p.positionZ.value = at.z;
    } else {
      p.setPosition(at.x, at.y, at.z);
    }
  }
}
