import { Vector3 } from 'three';
import { CTF, DT, ITEMS, KOTH, PLAYER, RACE } from './config';
import type { ItemKind } from './map';
import { flagBases, hillSpots, raceCourse, type RaceCourse } from './modes';
import { segmentDistance } from './physics';
import type { PlayerSim } from './player';
import type { SimEvent } from './events';
import type { GameSim } from './sim';

// The rules that differ by mode: health, armor and overdrive items; capture-the-flag flags; race
// checkpoints and lap times. Server only (the client is told the outcome in snapshots), stepped
// by GameSim.

/** A health pack, armor or overdrive, floating where it's taken from. Mirrored like mystery boxes. */
export interface Item {
  kind: ItemKind;
  pos: Vector3;
  respawnIn: number;
}

/** A capture-the-flag flag: at its base, carried, or lying where its carrier fell. */
export interface Flag {
  team: number;
  home: Vector3; // the base, on the floor
  pos: Vector3; // where it is now (its foot)
  carrier: string | null;
  atHome: boolean;
  returnIn: number; // seconds until a dropped flag goes home by itself
}

/** How high an item's center floats above the floor it stands on. */
const ITEM_HEIGHT = 0.7;
/** A player's center is this far above their feet. */
const FEET = PLAYER.halfHeight + PLAYER.radius;

const _center = new Vector3();
const _segment = new Vector3();
const _down = new Vector3();
const _rayOrigin = new Vector3();
const _want = new Vector3();

export class ModeRules {
  readonly items: Item[];
  /** Red's then blue's, in capture the flag (the same two exist in every mode, unused). */
  readonly flags: Flag[];
  readonly course: RaceCourse;
  /** Captures in capture the flag, kills in team deathmatch, rounds in elimination. */
  readonly teamScores = [0, 0];
  /** King of the hill: where it can be, and which spot it's on now. */
  readonly hills: Vector3[];
  hillIndex = 0;
  private hillClock = 0;
  private holder: string | null = null;
  private contested = false;

  constructor(private readonly sim: GameSim) {
    const map = sim.map;
    this.items = (map.items ?? []).map((d) => ({ kind: d.kind, pos: new Vector3(d.pos[0], d.pos[1] + ITEM_HEIGHT, d.pos[2]), respawnIn: 0 }));
    this.flags = flagBases(map).map((pos, team) => ({ team, home: new Vector3(...pos), pos: new Vector3(...pos), carrier: null, atHome: true, returnIn: 0 }));
    this.course = raceCourse(map);
    this.hills = hillSpots(map).map((h) => new Vector3(...h));
  }

  get hill(): Vector3 {
    return this.hills[this.hillIndex % this.hills.length];
  }

  /** Whether a living player stands on the hill. */
  onHill(p: PlayerSim): boolean {
    const h = this.hill;
    const feet = p.pos.y - FEET;
    return p.alive && Math.hypot(p.pos.x - h.x, p.pos.z - h.z) < KOTH.radius && feet > h.y - 1 && feet < h.y + KOTH.height;
  }

  /** A new match: the hill back to its first spot. */
  resetHill() {
    this.hillIndex = 0;
    this.hillClock = 0;
    this.holder = null;
    this.contested = false;
  }

  /**
   * King of the hill, server only: whoever is alone on the hill scores, a second at a time. Two or
   * more on it is contested: nobody scores. The hill moves on every so often.
   */
  stepHill(events: SimEvent[]) {
    this.hillClock += DT;
    if (this.hillClock >= KOTH.moveEvery) {
      this.hillClock = 0;
      this.hillIndex = (this.hillIndex + 1) % this.hills.length;
    }
    let on: PlayerSim | null = null;
    let count = 0;
    for (const p of this.sim.players.values()) {
      if (!this.onHill(p)) continue;
      on = p;
      count++;
    }
    const holder = count === 1 ? on!.id : null;
    const contested = count > 1;
    if (holder !== this.holder || contested !== this.contested) {
      this.holder = holder;
      this.contested = contested;
      events.push({ type: 'hill', playerId: holder, contested });
    }
    if (count === 1) on!.points += DT;
  }

  /** True if a living player's capsule is within `reach` of a point. */
  touches(p: PlayerSim, at: Vector3, reach: number): boolean {
    const dy = Math.min(Math.max(at.y - p.pos.y, -PLAYER.halfHeight), PLAYER.halfHeight);
    return _segment.set(p.pos.x, p.pos.y + dy, p.pos.z).distanceTo(at) <= reach + PLAYER.radius;
  }

