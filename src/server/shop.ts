import type Stripe from 'stripe';
import { hasAll, PREMIUM, type Profile } from '../shared/progress';
import type { Store } from './store';

// The skin shop: premium skins bought through Stripe Checkout (Stripe's hosted payment page).
//
//   POST /shop/checkout { key, sku, returnTo } -> { url }: the Checkout page for that skin (or set)
//   POST /stripe/webhook                         Stripe telling us what happened (signed)
//
// A skin is granted only by the webhook, never by the browser coming back from Checkout: the page
// just waits for its profile to show the skin. The events it listens for:
//
//   checkout.session.completed                 paid now (cards), or pending (bank debits)
//   checkout.session.async_payment_succeeded   a pending payment came through
//   checkout.session.async_payment_failed      ...or didn't
//   charge.refunded                            a full refund takes the skin back
//   charge.dispute.created                     so does a dispute
//
// Prices live in Stripe, found by lookup key (skin_tint_crimson); `npm run stripe:setup` makes
// them from PREMIUM, which also has the prices the menu shows.

/** Tags our Checkout Sessions in the Dashboard. */
const INTEGRATION_ID = 'rocketjump_skins_qhzvtmwa';
const PRICE_REFRESH = 60000; // ms between fetching prices again when one is missing
const LOOKUP_KEYS_PER_LIST = 10; // the most lookup keys Stripe takes in one prices.list
const CHECKOUTS_PER_HOUR = 10; // per profile: plenty for someone shopping, not for filling the store

export const lookupKey = (sku: string) => `skin_${sku.replace(':', '_')}`;

export class Shop {
  private prices = new Map<string, { id: string; amount: number | null }>();
  private pricesFetched = 0;

  constructor(
    private readonly stripe: Stripe,
    private readonly webhookSecret: string,
    private readonly store: Store,
    /** A profile's skins changed (a purchase or a refund): anyone playing as it should look right. */
    private readonly onChange: (profile: Profile) => void = () => {},
  ) {}

  /** Opens a Checkout Session for one skin. */
  async checkout(p: Profile, sku: string, returnTo: string): Promise<{ url: string } | { status: number; error: string }> {
    const skin = PREMIUM.find((s) => s.sku === sku);
    if (!skin) return { status: 404, error: 'There is no such skin.' };
    if (!p.account) return { status: 403, error: 'Sign in with Discord to buy skins.' };
    if (hasAll(sku, p.owned)) return { status: 409, error: skin.skus ? 'You have everything in that set already.' : 'You have that one already.' };
    if (this.store.checkoutsSince(p.id, Date.now() - 3600000) >= CHECKOUTS_PER_HOUR) return { status: 429, error: "You've opened a lot of checkouts just now. Try again later." };
    const price = await this.price(sku);
    if (!price) {
      console.error(`No Stripe price with lookup key ${lookupKey(sku)}: run npm run stripe:setup`);
      return { status: 503, error: "The shop isn't open right now." };
    }
    if (price.amount !== skin.price) console.error(`The Stripe price for ${sku} (${price.amount}) isn't the one the menu shows (${skin.price})`);
    const back = (q: string) => `${returnTo}?${q}`;
    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: price.id, quantity: 1 }],
      client_reference_id: p.id,
      metadata: { profile: p.id, sku },
      payment_intent_data: { metadata: { profile: p.id, sku } },
      success_url: back(`purchase=${encodeURIComponent(sku)}`),
      cancel_url: back('purchase=cancelled'),
      integration_identifier: INTEGRATION_ID,
    });
    this.store.addPurchase(session.id, p.id, sku);
    return { url: session.url! };
  }

  private async price(sku: string) {
    if (!this.prices.has(sku) && Date.now() - this.pricesFetched > PRICE_REFRESH) {
      this.pricesFetched = Date.now();
      // (In batches: Stripe refuses more lookup keys than that in one call.)
      const keys = PREMIUM.map((s) => lookupKey(s.sku));
      const batches = [];
      for (let i = 0; i < keys.length; i += LOOKUP_KEYS_PER_LIST) batches.push(keys.slice(i, i + LOOKUP_KEYS_PER_LIST));
      const lists = await Promise.all(batches.map((lookup_keys) => this.stripe.prices.list({ lookup_keys, active: true, limit: 100 })));
      this.prices = new Map();
      for (const price of lists.flatMap((l) => l.data)) {
        const skin = PREMIUM.find((s) => lookupKey(s.sku) === price.lookup_key);
        if (skin) this.prices.set(skin.sku, { id: price.id, amount: price.unit_amount });
      }
    }
    return this.prices.get(sku);
  }

  /** The webhook: checks Stripe signed it, then handles it. Throws on a bad signature. */
  webhook(body: Buffer, signature: string): string {
    const event = this.stripe.webhooks.constructEvent(body, signature, this.webhookSecret);
    return this.handle(event);
  }

  /** Handles one event (once: Stripe may send it again). Says what it did, for the log. */
  handle(event: Stripe.Event): string {
    if (this.store.seenEvent(event.id)) return 'already handled';
    try {
      return this.apply(event);
    } catch (err) {
      // (So Stripe's retry gets handled, rather than skipped as done.)
      this.store.forgetEvent(event.id);
      throw err;
    }
  }

  private apply(event: Stripe.Event): string {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
      case 'checkout.session.async_payment_failed': {
        const session = event.data.object;
        const { profile, sku } = session.metadata ?? {};
        if (!profile || !sku) return 'not one of ours';
        const status = event.type === 'checkout.session.async_payment_failed' ? 'failed' : session.payment_status === 'paid' ? 'paid' : 'pending';
        const purchase = this.store.settlePurchase(session.id, profile, sku, status, idOf(session.payment_intent));
        if (purchase.status === 'paid') this.changed(profile);
        return `${sku} for ${profile}: ${purchase.status}`;
      }
      case 'charge.refunded': {
        const charge = event.data.object;
        // (A partial refund keeps the skin: that's a goodwill gesture, not taking it back.)
        if (!charge.refunded) return 'partial refund';
        return this.revoke(idOf(charge.payment_intent), 'refunded');
      }
      case 'charge.dispute.created':
        return this.revoke(idOf(event.data.object.payment_intent), 'disputed');
      default:
        return 'ignored';
    }
  }

  private revoke(paymentIntent: string | null, status: 'refunded' | 'disputed') {
    const purchase = paymentIntent ? this.store.revokePurchase(paymentIntent, status) : undefined;
    if (!purchase) return 'no purchase for that payment';
    this.changed(purchase.profile);
    return `${purchase.sku} for ${purchase.profile}: ${status}`;
  }

  private changed(id: string) {
    const p = this.store.profileById(id);
    if (p) this.onChange(p);
  }
}

const idOf = (x: string | { id: string } | null | undefined) => (typeof x === 'string' ? x : (x?.id ?? null));
