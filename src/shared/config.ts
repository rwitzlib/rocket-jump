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
