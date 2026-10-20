import { Vector3 } from 'three';
import { DT, GRAVITY, GRENADE, HYPERSONIC, ROCKET, THUNDER } from './config';
import { isSeeker, type GameSim, type PlayerSim } from './sim';
import type { PlayerInput } from './types';

// A simple server-side opponent. It circles the tower bunny-hopping, and when it can see another
// player it shoots at them: leading their movement, aiming at the feet of grounded targets for
// splash, with some reaction time and aim error so it's beatable. With nobody in sight it rocket
// jumps and grapples now and then, so it keeps moving. In team modes it leaves its teammates alone,
// and in capture the flag it heads for an objective instead of circling: most bots attack (go for
// the enemy flag, escort whoever has it, run it home), the rest defend their own.

const ORBIT_RADIUS = 28;

/**
 * How good a bot is. Bots fill in for people, so they should be beatable by someone new and still
 * worth fighting for someone good: the server picks a level, or adapts it to how its people are doing.
 * reaction: seconds between spotting someone and the first shot. aimError: radians, re-rolled every
 * shot. hesitate: average extra seconds before each shot once the weapon is ready. sight: meters it
 * notices people from. splash: aims at the feet of people on the ground, the expert rocket habit.
 */
export const BOT_SKILLS = {
  novice: { reaction: 1.0, aimError: 0.2, hesitate: 0.5, sight: 35, splash: false }, // stands in for a new player in scripts/balance.ts
  easy: { reaction: 0.8, aimError: 0.12, hesitate: 0.6, sight: 35, splash: false },
  normal: { reaction: 0.5, aimError: 0.08, hesitate: 0.15, sight: 45, splash: true },
  hard: { reaction: 0.3, aimError: 0.045, hesitate: 0, sight: 55, splash: true },
};
export type BotSkill = keyof typeof BOT_SKILLS;

const _eye = new Vector3();
const _probe = new Vector3();
const DOWN = new Vector3(0, -1, 0);
// Headings tried, nearest first, when the way ahead drops off.
const SAFE_TURNS = [0.5, -0.5, 1, -1, 1.6, -1.6, 2.3, -2.3, Math.PI];
const _aim = new Vector3();
const _targetEye = new Vector3();
const _goal = new Vector3();

export class Bot {
  constructor(public skill: BotSkill = 'normal') {}

  /** Capture the flag: what this bot does when nothing more urgent is going on. */
  readonly role: 'attack' | 'defend' = Math.random() < 0.65 ? 'attack' : 'defend';
  // Heading for an objective, it notices when it stops getting closer (a wall, a ledge it can't
  // climb) and tries a detour: off to one side, jumping and rocket jumping.
  private progressAt = 0; // `t` when it last got meaningfully closer
  private closest = Infinity;
  private detour = 0; // seconds of detour left
  private detourSide = 1;

  private t = Math.random() * 100;
  private readonly orbitSpeed = (0.15 + Math.random() * 0.1) * (Math.random() < 0.5 ? -1 : 1);
  private nextRocketJump = 2 + Math.random() * 2;
  private nextGrapple = 5 + Math.random() * 3;
  private grappleFor = 0;
  private targetId: string | null = null;
  private retarget = 0;
  private reaction = 0;
  private errYaw = 0;
  private errPitch = 0;

  think(p: PlayerSim, sim: GameSim): PlayerInput {
    const input = this.decide(p, sim);
    this.keepFooting(p, sim, input);
    return input;
  }

  /**
   * Maps with edges (a quay, floating islands): if there's no floor where the bot is heading, it
   * swings round to the nearest heading that has some (along the edge, or onto the bridge) instead of
   * strafing or jumping off, and if it's already falling it grapples for something above the middle.
   */
  private keepFooting(p: PlayerSim, sim: GameSim, input: PlayerInput) {
    const depth = p.pos.y - sim.map.killY;
    const below = sim.clearDistance(p.pos, DOWN, depth) < depth;
    if (!below && !p.grounded) {
      // Falling: grapple for a point well above the middle of the map, if nothing's in the way (from
      // underneath an island it would only catch the underside and hang there).
      p.eye(_eye);
      _probe.set(0, Math.max(p.pos.y + 12, 16), 0);
      // Hooked into a ceiling (the island's underside) it would only hang there: let go.
      const reachable = p.grapple ? p.grapple.normal.y > -0.5 : sim.canSee(_eye, _probe);
      _probe.sub(_eye);
      input.yaw = Math.atan2(-_probe.x, -_probe.z);
      input.pitch = Math.atan2(_probe.y, Math.hypot(_probe.x, _probe.z));
      input.forward = 1;
      input.right = 0;
      input.grapple = reachable;
      input.fire = false;
      return;
    }
    const speed = Math.hypot(p.vel.x, p.vel.z);
    const want = speed > 1 ? Math.atan2(-p.vel.x, -p.vel.z) : input.yaw;
    // On a narrow bridge or ledge: no strafing or hopping, just walk.
    if (!this.floorAhead(p, sim, input.yaw + Math.PI / 2, 3, depth) || !this.floorAhead(p, sim, input.yaw - Math.PI / 2, 3, depth)) {
      input.right = 0;
      input.jump = false;
      if (input.pitch < -1) input.fire = false;
    }
    // A hop carries it about this far: only hop where it will come down on something.
    if (input.jump && !this.floorAhead(p, sim, want, speed * 0.75 + 1.5, depth)) input.jump = false;
    if (this.floorAhead(p, sim, want, Math.max(2.5, speed * 0.6), depth)) return;
    if (!p.grounded) {
      // Already in the air and drifting over the edge: brake with air control.
      input.yaw = want + Math.PI;
      input.forward = 1;
      input.right = 0;
      return;
    }
    for (const turn of SAFE_TURNS) {
      const yaw = want + turn;
      if (this.floorAhead(p, sim, yaw, 3, depth) && this.floorAhead(p, sim, yaw, 7, depth)) {
        input.yaw = yaw;
        input.forward = 1;
        input.right = 0;
        input.jump = false;
        if (input.pitch < -1) input.fire = false; // no rocket jumps out over the drop
        if (input.pitch < -0.3) input.pitch = 0;
        return;
      }
    }
  }

