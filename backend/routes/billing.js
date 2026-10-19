// routes/billing.js — subscription billing for shipper accounts.
//
//   GET  /api/billing/status                      — plan + usage (auth)
//   GET  /api/billing/history                     — plan-upgrade approvals (auth)
//   GET  /api/billing/payments                    — freight payment history (auth)
//   POST /api/billing/checkout {tier, billing}    — Stripe Checkout (auth)
//   POST /api/billing/upgrade                     — upgrade to the NEXT tier (auth)
//   POST /api/billing/portal                      — customer portal (auth)
//
// Prices live in Stripe; this route only reads price IDs from the env:
//   STRIPE_PRICE_STARTER_MONTHLY / STRIPE_PRICE_STARTER_ANNUAL
//   STRIPE_PRICE_GROWTH_MONTHLY  / STRIPE_PRICE_GROWTH_ANNUAL
//   STRIPE_PRICE_BUSINESS_MONTHLY / STRIPE_PRICE_BUSINESS_ANNUAL
//   STRIPE_PRICE_PRO_MONTHLY     / STRIPE_PRICE_PRO_ANNUAL
// plus STRIPE_SECRET_KEY. Missing keys → 501 with a clear message; nothing
// is hardcoded.
//
// Upgrade flow: an account at its quota gets an upgrade prompt (see the
// 402 response in routes/rates.js). Clicking Yes calls POST /upgrade:
//   - already on a paid tier → the live Stripe subscription is updated to
//     the next tier's price (standard proration, same billing cycle), the
//     approval is recorded as completed, and the new quota applies at once.
//   - on free → a Stripe Checkout session for the next tier (monthly); the
//     approval is recorded as pending and the Stripe webhook marks it
//     completed when the subscription lands.
//   - on pro (top tier) → no higher tier: 400 with contact=true, the
//     customer contacts shiprate.ca for over-500-quote arrangements.
'use strict';

const express = require('express');
const config = require('../config');
const db = require('../db');
const billing = require('../lib/billing');

const router = express.Router();

const PRICE_ENV = {
  'starter:monthly': 'STRIPE_PRICE_STARTER_MONTHLY',
  'starter:annual': 'STRIPE_PRICE_STARTER_ANNUAL',
  'growth:monthly': 'STRIPE_PRICE_GROWTH_MONTHLY',
  'growth:annual': 'STRIPE_PRICE_GROWTH_ANNUAL',
  'business:monthly': 'STRIPE_PRICE_BUSINESS_MONTHLY',
  'business:annual': 'STRIPE_PRICE_BUSINESS_ANNUAL',
  'pro:monthly': 'STRIPE_PRICE_PRO_MONTHLY',
  'pro:annual': 'STRIPE_PRICE_PRO_ANNUAL',
};

const PAID_TIERS = ['starter', 'growth', 'business', 'pro'];

function bad(res, code, error, extra) {
  return res.status(code).json(extra ? { error, ...extra } : { error });
}

function needAuth(req, res) {
  if (!req.user) {
    bad(res, 401, 'Sign in to manage billing.');
    return true;
  }
  return false;
}

function needDb(res) {
  if (!db.isEnabled()) {
    bad(res, 501, 'Billing requires a database: set DATABASE_URL on the server.');
    return true;
  }
  return false;
}

function stripeClient() {
  if (!config.stripeKey) return null;
  return require('stripe')(config.stripeKey);
}

// siteOrigin(req): absolute origin for Stripe redirect URLs. FRONTEND_ORIGIN
// wins when set; otherwise derive from the incoming request (same-origin
// deployment serves the frontend itself).
function siteOrigin(req) {
  if (config.frontendOrigin) return config.frontendOrigin.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  return `${proto}://${req.get('host')}`;
}

