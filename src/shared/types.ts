export type WeaponId = 'rocket' | 'grenade' | 'hypersonic' | 'javelin' | 'stinger' | 'grapple';
/** Primary weapons that need a lock on a player before they'll fire. */
export type SeekerId = 'javelin' | 'stinger';
/** Fire (left click) uses the primary weapon, grapple (right click) the secondary. */
export type WeaponSlot = 'primary' | 'secondary';

// One tick of player intent. This is exactly what a client will send to the server in multiplayer,
// so keep it small and serializable.
export interface PlayerInput {
  forward: number; // -1..1
  right: number; // -1..1
  jump: boolean;
  fire: boolean;
  grapple: boolean;
  yaw: number; // radians, 0 = looking down -Z
  pitch: number; // radians, positive = up
  /** Server tick the client was showing other players at, so hits are judged against what it saw. */
  view?: number;
}

export const EMPTY_INPUT: PlayerInput = {
  forward: 0,
  right: 0,
  jump: false,
  fire: false,
  grapple: false,
  yaw: 0,
  pitch: 0,
};