  private floorAhead(p: PlayerSim, sim: GameSim, yaw: number, dist: number, depth: number): boolean {
    _probe.set(p.pos.x - Math.sin(yaw) * dist, p.pos.y + 1, p.pos.z - Math.cos(yaw) * dist);
    return sim.clearDistance(_probe, DOWN, depth + 1) < depth + 1;
  }

  /**
   * Capture the flag: where to go. Carrying their flag, home. Our flag lying somewhere, go and send
   * it back; carried off, chase the carrier. Otherwise attackers go for their flag (or stay with the
   * teammate who has it) and defenders circle our base.
   */
  private objective(p: PlayerSim, sim: GameSim): Vector3 | null {
    // King of the hill: onto it, circling a little so they're hard to hit standing there.
    if (sim.mode === 'koth') {
      const h = sim.rules.hill;
      const a = this.t * this.orbitSpeed * 4;
      return _goal.set(h.x + Math.cos(a) * 3, h.y, h.z + Math.sin(a) * 3);
    }
    if (sim.mode !== 'ctf' || p.team < 0) return null;
    const own = sim.flags[p.team];
    const enemy = sim.flags[1 - p.team];
    if (p.flag >= 0) return _goal.copy(own.home);
    const ownCarrier = own.carrier ? sim.players.get(own.carrier) : undefined;
    if (ownCarrier && (this.role === 'defend' || ownCarrier.pos.distanceTo(p.pos) < 40)) return _goal.copy(ownCarrier.pos);
    if (!own.atHome && !own.carrier) return _goal.copy(own.pos);
    if (this.role === 'defend') {
      const a = this.t * this.orbitSpeed * 2;
      return _goal.set(own.home.x + Math.cos(a) * 9, own.home.y, own.home.z + Math.sin(a) * 9);
    }
    const escort = enemy.carrier ? sim.players.get(enemy.carrier) : undefined;
    return _goal.copy(escort ? escort.pos : enemy.pos);
  }

  private decide(p: PlayerSim, sim: GameSim): PlayerInput {
    this.t += DT;

    // Head for the objective, or a point that slides around a circle, strafing side to side like an air-strafer.
    const goal = this.objective(p, sim);
    const a = this.t * this.orbitSpeed;
    const orbit = sim.map.botOrbit ?? ORBIT_RADIUS;
    const dx = (goal ? goal.x : Math.cos(a) * orbit) - p.pos.x;
    const dz = (goal ? goal.z : Math.sin(a) * orbit) - p.pos.z;

    const input: PlayerInput = {
      forward: 1,
      right: Math.sin(this.t * 2.5),
      jump: true,
      fire: false,
      grapple: false,
      use: false,
      down: false,
      yaw: Math.atan2(-dx, -dz),
      pitch: 0,
    };

    // A flag carrier runs for home and doesn't stop to fight.
    if (goal && p.flag >= 0) {
      this.climbToward(p, goal, input);
      return input;
    }
    const target = this.updateTarget(p, sim);
    if (target) {
      this.aimAt(p, target, input);
      // A Thunder Gun only reaches so far: close in until they're well inside the cone.
      const thunder = p.primary === 'thunder';
      const outOfReach = thunder && target.pos.distanceTo(p.pos) > THUNDER.range * 0.7;
      input.forward = outOfReach ? 1 : 0.3; // strafe around them rather than running into its own splash
      if (goal) {
        // Shooting on the move: keep heading for the objective, whichever way it's aiming.
        const along = Math.atan2(-dx, -dz) - input.yaw;
        input.forward = Math.cos(along);
        input.right = -Math.sin(along);
      }
      this.reaction -= DT;
      const skill = BOT_SKILLS[this.skill];
      if (this.reaction <= 0 && p.fireCooldown === 0 && !outOfReach && Math.random() < DT / (DT + skill.hesitate)) {
        input.fire = true;
        this.errYaw = (Math.random() * 2 - 1) * skill.aimError;
        this.errPitch = (Math.random() * 2 - 1) * skill.aimError;
      }
      return input;
    }

    if (goal) {
      this.climbToward(p, goal, input);
      return input;
    }
    const depth = p.pos.y - sim.map.killY;
    this.nextRocketJump -= DT;
    // Only where there's somewhere to come down.
    if (this.nextRocketJump <= 0 && p.grounded && this.floorAhead(p, sim, input.yaw, 8, depth) && this.floorAhead(p, sim, input.yaw, 14, depth)) {
      input.pitch = -1.35; // at the feet
      input.fire = true;
      this.nextRocketJump = 3 + Math.random() * 3;
    }

    this.nextGrapple -= DT;
    if (this.nextGrapple <= 0 && this.floorAhead(p, sim, input.yaw, 16, depth)) {
      this.grappleFor = 1 + Math.random();
      this.nextGrapple = 6 + Math.random() * 4;
    }
    if (this.grappleFor > 0) {
      this.grappleFor -= DT;
      input.pitch = 0.7;
      input.grapple = true;
    }
    return input;
  }