// GET /api/billing/status — current plan, quota usage, renewal date.
router.get('/status', async (req, res) => {
  if (needAuth(req, res)) return;
  if (needDb(res)) return;
  try {
    const state = await billing.getBillingState(req.user.id);
    if (!state) return bad(res, 404, 'Account not found.');
    return res.json({
      tier: state.tier,
      is_admin: !!state.isAdmin,
      shipping_approved: !!state.shippingApproved,
      status: state.status,
      billing_active: state.billingActive,
      quotes_used: state.quotesUsed,
      quotes_limit: state.quotesLimit, // null = unlimited
      period_end: state.periodEnd,
      has_payment_method: !!state.stripeCustomerId,
    });
  } catch (err) {
    console.error('[billing/status]', err.message);
    return bad(res, 500, 'Could not load billing status.');
  }
});

// POST /api/billing/checkout — {tier: 'starter'|'pro', billing: 'monthly'|'annual'}
// Creates (or reuses) the Stripe customer and returns a Checkout URL.
router.post('/checkout', async (req, res) => {
  if (needAuth(req, res)) return;
  if (needDb(res)) return;
  const stripe = stripeClient();
  if (!stripe) {
    return bad(res, 501, 'Stripe is not configured: set STRIPE_SECRET_KEY on the server.');
  }
  const tier = String((req.body || {}).tier || '');
  const billingCycle = String((req.body || {}).billing || 'monthly');
  const envName = PRICE_ENV[`${tier}:${billingCycle}`];
  if (!envName || !PAID_TIERS.includes(tier) || !['monthly', 'annual'].includes(billingCycle)) {
    return bad(res, 400, "Choose a plan: tier 'starter', 'growth', 'business' or 'pro', billing 'monthly' or 'annual'.");
  }
  const priceId = process.env[envName] || '';
  if (!priceId) {
    return bad(res, 501, `Stripe price not configured: set ${envName} on the server.`);
  }
  try {
    let customerId = (await billing.getBillingState(req.user.id) || {}).stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        name: req.user.name || undefined,
        metadata: { user_id: req.user.id, company: req.user.company || '' },
      });
      customerId = customer.id;
      await billing.setSubscription(req.user.id, { stripe_customer_id: customerId });
    }
    const origin = siteOrigin(req);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: req.user.id,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { user_id: req.user.id, tier, billing: billingCycle },
      subscription_data: { metadata: { user_id: req.user.id, tier, billing: billingCycle } },
      success_url: `${origin}/?billing=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?billing=cancelled`,
      allow_promotion_codes: true,
    });
    return res.json({ url: session.url });
  } catch (err) {
    console.error('[billing/checkout]', err.message);
    return bad(res, 502, 'Could not start checkout: ' + err.message);
  }
});

