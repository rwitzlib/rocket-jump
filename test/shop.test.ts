import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Stripe from 'stripe';
import { allowedLook, DEFAULT_LOOK, ownedSkus, PREMIUM, SETS, viewProfile } from '../src/shared/progress';
import { DiscordAuth, safeReturn } from '../src/server/auth';
import { lookupKey, Shop } from '../src/server/shop';
import { newKey, Store } from '../src/server/store';

// Premium skins, signing in with Discord, and the Stripe shop: what can be worn, how accounts
// follow players between browsers, and what each webhook event does to a purchase.

const SECRET = 'whsec_test';
const stripe = new Stripe('sk_test_none'); // (webhook signing only: no requests)

/** A store with a signed-in profile; returns its key. */
function signedIn(store: Store, discordId = 'd1') {
  const key = newKey();
  store.signIn(store.idFor(key), { id: discordId, name: 'Ace' });
  return key;
}

const session = (id: string, profile: string, sku: string, paid: boolean, pi = `pi_${id}`) => ({ id, object: 'checkout.session', metadata: { profile, sku }, payment_status: paid ? 'paid' : 'unpaid', payment_intent: pi });
const event = (id: string, type: string, object: object) => ({ id, object: 'event', type, data: { object } }) as unknown as Stripe.Event;

test('premium skins are worn only once bought', () => {
  assert.ok(PREMIUM.length > 0);
  const tint = PREMIUM.find((s) => s.kind === 'tint')!;
  const trail = PREMIUM.find((s) => s.kind === 'trail')!;
  const look = { tint: tint.id, trail: trail.id, explosion: 'classic' } as never;
  assert.deepEqual(allowedLook(look, 50), { tint: 'auto', trail: 'classic', explosion: 'classic' }, 'no level unlocks them');
  assert.deepEqual(allowedLook(look, 1, [tint.sku, trail.sku]), look);
  // Free skins still go by level, whatever's been bought.
  assert.equal(allowedLook({ tint: 'gold' }, 1, [tint.sku]).tint, 'auto');
});

test('signing in keeps the profile, and follows the account to another browser', () => {
  const store = new Store(null);
  const first = newKey();
  store.profile(first, 'Ace').xp = 500;
  const a = store.signIn(store.idFor(first), { id: 'd1', name: 'Ace#1' });
  assert.equal(a.key, null, 'the first browser keeps its key');
  assert.equal(a.profile.xp, 500, 'and its progress');
  assert.equal(viewProfile(a.profile, Date.now()).account?.name, 'Ace#1');

  // Another browser, which played a bit anonymously, signs in to the same account.
  const second = newKey();
  store.profile(second, 'Guest').xp = 20;
  const b = store.signIn(store.idFor(second), { id: 'd1', name: 'Ace#1' });
  assert.ok(b.key, 'gets a key for the account');
  assert.equal(store.find(b.key!)!.id, a.profile.id);
  assert.equal(store.find(second)!.xp, 20, 'its anonymous profile is left as it was');

  // Signing out there: that key stops being the account's.
  store.signOut(b.key!);
  assert.notEqual(store.idFor(b.key!), a.profile.id);
  // The first browser's own key is the profile's, not an alias: it still works.
  store.signOut(first);
  assert.equal(store.find(first)!.id, a.profile.id);
});

test("a browser already signed in to one account doesn't hand its profile to another", () => {
  const store = new Store(null);
  const key = signedIn(store, 'd1');
  const other = store.signIn(store.idFor(key), { id: 'd2', name: 'Bee' });
  assert.ok(other.key);
  assert.notEqual(other.profile.id, store.idFor(key));
  assert.equal(store.find(key)!.account?.id, 'd1');
});