  /**
   * Gets up to an objective above it: a rocket jump toward it from the ground, then the grapple
   * at a point just over it while coming back down. Stuck, it detours.
   */
  private climbToward(p: PlayerSim, goal: Vector3, input: PlayerInput) {
    const dx = goal.x - p.pos.x;
    const dz = goal.z - p.pos.z;
    const horizontal = Math.hypot(dx, dz);
    const dist = Math.hypot(horizontal, goal.y - p.pos.y);
    if (dist < this.closest - 1 || dist > this.closest + 15) {
      this.closest = dist;
      this.progressAt = this.t;
    }
    if (this.detour > 0) {
      this.detour -= DT;
      input.yaw = Math.atan2(-dx, -dz) + this.detourSide * 1.3;
      input.forward = 1;
      input.right = 0;
      input.jump = true;
      if (p.grounded && p.fireCooldown === 0 && Math.random() < 0.05) {
        input.pitch = -1.35;
        input.fire = true;
      }
      return;
    }
    if (this.t - this.progressAt > 2.5 && horizontal > 3) {
      this.detour = 1 + Math.random();
      this.detourSide = -this.detourSide;
      this.closest = Infinity;
      return;
    }
    const above = goal.y - (p.pos.y - 0.9);
    this.grappleFor = 0;
    if (above < 2.5 || horizontal > 30) return;
    input.yaw = Math.atan2(-dx, -dz);
    if (p.grounded && p.fireCooldown === 0) {
      input.pitch = -1.35; // at the feet
      input.fire = true;
      input.jump = true;
      return;
    }
    if (!p.grounded && (p.vel.y < 3 || p.grapple)) {
      input.pitch = Math.atan2(above + 2 - 0.6, Math.max(horizontal, 1));
      input.grapple = true;
      input.right = 0;
    }
  }

  /** The nearest living player in sight, re-checked a few times a second. */
  private updateTarget(p: PlayerSim, sim: GameSim): PlayerSim | null {
    this.retarget -= DT;
    const target = this.targetId ? sim.players.get(this.targetId) : undefined;
    if (this.retarget > 0 && target?.alive) return target;
    this.retarget = 0.25;

    p.eye(_eye);
    let best: PlayerSim | null = null;
    let bestDist = BOT_SKILLS[this.skill].sight;
    for (const o of sim.players.values()) {
      if (o === p || !o.alive || (p.team >= 0 && o.team === p.team)) continue;
      const dist = o.pos.distanceTo(p.pos);
      if (dist < bestDist && sim.canSee(_eye, o.eye(_targetEye))) {
        best = o;
        bestDist = dist;
      }
    }
    if (best && best.id !== this.targetId) this.reaction = BOT_SKILLS[this.skill].reaction;
    this.targetId = best?.id ?? null;
    return best;
  }

  private aimAt(p: PlayerSim, target: PlayerSim, input: PlayerInput) {
    p.eye(_eye);
    const grenade = p.primary === 'grenade';
    const thunder = p.primary === 'thunder';
    // Seekers steer themselves: just keep the target centered in the lock box. A Thunder Gun hits at once.
    const speed = grenade ? GRENADE.speed : p.primary === 'hypersonic' ? HYPERSONIC.speed : ROCKET.speed;
    const flight = isSeeker(p.primary) || thunder ? 0 : target.pos.distanceTo(_eye) / speed;
    _aim.copy(target.pos).addScaledVector(target.vel, flight);
    if (target.grounded && BOT_SKILLS[this.skill].splash && !thunder) _aim.y -= 0.8; // the floor at their feet: splash is easier to land than a direct hit
    if (grenade) _aim.y += 0.5 * GRAVITY * flight * flight; // lob it: aim above by as much as it will drop
    _aim.sub(_eye);
    input.yaw = Math.atan2(-_aim.x, -_aim.z) + this.errYaw;
    input.pitch = Math.atan2(_aim.y, Math.hypot(_aim.x, _aim.z)) + this.errPitch;
  }
}