// POST /api/billing/upgrade — accept the upgrade prompt: move this account
// to the NEXT tier immediately for the current month. No body needed — the
// target is always the next rung above the account's effective tier.
// Paid → paid: the live Stripe subscription is updated (standard proration,
// same billing cycle). Free → paid: a Checkout session for the next tier
// (monthly); the approval is recorded as pending until the webhook confirms.
router.post('/upgrade', async (req, res) => {
  if (needAuth(req, res)) return;
  if (needDb(res)) return;
  const stripe = stripeClient();
  if (!stripe) {
    return bad(res, 501, 'Stripe is not configured: set STRIPE_SECRET_KEY on the server.');
  }
  try {
    const state = await billing.getBillingState(req.user.id);
    if (!state) return bad(res, 404, 'Account not found.');
    if (state.isAdmin || state.unlimitedQuotes) {
      return bad(res, 400, 'This account already has unlimited quotes — no upgrade needed.');
    }
    const fromTier = state.tier;
    const toTier = billing.nextTier(fromTier);
    if (!toTier) {
      // Top tier (pro, 500 quotes): nothing above it.
      return bad(res, 400, "You're at the Pro cap — 500 quotes a month. Contact shiprate.ca for more.", { contact: true, tier: fromTier });
    }
    const meta = billing.planMeta(toTier);

    // Paid tier with a live subscription → update it in place (prorated).
    if (state.billingActive && state.stripeCustomerId) {
      const subs = await stripe.subscriptions.list({ customer: state.stripeCustomerId, status: 'all', limit: 10 });
      const sub = (subs.data || []).find((s) => s.status === 'active' || s.status === 'trialing');
      if (!sub) {
        return bad(res, 409, 'No active subscription found — use checkout to subscribe.');
      }
      const item = sub.items && sub.items.data && sub.items.data[0];
      if (!item) {
        return bad(res, 409, 'Subscription has no items — contact shiprate.ca.');
      }
      // Keep the customer's current billing cycle (monthly vs annual).
      const cycle = (item.price && item.price.recurring && item.price.recurring.interval) === 'year' ? 'annual' : 'monthly';
      const envName = PRICE_ENV[`${toTier}:${cycle}`];
      const priceId = (envName && process.env[envName]) || '';
      if (!priceId) {
        return bad(res, 501, `Stripe price not configured: set ${envName} on the server.`);
      }
      const updated = await stripe.subscriptions.update(sub.id, {
        items: [{ id: item.id, price: priceId }],
        proration_behavior: 'create_prorations',
        metadata: { user_id: req.user.id, tier: toTier, billing: cycle },
      });
      // Sync the tier locally NOW so the new quota applies at once — don't
      // wait for the webhook (which re-affirms the same state idempotently).
      await billing.setSubscription(req.user.id, { subscription_tier: toTier });
      await billing.recordUpgradeApproval({
        userId: req.user.id,
        approverUserId: req.user.id,
        approverEmail: req.user.email,
        fromTier,
        toTier,
        method: 'subscription_update',
        status: 'completed',
        stripeSubscriptionId: updated.id,
      });
      const fresh = await billing.getBillingState(req.user.id);
      return res.json({
        upgraded: true,
        tier: toTier,
        tier_name: meta.name,
        billing_cycle: cycle,
        quotes_used: fresh ? fresh.quotesUsed : state.quotesUsed,
        quotes_limit: fresh ? fresh.quotesLimit : meta.quotes_limit,
      });
    }

    // Free (or lapsed) → paid: new subscription via the Checkout flow.
    // Guard: an existing non-canceled subscription (e.g. past_due) must be
    // settled in the portal — starting a second one would stack bills.
    let customerId = state.stripeCustomerId;
    if (customerId) {
      const existing = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
      if ((existing.data || []).some((s) => s.status !== 'canceled')) {
        return bad(res, 409, 'You already have a subscription — manage it from the billing portal instead of starting a new one.');
      }
    }
    const envName = PRICE_ENV[`${toTier}:monthly`];
    const priceId = (envName && process.env[envName]) || '';
    if (!priceId) {
      return bad(res, 501, `Stripe price not configured: set ${envName} on the server.`);
    }
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        name: req.user.name || undefined,
        metadata: { user_id: req.user.id, company: req.user.company || '' },
      });
      customerId = customer.id;
      await billing.setSubscription(req.user.id, { stripe_customer_id: customerId });
    }
    const origin = siteOrigin(req);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: req.user.id,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { user_id: req.user.id, tier: toTier, billing: 'monthly', upgrade: 'true', from_tier: fromTier },
      subscription_data: { metadata: { user_id: req.user.id, tier: toTier, billing: 'monthly', upgrade: 'true', from_tier: fromTier } },
      success_url: `${origin}/?billing=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?billing=cancelled`,
      allow_promotion_codes: true,
    });
    await billing.recordUpgradeApproval({
      userId: req.user.id,
      approverUserId: req.user.id,
      approverEmail: req.user.email,
      fromTier,
      toTier,
      method: 'checkout',
      status: 'pending',
      stripeSubscriptionId: null,
    });
    return res.json({ url: session.url, tier: toTier, tier_name: meta.name });
  } catch (err) {
    console.error('[billing/upgrade]', err.message);
    return bad(res, 502, 'Could not complete the upgrade: ' + err.message);
  }
});

// GET /api/billing/history — this account's plan-upgrade approvals, newest
// first: who approved each upgrade, from-tier → to-tier, when, and whether
// the new tier landed.
router.get('/history', async (req, res) => {
  if (needAuth(req, res)) return;
  if (needDb(res)) return;
  try {
    const approvals = await billing.listUpgradeApprovals(req.user.id);
    return res.json({ approvals });
  } catch (err) {
    console.error('[billing/history]', err.message);
    return bad(res, 500, 'Could not load plan history.');
  }
});

