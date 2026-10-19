import type { WeaponId, WeaponSlot } from './types';

// All gameplay tuning lives here. Units are meters and seconds.
// This file is shared so a future server simulates with identical numbers.

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const GRAVITY = 20;

export const PLAYER = {
  radius: 0.4,
  halfHeight: 0.5, // capsule cylinder half-height; total height = 2 * (halfHeight + radius) = 1.8
  eyeOffset: 0.6, // eye height above capsule center
};

// Quake-style movement: ground acceleration + friction, weak air control that still allows air-strafing.
export const MOVE = {
  maxSpeed: 8,
  groundAccel: 10,
  airAccel: 10,
  airWishCap: 1.0, // caps the speed gained per direction in the air (the strafe-jump trick)
  airControl: 1.5, // extra air acceleration toward WASD: steer and brake a little mid-air without losing a rocket jump's speed
  airControlSpeed: 6, // air control only pushes until you're moving this fast that way: half the ground speed
  friction: 6,
  stopSpeed: 2,
  jumpSpeed: 7,
};

export const ROCKET = {
  speed: 30,
  cooldown: 1.0,
  lifetime: 4,
  blastRadius: 4.5,
  knockback: 15, // velocity change at the center of the blast, falls off linearly to 0 at the edge
  selfKnockback: 1.4, // your own rockets launch you this much harder: bigger rocket jumps
  crateKnockback: 12,
  hookRadius: 0.6, // how close a grapple ray has to pass to a rocket to hook it: a bit bigger than it looks
};

// The burst and area-denial weapon: empty a six-shot drum fast, then wait out a long reload. Each
// grenade hits for less than a rocket but over a wider area, and they bounce off walls, so they can
// be banked around corners or left rolling in a doorway until the fuse goes.
export const GRENADE = {
  speed: 24, // launch speed along the aim; gravity bends it from there
  cooldown: 0.3, // between shots while the drum has grenades in it
  drum: 6, // grenades per load
  reload: 2.5, // seconds to refill an empty drum
  lifetime: 2.5, // fuse: explodes on its own if it hasn't hit anyone by then
  radius: 0.12, // collision radius, so it bounces off surfaces instead of sinking into them
  armDistance: 6, // meters flown before it explodes on players. Surfaces it always bounces off
  restitution: 0.55, // fraction of the speed into a surface it bounces back with
  friction: 0.75, // fraction of the speed along a surface it keeps on each bounce
  blastRadius: 5,
  knockback: 14,
  selfKnockback: 1.4,
  crateKnockback: 11,
  damage: 55, // at the center of the blast, falling off linearly. Two close ones kill
  impactDamage: 35, // an unarmed grenade hitting someone point blank: it bounces off them instead of exploding
  impactKnockback: 4, // velocity change from that hit, along the grenade's flight
};

export const GRAPPLE = {
  range: 70,
  pullAccel: 38,
  maxPullSpeed: 28, // stop adding pull once already moving toward the anchor this fast
  minLength: 2,
  stiffness: 30, // how hard the rope corrects when stretched past its length
  cooldown: 0.6, // after letting go (or missing) before the grapple can fire again
  attachHop: 5, // upward kick when the hook lands while you're on the ground, so it can lift you off
  playerTug: 0.6, // a hooked player is pulled toward you at this fraction of your own pull
  cratePull: 0.35, // fraction of the usual pull you get when hooked to a crate; the rest reels the crate in
  crateReelForce: 45, // newtons-ish pulling a hooked crate toward you: light crates fly, stacked ones resist
  hookOwnRockets: true, // your own rocket leaves from your eye along your aim, so it is easy to hook: fire, then grapple to ride it
};

export const CRATE = {
  size: 1.2,
  density: 0.6,
};

export const NET = {
  snapshotInterval: 2, // server ticks per snapshot: 30 Hz
  inputRedundancy: 4, // every input packet repeats the last few inputs, so one lost packet costs nothing
  jitterBuffer: 2, // inputs the server collects from a client before it starts consuming them
  maxInputQueue: 8, // past this the server drops a client's oldest inputs to catch up
  eventWindow: 6, // ticks of past events repeated in each snapshot, so one lost snapshot loses no explosions
};

export const COMBAT = {
  maxHealth: 100,
  rocketDamage: 100, // at the center of the blast, falling off linearly like knockback
  selfDamage: false, // your own rockets never hurt you, so rocket jumping is free
  spawnProtection: 3, // seconds of invulnerability after spawning
  regenDelay: 5, // seconds without taking damage before health starts coming back
  regenRate: 10, // health per second
  respawnDelay: 3,
  killCredit: 5, // falling off the map within this many seconds of being hit counts as a kill for the hitter
};

export const WEAPONS: Record<WeaponId, { slot: WeaponSlot; name: string }> = {
  rocket: { slot: 'primary', name: 'Rocket Launcher' },
  grenade: { slot: 'primary', name: 'Grenade Launcher' },
  grapple: { slot: 'secondary', name: 'Grapple' },
};

/** What everyone spawns with. Mystery boxes swap one slot for something else until you die. */
export const LOADOUT = { primary: 'rocket', secondary: 'grapple' } as const satisfies Record<WeaponSlot, WeaponId>;

/** Floating mystery boxes: walk into one to swap a weapon for one you don't have. */
export const PICKUP = {
  size: 0.8, // cube edge
  reach: 0.5, // how close (beyond the box's half size) your capsule has to get to take it
  respawn: 10, // seconds until a taken box comes back
};
