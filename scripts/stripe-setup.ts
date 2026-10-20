// Makes the shop's products and prices in Stripe from PREMIUM (src/shared/progress.ts): one
// product per premium skin (id skin_tint_crimson) and a USD price with the same lookup key, which is
// how the server finds it. Run it again after changing a price or adding a skin: an unchanged skin
// is left alone, a new price takes over the lookup key and the old one is archived.
//
//   npm run stripe:setup          (uses STRIPE_SECRET_KEY from the environment or .env)

import Stripe from 'stripe';
import { PREMIUM } from '../src/shared/progress';
import { lookupKey } from '../src/server/shop';

try {
  process.loadEnvFile();
} catch {
  // no .env
}
/**
 * Stripe's tax category for the skins. Managed Payments (Stripe as merchant of record, the account's
 * default) needs one on every product. There's none for in-game items as such; a skin is kept for
 * good, so: Video Games - downloaded - non subscription - with permanent rights.
 */
const TAX_CODE = 'txcd_10201000';

const secret = process.env.STRIPE_SECRET_KEY;
if (!secret) {
  console.error('Set STRIPE_SECRET_KEY (in .env, or the environment).');
  process.exit(1);
}
const stripe = new Stripe(secret);
console.log(`Stripe ${secret.includes('_live_') ? 'LIVE' : 'test'} mode`);

for (const skin of PREMIUM) {
  const id = lookupKey(skin.sku);
  let product: Stripe.Product;
  try {
    product = await stripe.products.retrieve(id);
    const taxCode = typeof product.tax_code === 'string' ? product.tax_code : product.tax_code?.id;
    if (product.name !== skin.name || !product.active || taxCode !== TAX_CODE) product = await stripe.products.update(id, { name: skin.name, active: true, tax_code: TAX_CODE });
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err;
    product = await stripe.products.create({ id, name: skin.name, description: 'A premium Rocket Jump skin.', tax_code: TAX_CODE, metadata: { sku: skin.sku } });
  }
  const [current] = (await stripe.prices.list({ lookup_keys: [id], active: true, limit: 1 })).data;
  if (current && current.unit_amount === skin.price && current.currency === 'usd' && current.product === product.id) {
    console.log(`${skin.sku}: ${current.id} ($${skin.price / 100}) is up to date`);
    continue;
  }
  const price = await stripe.prices.create({
    product: product.id,
    currency: 'usd',
    unit_amount: skin.price,
    lookup_key: id,
    transfer_lookup_key: true,
    metadata: { sku: skin.sku },
  });
  await stripe.products.update(product.id, { default_price: price.id });
  if (current) await stripe.prices.update(current.id, { active: false });
  console.log(`${skin.sku}: ${price.id} ($${skin.price / 100})${current ? `, replacing ${current.id}` : ''}`);
}