// POST /api/billing/portal — Stripe customer portal (manage/cancel plan).
router.post('/portal', async (req, res) => {
  if (needAuth(req, res)) return;
  if (needDb(res)) return;
  const stripe = stripeClient();
  if (!stripe) {
    return bad(res, 501, 'Stripe is not configured: set STRIPE_SECRET_KEY on the server.');
  }
  try {
    const state = await billing.getBillingState(req.user.id);
    if (!state || !state.stripeCustomerId) {
      return bad(res, 400, 'No billing account yet — subscribe to a plan first.');
    }
    const portal = await stripe.billingPortal.sessions.create({
      customer: state.stripeCustomerId,
      return_url: siteOrigin(req) + '/',
    });
    return res.json({ url: portal.url });
  } catch (err) {
    console.error('[billing/portal]', err.message);
    return bad(res, 502, 'Could not open the billing portal: ' + err.message);
  }
});

// GET /api/billing/payment-method — the signed-in shipper's saved card on
// file (from Stripe), if any. Stripe unconfigured or no customer yet returns
// { configured: false } / { card: null } instead of an error so the
// Billing Center can render an honest "no card on file" state.
router.get('/payment-method', async (req, res) => {
  if (needAuth(req, res)) return;
  if (needDb(res)) return;
  const stripe = stripeClient();
  if (!stripe) return res.json({ configured: false, card: null });
  try {
    const state = await billing.getBillingState(req.user.id);
    if (!state || !state.stripeCustomerId) {
      return res.json({ configured: true, card: null });
    }
    const pms = await stripe.paymentMethods.list({
      customer: state.stripeCustomerId,
      type: 'card',
      limit: 1,
    });
    const pm = pms.data[0];
    if (!pm || !pm.card) return res.json({ configured: true, card: null });
    return res.json({
      configured: true,
      card: {
        brand: pm.card.brand || 'card',
        last4: pm.card.last4 || '••••',
        exp_month: pm.card.exp_month,
        exp_year: pm.card.exp_year,
      },
    });
  } catch (err) {
    console.error('[billing/payment-method]', err.message);
    return bad(res, 502, 'Could not load the payment method: ' + err.message);
  }
});

// GET /api/billing/payments — the signed-in shipper's freight payment history
// (one row per scheduled load: date, PRO, route, amount, payment status).
router.get('/payments', async (req, res) => {
  if (needAuth(req, res)) return;
  if (needDb(res)) return;
  try {
    const r = await db.query(
      `SELECT o.created_at, o.tracking_code, o.shipper_order_no, o.receiver_po_no,
              o.carrier, o.service_level, o.charged_amount, o.payment_status,
              o.status, o.bol_json
       FROM orders o
       WHERE o.user_id = $1
       ORDER BY o.created_at DESC LIMIT 200`,
      [req.user.id]
    );
    const payments = r.rows.map((row) => {
      let bol = {};
      try { bol = typeof row.bol_json === 'object' ? row.bol_json || {} : JSON.parse(row.bol_json || '{}'); } catch { /* ignore */ }
      const city = (p) => [p && p.city, p && (p.province || p.state)].filter(Boolean).join(', ');
      const origin = city(bol.shipper);
      const dest = city(bol.consignee);
      return {
        date: row.created_at ? new Date(row.created_at).toISOString().slice(0, 10) : '',
        tracking_code: row.tracking_code || '',
        shipper_order_no: row.shipper_order_no || '',
        receiver_po_no: row.receiver_po_no || '',
        carrier: row.carrier || '',
        service: row.service_level || '',
        route: [origin, dest].filter(Boolean).join(' → ') || '',
        charged_amount: row.charged_amount == null ? null : Number(row.charged_amount),
        payment_status: row.payment_status || '',
        status: row.status || '',
      };
    });
    return res.json({ payments });
  } catch (err) {
    console.error('[billing/payments]', err.message);
    return bad(res, 500, 'Could not load payment history.');
  }
});

module.exports = router;