  /** Health, armor and the overdrive, server only: walk into one to take it, if it would do you any good. */
  stepItems(events: SimEvent[]) {
    this.items.forEach((item, index) => {
      if (item.respawnIn > 0) {
        item.respawnIn = Math.max(0, item.respawnIn - DT);
        return;
      }
      for (const p of this.sim.players.values()) {
        if (!p.alive || !this.touches(p, item.pos, ITEMS.reach)) continue;
        if (item.kind === 'health') {
          if (p.health >= ITEMS.health.max) continue;
          p.health = Math.min(ITEMS.health.max, p.health + ITEMS.health.amount);
        } else if (item.kind === 'armor') {
          if (p.armor >= ITEMS.armor.max) continue;
          p.armor = Math.min(ITEMS.armor.max, p.armor + ITEMS.armor.amount);
        } else p.overdrive = ITEMS.overdrive.duration;
        item.respawnIn = ITEMS[item.kind].respawn;
        events.push({ type: 'item', playerId: p.id, kind: item.kind, index });
        return;
      }
    });
  }

  /**
   * Capture the flag, server only. Touch the other team's flag to take it; touch your own where it
   * lies to send it home; bring theirs to yours while yours is home to score. A dropped flag goes
   * home by itself after a while.
   */
  stepFlags(events: SimEvent[]) {
    for (const f of this.flags) {
      if (f.carrier) {
        const carrier = this.sim.players.get(f.carrier);
        if (carrier) f.pos.copy(carrier.pos).setY(carrier.pos.y - FEET);
        continue;
      }
      if (!f.atHome) {
        f.returnIn = Math.max(0, f.returnIn - DT);
        if (f.returnIn === 0) {
          this.returnFlag(f);
          events.push({ type: 'flag', team: f.team, action: 'returned', playerId: null });
          continue;
        }
      }
      _center.copy(f.pos).setY(f.pos.y + FEET);
      for (const p of this.sim.players.values()) {
        if (!p.alive || p.team < 0 || !this.touches(p, _center, CTF.touchRadius)) continue;
        if (p.team !== f.team) {
          f.carrier = p.id;
          f.atHome = false;
          p.flag = f.team;
          events.push({ type: 'flag', team: f.team, action: 'taken', playerId: p.id });
          break;
        }
        if (!f.atHome) {
          this.returnFlag(f);
          events.push({ type: 'flag', team: f.team, action: 'returned', playerId: p.id });
          break;
        }
        if (p.flag >= 0) {
          const taken = this.flags[p.flag];
          this.returnFlag(taken);
          p.flag = -1;
          p.captures++;
          this.teamScores[p.team]++;
          events.push({ type: 'flag', team: taken.team, action: 'captured', playerId: p.id });
          break;
        }
      }
    }
  }

  returnFlag(f: Flag) {
    if (f.carrier) {
      const carrier = this.sim.players.get(f.carrier);
      if (carrier) carrier.flag = -1;
    }
    f.carrier = null;
    f.atHome = true;
    f.returnIn = 0;
    f.pos.copy(f.home);
  }

  /** Its carrier died or left: the flag falls to the floor under them, or goes home if there's none. */
  dropFlag(p: PlayerSim, events: SimEvent[]) {
    const f = this.flags[p.flag];
    p.flag = -1;
    if (!f) return;
    f.carrier = null;
    _down.set(0, -1, 0);
    _rayOrigin.copy(p.pos);
    const below = p.pos.y > this.sim.map.killY ? this.sim.castLevel(_rayOrigin, _down, 60, _want) : null;
    if (below === null || p.pos.y - below < this.sim.map.killY + 2) {
      this.returnFlag(f);
      events.push({ type: 'flag', team: f.team, action: 'returned', playerId: null });
      return;
    }
    f.pos.set(p.pos.x, p.pos.y - below, p.pos.z);
    f.returnIn = CTF.returnTime;
    events.push({ type: 'flag', team: f.team, action: 'dropped', playerId: p.id });
  }

  /**
   * Rocket race, server only: fly through the rings in order. The start gate starts the clock, and
   * coming back through it finishes the lap and starts the next one.
   */
  stepRace(p: PlayerSim, events: SimEvent[]) {
    const rings = this.course.rings;
    const ring = rings[p.checkpoint];
    _center.set(...ring);
    if (segmentDistance(p.prevPos, p.pos, _center) > RACE.ringRadius) return;
    if (p.checkpoint === 0) {
      if (p.lapTime >= 0) {
        const time = p.lapTime;
        const best = p.bestLap === 0 || time < p.bestLap;
        if (best) p.bestLap = time;
        events.push({ type: 'lap', playerId: p.id, time, best });
      }
      p.lapTime = 0;
    } else events.push({ type: 'checkpoint', playerId: p.id, index: p.checkpoint, time: p.lapTime });
    p.checkpoint = (p.checkpoint + 1) % rings.length;
  }
}
