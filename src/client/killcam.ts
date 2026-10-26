import * as THREE from 'three';
import type { ExplosionId } from '../shared/progress';
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
  style: ExplosionId; // the shooter's explosion skin
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

  explosion(pos: THREE.Vector3, normal: THREE.Vector3, surface: boolean, radius: number, style: ExplosionId = 'classic') {
    this.blasts.push({ t: this.clock, pos: pos.clone(), normal: normal.clone(), surface, radius, style });
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
      const r = copyProjectile(p);
      const from = a.projectiles.find((o) => o.id === p.id);
      const to = b.projectiles.find((o) => o.id === p.id);
      if (from && to) r.pos.copy(from.pos).lerp(to.pos, f);
      return r;
    });
  }

  /** A copy of the stretch from `from` to `to`, to replay later (the play of the match). */
  snapshot(from: number, to: number): KillcamRecorder {
    const copy = new KillcamRecorder();
    copy.frames.push(...this.frames.filter((f) => f.t >= from && f.t <= to));
    copy.blasts.push(...this.blasts.filter((b) => b.t >= from && b.t <= to));
    copy.shots.push(...this.shots.filter((s) => s.t >= from && s.t <= to));
    copy.clock = to;
    return copy;
  }

  /**
   * The shot (Projectile.shot) of `killerId`'s that killed `victimId` at about `t`, and when it was
   * first seen: of their `kind` projectiles in flight around then, the one last seen nearest the
   * victim (and nearest `t`). Null if there was none. Matched by shot, not id: our own predicted
   * copies change id when the server's replaces them.
   */
  killingShot(killerId: string, victimId: string, kind: string, t: number): { shot: number; firstSeen: number } | null {
    const seen = new Map<number, { first: number; last: number; miss: number }>();
    for (const f of this.frames) {
      const victim = f.players.find((p) => p.id === victimId);
      for (const p of f.projectiles) {
        if (p.ownerId !== killerId || p.kind !== kind) continue;
        const s = seen.get(p.shot) ?? { first: f.t, last: f.t, miss: Infinity };
        s.last = f.t;
        s.miss = victim ? p.pos.distanceTo(victim.pos) : Infinity;
        seen.set(p.shot, s);
      }
    }
    let best: { shot: number; firstSeen: number } | null = null;
    let bestScore = Infinity;
    for (const [shot, s] of seen) {
      // A meter off the victim weighs about as much as an eighth of a second off the kill.
      const score = s.miss + 8 * Math.abs(s.last - t);
      if (s.last < t - 1.5 || score >= bestScore) continue;
      bestScore = score;
      best = { shot, firstSeen: s.first };
    }
    return best;
  }

  /** Explosions that went off in (from, to]. */
  blastsBetween(from: number, to: number): readonly Blast[] {
    return this.blasts.filter((b) => b.t > from && b.t <= to);
  }
}
