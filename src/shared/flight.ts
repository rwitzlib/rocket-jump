import { Vector3 } from 'three';
import { DT, GRAVITY, GRENADE, SEEKERS } from './config';
import type { SimEvent, StepMode } from './events';
import { BLASTS, isArmed, type Projectile } from './projectile';
import type { GameSim } from './sim';
import type { SeekerId } from './types';

// Projectiles in flight: rockets and darts straight, grenades falling and bouncing, seeker
// missiles steering for their target; each explodes on whatever it hits. Stepped by GameSim, on
// the server for everyone's and on a client for its own (predicted).

/** How steeply a javelin aims to come down on its target. */
const DIVE_ANGLE = 0.95; // about 55°

const _step = new Vector3();
const _want = new Vector3();

export class Flight {

  constructor(private readonly sim: GameSim) {}

  stepProjectiles(events: SimEvent[], mode: StepMode) {
    for (let i = this.sim.projectiles.length - 1; i >= 0; i--) {
      const r = this.sim.projectiles[i];
      r.prevPos.copy(r.pos);
      const exploded =
        r.kind === 'grenade'
          ? this.stepGrenade(r, events, mode)
          : r.kind === 'rocket' || r.kind === 'hypersonic'
            ? this.stepRocket(r, events, mode)
            : this.stepMissile(r, r.kind, events, mode);
      if (exploded) this.sim.projectiles.splice(i, 1);
    }
  }

  /**
   * Seeker missiles: the motor brings them up to speed, then they steer for their target at a
   * limited turn rate. A javelin first climbs steeply toward its target until it reaches its apex
   * (or gets so close it has to come down now), turns over, then dives. On the final approach a
   * target that gets outside the seeker cone is lost, and the missile flies straight on, as it does
   * when its target dies. True once it has exploded.
   */
  private stepMissile(m: Projectile, kind: SeekerId, events: SimEvent[], mode: StepMode): boolean {
    const seeker = SEEKERS[kind];
    const dir = _step.copy(m.vel).normalize();
    const speed = Math.min(seeker.speed, m.vel.length() + seeker.boost * DT);
    const target = m.target ? this.sim.playerPosition(m.target) : undefined;
    if (target) {
      if (m.phase === 'climb') {
        const dx = target.x - m.pos.x;
        const dz = target.z - m.pos.z;
        const horizontal = Math.hypot(dx, dz);
        // Turn over at the apex, or sooner if the target is close: arcing over takes some distance,
        // and the dive should still come down steeply rather than overshoot.
        const radius = speed / (seeker.turnOverRate ?? seeker.turnRate);
        const arc = radius * (Math.sin(seeker.climbAngle ?? 1) + Math.sin(DIVE_ANGLE));
        const dive = Math.max(0, m.pos.y - target.y) / Math.tan(DIVE_ANGLE);
        if (m.pos.y >= m.apex || horizontal < arc + dive) m.phase = 'turn';
        else {
          // Nose up at the climb angle, heading for the target.
          const c = Math.cos(seeker.climbAngle ?? 1);
          if (horizontal > 1e-3) _want.set((dx / horizontal) * c, Math.sin(seeker.climbAngle ?? 1), (dz / horizontal) * c);
          else _want.set(0, 1, 0);
        }
      }
      if (m.phase !== 'climb') _want.copy(target).sub(m.pos).normalize();
      const angle = Math.acos(Math.min(1, Math.max(-1, dir.dot(_want))));
      if (m.phase === 'turn' && angle < seeker.gimbal) m.phase = 'terminal';
      else if (m.phase === 'terminal' && angle > seeker.gimbal) m.target = null; // shaken off
      const maxTurn = (m.phase === 'turn' ? (seeker.turnOverRate ?? seeker.turnRate) : seeker.turnRate) * DT;
      if (m.target && angle > 1e-4) dir.lerp(_want, Math.min(1, maxTurn / angle)).normalize();
    }
    m.vel.copy(dir).multiplyScalar(speed);
    return this.stepRocket(m, events, mode);
  }