test('webhooks grant a paid skin once, wait for a delayed payment, and take it back on a refund', () => {
  const store = new Store(null);
  const key = signedIn(store);
  const id = store.idFor(key);
  const changed: string[] = [];
  const shop = new Shop(stripe, SECRET, store, (p) => changed.push(p.id));
  const [tint, trail] = [PREMIUM[0], PREMIUM.find((s) => s.kind === 'trail')!];

  // Card: paid at once.
  assert.match(shop.handle(event('evt_1', 'checkout.session.completed', session('cs_1', id, tint.sku, true))), /paid/);
  assert.deepEqual(store.find(key)!.owned, [tint.sku]);
  assert.equal(shop.handle(event('evt_1', 'checkout.session.completed', session('cs_1', id, tint.sku, true))), 'already handled');
  assert.deepEqual(changed, [id]);

  // A bank debit: pending, then it clears.
  shop.handle(event('evt_2', 'checkout.session.completed', session('cs_2', id, trail.sku, false)));
  assert.deepEqual(store.find(key)!.owned, [tint.sku]);
  assert.equal(store.purchase('cs_2')!.status, 'pending');
  shop.handle(event('evt_3', 'checkout.session.async_payment_succeeded', session('cs_2', id, trail.sku, true)));
  assert.deepEqual(store.find(key)!.owned, [tint.sku, trail.sku]);

  // Wearing the tint, then a full refund: it comes off and goes.
  store.setLook(key, { tint: tint.id as never, trail: 'classic', explosion: 'classic' });
  assert.equal(store.find(key)!.look.tint, tint.id);
  assert.match(shop.handle(event('evt_4', 'charge.refunded', { id: 'ch_1', refunded: true, payment_intent: 'pi_cs_1' })), /refunded/);
  assert.deepEqual(store.find(key)!.owned, [trail.sku]);
  assert.equal(store.find(key)!.look.tint, 'auto');
  // A late copy of the success event doesn't give it back.
  shop.handle(event('evt_5', 'checkout.session.completed', session('cs_1', id, tint.sku, true)));
  assert.deepEqual(store.find(key)!.owned, [trail.sku]);

  // A partial refund keeps it; a dispute doesn't.
  assert.equal(shop.handle(event('evt_6', 'charge.refunded', { id: 'ch_2', refunded: false, payment_intent: 'pi_cs_2' })), 'partial refund');
  assert.deepEqual(store.find(key)!.owned, [trail.sku]);
  shop.handle(event('evt_7', 'charge.dispute.created', { id: 'dp_1', payment_intent: 'pi_cs_2' }));
  assert.deepEqual(store.find(key)!.owned, []);
  assert.equal(store.purchase('cs_2')!.status, 'disputed');
});

test('a failed delayed payment grants nothing; other events are ignored', () => {
  const store = new Store(null);
  const id = store.idFor(signedIn(store));
  const shop = new Shop(stripe, SECRET, store);
  shop.handle(event('evt_1', 'checkout.session.completed', session('cs_1', id, PREMIUM[0].sku, false)));
  shop.handle(event('evt_2', 'checkout.session.async_payment_failed', session('cs_1', id, PREMIUM[0].sku, false)));
  assert.equal(store.purchase('cs_1')!.status, 'failed');
  assert.deepEqual(store.profileById(id)!.owned ?? [], []);
  assert.equal(shop.handle(event('evt_3', 'customer.created', { id: 'cus_1' })), 'ignored');
  assert.equal(shop.handle(event('evt_4', 'checkout.session.completed', { id: 'cs_x', metadata: {}, payment_status: 'paid' })), 'not one of ours');
});

test('the webhook only takes events Stripe signed', () => {
  const store = new Store(null);
  const id = store.idFor(signedIn(store));
  const shop = new Shop(stripe, SECRET, store);
  const payload = JSON.stringify(event('evt_s', 'checkout.session.completed', session('cs_s', id, PREMIUM[0].sku, true)));
  assert.throws(() => shop.webhook(Buffer.from(payload), 't=1,v1=forged'));
  assert.throws(() => shop.webhook(Buffer.from(payload), stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_other' })));
  assert.equal(store.profileById(id)!.owned, undefined);
  shop.webhook(Buffer.from(payload), stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET }));
  assert.deepEqual(store.profileById(id)!.owned, [PREMIUM[0].sku]);
});

