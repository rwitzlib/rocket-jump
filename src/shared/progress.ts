import type { GameMode } from './config';
import type { DeathCause } from './projectile';

// Progression for online play: experience and levels, lifetime stats, daily and weekly challenges,
// and the cosmetics levels unlock. Everything here is plain data and pure functions; the dedicated
// server keeps profiles (src/server/store.ts) and the game server reports what happened (StatEvent).
//
// There are no accounts. A browser makes up a secret key the first time it plays online and sends it
// when joining; the server knows the profile by a hash of it. Lose the key (clear site data) and the
// profile is gone, which is the price of no sign-up.

// --- levels -----------------------------------------------------------------------------------

/** Total XP to reach a level: 100 for level 2, 300 for 3, 600 for 4... 50 L (L - 1). */
export const xpForLevel = (level: number) => 50 * level * (level - 1);

export function levelOf(xp: number): number {
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level++;
  return level;
}

/** XP for each thing, before challenges. */
export const XP = {
  kill: 10,
  airshot: 15, // on top of the kill
  capture: 50,
  lap: 5,
  bestLap: 15, // a new personal best, on top of the lap
  matchPlayed: 25,
  matchWon: 75, // on top of playing it
  podium: 25, // second or third
};

// --- cosmetics --------------------------------------------------------------------------------

/** Armor colors, worn outside team modes (teams wear their team's). `auto` picks one from your id. */
export const TINTS = [
  { id: 'auto', name: 'Random', color: 0, level: 1 },
  { id: 'blue', name: 'Blue', color: 0x3d9cf0, level: 1 },
  { id: 'orange', name: 'Orange', color: 0xf0a830, level: 1 },
  { id: 'purple', name: 'Purple', color: 0xa860f0, level: 3 },
  { id: 'green', name: 'Green', color: 0x40c878, level: 5 },
  { id: 'pink', name: 'Pink', color: 0xf05a80, level: 7 },
  { id: 'teal', name: 'Teal', color: 0x30c8d0, level: 9 },
  { id: 'white', name: 'Arctic', color: 0xe4eaf2, level: 12 },
  { id: 'black', name: 'Stealth', color: 0x30343e, level: 15 },
  { id: 'gold', name: 'Gold', color: 0xe8b830, level: 20 },
  // Premium: bought rather than earned (see PREMIUM). Prices in US cents.
  { id: 'crimson', name: 'Crimson', color: 0xc8202c, level: 1, price: 199 },
  { id: 'neon', name: 'Neon', color: 0x9cff3a, level: 1, price: 199 },
  { id: 'midnight', name: 'Midnight', color: 0x283a9a, level: 1, price: 199 },
] as const;

/** A lifetime count that unlocks skins (as well as levels). */
export type StatKey = keyof Stats;

/** Seasonal events, by UTC month and day (inclusive; one may run over New Year). */
export const SEASONS = {
  halloween: { name: 'Halloween', from: [10, 15], to: [11, 7] },
  winter: { name: 'Winter', from: [12, 1], to: [1, 15] },
  newyear: { name: 'New Year', from: [12, 26], to: [1, 7] },
} as const;
export type Season = keyof typeof SEASONS;

