// routes/billing.js — subscription billing for shipper accounts.
//
//   GET  /api/billing/status                      — plan + usage (auth)
//   GET  /api/billing/payments                    — freight payment history (auth)
//   POST /api/billing/checkout {tier, billing}    — Stripe Checkout (auth)
//   POST /api/billing/portal                      — customer portal (auth)
//
// Prices live in Stripe; this route only reads price IDs from the env:
//   STRIPE_PRICE_STARTER_MONTHLY / STRIPE_PRICE_STARTER_ANNUAL
//   STRIPE_PRICE_PRO_MONTHLY     / STRIPE_PRICE_PRO_ANNUAL
// plus STRIPE_SECRET_KEY. Missing keys → 501 with a clear message; nothing
// is hardcoded.
'use strict';

const express = require('express');
const config = require('../config');
const db = require('../db');
const billing = require('../lib/billing');

const router = express.Router();

const PRICE_ENV = {
  'starter:monthly': 'STRIPE_PRICE_STARTER_MONTHLY',
  'starter:annual': 'STRIPE_PRICE_STARTER_ANNUAL',
  'pro:monthly': 'STRIPE_PRICE_PRO_MONTHLY',
  'pro:annual': 'STRIPE_PRICE_PRO_ANNUAL',
};

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
  if (!envName || !['starter', 'pro'].includes(tier) || !['monthly', 'annual'].includes(billingCycle)) {
    return bad(res, 400, "Choose a plan: tier 'starter' or 'pro', billing 'monthly' or 'annual'.");
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
