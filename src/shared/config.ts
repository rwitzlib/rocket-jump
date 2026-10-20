import type { SeekerId, VehicleKind, WeaponId, WeaponSlot } from './types';

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

// The precision weapon: a near-hitscan dart with a tiny blast. A direct hit always lands its full
// damage and a huge shove (enough to launch people off ledges); a near miss barely scratches. It's
// also the best jumping weapon: your own blast reaches further and launches you higher than a rocket.
export const HYPERSONIC = {
  speed: 110, // about 4x a rocket: crosses the arena in a second
  cooldown: 1.6,
  lifetime: 1.5,
  blastRadius: 1.5,
  damage: 90,
  knockback: 26,
  lift: 0.35, // knockback always angles at least this far upward, so a flat hit launches people instead of sliding them
  // Your own darts reach further and push harder, so shooting your feet is a big jump: about 1.5x a rocket jump.
  selfRadius: 3,
  selfKnockback: 1.1,
  crateKnockback: 20,
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

/**
 * Heat-seeking launchers. Hold a player inside the lock box (an area around the crosshair) for
 * `lockTime` to lock on; only then will it fire, and the missile steers after them. Every shot
 * spends the lock, and a new one can't start building until the launcher has reloaded.
 */
export interface SeekerConfig {
  lockTime: number; // seconds a target has to stay in the box
  lockBox: [number, number]; // half-width, half-height of the box, radians off the aim
  lockRange: number;
  lockDecay: number; // lock progress drains this many times faster than it builds while they're out of the box
  cooldown: number; // reload after each shot
  speed: number; // cruising speed
  launchSpeed: number; // speed leaving the tube; the motor brings it up to `speed`
  boost: number; // m/s² the motor adds until it reaches `speed`
  turnRate: number; // radians per second it can steer: lower is easier to dodge
  /**
   * Half-angle of the missile's seeker cone, radians. On its final approach, a target that gets
   * further off the missile's nose than this (a sharp grapple yank when it's close) is lost for
   * good, and the missile flies straight on.
   */
  gimbal: number;
  lifetime: number;
  blastRadius: number;
  damage: number;
  knockback: number;
  selfKnockback: number;
  crateKnockback: number;
}

export const SEEKERS: Record<SeekerId, SeekerConfig & { climb?: number; climbAngle?: number; turnOverRate?: number }> = {
  // Fire and forget, top attack: pops out of the tube slowly, then climbs steeply (`climbAngle`)
  // toward the target to `climb` meters above it (less for close targets), arcs over and dives on
  // them from above, over cover. Long lock, long reload, kills on a clean hit.
  javelin: {
    lockTime: 1.4,
    lockBox: [0.2, 0.14],
    lockRange: 90,
    lockDecay: 2,
    cooldown: 4,
    speed: 24,
    launchSpeed: 7,
    boost: 45,
    turnRate: 3.5,
    gimbal: 0.35,
    lifetime: 7,
    blastRadius: 3.5, // tight: a direct hit kills, but a late grapple out of the dive gets you clear
    damage: 130, // a top-down hit lands near their head, ~1 m off center: still a kill
    knockback: 16,
    selfKnockback: 1.4,
    crateKnockback: 14,
    climb: 16,
    climbAngle: 1.1, // about 63° up
    turnOverRate: 6, // radians per second while arcing over the top: tighter than its turns in the dive
  },
  // Quick lock, quick reload, light hit. Flies straight at the target, fast but wide-turning, so hard
  // strafing or a grapple swing at the last moment can shake it.
  stinger: {
    lockTime: 0.6,
    lockBox: [0.16, 0.11],
    lockRange: 70,
    lockDecay: 3,
    cooldown: 1.2,
    speed: 34,
    launchSpeed: 34,
    boost: 0,
    turnRate: 2.2,
    gimbal: 0.7,
    lifetime: 4,
    blastRadius: 3.5,
    damage: 50,
    knockback: 11,
    selfKnockback: 1.4,
    crateKnockback: 10,
  },
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

/** Bump whenever client and server stop understanding each other; mismatched clients are told to reload. */
export const PROTOCOL_VERSION = 4;

/**
 * - ffa: free-for-all deathmatch, first to the frag limit.
 * - koth: king of the hill. Score a point a second while you're alone on the hill; it moves every minute.
 * - duel: one on one, first to 10. The winner stays on for the next challenger.
 * - instagib: everyone has the Hypersonic and one hit kills. No pickups or items.
 * - elim: elimination rounds, red against blue. No regeneration or respawning mid-round: the last
 *   team standing takes it.
 * - tdm: two teams, first team to the frag limit. No friendly fire (your rockets still shove teammates).
 * - ctf: capture the flag. Take the other team's flag from their base and bring it to yours, while
 *   your own flag is home.
 * - race: a time trial round a loop of checkpoint rings. Nobody can hurt anyone, best lap wins.
 */
export type GameMode = 'ffa' | 'tdm' | 'ctf' | 'race' | 'koth' | 'duel' | 'instagib' | 'elim';

export const MODES: Record<GameMode, { name: string; short: string; teams: boolean; blurb: string }> = {
  ffa: { name: 'Deathmatch', short: 'DM', teams: false, blurb: 'Everyone for themselves. First to the frag limit.' },
  tdm: { name: 'Team Deathmatch', short: 'TDM', teams: true, blurb: 'Red against blue. First team to the frag limit.' },
  ctf: { name: 'Capture the Flag', short: 'CTF', teams: true, blurb: "Grab their flag and bring it home while yours is safe." },
  race: { name: 'Rocket Race', short: 'Race', teams: false, blurb: 'Rocket jump and grapple round the checkpoints. Best lap wins.' },
  koth: { name: 'King of the Hill', short: 'KOTH', teams: false, blurb: 'Stand on the hill alone to score. It moves every minute.' },
  duel: { name: 'Duel', short: 'Duel', teams: false, blurb: 'One on one, first to 10. The winner stays on for the next challenger.' },
  instagib: { name: 'Instagib', short: 'Insta', teams: false, blurb: 'Everyone has a Hypersonic, and one hit kills. No pickups.' },
  elim: { name: 'Elimination', short: 'Elim', teams: true, blurb: 'Rounds, red against blue. No regeneration, no respawns: last team standing takes the round.' },
};

export const TEAMS = [
  { name: 'Red', color: 0xf0503c },
  { name: 'Blue', color: 0x3d8cf0 },
] as const;

/** Team deathmatch frag limits are this many times the map's free-for-all one: kills come from a whole team. */
export const TDM = { fragScale: 1.6 };

export const CTF = {
  captureLimit: 3,
  timeLimit: 10 * 60,
  touchRadius: 1.7, // meters between a player's center and a flag's base for a touch
  returnTime: 20, // seconds a dropped flag lies before it goes home by itself
  carrierSpeedCap: 26, // m/s: a flag carrier's speed is clipped to this, so one rocket jump can't cross the map
};

export const KOTH = {
  scoreLimit: 60, // seconds on the hill to win
  timeLimit: 8 * 60,
  radius: 6, // the hill: a cylinder this wide...
  height: 5, // ...rising this far above its floor (and a meter below, for uneven ground)
  moveEvery: 60, // seconds before it moves to the next spot
};

export const DUEL = { fragLimit: 10, players: 2 };

export const INSTAGIB = {
  killDamage: 30, // a Hypersonic hit doing at least this much (anything close to direct) kills outright
};

export const ELIM = {
  roundLimit: 5, // rounds to win the match
  roundTime: 120, // seconds before a round ends anyway: the team with more people standing takes it
  between: 4, // seconds between rounds
  timeLimit: 20 * 60,
};

export const RACE = {
  timeLimit: 5 * 60,
  ringRadius: 3.2, // pass within this of a checkpoint's center
  respawnDelay: 0.6, // falling off restarts you at the start almost straight away
};

/**
 * Items on the floor, besides mystery boxes. Health tops you up, past full to `max` (overhealth
 * drains back to 100). Armor soaks up `absorb` of each hit until it runs out. Overdrive doubles your
 * damage and knockback on other players for a while: there's one per map, somewhere hard to reach.
 */
export const ITEMS = {
  reach: 1.1, // meters from the item's center to the player's capsule
  health: { amount: 50, max: 150, respawn: 20, decay: 2 }, // decay: overhealth lost per second
  armor: { amount: 50, max: 100, absorb: 2 / 3, respawn: 25 },
  overdrive: { duration: 15, damage: 2, knockback: 1.5, respawn: 60 },
};

/**
 * A match is free-for-all deathmatch: first to the frag limit, or the most kills when time runs out.
 * Then everyone gets the results for `intermission` seconds and the next map in the rotation starts.
 * The server can override all of these (see src/server/main.ts).
 */
export const MATCH = {
  mode: 'ffa' as GameMode,
  timeLimit: 8 * 60, // seconds
  fragLimit: 25,
  intermission: 15, // seconds on the results screen
  minPlayers: 4, // bots fill in up to this many while at least one person is playing
  maxPlayers: 12, // people, not counting bots (who leave to make room)
  multiKillWindow: 3, // seconds between kills for a double / multi kill
};

export const COMBAT = {
  maxHealth: 100,
  rocketDamage: 100, // at the center of the blast, falling off linearly like knockback
  selfDamage: false, // your own rockets never hurt you, so rocket jumping is free
  spawnProtection: 3, // seconds of invulnerability after spawning
  regenDelay: 5, // seconds without taking damage before health starts coming back
  regenRate: 10, // health per second
  respawnDelay: 3.5, // long enough for the killcam
  killCredit: 5, // falling off the map within this many seconds of being hit counts as a kill for the hitter
};

/** `twoHanded`: takes both hands, so the secondary (the grapple) can't be used while carrying it. */
export const WEAPONS: Record<WeaponId, { slot: WeaponSlot; name: string; twoHanded?: boolean }> = {
  rocket: { slot: 'primary', name: 'Rocket Launcher' },
  grenade: { slot: 'primary', name: 'Grenade Launcher' },
  hypersonic: { slot: 'primary', name: 'Hypersonic' },
  javelin: { slot: 'primary', name: 'Javelin', twoHanded: true },
  stinger: { slot: 'primary', name: 'Stinger' },
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

/**
 * A seat in a vehicle. Offsets are in the vehicle's own frame (-Z forward), to the seated player's
 * capsule center. The third-person camera orbits `pivot` meters above the seat at `camDist`, and
 * the crosshair ray starts from that pivot so the sim and the camera agree on what you aim at.
 */
export interface SeatConfig {
  role: 'driver' | 'gunner'; // the driver steers (and flies a helicopter's guns); gunners fire their own weapon
  offset: [number, number, number];
  pivot: number;
  camDist: number;
  hidden: boolean; // inside the body: the model isn't drawn
  exit: [number, number, number]; // where you get out, in the vehicle's frame
}

export interface VehicleConfig {
  name: string;
  size: [number, number, number]; // collider full extents: width, height, length
  health: number;
  respawn: number; // seconds after being destroyed before it's back on its pad
  seats: SeatConfig[];
  enterRange: number; // how close to its center you have to be to get in
  maxSpeed: number;
  accel: number; // m/s²
  turnRate: number; // radians per second at full lock
  knockback: number; // fraction of a blast's push it takes: heavier than a player
  crashSpeed: number; // landing faster than this damages it
}

export const CAR = {
  name: 'Buggy',
  size: [2.4, 1.3, 4.2],
  health: 300,
  respawn: 15,
  enterRange: 4,
  seats: [
    { role: 'driver', offset: [0, 0.2, 0.2], pivot: 2.2, camDist: 7.5, hidden: true, exit: [-2.2, 0.3, 0] },
    // stands on the rear deck behind the roll bar, exposed
    { role: 'gunner', offset: [0, 1.55, 1.3], pivot: 1.2, camDist: 4.5, hidden: false, exit: [2.2, 0.3, 1] },
  ],
  maxSpeed: 26,
  reverseSpeed: 9,
  accel: 14,
  brake: 30,
  coast: 3, // m/s² of rolling resistance with no throttle
  turnRate: 2.1,
  fullTurnSpeed: 7, // below this, steering is proportionally weaker: no spinning on the spot
  grip: 7, // 1/s: how fast sideways sliding dies out on the ground
  knockback: 0.45,
  crashSpeed: 24,
  ramSpeed: 7, // hitting a player faster than this knocks them flying
  ramDamage: 5, // per m/s over ramSpeed
  ramKnockback: 0.8, // fraction of the car's speed they're launched at, plus ramLift upward
  ramLift: 7,
} satisfies VehicleConfig & Record<string, unknown>;

export const HELI = {
  name: 'Helicopter',
  size: [2.6, 2.2, 5.6],
  health: 300,
  respawn: 20,
  enterRange: 5,
  seats: [
    { role: 'driver', offset: [0, 0, -1], pivot: 3, camDist: 13, hidden: true, exit: [-2.6, -0.4, 0] },
    // sitting in the open side door
    { role: 'gunner', offset: [1.9, -0.1, 0.2], pivot: 1, camDist: 5, hidden: false, exit: [2.8, -0.4, 0.2] },
  ],
  maxSpeed: 28,
  accel: 16,
  climbSpeed: 10,
  climbAccel: 14,
  drag: 1.2, // 1/s: how fast it drifts to a stop with the stick centered
  ceiling: 75, // m above the ground it can't climb past
  turnRate: 2.0, // the nose follows your view at this rate
  knockback: 0.3,
  crashSpeed: 16,
  tilt: 0.03, // radians of visual pitch/roll per m/s² of acceleration
  // Rocket pods (left click): quick alternating volleys, lighter hits than a rocket launcher.
  podCooldown: 0.16,
  podSpeed: 60,
  podLifetime: 3,
  podPower: 0.4, // damage and knockback relative to a rocket
  // Heat seeker (right click): locks like a Stinger, then fires one of its missiles.
  missileCooldown: 3,
} satisfies VehicleConfig & Record<string, unknown>;

export const VEHICLES: Record<VehicleKind, VehicleConfig> = { car: CAR, heli: HELI };

/** Damage to vehicles relative to players. Either vehicle takes three direct rockets. */
export const VEHICLE_DAMAGE = 1;
