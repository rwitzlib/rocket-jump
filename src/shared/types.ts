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
