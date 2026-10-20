// Spotting aim that's too good to be human. The server is authoritative, so speed hacks and
// teleports are impossible already; what a cheat can still do is aim (an aimbot snaps the view onto
// someone and fires). This watches each player's view for the tell-tale pattern: a big, instant
// turn right before a hit, again and again. It only ever reports: false positives on a game like
// this (fast flicks are normal) would be worse than a cheat or two, so a person decides.

/** How far back (ticks) a turn counts as "right before" a hit. */
const WINDOW = 4;
/** A turn this big within the window is a snap (radians): about 70°. */
const SNAP = 1.2;
/** Reported once this many hits came right after a snap... */
const MIN_SNAPS = 8;
/** ...and they're this large a share of all their hits. */
const SNAP_SHARE = 0.35;

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** One player's recent aim and their hits, for one match. */
export class AimWatch {
  private readonly yaws: number[] = [];
  private readonly pitches: number[] = [];
  hits = 0;
  snaps = 0;
  reported = false;

  /** Every tick, with their view. */
  look(yaw: number, pitch: number) {
    this.yaws.push(yaw);
    this.pitches.push(pitch);
    if (this.yaws.length > WINDOW + 1) {
      this.yaws.shift();
      this.pitches.shift();
    }
  }

  /** How far the view turned over the window (radians). */
  private turned(): number {
    let most = 0;
    const last = this.yaws.length - 1;
    for (let i = 0; i < last; i++) {
      const dy = wrap(this.yaws[last] - this.yaws[i]);
      const dp = this.pitches[last] - this.pitches[i];
      most = Math.max(most, Math.hypot(dy, dp));
    }
    return most;
  }

  /** They hit someone. True the first time the pattern is strong enough to report. */
  hit(): boolean {
    this.hits++;
    if (this.turned() > SNAP) this.snaps++;
    if (this.reported || this.snaps < MIN_SNAPS || this.snaps / this.hits < SNAP_SHARE) return false;
    this.reported = true;
    return true;
  }

  reset() {
    this.hits = 0;
    this.snaps = 0;
    this.reported = false;
  }
}
