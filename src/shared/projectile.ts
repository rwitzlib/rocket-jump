import type { Vector3 } from 'three';
import { COMBAT, GRENADE, HYPERSONIC, ROCKET, SEEKERS, type SeekerConfig } from './config';
import type { SeekerId, WeaponId } from './types';

// Projectiles as data: what each weapon fires, how hard each one's blast hits, and the seeker
// launchers' lock rules. Flight.ts moves them.

/** 'vehicle': blown up inside one. 'ram': run over. */
export type DeathCause = ProjectileKind | 'thunder' | 'fall' | 'vehicle' | 'ram';

export const isSeeker = (w: WeaponId): w is SeekerId => w in SEEKERS;

/** True once a seeker launcher has held its target long enough to fire. */
export function lockedOn(p: { primary: WeaponId; lockTarget: string | null; lockProgress: number }): boolean {
  return lockReady(isSeeker(p.primary) ? p.primary : null, p);
}

/** True once `weapon` has held its target long enough to fire. */
export function lockReady(weapon: SeekerId | null, p: { lockTarget: string | null; lockProgress: number }): boolean {
  return weapon !== null && p.lockTarget !== null && p.lockProgress >= SEEKERS[weapon].lockTime;
}

export type MissilePhase = 'climb' | 'turn' | 'terminal';

/** The weapons that go in the primary slot. */
export type PrimaryId = Exclude<WeaponId, 'grapple'>;

/** Every primary weapon but the Thunder Gun (a cone of air, see THUNDER) fires a projectile of the same name. */
export type ProjectileKind = Exclude<PrimaryId, 'thunder'>;

/**
 * Rockets fly straight at a constant speed and explode on anything. Grenades fall and bounce off
 * surfaces; once armed they explode on any player they touch, otherwise when the fuse runs out.
 */
export interface Projectile {
  id: number; // server-assigned; predicted ones use -shot until the server's copy replaces them
  kind: ProjectileKind;
  ownerId: string;
  shot: number; // seq of the owner's input that fired it
  pos: Vector3;
  prevPos: Vector3;
  vel: Vector3;
  life: number;
  traveled: number; // meters flown: a grenade arms (explodes on players) at GRENADE.armDistance
  lag: number; // ticks to rewind other players by when testing hits: how far behind the shooter was seeing
  struck: string | null; // the last player an unarmed grenade bounced off, so one hit only hurts once
  target: string | null; // the player a seeker missile is steering for
  /**
   * A seeker's flight: a javelin climbs, turns over at the top, then makes its terminal dive. Only
   * in the terminal phase can the target slip out of its seeker cone. Everything else is terminal.
   */
  phase: MissilePhase;
  apex: number; // the height a javelin climbs to before turning over
  from: number; // the vehicle it was fired from (it flies through that one), -1 on foot
  power: number; // damage and knockback scale: 1, less for a helicopter's rocket pods
}

export const isArmed = (p: Projectile) => p.kind !== 'grenade' || p.traveled >= GRENADE.armDistance;

function seekerBlast(s: SeekerConfig): Blast {
  return { radius: s.blastRadius, knockback: s.knockback, selfKnockback: s.selfKnockback, crateKnockback: s.crateKnockback, damage: s.damage };
}

export interface Blast {
  radius: number;
  knockback: number;
  selfKnockback: number;
  crateKnockback: number;
  damage: number;
  directFull?: boolean; // the player it hits directly takes full damage and knockback, however far from their center
  lift?: number; // minimum upward component of the knockback direction
  selfRadius?: number; // how far the blast reaches the player who fired it, if not `radius`
}

/** What blew up when a vehicle is destroyed: its riders die outright, this is for everyone nearby. */
export const VEHICLE_BLAST: Blast = { radius: 7, knockback: 18, selfKnockback: 1, crateKnockback: 14, damage: 80 };

export const BLASTS: Record<ProjectileKind, Blast> = {
  rocket: { radius: ROCKET.blastRadius, knockback: ROCKET.knockback, selfKnockback: ROCKET.selfKnockback, crateKnockback: ROCKET.crateKnockback, damage: COMBAT.rocketDamage },
  grenade: { radius: GRENADE.blastRadius, knockback: GRENADE.knockback, selfKnockback: GRENADE.selfKnockback, crateKnockback: GRENADE.crateKnockback, damage: GRENADE.damage },
  javelin: seekerBlast(SEEKERS.javelin),
  stinger: seekerBlast(SEEKERS.stinger),
  hypersonic: {
    radius: HYPERSONIC.blastRadius,
    knockback: HYPERSONIC.knockback,
    selfKnockback: HYPERSONIC.selfKnockback,
    crateKnockback: HYPERSONIC.crateKnockback,
    damage: HYPERSONIC.damage,
    directFull: true,
    lift: HYPERSONIC.lift,
    selfRadius: HYPERSONIC.selfRadius,
  },
};
export const BLAST_CAUSE = new Map<Blast, DeathCause>(Object.entries(BLASTS).map(([kind, blast]) => [blast, kind as ProjectileKind]));
