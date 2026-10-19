import * as THREE from 'three';
import type { Projectile } from '../shared/sim';
import type { RemotePlayer } from './net/netclient';

// The killcam: the last few seconds of the match as we saw them, kept in a rolling buffer, so that
// after we die we can watch it again from our killer's eyes. Everyone is recorded where we drew
// them (ourselves included), with every projectile, explosion and shot, a few dozen times a second;
// playback interpolates between recorded frames.

const RATE = 30; // frames recorded per second
const KEEP = 5; // seconds of history
/** How much of the run-up to our death the replay shows, and how long it lingers after. */
export const KILLCAM_BEFORE = 2.3;
export const KILLCAM_AFTER = 0.35;

interface Frame {
  t: number; // seconds, on the recorder's clock
  players: RemotePlayer[];
  projectiles: Projectile[];
}

interface Blast {
  t: number;
  pos: THREE.Vector3;
  normal: THREE.Vector3;
  surface: boolean;
  radius: number;
}

const copyPlayer = (r: RemotePlayer): RemotePlayer => ({ ...r, pos: r.pos.clone(), anchor: r.anchor?.clone() ?? null });
const copyProjectile = (p: Projectile): Projectile => ({ ...p, pos: p.pos.clone(), prevPos: p.prevPos.clone(), vel: p.vel.clone() });

export class KillcamRecorder {
  private readonly frames: Frame[] = [];
  private readonly blasts: Blast[] = [];
  private readonly shots: { t: number; id: string }[] = [];
  private nextFrame = 0;
  /** Seconds since the game started: the clock frames are stamped with. */
  clock = 0;

  /** Call every rendered frame with everyone as drawn; it keeps RATE frames a second of them. */
  record(dt: number, players: Iterable<RemotePlayer>, projectiles: readonly Projectile[]) {
    this.clock += dt;
    if (this.clock < this.nextFrame) return;
    this.nextFrame = this.clock + 1 / RATE;
    this.frames.push({ t: this.clock, players: [...players].map(copyPlayer), projectiles: projectiles.map(copyProjectile) });
    while (this.frames.length && this.frames[0].t < this.clock - KEEP) this.frames.shift();
    while (this.blasts.length && this.blasts[0].t < this.clock - KEEP) this.blasts.shift();
    while (this.shots.length && this.shots[0].t < this.clock - KEEP) this.shots.shift();
  }

  /** Someone fired: the killcam kicks the killer's weapon back at the same moment. */
  fired(id: string) {
    this.shots.push({ t: this.clock, id });
  }

  /** Who fired in (from, to]. */
  firedBetween(from: number, to: number): string[] {
    return this.shots.filter((s) => s.t > from && s.t <= to).map((s) => s.id);
  }

  explosion(pos: THREE.Vector3, normal: THREE.Vector3, surface: boolean, radius: number) {
    this.blasts.push({ t: this.clock, pos: pos.clone(), normal: normal.clone(), surface, radius });
  }

  /** True if there's enough history before `t` to be worth replaying. */
  covers(t: number): boolean {
    return this.frames.length > 0 && this.frames[0].t <= t - KILLCAM_BEFORE * 0.6;
  }

  /**
   * Everyone as they were at time `t`, into `out` (cleared first), interpolated between the two
   * frames around it. Returns the projectiles of the nearer frame.
   */
  sample(t: number, out: Map<string, RemotePlayer>): Projectile[] {
    out.clear();
    const frames = this.frames;
    if (!frames.length) return [];
    let i = 0;
    while (i < frames.length - 1 && frames[i + 1].t <= t) i++;
    const a = frames[i];
    const b = frames[Math.min(i + 1, frames.length - 1)];
    const f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    for (const pa of a.players) {
      const pb = b.players.find((p) => p.id === pa.id) ?? pa;
      const r = copyPlayer(f < 0.5 ? pa : pb);
      if (pa.alive === pb.alive) r.pos.copy(pa.pos).lerp(pb.pos, f);
      r.yaw = pa.yaw + Math.atan2(Math.sin(pb.yaw - pa.yaw), Math.cos(pb.yaw - pa.yaw)) * f;
      r.pitch = pa.pitch + (pb.pitch - pa.pitch) * f;
      out.set(r.id, r);
    }
    return (f < 0.5 ? a : b).projectiles.map((p) => {
      const q = b.projectiles.find((o) => o.id === p.id);
      const r = copyProjectile(p);
      if (q && f >= 0.5) return r;
      const from = a.projectiles.find((o) => o.id === p.id);
      if (from && q) r.pos.copy(from.pos).lerp(q.pos, f);
      return r;
    });
  }

  /** Explosions that went off in (from, to]. */
  blastsBetween(from: number, to: number): readonly Blast[] {
    return this.blasts.filter((b) => b.t > from && b.t <= to);
  }
}
