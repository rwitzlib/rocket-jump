import type RAPIER from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three';
import { COMBAT, GRENADE, LOADOUT, PLAYER } from './config';
import { PositionHistory } from './hits';
import type { Vec3Tuple } from './map';
import type { GrappleState, Hook } from './movement';
import type { WeaponId } from './types';

// A player in the simulation, and the plain-data copy of one that goes over the wire to its own
// client for prediction.

/** Everything about a player that affects how the next input plays out. Plain data, so it can go over the wire. */
export interface PlayerState {
  pos: Vec3Tuple;
  vel: Vec3Tuple;
  grounded: boolean;
  grapple: { anchor: Vec3Tuple; normal: Vec3Tuple; length: number; hook: HookState | null } | null;
  fireCooldown: number;
  drum: number; // grenades left in the grenade launcher
  reloading: boolean; // the drum is being refilled; fireCooldown counts it down
  grappleCooldown: number;
  grappleUsed: boolean;
  lockTarget: string | null; // who a seeker launcher is locking onto
  lockProgress: number; // seconds they've been held in the lock box; locked at the weapon's lockTime
  yaw: number;
  pitch: number;
  health: number;
  alive: boolean;
  respawnIn: number; // seconds, while dead
  protectedFor: number; // seconds of spawn protection left
  primary: WeaponId;
  secondary: WeaponId;
  vehicle: number; // index into GameSim.vehicles, -1 on foot
  seat: number;
  team: number; // 0 red, 1 blue, -1 in free-for-all modes
  armor: number;
  overdrive: number; // seconds of overdrive left
  flag: number; // the team whose flag you're carrying, -1 for none
  checkpoint: number; // race: the ring to fly through next
  lapTime: number; // race: seconds into the current lap, -1 before the start gate
}

export type HookState =
  | { kind: 'player'; id: string; offset: Vec3Tuple }
  | { kind: 'crate'; index: number; local: Vec3Tuple; localNormal: Vec3Tuple }
  | { kind: 'rocket'; ownerId: string; shot: number }
  | { kind: 'vehicle'; index: number; local: Vec3Tuple };

export function hookToState(h: Hook | null): HookState | null {
  if (!h) return null;
  if (h.kind === 'player') return { kind: 'player', id: h.id, offset: tuple(h.offset) };
  if (h.kind === 'crate') return { kind: 'crate', index: h.index, local: tuple(h.local), localNormal: tuple(h.localNormal) };
  if (h.kind === 'vehicle') return { kind: 'vehicle', index: h.index, local: tuple(h.local) };
  return { ...h };
}

export function hookFromState(h: HookState | null): Hook | null {
  if (!h) return null;
  if (h.kind === 'player') return { kind: 'player', id: h.id, offset: new Vector3(...h.offset) };
  if (h.kind === 'crate') return { kind: 'crate', index: h.index, local: new Vector3(...h.local), localNormal: new Vector3(...h.localNormal) };
  if (h.kind === 'vehicle') return { kind: 'vehicle', index: h.index, local: new Vector3(...h.local) };
  return { ...h };
}

export const tuple = (v: Vector3): Vec3Tuple => [v.x, v.y, v.z];

export class PlayerSim {
  readonly pos = new Vector3();
  readonly prevPos = new Vector3();
  readonly vel = new Vector3();
  grounded = false;
  grapple: GrappleState | null = null;
  fireCooldown = 0;
  drum: number = GRENADE.drum;
  reloading = false;
  grappleCooldown = 0;
  grappleUsed = false; // this press of the grapple button already fired; cleared on release
  lockTarget: string | null = null;
  lockProgress = 0;
  yaw = 0;
  pitch = 0;
  /** Seq of the input being simulated (0 offline). Tags fired rockets so a client can match its predictions. */
  seq = 0;
  primary: WeaponId = LOADOUT.primary;
  secondary: WeaponId = LOADOUT.secondary;
  vehicle = -1; // index into GameSim.vehicles while seated in one
  seat = -1;
  useHeld = false; // server only: E is down, so holding it doesn't get you in and straight back out
  rammedFor = 0; // server only: seconds before a car can run you over again
  team = -1;
  armor = 0;
  overdrive = 0;
  flag = -1;
  checkpoint = 0;
  lapTime = -1;
  bestLap = 0; // race: seconds, 0 for none yet
  captures = 0;
  points = 0; // king of the hill: seconds held