test('checkout needs a sign-in and a skin not yet owned, and records the session', async () => {
  const store = new Store(null);
  const created: Stripe.Checkout.SessionCreateParams[] = [];
  const fake = {
    prices: { list: async () => ({ data: PREMIUM.map((s) => ({ id: `price_${s.sku}`, lookup_key: lookupKey(s.sku), unit_amount: s.price })) }) },
    checkout: {
      sessions: {
        create: async (params: Stripe.Checkout.SessionCreateParams) => {
          created.push(params);
          return { id: `cs_${created.length}`, url: 'https://checkout.stripe.com/c/pay/test' };
        },
      },
    },
  } as unknown as Stripe;
  const shop = new Shop(fake, SECRET, store);
  const sku = PREMIUM[0].sku;

  const anon = store.profile(newKey());
  assert.deepEqual(await shop.checkout(anon, sku, 'http://localhost:5173/'), { status: 403, error: 'Sign in with Discord to buy skins.' });
  const p = store.find(signedIn(store))!;
  assert.equal(((await shop.checkout(p, 'tint:nope', 'http://localhost:5173/')) as { status: number }).status, 404);

  assert.deepEqual(await shop.checkout(p, sku, 'http://localhost:5173/'), { url: 'https://checkout.stripe.com/c/pay/test' });
  assert.equal(created[0].line_items![0].price, `price_${sku}`);
  assert.deepEqual(created[0].metadata, { profile: p.id, sku });
  assert.equal(created[0].success_url, `http://localhost:5173/?purchase=${encodeURIComponent(sku)}`);
  assert.equal('payment_method_types' in created[0], false, 'payment methods come from the Dashboard');
  assert.equal(store.purchase('cs_1')!.status, 'pending');

  p.owned = [sku];
  assert.equal(((await shop.checkout(p, sku, 'http://localhost:5173/')) as { status: number }).status, 409);
});

test('a set owns the skins in it: worn, refused at checkout once all are owned, and refunded together', async () => {
  assert.ok(SETS.every((s) => s.skus.every((sku) => PREMIUM.some((p) => p.sku === sku))), "every set's skins are for sale");
  assert.ok(SETS.every((s) => s.price < s.skus.reduce((sum, sku) => sum + PREMIUM.find((p) => p.sku === sku)!.price, 0)), 'a set costs less than its skins apart');
  const storm = { tint: 'auto', trail: 'lightning', explosion: 'thunderclap' } as const;
  assert.deepEqual(allowedLook(storm, 50), DEFAULT_LOOK, 'no level unlocks them');
  assert.deepEqual(allowedLook(storm, 1, ['set:storm']), storm);
  assert.deepEqual(allowedLook(storm, 1, ['trail:lightning']), { ...storm, explosion: 'classic' });
  assert.deepEqual(ownedSkus(['set:storm']), ['set:storm', 'trail:lightning', 'explosion:thunderclap']);

  const store = new Store(null);
  const key = signedIn(store);
  const id = store.idFor(key);
  const fake = {
    prices: { list: async () => ({ data: PREMIUM.map((s) => ({ id: `price_${s.sku}`, lookup_key: lookupKey(s.sku), unit_amount: s.price })) }) },
    checkout: { sessions: { create: async () => ({ id: 'cs_x', url: 'https://checkout.stripe.com/c/pay/test' }) } },
  } as unknown as Stripe;
  const shop = new Shop(fake, SECRET, store);
  const status = async (sku: string) => ((await shop.checkout(store.find(key)!, sku, 'http://localhost:5173/')) as { status?: number }).status;

  // Owning one skin of a set still lets you buy the set; owning both doesn't.
  store.find(key)!.owned = ['trail:lightning'];
  assert.equal(await status('set:storm'), undefined);
  store.find(key)!.owned = ['trail:lightning', 'explosion:thunderclap'];
  assert.equal(await status('set:storm'), 409);
  // ...and nor can a skin you have from a set be bought again.
  store.find(key)!.owned = [];
  shop.handle(event('evt_1', 'checkout.session.completed', session('cs_1', id, 'set:storm', true)));
  assert.equal(await status('explosion:thunderclap'), 409);
  assert.equal(await status('set:storm'), 409);
  assert.equal(await status('trail:bubbles'), undefined);
  assert.deepEqual(viewProfile(store.find(key)!, Date.now()).owned, ['set:storm', 'trail:lightning', 'explosion:thunderclap']);

  store.setLook(key, storm);
  assert.deepEqual(store.find(key)!.look, storm);
  shop.handle(event('evt_2', 'charge.refunded', { id: 'ch_1', refunded: true, payment_intent: 'pi_cs_1' }));
  assert.deepEqual(store.find(key)!.owned, []);
  assert.deepEqual(store.find(key)!.look, DEFAULT_LOOK, 'both come off');
});