/** The seasons on at a time. */
export function seasonsAt(t: number): Season[] {
  const d = new Date(t);
  const md = (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  return (Object.keys(SEASONS) as Season[]).filter((k) => {
    const { from, to } = SEASONS[k];
    const a = from[0] * 100 + from[1];
    const b = to[0] * 100 + to[1];
    return a <= b ? md >= a && md <= b : md >= a || md <= b;
  });
}

// Skins are earned by level, by a lifetime count reaching a number (`stat`), or by playing a match
// during a season (`season`); premium ones (`price`, US cents) are bought instead.

/**
 * Rocket trails: the flame's two colors and the smoke's. Most also draw shapes of their own (the
 * client's recipes, src/client/skinfx.ts); these colors are the plain trail under them.
 */
export const TRAILS = [
  { id: 'classic', name: 'Classic', fire: [0xffd080, 0xff5010], smoke: [0xd8d4d0, 0x8a8682], level: 1 },
  { id: 'ember', name: 'Ember', fire: [0xff9060, 0xd01010], smoke: [0x8a6a60, 0x3a2a28], level: 2 },
  { id: 'contrail', name: 'Contrail', fire: [0xffffff, 0xd0e0ff], smoke: [0xffffff, 0xe0e8f0], level: 3 },
  { id: 'toxic', name: 'Toxic', fire: [0xd0ff80, 0x30c020], smoke: [0xa0d090, 0x507040], level: 4 },
  { id: 'plasma', name: 'Plasma', fire: [0xe0c0ff, 0x8030ff], smoke: [0xb0a0e0, 0x504080], level: 6 },
  { id: 'frost', name: 'Frost', fire: [0xe0fcff, 0x40b0ff], smoke: [0xe8f4ff, 0x9ab8d0], level: 8 },
  { id: 'ash', name: 'Ash', fire: [0xffb070, 0xa03010], smoke: [0x707070, 0x303030], level: 10 },
  { id: 'gold', name: 'Gilded', fire: [0xfff0a0, 0xe0a010], smoke: [0xe8d8a0, 0x9a8040], level: 11 },
  { id: 'sparkler', name: 'Sparkler', fire: [0xffffff, 0xffc040], smoke: [0xe0dcd0, 0x9a968a], level: 13 },
  { id: 'void', name: 'Void', fire: [0xff60e0, 0x200830], smoke: [0x302030, 0x100810], level: 14 },
  { id: 'dustdevil', name: 'Dust Devil', fire: [0xffd8a0, 0xc08040], smoke: [0xd8c0a0, 0x907860], level: 16 },
  { id: 'comet', name: 'Comet', fire: [0xffffff, 0x60c0ff], smoke: [0xc8e8ff, 0x6080b0], level: 18 },
  { id: 'pixel', name: 'Pixel', fire: [0xffffff, 0xff4080], smoke: [0xd0d0f0, 0x8080b0], level: 22 },
  { id: 'rainbow', name: 'Rainbow', fire: [0xffffff, 0xff0000], smoke: [0xf0f0f0, 0xb0b0b0], level: 25 },
  { id: 'afterburner', name: 'Afterburner', fire: [0xffffff, 0x3080ff], smoke: [0xd0d8e8, 0x7080a0], level: 30 },
  { id: 'starlight', name: 'Starlight', fire: [0xffffff, 0xa0c0ff], smoke: [0xc0c8e8, 0x505878], level: 40 },
  { id: 'solarflare', name: 'Solar Flare', fire: [0xffffff, 0xff6000], smoke: [0xffd0a0, 0xa05020], level: 50 },
  // Earned by doing things.
  { id: 'skywriter', name: 'Sky Writer', fire: [0xffffff, 0xe0e8ff], smoke: [0xffffff, 0xf0f0f4], level: 1, stat: ['airshots', 100] },
  { id: 'scarf', name: 'Hero Scarf', fire: [0xffe0c0, 0xff4020], smoke: [0xd8d4d0, 0x8a8682], level: 1, stat: ['rocketJumps', 1000] },
  { id: 'checkered', name: 'Checkered Flag', fire: [0xffffff, 0x404040], smoke: [0xe8e8e8, 0x909090], level: 1, stat: ['laps', 250] },
  { id: 'stopwatch', name: 'Stopwatch', fire: [0xffffff, 0x40e0ff], smoke: [0xd8e4ec, 0x8898a8], level: 1, stat: ['personalBests', 25] },
  { id: 'flagbearer', name: 'Flag Bearer', fire: [0xffffff, 0xe03040], smoke: [0xe8e8f0, 0x9098b0], level: 1, stat: ['captures', 25] },
  { id: 'crown', name: 'Crown Jewels', fire: [0xfff4c0, 0xffb020], smoke: [0xf0e0b0, 0xa08850], level: 1, stat: ['kothWins', 25] },
  { id: 'confetti', name: 'Confetti', fire: [0xffffff, 0xff60c0], smoke: [0xe8e0f0, 0xa098b0], level: 1, stat: ['dailies', 30] },
  { id: 'medal', name: 'Medal Ribbon', fire: [0xfff0a0, 0x2050d0], smoke: [0xe0e4f0, 0x8890b0], level: 1, stat: ['weeklies', 10] },
  { id: 'training', name: 'Training Wheels', fire: [0xffffff, 0xd0d0d0], smoke: [0xf0f0f0, 0xc0c0c0], level: 1, stat: ['matches', 1] },
  { id: 'bats', name: 'Bat Swarm', fire: [0xffc060, 0xff6000], smoke: [0x403848, 0x181420], level: 1, season: 'halloween' },
  { id: 'snowfall', name: 'Snowfall', fire: [0xffffff, 0xa0d8ff], smoke: [0xf4f8ff, 0xc8d8e8], level: 1, season: 'winter' },
  // Premium.
  { id: 'sunburst', name: 'Sunburst', fire: [0xfff4b0, 0xff3d7f], smoke: [0xffc0d8, 0xa05070], level: 1, price: 299 },
  { id: 'aurora', name: 'Aurora', fire: [0xc0fff0, 0x20e0a0], smoke: [0xb0e0ff, 0x6040a0], level: 1, price: 299 },
  { id: 'inferno', name: 'Inferno', fire: [0xffffff, 0xff2000], smoke: [0x404040, 0x101010], level: 1, price: 299 },
  { id: 'lightning', name: 'Lightning', fire: [0xffffff, 0x5a9cff], smoke: [0xc8d8ff, 0x4a5a90], level: 1, price: 499 },
  { id: 'bubbles', name: 'Bubbles', fire: [0xe8ffff, 0x60d8ff], smoke: [0xe0f8ff, 0x90c8e8], level: 1, price: 299 },
  { id: 'clouds', name: 'Cartoon Clouds', fire: [0xffffff, 0xfff0d0], smoke: [0xffffff, 0xe8ecf4], level: 1, price: 299 },
  { id: 'hearts', name: 'Hearts', fire: [0xffe0f0, 0xff4090], smoke: [0xffd0e0, 0xd08098], level: 1, price: 199 },
  { id: 'notes', name: 'Musical Notes', fire: [0xffffff, 0xa060ff], smoke: [0xe0d8f0, 0x9088b0], level: 1, price: 299 },
  { id: 'paint', name: 'Paint Splat', fire: [0xffffff, 0xff40a0], smoke: [0xf0e0f0, 0xb090b0], level: 1, price: 499 },
  { id: 'fireworks', name: 'Fireworks', fire: [0xffffff, 0xffa040], smoke: [0xd8d0c8, 0x807870], level: 1, price: 399 },
  { id: 'sakura', name: 'Cherry Blossom', fire: [0xfff0f4, 0xff90b0], smoke: [0xffe0ec, 0xd0a0b0], level: 1, price: 299 },
  { id: 'leaves', name: 'Autumn Leaves', fire: [0xffe0a0, 0xe06010], smoke: [0xd8c0a0, 0x907050], level: 1, price: 299 },
  { id: 'ink', name: 'Ink Brush', fire: [0x808080, 0x101010], smoke: [0x202020, 0x080808], level: 1, price: 399 },
  { id: 'glitch', name: 'Glitch', fire: [0xffffff, 0x00ffd0], smoke: [0x404050, 0x101018], level: 1, price: 499 },
  { id: 'digitalrain', name: 'Digital Rain', fire: [0xd0ffd0, 0x20ff60], smoke: [0x204020, 0x081008], level: 1, price: 399 },
  { id: 'hologram', name: 'Hologram', fire: [0xe0ffff, 0x20e0ff], smoke: [0x80e0ff, 0x204860], level: 1, price: 399 },
  { id: 'neon', name: 'Neon Tube', fire: [0xffe0ff, 0xff30c0], smoke: [0x302040, 0x100818], level: 1, price: 299 },
  { id: 'dragon', name: 'Dragon', fire: [0xfff0a0, 0xff3000], smoke: [0x503028, 0x201010], level: 1, price: 699 },
  { id: 'phoenix', name: 'Phoenix', fire: [0xfff8c0, 0xff5000], smoke: [0xffb060, 0x803010], level: 1, price: 499 },
  { id: 'ghost', name: 'Ghost', fire: [0xe8fff8, 0x80ffd0], smoke: [0xd8f0ec, 0x7090a0], level: 1, price: 299 },
  { id: 'cash', name: 'Make It Rain', fire: [0xf0ffe0, 0x60c040], smoke: [0xd8e8d0, 0x88a080], level: 1, price: 299 },
  { id: 'sprinkles', name: 'Sprinkles', fire: [0xffffff, 0xff80c0], smoke: [0xfff0f8, 0xd0b0c0], level: 1, price: 199 },
  { id: 'ducks', name: 'Rubber Ducks', fire: [0xfff8c0, 0xffc000], smoke: [0xe0f4ff, 0x90b8d0], level: 1, price: 299 },
  { id: 'smokerings', name: 'Smoke Rings', fire: [0xffe0b0, 0xff8040], smoke: [0xe0dcd8, 0x9a9692], level: 1, price: 299 },
  { id: 'blackhole', name: 'Black Hole', fire: [0xffd0ff, 0x6020ff], smoke: [0x100818, 0x000000], level: 1, price: 599 },
  { id: 'lava', name: 'Molten Lava', fire: [0xffe080, 0xff3000], smoke: [0x302020, 0x100808], level: 1, price: 399 },
  { id: 'slime', name: 'Slime', fire: [0xe0ffa0, 0x60e020], smoke: [0x90d060, 0x406020], level: 1, price: 299 },
  { id: 'galaxy', name: 'Galaxy', fire: [0xffffff, 0xc060ff], smoke: [0x502080, 0x101040], level: 1, price: 399 },
  { id: 'blueprint', name: 'Blueprint', fire: [0xffffff, 0x80c0ff], smoke: [0x2050a0, 0x103060], level: 1, price: 299 },
  { id: 'soundwave', name: 'Sound Wave', fire: [0xffffff, 0x40ffe0], smoke: [0x305060, 0x102030], level: 1, price: 299 },
  { id: 'fairydust', name: 'Fairy Dust', fire: [0xffffff, 0xffa0ff], smoke: [0xf8e8ff, 0xc0a0d0], level: 1, price: 199 },
  { id: 'cranes', name: 'Origami Cranes', fire: [0xffffff, 0xff8060], smoke: [0xf8f0e8, 0xc0b0a0], level: 1, price: 399 },
  { id: 'bees', name: 'Bees', fire: [0xfff0a0, 0xffb000], smoke: [0xe8dcb0, 0xa09060], level: 1, price: 299 },
] as const;

/** Explosions: how your blasts look. `color` is the menu's swatch. */
export const EXPLOSIONS = [
  { id: 'classic', name: 'Classic', color: 0xff8a30, level: 1 },
  { id: 'smoky', name: 'Smoky', color: 0x6a6460, level: 2 },
  { id: 'firecracker', name: 'Firecracker', color: 0xff4040, level: 5 },
  { id: 'flashpop', name: 'Flashpop', color: 0xfff4d0, level: 9 },
  { id: 'dirtkick', name: 'Dirt Kick', color: 0x8a6a48, level: 12 },
  { id: 'shockwave', name: 'Shockwave', color: 0xc0e0ff, level: 17 },
  { id: 'sparkshower', name: 'Spark Shower', color: 0xffc040, level: 19 },
  { id: 'mushroom', name: 'Mini Mushroom', color: 0xd06030, level: 24 },
  { id: 'supernova', name: 'Supernova', color: 0xfff0ff, level: 35 },
  { id: 'bigbang', name: 'Big Bang', color: 0x8060ff, level: 50 },
  // Earned by doing things.
  { id: 'airburst', name: 'Airburst', color: 0x80d0ff, level: 1, stat: ['airshots', 250] },
  { id: 'doubletap', name: 'Double Tap', color: 0xff6020, level: 1, stat: ['multikills', 25] },
  { id: 'bullseye', name: 'Bullseye', color: 0xff2030, level: 1, stat: ['directHits', 100] },
  { id: 'goldrush', name: 'Gold Rush', color: 0xffc820, level: 1, stat: ['wins', 100] },
  { id: 'banner', name: 'Banner Burst', color: 0x3070ff, level: 1, stat: ['captures', 50] },
  { id: 'burnout', name: 'Burnout', color: 0x505050, level: 1, stat: ['laps', 250] },
  { id: 'sawdust', name: 'Sawdust', color: 0xc8a070, level: 1, stat: ['botKills', 50] },
  { id: 'meteor', name: 'Meteor Impact', color: 0xa04020, level: 1, stat: ['weeklies', 10] },
  { id: 'jackolantern', name: "Jack-o'-Lantern", color: 0xff8000, level: 1, season: 'halloween' },
  { id: 'snowglobe', name: 'Snow Globe', color: 0xe0f4ff, level: 1, season: 'winter' },
  { id: 'finale', name: 'Grand Finale', color: 0xff40c0, level: 1, season: 'newyear' },
  // Premium.
  { id: 'thunderclap', name: 'Thunderclap', color: 0x5a9cff, level: 1, price: 499 },
  { id: 'bubblepop', name: 'Bubble Pop', color: 0x60d8ff, level: 1, price: 299 },
  { id: 'kaboom', name: 'Kaboom!', color: 0xffe020, level: 1, price: 399 },
  { id: 'tooncloud', name: 'Toon Cloud', color: 0xf4f4f4, level: 1, price: 299 },
  { id: 'tesla', name: 'Tesla', color: 0x80a0ff, level: 1, price: 499 },
  { id: 'blackhole', name: 'Black Hole', color: 0x401060, level: 1, price: 599 },
  { id: 'portal', name: 'Portal', color: 0xa040ff, level: 1, price: 499 },
  { id: 'confetti', name: 'Confetti Cannon', color: 0xff60c0, level: 1, price: 299 },
  { id: 'pinata', name: 'Piñata', color: 0xff9020, level: 1, price: 299 },
  { id: 'paint', name: 'Paint Bomb', color: 0xff40a0, level: 1, price: 399 },
  { id: 'glitter', name: 'Glitter Bomb', color: 0xffa0ff, level: 1, price: 199 },
  { id: 'ink', name: 'Ink Splash', color: 0x181818, level: 1, price: 299 },
  { id: 'glitch', name: 'Glitch', color: 0x00ffd0, level: 1, price: 499 },
  { id: 'eightbit', name: '8-Bit', color: 0xff8000, level: 1, price: 299 },
  { id: 'hologram', name: 'Hologram', color: 0x20e0ff, level: 1, price: 399 },
  { id: 'fruit', name: 'Fruit Splat', color: 0xff3050, level: 1, price: 299 },
  { id: 'pillow', name: 'Pillow Burst', color: 0xf8f4ec, level: 1, price: 199 },
  { id: 'ducks', name: 'Duck Scatter', color: 0xffd000, level: 1, price: 299 },
  { id: 'disco', name: 'Disco', color: 0xd0a0ff, level: 1, price: 399 },
  { id: 'drumroll', name: 'Drumroll', color: 0xa060ff, level: 1, price: 299 },
  { id: 'ice', name: 'Ice Shatter', color: 0xa0e0ff, level: 1, price: 399 },
  { id: 'lava', name: 'Lava Burst', color: 0xff4000, level: 1, price: 399 },
  { id: 'dragon', name: 'Dragon Breath', color: 0xff3000, level: 1, price: 699 },
  { id: 'phoenix', name: 'Phoenix Rebirth', color: 0xff8000, level: 1, price: 599 },
  { id: 'galaxy', name: 'Galaxy', color: 0xc060ff, level: 1, price: 399 },
  { id: 'ghost', name: 'Ghost Wail', color: 0x80ffd0, level: 1, price: 299 },
  { id: 'origami', name: 'Origami', color: 0xff8060, level: 1, price: 399 },
  { id: 'sakura', name: 'Sakura Storm', color: 0xff90b0, level: 1, price: 299 },
  { id: 'slime', name: 'Slime Splat', color: 0x60e020, level: 1, price: 299 },
  { id: 'divine', name: 'Divine', color: 0xfff0b0, level: 1, price: 499 },
] as const;

/**
 * Sets: a trail and an explosion that go together, sold as one for less than the two. Buying one
 * owns the set's sku, which counts as owning each skin in it (see ownedSkus), so a refund takes
 * both back.
 */
export const SETS = [
  { id: 'storm', name: 'Storm', skus: ['trail:lightning', 'explosion:thunderclap'], price: 749 },
  { id: 'bubbles', name: 'Bubble', skus: ['trail:bubbles', 'explosion:bubblepop'], price: 449 },
  { id: 'dragon', name: 'Dragon', skus: ['trail:dragon', 'explosion:dragon'], price: 999 },
  { id: 'phoenix', name: 'Phoenix', skus: ['trail:phoenix', 'explosion:phoenix'], price: 799 },
  { id: 'blackhole', name: 'Black Hole', skus: ['trail:blackhole', 'explosion:blackhole'], price: 899 },
  { id: 'glitch', name: 'Glitch', skus: ['trail:glitch', 'explosion:glitch'], price: 749 },
  { id: 'paint', name: 'Paint', skus: ['trail:paint', 'explosion:paint'], price: 649 },
  { id: 'toon', name: 'Cartoon', skus: ['trail:clouds', 'explosion:tooncloud'], price: 449 },
  { id: 'ink', name: 'Ink', skus: ['trail:ink', 'explosion:ink'], price: 499 },
  { id: 'hologram', name: 'Hologram', skus: ['trail:hologram', 'explosion:hologram'], price: 599 },
  { id: 'galaxy', name: 'Galaxy', skus: ['trail:galaxy', 'explosion:galaxy'], price: 599 },
  { id: 'lava', name: 'Lava', skus: ['trail:lava', 'explosion:lava'], price: 599 },
  { id: 'origami', name: 'Origami', skus: ['trail:cranes', 'explosion:origami'], price: 599 },
  { id: 'ghost', name: 'Ghost', skus: ['trail:ghost', 'explosion:ghost'], price: 449 },
  { id: 'sakura', name: 'Sakura', skus: ['trail:sakura', 'explosion:sakura'], price: 449 },
  { id: 'slime', name: 'Slime', skus: ['trail:slime', 'explosion:slime'], price: 449 },
  { id: 'ducks', name: 'Rubber Duck', skus: ['trail:ducks', 'explosion:ducks'], price: 449 },
] as const;

/**
 * Premium skins, the ones sold in the shop: a level doesn't unlock them, buying one does (with a
 * Discord sign-in, so it isn't lost with the browser's key). A profile's `owned` lists their skus.
 */
export interface PremiumSkin {
  sku: string; // "tint:crimson"
  kind: 'tint' | 'trail' | 'explosion' | 'set';
  id: string;
  name: string; // "Crimson armor"
  price: number; // US cents
  /** A set's skins. */
  skus?: readonly string[];
}

const priced = <T extends object>(item: T): item is T & { price: number } => 'price' in item;

export const PREMIUM: PremiumSkin[] = [
  ...TINTS.filter(priced).map((t) => ({ sku: `tint:${t.id}`, kind: 'tint' as const, id: t.id, name: `${t.name} armor`, price: t.price })),
  ...TRAILS.filter(priced).map((t) => ({ sku: `trail:${t.id}`, kind: 'trail' as const, id: t.id, name: `${t.name} trail`, price: t.price })),
  ...EXPLOSIONS.filter(priced).map((t) => ({ sku: `explosion:${t.id}`, kind: 'explosion' as const, id: t.id, name: `${t.name} explosion`, price: t.price })),
  ...SETS.map((s) => ({ sku: `set:${s.id}`, kind: 'set' as const, id: s.id, name: `${s.name} set`, price: s.price, skus: s.skus })),
];

/** The skus a profile's purchases let it wear: what it bought, and what's in the sets it bought. */
export function ownedSkus(owned: readonly string[] = []): string[] {
  const sets = PREMIUM.filter((s) => s.skus && owned.includes(s.sku));
  return [...new Set([...owned, ...sets.flatMap((s) => s.skus!)])];
}

/** Whether buying a sku would add nothing: it's owned, or (a set) everything in it is. */
export function hasAll(sku: string, owned: readonly string[] = []): boolean {
  const have = ownedSkus(owned);
  const skus = PREMIUM.find((s) => s.sku === sku)?.skus;
  return have.includes(sku) || (!!skus && skus.every((s) => have.includes(s)));
}

/** What earns a skin besides its level, if anything: a lifetime count, or a season. */
export const statUnlock = (item: object) => ('stat' in item ? (item.stat as readonly [StatKey, number]) : null);
export const seasonUnlock = (item: object) => ('season' in item ? (item.season as Season) : null);

/** What a profile has done toward skins, as far as unlocking them goes. */
export interface Progress {
  stats?: Partial<Stats>;
  /** Seasons played in ("season:halloween"). */
  earned?: readonly string[];
}

/** Whether a skin can be worn: premium ones once bought, others once their level, count or season is reached. */
function wearable(kind: Exclude<PremiumSkin['kind'], 'set'>, item: object & { id: string; level: number }, level: number, owned: readonly string[], progress: Progress): boolean {
  if (item.level > level) return false;
  if (priced(item)) return ownedSkus(owned).includes(`${kind}:${item.id}`);
  const stat = statUnlock(item);
  if (stat && (progress.stats?.[stat[0]] ?? 0) < stat[1]) return false;
  const season = seasonUnlock(item);
  return !season || !!progress.earned?.includes(`season:${season}`);
}

export const formatPrice = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export type TintId = (typeof TINTS)[number]['id'];
export type TrailId = (typeof TRAILS)[number]['id'];
export type ExplosionId = (typeof EXPLOSIONS)[number]['id'];

/** What a player wears (their skins), as it goes over the wire: "tint/trail/explosion". */
export interface Look {
  tint: TintId;
  trail: TrailId;
  explosion: ExplosionId;
}

export const DEFAULT_LOOK: Look = { tint: 'auto', trail: 'classic', explosion: 'classic' };

export const encodeLook = (look: Look) => `${look.tint}/${look.trail}/${look.explosion}`;

export function decodeLook(text: string | undefined): Look {
  const [tint, trail, explosion] = (text ?? '').split('/');
  return {
    tint: TINTS.find((t) => t.id === tint)?.id ?? 'auto',
    trail: TRAILS.find((t) => t.id === trail)?.id ?? 'classic',
    explosion: EXPLOSIONS.find((t) => t.id === explosion)?.id ?? 'classic',
  };
}

/**
 * A look this level (and these purchases, counts and seasons) may wear; anything locked, not bought
 * (or refunded), or missing (from before it existed) goes back to the default.
 */
export function allowedLook(look: Partial<Look>, level: number, owned: readonly string[] = [], progress: Progress = {}): Look {
  const tint = TINTS.find((t) => t.id === look.tint && wearable('tint', t, level, owned, progress))?.id ?? 'auto';
  const trail = TRAILS.find((t) => t.id === look.trail && wearable('trail', t, level, owned, progress))?.id ?? 'classic';
  const explosion = EXPLOSIONS.find((t) => t.id === look.explosion && wearable('explosion', t, level, owned, progress))?.id ?? 'classic';
  return { tint, trail, explosion };
}

/** A look a profile may wear, as far as everything it's done allows. */
export const lookFor = (p: Profile, look: Partial<Look>): Look => allowedLook(look, levelOf(p.xp), p.owned, p);

/** The skins a profile has earned by counts and seasons (not levels), by name: for noticing new ones. */
function earnedSkins(p: Profile): string[] {
  const level = levelOf(p.xp);
  const earns = (t: object) => !!(statUnlock(t) || seasonUnlock(t));
  return [
    ...TRAILS.filter((t) => earns(t) && wearable('trail', t, level, [], p)).map((t) => `${t.name} trail`),
    ...EXPLOSIONS.filter((t) => earns(t) && wearable('explosion', t, level, [], p)).map((t) => `${t.name} explosion`),
  ];
}

/** Skins that unlock on reaching exactly this level, for the level-up message. */
export function unlocksAt(level: number): string[] {
  return [
    ...TINTS.filter((t) => t.level === level && !priced(t)).map((t) => `${t.name} armor`),
    ...TRAILS.filter((t) => t.level === level && !priced(t) && !statUnlock(t) && !seasonUnlock(t)).map((t) => `${t.name} trail`),
    ...EXPLOSIONS.filter((t) => t.level === level && level > 1 && !priced(t) && !statUnlock(t) && !seasonUnlock(t)).map((t) => `${t.name} explosion`),
  ];
}

// --- what the game server reports -------------------------------------------------------------

export type StatEvent =
  | { type: 'kill'; airshot: boolean; cause: DeathCause; streak: number; bot?: boolean }
  | { type: 'rocketJump' } // blown up by your own blast, hard enough to fly
  | { type: 'directHit' } // hitting someone with the heart of a blast
  | { type: 'multikill' } // a kill hard on the heels of your last one
  | { type: 'death' }
  | { type: 'capture' }
  | { type: 'lap'; map: string; time: number; best: boolean; path: number[] }
  | { type: 'match'; mode: GameMode; won: boolean; place: number; players: number };

// --- challenges -------------------------------------------------------------------------------

export interface ChallengeDef {
  id: string;
  text: (n: number) => string;
  /** How much an event counts toward it (0 for none). */
  counts: (e: StatEvent) => number;
  daily: number; // target for a daily one
  weekly: number;
}

/** Kills in one life for the streak challenge (counted separately: the kill that brings a streak to this). */
const STREAK = 5;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const killWith = (causes: DeathCause[]) => (e: StatEvent) => (e.type === 'kill' && causes.includes(e.cause) ? 1 : 0);

export const CHALLENGES: ChallengeDef[] = [
  { id: 'kills', text: (n) => `Get ${n} kills`, counts: (e) => (e.type === 'kill' ? 1 : 0), daily: 15, weekly: 100 },
  { id: 'airshots', text: (n) => `Kill ${plural(n, 'player')} in midair`, counts: (e) => (e.type === 'kill' && e.airshot ? 1 : 0), daily: 3, weekly: 20 },
  { id: 'matches', text: (n) => `Finish ${plural(n, 'match', 'matches')}`, counts: (e) => (e.type === 'match' ? 1 : 0), daily: 3, weekly: 15 },
  { id: 'wins', text: (n) => `Win ${plural(n, 'match', 'matches')} (or be on the winning team)`, counts: (e) => (e.type === 'match' && e.won ? 1 : 0), daily: 1, weekly: 6 },
  { id: 'captures', text: (n) => `Capture ${plural(n, 'flag')}`, counts: (e) => (e.type === 'capture' ? 1 : 0), daily: 1, weekly: 6 },
  { id: 'laps', text: (n) => `Fly ${plural(n, 'race lap')}`, counts: (e) => (e.type === 'lap' ? 1 : 0), daily: 5, weekly: 30 },
  { id: 'grenades', text: (n) => `Get ${plural(n, 'grenade kill')}`, counts: killWith(['grenade']), daily: 3, weekly: 20 },
  { id: 'hypersonic', text: (n) => `Get ${plural(n, 'Hypersonic kill')}`, counts: killWith(['hypersonic']), daily: 3, weekly: 20 },
  { id: 'seekers', text: (n) => `Get ${plural(n, 'kill')} with a heat seeker`, counts: killWith(['javelin', 'stinger']), daily: 2, weekly: 12 },
  { id: 'falls', text: (n) => `Knock ${plural(n, 'player')} off the map`, counts: killWith(['fall']), daily: 3, weekly: 20 },
  { id: 'streak', text: (n) => (n === 1 ? `Get ${STREAK} kills without dying` : `Get ${STREAK} kills without dying, ${n} times`), counts: () => 0, daily: 1, weekly: 5 },
];
const streakCounts = (e: StatEvent) => (e.type === 'kill' && e.streak === STREAK ? 1 : 0);

export const CHALLENGE_XP = { daily: 150, weekly: 600 };
const PER_PERIOD = 3;

/** "2026-10-19" for a date, in UTC: everyone's day turns over together. */
export const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The Monday that starts this UTC week, as a day key. */
export function weekKey(t: number): string {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7; // Monday 0
  return dayKey(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** The period's challenges, the same for everybody: three picked by the date. */
export function challengesFor(period: string): ChallengeDef[] {
  const pool = [...CHALLENGES];
  const out: ChallengeDef[] = [];
  let h = hash(period);
  while (out.length < PER_PERIOD) {
    out.push(pool.splice(h % pool.length, 1)[0]);
    h = hash(`${h}`);
  }
  return out;
}

export const challengeText = (def: ChallengeDef, target: number) => def.text(target);

// --- profiles ---------------------------------------------------------------------------------

export interface Stats {
  kills: number;
  deaths: number;
  airshots: number;
  captures: number;
  matches: number;
  wins: number;
  laps: number;
  bestStreak: number;
  // (Added later: a profile from before has none of these, so read them as 0 when missing.)
  rocketJumps: number;
  directHits: number;
  multikills: number;
  kothWins: number;
  botKills: number;
  dailies: number; // daily challenges completed
  weeklies: number;
  personalBests: number; // laps beating your own best
}

export interface Profile {
  id: string; // public: a hash of the secret key
  name: string;
  created: number;
  seen: number;
  xp: number;
  stats: Stats;
  look: Look;
  /** Progress on the current day's and week's challenges, by position in challengesFor(period). */
  daily: { period: string; progress: number[] };
  weekly: { period: string; progress: number[] };
  bestLaps: Record<string, number>; // map -> seconds
  /** The Discord account it's tied to, once they sign in (optional: only buying needs it). */
  account?: { provider: 'discord'; id: string; name: string };
  /** Premium skins bought, by sku. */
  owned?: string[];
  /** Seasons played a match in ("season:halloween"), which unlock that season's skins for good. */
  earned?: string[];
}

/** The look a profile wears right now, as far as its level and purchases allow. */
export const wornLook = (p: Profile): Look => lookFor(p, p.look);

export function newProfile(id: string, name: string, now: number): Profile {
  return {
    id,
    name,
    created: now,
    seen: now,
    xp: 0,
    stats: { kills: 0, deaths: 0, airshots: 0, captures: 0, matches: 0, wins: 0, laps: 0, bestStreak: 0, rocketJumps: 0, directHits: 0, multikills: 0, kothWins: 0, botKills: 0, dailies: 0, weeklies: 0, personalBests: 0 },
    look: { ...DEFAULT_LOOK },
    daily: { period: dayKey(now), progress: [0, 0, 0] },
    weekly: { period: weekKey(now), progress: [0, 0, 0] },
    bestLaps: {},
  };
}

/** What one event earned, to tell the player. */
export interface Gain {
  xp: number;
  reasons: string[]; // "Airshot +25"
  level: number; // after
  levelUp: boolean;
  unlocked: string[];
  completed: string[]; // challenge descriptions
}

/** Moves a profile's challenges on to the current day and week, if they've turned over. */
export function rollChallenges(p: Profile, now: number) {
  if (p.daily.period !== dayKey(now)) p.daily = { period: dayKey(now), progress: [0, 0, 0] };
  if (p.weekly.period !== weekKey(now)) p.weekly = { period: weekKey(now), progress: [0, 0, 0] };
}

/** Applies one event to a profile: stats, XP, challenges. Says what it earned. */
export function applyStat(p: Profile, e: StatEvent, now: number): Gain {
  rollChallenges(p, now);
  const before = levelOf(p.xp);
  const hadSkins = earnedSkins(p);
  const reasons: string[] = [];
  let xp = 0;
  const earn = (amount: number, why: string) => {
    xp += amount;
    reasons.push(`${why} +${amount}`);
  };
  const s = p.stats;
  const bump = (key: StatKey) => (s[key] = (s[key] ?? 0) + 1);
  switch (e.type) {
    case 'kill':
      s.kills++;
      if (e.bot) bump('botKills');
      s.bestStreak = Math.max(s.bestStreak, e.streak);
      earn(XP.kill, 'Kill');
      if (e.airshot) {
        s.airshots++;
        earn(XP.airshot, 'Airshot');
      }
      break;
    case 'death':
      s.deaths++;
      break;
    case 'capture':
      s.captures++;
      earn(XP.capture, 'Capture');
      break;
    case 'lap': {
      s.laps++;
      earn(XP.lap, 'Lap');
      const best = p.bestLaps[e.map];
      if (!best || e.time < best) {
        p.bestLaps[e.map] = e.time;
        if (best) {
          bump('personalBests');
          earn(XP.bestLap, 'Personal best');
        }
      }
      break;
    }
    case 'rocketJump':
    case 'directHit':
    case 'multikill':
      // (Counted for skins only: no XP, so they're no way to farm levels.)
      bump(e.type === 'rocketJump' ? 'rocketJumps' : e.type === 'directHit' ? 'directHits' : 'multikills');
      break;
    case 'match':
      s.matches++;
      earn(XP.matchPlayed, 'Match');
      // Playing a match during a season earns its skins for good.
      for (const season of seasonsAt(now)) if (!p.earned?.includes(`season:${season}`)) p.earned = [...(p.earned ?? []), `season:${season}`];
      if (e.won) {
        s.wins++;
        if (e.mode === 'koth') bump('kothWins');
        earn(XP.matchWon, 'Victory');
      } else if (e.place >= 2 && e.place <= 3 && e.players >= 4 && e.mode !== 'tdm' && e.mode !== 'ctf') earn(XP.podium, 'Podium');
      break;
  }
  const completed: string[] = [];
  for (const [period, slot, reward] of [
    [p.daily.period, p.daily, CHALLENGE_XP.daily],
    [p.weekly.period, p.weekly, CHALLENGE_XP.weekly],
  ] as const) {
    const weekly = slot === p.weekly;
    challengesFor(period).forEach((def, i) => {
      const target = weekly ? def.weekly : def.daily;
      const was = slot.progress[i] ?? 0;
      if (was >= target) return;
      const step = def.id === 'streak' ? streakCounts(e) : def.counts(e);
      if (!step) return;
      slot.progress[i] = Math.min(target, was + step);
      if (slot.progress[i] >= target) {
        completed.push(`${weekly ? 'Weekly' : 'Daily'}: ${challengeText(def, target)}`);
        bump(weekly ? 'weeklies' : 'dailies');
        earn(reward, weekly ? 'Weekly challenge' : 'Daily challenge');
      }
    });
  }
  p.xp += xp;
  const level = levelOf(p.xp);
  const unlocked: string[] = [];
  for (let l = before + 1; l <= level; l++) unlocked.push(...unlocksAt(l));
  unlocked.push(...earnedSkins(p).filter((name) => !hadSkins.includes(name)));
  return { xp, reasons, level, levelUp: level > before, unlocked, completed };
}

/** A profile as the menu shows it: no secrets in it, challenges spelled out. */
export interface ProfileView {
  id: string;
  name: string;
  xp: number;
  level: number;
  levelXp: number; // XP into this level
  levelSize: number; // XP this level takes
  stats: Stats;
  look: Look;
  bestLaps: Record<string, number>;
  daily: { text: string; progress: number; target: number }[];
  weekly: { text: string; progress: number; target: number }[];
  dailyEnds: number; // ms timestamp
  weeklyEnds: number;
  /** Who they're signed in as, if they are. */
  account: { provider: 'discord'; name: string } | null;
  owned: string[];
  earned: string[];
  /** What this server offers: Discord sign-in, and the shop (both need setting up). */
  signIn?: boolean;
  shop?: boolean;
}

export function viewProfile(p: Profile, now: number): ProfileView {
  rollChallenges(p, now);
  const level = levelOf(p.xp);
  const list = (period: string, progress: number[], weekly: boolean) =>
    challengesFor(period).map((def, i) => {
      const target = weekly ? def.weekly : def.daily;
      return { text: challengeText(def, target), progress: progress[i] ?? 0, target };
    });
  const day = new Date(dayKey(now)).getTime();
  return {
    id: p.id,
    name: p.name,
    xp: p.xp,
    level,
    levelXp: p.xp - xpForLevel(level),
    levelSize: xpForLevel(level + 1) - xpForLevel(level),
    stats: p.stats,
    look: lookFor(p, p.look),
    bestLaps: p.bestLaps,
    daily: list(p.daily.period, p.daily.progress, false),
    weekly: list(p.weekly.period, p.weekly.progress, true),
    dailyEnds: day + 86400000,
    weeklyEnds: new Date(weekKey(now)).getTime() + 7 * 86400000,
    account: p.account ? { provider: p.account.provider, name: p.account.name } : null,
    owned: ownedSkus(p.owned), // (with what's in their sets)
    earned: p.earned ?? [],
  };
}

/** One line on a map's race leaderboard. */
export interface LapRecord {
  id: string; // profile id
  name: string;
  time: number;
  when: number;
}
