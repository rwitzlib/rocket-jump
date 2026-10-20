import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLAST_FX, TRAIL_FX } from '../src/client/skinfx';
import { ATLAS_GRID } from '../src/client/spriteframes';
import { allowedLook, applyStat, DEFAULT_LOOK, EXPLOSIONS, newProfile, PREMIUM, SETS, seasonsAt, TRAILS, viewProfile } from '../src/shared/progress';

// The skin catalog: every skin has a look, unlocks the way it says, and the shop sells the rest.

/** Trails that are only their two colors, and the skins effects.ts draws in code of its own. */
const PLAIN_TRAILS = ['classic', 'ember', 'toxic', 'plasma', 'frost', 'gold', 'void', 'rainbow', 'sunburst', 'aurora', 'inferno'];
const CODED_TRAILS = ['lightning', 'bubbles'];
const CODED_BLASTS = ['classic', 'smoky', 'firecracker', 'flashpop', 'thunderclap', 'bubblepop'];

test('every skin has a look of its own', () => {
  for (const t of TRAILS) assert.ok(PLAIN_TRAILS.includes(t.id) || CODED_TRAILS.includes(t.id) || TRAIL_FX[t.id], `trail ${t.id} has a recipe`);
  for (const e of EXPLOSIONS) assert.ok(CODED_BLASTS.includes(e.id) || BLAST_FX[e.id], `explosion ${e.id} has a recipe`);
  // (Recipes only for skins that exist, and frames only from the atlas.)
  for (const id of Object.keys(TRAIL_FX)) assert.ok(TRAILS.some((t) => t.id === id), id);
  for (const id of Object.keys(BLAST_FX)) assert.ok(EXPLOSIONS.some((t) => t.id === id), id);
  const frames = [...Object.values(TRAIL_FX).flatMap((fx) => fx!.emits.map((e) => e.frame)), ...Object.values(BLAST_FX).flatMap((fx) => (fx!.bursts ?? []).map((b) => b.frame))].flat();
  for (const f of frames) assert.ok(Number.isInteger(f) && f >= 0 && f < ATLAS_GRID * ATLAS_GRID, `frame ${f}`);
});

test('the catalog: ids unique, a hundred-odd skins, and every premium one and set in the shop', () => {
  for (const list of [TRAILS, EXPLOSIONS, SETS]) assert.equal(new Set(list.map((t) => t.id)).size, list.length);
  assert.ok(TRAILS.length >= 50 && EXPLOSIONS.length >= 50);
  for (const sku of [...TRAILS.filter((t) => 'price' in t).map((t) => `trail:${t.id}`), ...EXPLOSIONS.filter((t) => 'price' in t).map((t) => `explosion:${t.id}`), ...SETS.map((s) => `set:${s.id}`)]) {
    assert.ok(PREMIUM.some((p) => p.sku === sku), sku);
  }
  assert.equal(new Set(PREMIUM.map((p) => p.sku)).size, PREMIUM.length);
});

test('skins earned by counts unlock at their count, and say so when they do', () => {
  const p = newProfile('x', 'Ace', Date.UTC(2026, 5, 1));
  const look = { trail: 'skywriter', explosion: 'bullseye' } as const;
  assert.deepEqual(allowedLook(look, 50, [], p), DEFAULT_LOOK, 'locked at first, whatever the level');
  p.stats.airshots = 99;
  const gain = applyStat(p, { type: 'kill', airshot: true, cause: 'rocket', streak: 1 }, Date.UTC(2026, 5, 1));
  assert.ok(gain.unlocked.includes('Sky Writer trail'), gain.unlocked.join());
  assert.equal(allowedLook(look, 1, [], p).trail, 'skywriter');

  for (let i = 0; i < 99; i++) applyStat(p, { type: 'directHit' }, Date.UTC(2026, 5, 1));
  assert.equal(allowedLook(look, 1, [], p).explosion, 'classic');
  assert.ok(applyStat(p, { type: 'directHit' }, Date.UTC(2026, 5, 1)).unlocked.includes('Bullseye explosion'));
  assert.equal(viewProfile(p, Date.UTC(2026, 5, 1)).look.explosion, 'classic', 'unlocked, not worn');
  // A profile from before the new counts existed still counts from nothing.
  const old = newProfile('y', 'Old', 0);
  delete (old.stats as Partial<typeof old.stats>).rocketJumps;
  applyStat(old, { type: 'rocketJump' }, 0);
  assert.equal(old.stats.rocketJumps, 1);
});

test('seasonal skins: earned by playing a match while the season is on, and kept after', () => {
  assert.deepEqual(seasonsAt(Date.UTC(2026, 9, 20)), ['halloween']);
  assert.deepEqual(seasonsAt(Date.UTC(2026, 11, 28)).sort(), ['newyear', 'winter']);
  assert.deepEqual(seasonsAt(Date.UTC(2027, 0, 3)).sort(), ['newyear', 'winter']);
  assert.deepEqual(seasonsAt(Date.UTC(2026, 6, 4)), []);

  const p = newProfile('x', 'Ace', 0);
  const look = { trail: 'bats', explosion: 'jackolantern' } as const;
  applyStat(p, { type: 'kill', airshot: false, cause: 'rocket', streak: 1 }, Date.UTC(2026, 9, 20));
  assert.equal(allowedLook(look, 1, [], p).trail, 'classic', 'a kill alone does not earn it');
  const gain = applyStat(p, { type: 'match', mode: 'ffa' as never, won: false, place: 4, players: 6 }, Date.UTC(2026, 9, 20));
  assert.ok(gain.unlocked.includes('Bat Swarm trail') && gain.unlocked.includes("Jack-o'-Lantern explosion"), gain.unlocked.join());
  assert.deepEqual(allowedLook(look, 1, [], p), { tint: 'auto', ...look });
  applyStat(p, { type: 'match', mode: 'ffa' as never, won: false, place: 4, players: 6 }, Date.UTC(2027, 2, 1));
  assert.equal(allowedLook(look, 1, [], p).trail, 'bats', 'still theirs after the season');
  assert.equal(allowedLook({ trail: 'snowfall' }, 1, [], p).trail, 'classic', "another season's isn't");
});

test('KOTH wins, personal bests and challenges count toward their skins', () => {
  const p = newProfile('x', 'Ace', Date.UTC(2026, 5, 1));
  applyStat(p, { type: 'match', mode: 'koth', won: true, place: 1, players: 4 }, Date.UTC(2026, 5, 1));
  applyStat(p, { type: 'match', mode: 'ctf', won: true, place: 1, players: 4 }, Date.UTC(2026, 5, 1));
  assert.equal(p.stats.kothWins, 1);
  applyStat(p, { type: 'lap', map: 'm', time: 30, best: true, path: [] }, Date.UTC(2026, 5, 1));
  applyStat(p, { type: 'lap', map: 'm', time: 29, best: true, path: [] }, Date.UTC(2026, 5, 1));
  applyStat(p, { type: 'lap', map: 'm', time: 31, best: false, path: [] }, Date.UTC(2026, 5, 1));
  assert.equal(p.stats.personalBests, 1, 'only beating an earlier best counts');
  applyStat(p, { type: 'kill', airshot: false, cause: 'rocket', streak: 1, bot: true }, Date.UTC(2026, 5, 1));
  assert.equal(p.stats.botKills, 1);
  assert.equal(applyStat(p, { type: 'rocketJump' }, Date.UTC(2026, 5, 1)).xp, 0, 'rocket jumps earn no XP');
});
