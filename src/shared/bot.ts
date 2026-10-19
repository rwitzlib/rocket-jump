import { Vector3 } from 'three';
import { DT, GRAVITY, GRENADE, HYPERSONIC, ROCKET } from './config';
import { isSeeker, type GameSim, type PlayerSim } from './sim';
import type { PlayerInput } from './types';

// A simple server-side opponent. It circles the tower bunny-hopping, and when it can see another
// player it shoots at them: leading their movement, aiming at the feet of grounded targets for
// splash, with some reaction time and aim error so it's beatable. With nobody in sight it rocket
// jumps and grapples now and then, so it keeps moving.

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
const _aim = new Vector3();
const _targetEye = new Vector3();

export class Bot {
  constructor(public skill: BotSkill = 'normal') {}

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
    this.t += DT;

    // Head for a point that slides around a circle, strafing side to side like an air-strafer.
    const a = this.t * this.orbitSpeed;
    const orbit = sim.map.botOrbit ?? ORBIT_RADIUS;
    const dx = Math.cos(a) * orbit - p.pos.x;
    const dz = Math.sin(a) * orbit - p.pos.z;

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

    const target = this.updateTarget(p, sim);
    if (target) {
      this.aimAt(p, target, input);
      input.forward = 0.3; // strafe around them rather than running into its own splash
      this.reaction -= DT;
      const skill = BOT_SKILLS[this.skill];
      if (this.reaction <= 0 && p.fireCooldown === 0 && Math.random() < DT / (DT + skill.hesitate)) {
        input.fire = true;
        this.errYaw = (Math.random() * 2 - 1) * skill.aimError;
        this.errPitch = (Math.random() * 2 - 1) * skill.aimError;
      }
      return input;
    }

    this.nextRocketJump -= DT;
    if (this.nextRocketJump <= 0 && p.grounded) {
      input.pitch = -1.35; // at the feet
      input.fire = true;
      this.nextRocketJump = 3 + Math.random() * 3;
    }

    this.nextGrapple -= DT;
    if (this.nextGrapple <= 0) {
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
      if (o === p || !o.alive) continue;
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
    // Seekers steer themselves: just keep the target centered in the lock box.
    const speed = grenade ? GRENADE.speed : p.primary === 'hypersonic' ? HYPERSONIC.speed : ROCKET.speed;
    const flight = isSeeker(p.primary) ? 0 : target.pos.distanceTo(_eye) / speed;
    _aim.copy(target.pos).addScaledVector(target.vel, flight);
    if (target.grounded && BOT_SKILLS[this.skill].splash) _aim.y -= 0.8; // the floor at their feet: splash is easier to land than a direct hit
    if (grenade) _aim.y += 0.5 * GRAVITY * flight * flight; // lob it: aim above by as much as it will drop
    _aim.sub(_eye);
    input.yaw = Math.atan2(-_aim.x, -_aim.z) + this.errYaw;
    input.pitch = Math.atan2(_aim.y, Math.hypot(_aim.x, _aim.z)) + this.errPitch;
  }
}
