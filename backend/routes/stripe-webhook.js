// routes/stripe-webhook.js — POST /api/webhooks/stripe
//
// Receives Stripe subscription events. MUST be mounted with
// express.raw({type:'application/json'}) BEFORE any express.json() parsing,
// because signature verification needs the untouched request body.
//
// Verified with STRIPE_WEBHOOK_SECRET. Always answers 200 on a valid
// signature (Stripe retries otherwise); 400 only when the signature is
// invalid or Stripe is unconfigured.
//
// Handled events (all idempotent — user is found by stripe_customer_id and
// updates land on the same state when replayed):
//   checkout.session.completed   → tier from the price ID used, status active
//   customer.subscription.updated → sync status / tier / period end
//   customer.subscription.deleted → downgrade to free
//   invoice.payment_failed         → status past_due (treated as free tier)
'use strict';

const config = require('../config');
const db = require('../db');
const billing = require('../lib/billing');

// Map configured Stripe price IDs → subscription tier.
function priceTierMap() {
  const map = {};
  const pairs = [
    [process.env.STRIPE_PRICE_STARTER_MONTHLY, 'starter'],
    [process.env.STRIPE_PRICE_STARTER_ANNUAL, 'starter'],
    [process.env.STRIPE_PRICE_PRO_MONTHLY, 'pro'],
    [process.env.STRIPE_PRICE_PRO_ANNUAL, 'pro'],
  ];
  for (const [priceId, tier] of pairs) {
    if (priceId) map[priceId] = tier;
  }
  return map;
}

async function findUserIdByCustomer(customerId) {
  if (!customerId || !db.isEnabled()) return null;
  const r = await db.query('SELECT id FROM users WHERE stripe_customer_id = $1 LIMIT 1', [customerId]);
  return r.rows.length ? r.rows[0].id : null;
}

async function syncSubscription(stripe, subscription) {
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer && subscription.customer.id;
  const userId = await findUserIdByCustomer(customerId);
  if (!userId) {
    console.warn('[stripe-webhook] no user for customer', customerId);
    return;
  }
  // The subscription's first price item decides the tier.
  const items = (subscription.items && subscription.items.data) || [];
  const priceId = items.length && items[0].price ? items[0].price.id : null;
  const tier = priceTierMap()[priceId] || 'free';
  const periodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null;
  await billing.setSubscription(userId, {
    subscription_tier: tier,
    subscription_status: subscription.status,
    current_period_end: periodEnd,
  });
  console.log(`[stripe-webhook] user ${userId} → ${tier}/${subscription.status}`);
}

async function handleEvent(stripe, event) {
  const type = event.type;
  const obj = event.data && event.data.object ? event.data.object : {};

  if (type === 'checkout.session.completed') {
    // Shipment freight payment (pay-at-scheduling): finalize the order —
    // buy the EasyPost label or mint the internal PRO — then mark paid.
    const meta = obj.metadata || {};
    if (meta.type === 'shipment_payment' && meta.order_id) {
      const shipments = require('./shipments');
      const pi = obj.payment_intent;
      const paymentIntentId = typeof pi === 'string' ? pi : (pi && pi.id) || null;
      const done = await shipments.finalizeShipmentPayment(meta.order_id, paymentIntentId);
      console.log(`[stripe-webhook] shipment paid → order ${meta.order_id} (${done.status})`);
      return;
    }
    // Prefer the subscription object when present (most reliable); fall
    // back to checkout metadata + line items.
    let subscriptionId = obj.subscription || null;
    const customerId = typeof obj.customer === 'string' ? obj.customer : (obj.customer && obj.customer.id);
    const metaUserId = (obj.metadata && obj.metadata.user_id) || obj.client_reference_id || null;
    if (subscriptionId) {
      const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['items.data.price'] });
      await syncSubscription(stripe, sub);
    } else {
      const userId = metaUserId || (await findUserIdByCustomer(customerId));
      if (userId) {
        let tier = (obj.metadata && obj.metadata.tier) || 'free';
        if (!['starter', 'pro'].includes(tier)) {
          // Resolve from the price actually purchased.
          const items = await stripe.checkout.sessions.listLineItems(obj.id, { limit: 5 });
          const priceId = items.data.length && items.data[0].price ? items.data[0].price.id : null;
          tier = priceTierMap()[priceId] || 'free';
        }
        await billing.setSubscription(userId, {
          stripe_customer_id: customerId,
          subscription_tier: tier,
          subscription_status: 'active',
        });
        console.log(`[stripe-webhook] checkout completed → user ${userId} ${tier}/active`);
      }
    }
    return;
  }

  if (type === 'customer.subscription.updated') {
    await syncSubscription(stripe, obj);
    return;
  }

  if (type === 'customer.subscription.deleted') {
    const customerId = typeof obj.customer === 'string' ? obj.customer : (obj.customer && obj.customer.id);
    const userId = await findUserIdByCustomer(customerId);
    if (userId) {
      await billing.setSubscription(userId, {
        subscription_tier: 'free',
        subscription_status: 'canceled',
        current_period_end: null,
      });
      console.log(`[stripe-webhook] subscription deleted → user ${userId} free/canceled`);
    }
    return;
  }

  if (type === 'invoice.payment_failed') {
    const customerId = typeof obj.customer === 'string' ? obj.customer : (obj.customer && obj.customer.id);
    const userId = await findUserIdByCustomer(customerId);
    if (userId) {
      // past_due is treated as the free tier by the quota logic until the
      // invoice is paid (which fires customer.subscription.updated).
      await billing.setSubscription(userId, { subscription_status: 'past_due' });
      console.log(`[stripe-webhook] payment failed → user ${userId} past_due`);
    }
    return;
  }

  // Other events are acknowledged and ignored.
}

async function stripeWebhookHandler(req, res) {
  const secret = config.stripeKey;
  const webhookSecret = config.stripeWebhookSecret;
  if (!secret || !webhookSecret) {
    return res.status(400).json({ error: 'Stripe webhook is not configured.' });
  }
  const stripe = require('stripe')(secret);
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('[stripe-webhook] signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid webhook signature.' });
  }
  try {
    await handleEvent(stripe, event);
  } catch (err) {
    // Log but still acknowledge: a 500 would make Stripe retry a handler
    // that may fail the same way every time.
    console.error('[stripe-webhook] handler error (acknowledging anyway):', err.message);
  }
  return res.status(200).json({ received: true });
}

module.exports = stripeWebhookHandler;