  /** Straight line at its current speed until it hits something. True once it has exploded. */
  private stepRocket(r: Projectile, events: SimEvent[], mode: StepMode): boolean {
    const travel = r.vel.length() * DT;
    const dir = _step.copy(r.vel).normalize();
    const normal = new Vector3();
    // Other players are rewound by the shooter's lag, so a rocket that hits someone on the
    // shooter's screen hits them here too.
    const kind = this.sim.aimHit(r.pos, dir, travel, r.ownerId, r.lag ? this.sim.tick - r.lag : undefined, normal, r.from);
    if (kind === 'player') {
      r.pos.addScaledVector(dir, Math.max(0, this.sim.aim.dist - 0.1));
      this.explode(r, normal, false, events, mode, { id: this.sim.aim.playerId, center: this.sim.aim.center.clone() });
      return true;
    }
    if (kind === 'vehicle') {
      r.pos.addScaledVector(dir, this.sim.aim.dist - 0.1);
      this.explode(r, normal, true, events, mode, undefined, this.sim.aim.vehicleIndex);
      return true;
    }
    if (kind !== 'none') {
      r.pos.addScaledVector(dir, this.sim.aim.dist - 0.1);
    } else {
      r.pos.addScaledVector(dir, travel);
      r.traveled += travel;
      r.life -= DT;
      if (r.life > 0) return false;
      normal.copy(dir).negate();
    }
    this.explode(r, normal, true, events, mode);
    return true;
  }

  /**
   * Gravity, then a sweep along this tick's motion. Once a grenade has flown GRENADE.armDistance,
   * anything it touches sets it off. Closer than that it bounces, so it can be banked around a near
   * corner, and a player it bounces off gets hurt. Otherwise the fuse sets it off.
   * True once it has exploded.
   */
  private stepGrenade(g: Projectile, events: SimEvent[], mode: StepMode): boolean {
    g.vel.y -= GRAVITY * DT;
    g.life -= DT;
    const speed = g.vel.length();
    const travel = speed * DT;
    if (travel < 1e-6) return this.fuse(g, events, mode);
    const dir = _step.copy(g.vel).divideScalar(speed);
    const normal = new Vector3();
    // The ray reaches a radius past the center's new spot, so the grenade's surface stops at walls.
    const kind = this.sim.aimHit(g.pos, dir, travel + GRENADE.radius, g.ownerId, g.lag ? this.sim.tick - g.lag : undefined, normal, g.from);
    if (kind === 'none') {
      g.pos.addScaledVector(dir, travel);
      g.traveled += travel;
      return this.fuse(g, events, mode);
    }

    const dist = Math.max(0, this.sim.aim.dist - GRENADE.radius);
    g.pos.addScaledVector(dir, dist);
    g.traveled += dist;
    const player = kind === 'player' ? { id: this.sim.aim.playerId, center: this.sim.aim.center.clone() } : undefined;
    if (player && isArmed(g)) {
      this.explode(g, normal, false, events, mode, player);
      return true;
    }
    if (kind === 'vehicle' && isArmed(g)) {
      this.explode(g, normal, true, events, mode, undefined, this.sim.aim.vehicleIndex);
      return true;
    }
    if (!player && isArmed(g)) {
      this.explode(g, normal, true, events, mode);
      return true;
    }

    // Not armed yet: a player hit point blank takes a knock and some damage, once.
    if (player && player.id !== g.struck) {
      g.struck = player.id;
      const target = this.sim.players.get(player.id);
      if (target) {
        target.vel.addScaledVector(dir, GRENADE.impactKnockback);
        target.grounded = false;
        if (mode === 'authority') this.sim.damage(target, GRENADE.impactDamage, g.ownerId, events, 'grenade');
      }
    }
    // Bounce off the surface or player: lose some of the speed into it, and a little along it.
    const into = -g.vel.dot(normal);
    if (into > 0) {
      g.vel.addScaledVector(normal, into).multiplyScalar(GRENADE.friction).addScaledVector(normal, into * GRENADE.restitution);
      if (into > 2) events.push({ type: 'bounce', pos: g.pos.clone(), normal, ownerId: g.ownerId, shot: g.shot, speed: into });
    }
    g.pos.addScaledVector(normal, 0.01); // off the surface, so next tick's ray doesn't start inside it
    return this.fuse(g, events, mode);
  }

  /** A grenade whose fuse has run out explodes where it is. True if it did. */
  private fuse(g: Projectile, events: SimEvent[], mode: StepMode): boolean {
    if (g.life > 0) return false;
    this.explode(g, new Vector3(0, 1, 0), false, events, mode);
    return true;
  }

  /**
   * `direct`: the player the projectile hit, at the (possibly rewound) position it hit them at.
   * `directVehicle`: the vehicle it hit, which takes the full blast.
   */
  private explode(
    r: Projectile,
    normal: Vector3,
    surface: boolean,
    events: SimEvent[],
    mode: StepMode,
    direct?: { id: string; center: Vector3 },
    directVehicle = -1,
  ) {
    const blast = BLASTS[r.kind];
    this.sim.blast(r.pos, blast, r.ownerId, r.shot, r.power, events, mode, direct, directVehicle);
    events.push({ type: 'explosion', pos: r.pos.clone(), normal, surface, ownerId: r.ownerId, shot: r.shot, radius: blast.radius });
  }
}
