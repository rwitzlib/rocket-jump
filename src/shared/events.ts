import type { Vector3 } from 'three';
import type { ItemKind } from './map';
import type { DeathCause } from './projectile';
import type { WeaponId } from './types';

// What the simulation reports happening each tick: the server sends these to clients (as wire
// events), and the client turns them into sound, effects and HUD messages.

/**
 * How a player step treats side effects.
 * - authority: the real simulation (server, single-player).
 * - predict: a client guessing its own player (and its own rockets) ahead of the server. Feedback
 *   events still fire. Respawns and crates are left to the server.
 * - replay: re-running inputs that were already predicted, after a server correction. Silent.
 */
export type StepMode = 'authority' | 'predict' | 'replay';

export type FlagAction = 'taken' | 'dropped' | 'returned' | 'captured';

export type SimEvent =
  | { type: 'fired'; playerId: string; weapon: WeaponId }
  | { type: 'explosion'; pos: Vector3; normal: Vector3; surface: boolean; ownerId: string; shot: number; radius: number } // surface = false for mid-air
  | { type: 'bounce'; pos: Vector3; normal: Vector3; ownerId: string; shot: number; speed: number } // a grenade hitting something before it arms
  | { type: 'pickup'; playerId: string; weapon: WeaponId; box: number }
  | { type: 'grapple'; playerId: string; attached: boolean }
  | { type: 'grappleMiss'; playerId: string }
  | { type: 'jumped'; playerId: string }
  | { type: 'landed'; playerId: string; impactSpeed: number }
  | { type: 'knockback'; playerId: string; strength: number; sourceId: string; shot: number } // strength 0..1
  | { type: 'respawn'; playerId: string; yaw: number }
  | { type: 'damaged'; playerId: string; sourceId: string; amount: number; midair: boolean }
  // killerId null: suicide; midair: an airshot; distance and killerHealth are for the victim's death recap
  | { type: 'killed'; playerId: string; killerId: string | null; cause: DeathCause; midair: boolean; distance: number; killerHealth: number }
  | { type: 'item'; playerId: string; kind: ItemKind; index: number }
  | { type: 'flag'; team: number; action: FlagAction; playerId: string | null } // playerId null: it went home by itself
  | { type: 'checkpoint'; playerId: string; index: number; time: number }
  | { type: 'hill'; playerId: string | null; contested: boolean } // king of the hill: who has it now (null: nobody)
  | { type: 'lap'; playerId: string; time: number; best: boolean }
  | { type: 'entered'; playerId: string; vehicle: number; seat: number }
  | { type: 'exited'; playerId: string; vehicle: number }
  | { type: 'vehicleHit'; vehicle: number; sourceId: string; amount: number }
  | { type: 'vehicleDestroyed'; vehicle: number; pos: Vector3; normal: Vector3 }
  | { type: 'rammed'; playerId: string; vehicle: number; speed: number }
  | { type: 'thunder'; playerId: string; pos: Vector3; dir: Vector3 }; // a Thunder Gun blast: from the shooter's eye, along their aim
