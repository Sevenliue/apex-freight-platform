// lib/billing.js — subscription tier + monthly quote-quota logic.
//
// Tiers: free (5 quotes / calendar month), starter (50), pro (unlimited).
// A paid tier only counts while subscription_status is 'active' or
// 'trialing'; any other status (past_due, canceled, ...) falls back to the
// free tier. Quota usage resets on the first request of a new YYYY-MM period.
//
// Admins: account emails listed in the ADMIN_EMAILS env var get tier
// 'admin' — unlimited quotes, no paywall — for the site owner and staff.
'use strict';

const config = require('../config');
const db = require('../db');

const TIERS = ['free', 'starter', 'pro'];

// quotes_limit: null = unlimited.
const QUOTA_LIMITS = { free: 5, starter: 50, pro: null, admin: null };

const ACTIVE_STATUSES = new Set(['active', 'trialing']);

// isAdminEmail(email): is this account on the owner/staff bypass list?
function isAdminEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return !!e && config.adminEmails.includes(e);
}

function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function normalizeTier(tier) {
  return TIERS.includes(tier) ? tier : 'free';
}

// effectiveTier(row): the tier that actually applies right now.
function effectiveTier(row) {
  const tier = normalizeTier(row && row.subscription_tier);
  if (tier === 'free') return 'free';
  return ACTIVE_STATUSES.has(row.subscription_status) ? tier : 'free';
}

function quotesLimit(tier) {
  if (tier === 'admin') return null; // owner/staff bypass: unlimited
  return QUOTA_LIMITS[normalizeTier(tier)];
}

// getBillingState(userId): read the user's billing row, rolling the quota
// period over when the calendar month changed. Returns null when the DB is
// off (callers should then fail closed on gated routes).
async function getBillingState(userId) {
  if (!db.isEnabled()) return null;
  const r = await db.query(
    `SELECT id, email, subscription_tier, subscription_status, current_period_end,
            quotes_used, quota_period, stripe_customer_id, shipping_approved
       FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  const shippingApproved = !!row.shipping_approved;
  // Owner/staff bypass: unlimited quotes, no subscription needed.
  if (isAdminEmail(row.email)) {
    return {
      userId: row.id,
      tier: 'admin',
      isAdmin: true,
      shippingApproved: true, // staff always bypass the shipping gate
      status: row.subscription_status,
      billingActive: true,
      quotesUsed: Number(row.quotes_used) || 0,
      quotesLimit: null,
      periodEnd: row.current_period_end || null,
      stripeCustomerId: row.stripe_customer_id || null,
    };
  }
  const period = currentPeriod();
  let quotesUsed = Number(row.quotes_used) || 0;
  let quotaPeriod = row.quota_period || null;
  if (quotaPeriod !== period) {
    // New month: reset the counter. Single UPDATE keeps it race-safe.
    const u = await db.query(
      `UPDATE users SET quotes_used = 0, quota_period = $2
        WHERE id = $1 RETURNING quotes_used, quota_period`,
      [userId, period]
    );
    quotesUsed = Number(u.rows[0].quotes_used) || 0;
    quotaPeriod = u.rows[0].quota_period;
  }
  const tier = effectiveTier(row);
  return {
    userId: row.id,
    tier,
    isAdmin: false,
    shippingApproved,
    status: row.subscription_status,
    billingActive: ACTIVE_STATUSES.has(row.subscription_status),
    quotesUsed,
    quotesLimit: quotesLimit(tier),
    periodEnd: row.current_period_end || null,
    stripeCustomerId: row.stripe_customer_id || null,
  };
}

// checkQuota(userId): may this account run one more quote right now?
// Returns { allowed, state, reason }.
async function checkQuota(userId) {
  const state = await getBillingState(userId);
  if (!state) {
    return { allowed: false, state: null, reason: 'Billing requires a database.' };
  }
  if (state.quotesLimit == null) return { allowed: true, state, reason: null };
  if (state.quotesUsed >= state.quotesLimit) {
    return {
      allowed: false,
      state,
      reason: `You've used all ${state.quotesLimit} quotes on the ${state.tier} plan this month.`,
    };
  }
  return { allowed: true, state, reason: null };
}

// incrementQuota(userId): count one consumed quote. Call only after a quote
// was actually produced. Keeps the period rollover race-safe.
async function incrementQuota(userId) {
  if (!db.isEnabled()) return;
  const period = currentPeriod();
  await db.query(
    `UPDATE users
        SET quotes_used = CASE WHEN quota_period = $2 THEN quotes_used + 1 ELSE 1 END,
            quota_period = $2
      WHERE id = $1`,
    [userId, period]
  );
}

// setSubscription(userId, fields): upsert billing fields from Stripe events.
// Idempotent — re-processing the same event lands on the same state.
async function setSubscription(userId, fields) {
  if (!db.isEnabled()) return;
  const cols = [];
  const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) {
    cols.push(`${k} = $${i++}`);
    vals.push(v);
  }
  if (!cols.length) return;
  vals.push(userId);
  await db.query(`UPDATE users SET ${cols.join(', ')} WHERE id = $${i}`, vals);
}

module.exports = {
  TIERS,
  QUOTA_LIMITS,
  currentPeriod,
  effectiveTier,
  quotesLimit,
  isAdminEmail,
  getBillingState,
  checkQuota,
  incrementQuota,
  setSubscription,
};