  health: number = COMBAT.maxHealth;
  alive = true;
  respawnIn = 0;
  protectedFor = 0;
  sinceDamaged = Infinity; // seconds, for regen
  lastAttacker: string | null = null; // who to credit if this player dies soon after being hit by them
  sinceAttacked = Infinity; // seconds since lastAttacker's hit
  kills = 0;
  deaths = 0;
  /** Recent positions, server-side, for lag-compensated hit tests. */
  readonly history = new PositionHistory();

  constructor(
    readonly id: string,
    readonly body: RAPIER.RigidBody,
    readonly collider: RAPIER.Collider,
  ) {}

  eye(out: Vector3): Vector3 {
    return out.set(this.pos.x, this.pos.y + PLAYER.eyeOffset, this.pos.z);
  }

  capture(): PlayerState {
    const g = this.grapple;
    return {
      pos: tuple(this.pos),
      vel: tuple(this.vel),
      grounded: this.grounded,
      grapple: g && { anchor: tuple(g.anchor), normal: tuple(g.normal), length: g.length, hook: hookToState(g.hook) },
      fireCooldown: this.fireCooldown,
      drum: this.drum,
      reloading: this.reloading,
      grappleCooldown: this.grappleCooldown,
      grappleUsed: this.grappleUsed,
      lockTarget: this.lockTarget,
      lockProgress: this.lockProgress,
      yaw: this.yaw,
      pitch: this.pitch,
      health: this.health,
      alive: this.alive,
      respawnIn: this.respawnIn,
      protectedFor: this.protectedFor,
      primary: this.primary,
      secondary: this.secondary,
      vehicle: this.vehicle,
      seat: this.seat,
      team: this.team,
      armor: this.armor,
      overdrive: this.overdrive,
      flag: this.flag,
      checkpoint: this.checkpoint,
      lapTime: this.lapTime,
    };
  }

  /** Overwrites this player with a captured state and moves its collider there immediately. */
  restore(s: PlayerState) {
    this.pos.set(...s.pos);
    this.prevPos.copy(this.pos);
    this.vel.set(...s.vel);
    this.grounded = s.grounded;
    const g = s.grapple;
    this.grapple = g && {
      anchor: new Vector3(...g.anchor),
      normal: new Vector3(...g.normal),
      length: g.length,
      hook: hookFromState(g.hook),
    };
    this.fireCooldown = s.fireCooldown;
    this.drum = s.drum;
    this.reloading = s.reloading;
    this.grappleCooldown = s.grappleCooldown;
    this.grappleUsed = s.grappleUsed;
    this.lockTarget = s.lockTarget;
    this.lockProgress = s.lockProgress;
    this.yaw = s.yaw;
    this.pitch = s.pitch;
    this.health = s.health;
    this.respawnIn = s.respawnIn;
    this.protectedFor = s.protectedFor;
    this.primary = s.primary;
    this.secondary = s.secondary;
    this.vehicle = s.vehicle;
    this.seat = s.seat;
    this.team = s.team;
    this.armor = s.armor;
    this.overdrive = s.overdrive;
    this.flag = s.flag;
    this.checkpoint = s.checkpoint;
    this.lapTime = s.lapTime;
    if (s.alive !== this.alive) {
      this.alive = s.alive;
      this.collider.setEnabled(s.alive);
    }
    this.collider.setTranslation(this.pos);
    this.body.setNextKinematicTranslation(this.pos);
  }
}