test('sign-in returns only to our own pages, and its codes work once', async () => {
  assert.equal(safeReturn('http://localhost:5173/?x=1#y', []), 'http://localhost:5173/');
  assert.equal(safeReturn('https://evil.example/', []), null);
  assert.equal(safeReturn('https://rocketjump.gg/play', ['https://rocketjump.gg']), 'https://rocketjump.gg/play');
  assert.equal(safeReturn('http://localhost:5173/', ['https://rocketjump.gg']), null, 'localhost only while no origins are set');
  assert.equal(safeReturn('javascript:alert(1)', []), null);

  const auth = new DiscordAuth({ clientId: 'c', clientSecret: 's', redirectUri: 'http://localhost:8080/auth/discord/callback' }, async (code) => {
    assert.equal(code, 'good');
    return { id: 'd1', name: 'Ace' };
  });
  const url = new URL(auth.start('profile1', 'http://localhost:5173/'));
  assert.equal(url.origin, 'https://discord.com');
  assert.equal(url.searchParams.get('scope'), 'identify');
  const state = url.searchParams.get('state')!;

  const forged = await auth.callback(new URLSearchParams({ state: 'made-up', code: 'good' }));
  assert.equal(forged, null);
  const back = await auth.callback(new URLSearchParams({ state, code: 'good' }));
  assert.match(back!, /^http:\/\/localhost:5173\/#signin=[a-f0-9]{32}$/);
  assert.equal(await auth.callback(new URLSearchParams({ state, code: 'good' })), null, 'a state works once');
  const code = back!.split('=')[1];
  let signedInAs = '';
  const signIn = (from: string, user: { id: string }) => {
    signedInAs = `${from}/${user.id}`;
    return { key: 'k'.repeat(32) };
  };
  assert.equal(auth.claim(code, 'someone-else', signIn), null, 'only the profile that started it may claim it');
  assert.equal(signedInAs, '', 'and nothing is linked until it does');
  assert.deepEqual(auth.claim(code, 'profile1', signIn), { key: 'k'.repeat(32), name: 'Ace' });
  assert.equal(signedInAs, 'profile1/d1');
  assert.equal(auth.claim(code, 'profile1', signIn), null, 'and so does a claim');

  const denied = new URL(auth.start('profile1', 'http://localhost:5173/')).searchParams.get('state')!;
  assert.equal(await auth.callback(new URLSearchParams({ state: denied, error: 'access_denied' })), 'http://localhost:5173/#signin-error=denied');
});

test("a sign-in link someone else started can't tie your Discord account to their profile", async () => {
  const store = new Store(null);
  const auth = new DiscordAuth({ clientId: 'c', clientSecret: 's', redirectUri: 'http://localhost:8080/auth/discord/callback' }, async () => ({ id: 'victim', name: 'Vic' }));
  const attacker = newKey();
  store.profile(attacker, 'Mallory');
  // The attacker starts a sign-in for their own profile and sends the Discord link to the victim,
  // who approves it: their browser comes back with the code, and claims it with its own key.
  const state = new URL(auth.start(store.idFor(attacker), 'http://localhost:5173/')).searchParams.get('state')!;
  const back = await auth.callback(new URLSearchParams({ state, code: 'x' }));
  const code = back!.split('=')[1];
  const victim = newKey();
  const link = (from: string, user: { id: string; name: string }) => store.signIn(from, user);
  assert.equal(auth.claim(code, store.idFor(victim), link), null);
  assert.equal(store.find(attacker)!.account, undefined, "the attacker's profile isn't tied to the victim's Discord");
  // So when the victim signs in for real, they keep their own profile.
  const own = store.signIn(store.idFor(victim), { id: 'victim', name: 'Vic' });
  assert.equal(own.profile.id, store.idFor(victim));
});

test('accounts, aliases and purchases survive a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rj-'));
  try {
    const store = new Store(dir);
    const key = signedIn(store);
    const other = store.signIn(store.idFor(newKey()), { id: 'd1', name: 'Ace' }).key!;
    new Shop(stripe, SECRET, store).handle(event('evt_1', 'checkout.session.completed', session('cs_1', store.idFor(key), PREMIUM[0].sku, true)));
    store.save();
    const again = new Store(dir);
    assert.equal(again.find(other)!.id, again.find(key)!.id);
    assert.deepEqual(again.find(key)!.owned, [PREMIUM[0].sku]);
    assert.equal(again.seenEvent('evt_1'), true);
    // Signing in again finds the same profile.
    const k = again.signIn(again.idFor(newKey()), { id: 'd1', name: 'Ace' }).key!;
    assert.equal(again.find(k)!.id, again.find(key)!.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
