// lib/billing.js — subscription tier + monthly quote-quota logic.
//
// Tiers (monthly, CAD): free (5 quotes / calendar month), starter ($29, 35),
// growth ($69, 100), business ($99, 200), pro ($149, 500). Annual billing
// is 10x monthly (2 months free). Over 500 quotes/month is not a tier —
// the customer contacts shiprate.ca for a custom arrangement.
// A paid tier only counts while subscription_status is 'active' or
// 'trialing'; any other status (past_due, canceled, ...) falls back to the
// free tier. Quota usage resets on the first request of a new YYYY-MM period.
//
// Admins: account emails listed in the ADMIN_EMAILS env var get tier
// 'admin' — unlimited quotes, no paywall — for the site owner and staff.
//
// Upgrade flow (Oct 2026): when an account at its quota tries to quote,
// the 402 response carries an upgrade offer (next tier + monthly price).
// Clicking Yes calls POST /api/billing/upgrade, which upgrades the account
// to the next tier immediately for the current month — a Stripe
// subscription update (standard proration) when already paid, or a new
// Checkout session when coming from free. Every Yes is recorded in
// plan_upgrade_approvals with the approving user's id + email + timestamp
// + from-tier → to-tier, so a company can always see WHO approved a bill.
'use strict';

const config = require('../config');
const db = require('../db');

// Ladder order: the upgrade offer always points at the next rung.
const TIERS = ['free', 'starter', 'growth', 'business', 'pro'];

// PLAN_META: display name + monthly/annual CAD price + monthly quote cap.
// quotes_limit: null = unlimited (only the staff 'admin' tier, not 'pro').
const PLAN_META = {
  free:     { name: 'Free',     monthly: 0,   annual: 0,    quotes_limit: 5 },
  starter:  { name: 'Starter',  monthly: 29,  annual: 290,  quotes_limit: 35 },
  growth:   { name: 'Growth',   monthly: 69,  annual: 690,  quotes_limit: 100 },
  business: { name: 'Business', monthly: 99,  annual: 990,  quotes_limit: 200 },
  pro:      { name: 'Pro',      monthly: 149, annual: 1490, quotes_limit: 500 },
};

const QUOTA_LIMITS = { free: 5, starter: 35, growth: 100, business: 200, pro: 500, admin: null };

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

function planMeta(tier) {
  return PLAN_META[normalizeTier(tier)];
}

// nextTier(tier): the next rung on the ladder, or null at the top (pro).
function nextTier(tier) {
  const i = TIERS.indexOf(normalizeTier(tier));
  return i >= 0 && i < TIERS.length - 1 ? TIERS[i + 1] : null;
}

// upgradeOfferFor(state): what the quota-exceeded prompt should offer.
// Returns { next_tier, next_tier_name, next_price, next_quotes_limit } or
// null when there is no higher tier (pro at the 500 cap → contact sales).
function upgradeOfferFor(state) {
  if (!state || state.isAdmin || state.unlimitedQuotes) return null;
  const next = nextTier(state.tier);
  if (!next) return null;
  const meta = PLAN_META[next];
  return {
    next_tier: next,
    next_tier_name: meta.name,
    next_price: meta.monthly,
    next_quotes_limit: meta.quotes_limit,
  };
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
            quotes_used, quota_period, stripe_customer_id, shipping_approved,
            unlimited_quotes
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
      unlimitedQuotes: true,
      shippingApproved: true, // staff always bypass the shipping gate
      status: row.subscription_status,
      billingActive: true,
      quotesUsed: Number(row.quotes_used) || 0,
      quotesLimit: null,
      periodEnd: row.current_period_end || null,
      stripeCustomerId: row.stripe_customer_id || null,
    };
  }
  // Admin-granted unlimited quotes: no monthly cap, but NOT an admin —
  // no admin UI, no shipping bypass, stays on the account's own plan tier.
  if (row.unlimited_quotes) {
    return {
      userId: row.id,
      tier: effectiveTier(row),
      isAdmin: false,
      unlimitedQuotes: true,
      shippingApproved,
      status: row.subscription_status,
      billingActive: ACTIVE_STATUSES.has(row.subscription_status),
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

// tryIncrementQuota(userId, limit): atomically consume one quote, but only
// when the hard cap allows it. Returns true when the quote was counted,
// false when the cap was already reached (a concurrent request won the race).
// The check and the increment happen in a single UPDATE, so concurrent
// requests can never push usage past a hard cap — quotas are hard caps with
// no overdraft. limit = null means unlimited. Fails closed: a DB error
// throws, and callers must not serve the quote uncounted.
async function tryIncrementQuota(userId, limit) {
  if (!db.isEnabled()) return true;
  const period = currentPeriod();
  const r = await db.query(
    `UPDATE users
        SET quotes_used = CASE WHEN quota_period = $2 THEN quotes_used + 1 ELSE 1 END,
            quota_period = $2
      WHERE id = $1
        AND ($3::int IS NULL OR quota_period IS DISTINCT FROM $2 OR quotes_used < $3::int)
      RETURNING quotes_used`,
    [userId, period, limit]
  );
  return r.rowCount > 0;
}

// incrementQuota(userId): legacy non-atomic counter. Kept for compatibility;
// new code should use tryIncrementQuota so hard caps hold under concurrency.
async function incrementQuota(userId) {
  await tryIncrementQuota(userId, null);
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

// --- Plan-upgrade approval log -------------------------------------------
// plan_upgrade_approvals: one row per Yes on an upgrade prompt. The
// approver is the signed-in user who clicked Yes (id + email, snapshotted
// at approval time). status: 'pending' = checkout started, upgrade not yet
// confirmed by Stripe; 'completed' = the new tier landed (subscription
// update applied immediately, or the Stripe webhook confirmed checkout).
async function ensureUpgradeTables() {
  if (!db.isEnabled()) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS plan_upgrade_approvals (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      approver_user_id      uuid,
      approver_email        text NOT NULL,
      from_tier             text NOT NULL,
      to_tier               text NOT NULL,
      method                text NOT NULL DEFAULT 'checkout',
      status                text NOT NULL DEFAULT 'pending',
      stripe_subscription_id text,
      created_at            timestamptz NOT NULL DEFAULT now(),
      completed_at          timestamptz
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_plan_upgrade_approvals_user_id ON plan_upgrade_approvals (user_id, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_plan_upgrade_approvals_created_at ON plan_upgrade_approvals (created_at DESC)`);
}

// recordUpgradeApproval: persist a Yes. Returns the inserted row.
async function recordUpgradeApproval({ userId, approverUserId, approverEmail, fromTier, toTier, method, status, stripeSubscriptionId }) {
  await ensureUpgradeTables();
  const r = await db.query(
    `INSERT INTO plan_upgrade_approvals
       (user_id, approver_user_id, approver_email, from_tier, to_tier, method, status, stripe_subscription_id, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $7 = 'completed' THEN now() ELSE NULL END)
     RETURNING id, user_id, approver_user_id, approver_email, from_tier, to_tier, method, status, stripe_subscription_id, created_at, completed_at`,
    [userId, approverUserId || null, approverEmail, fromTier, toTier, method || 'checkout', status || 'pending', stripeSubscriptionId || null]
  );
  return r.rows[0];
}

// completeUpgradeApproval(userId, toTier): mark the latest pending approval
// for this account+target-tier as completed. Called by the Stripe webhook
// when the new tier lands. No-op when there is no pending approval (e.g.
// the upgrade came through the customer portal) — never throws.
async function completeUpgradeApproval(userId, toTier) {
  if (!db.isEnabled() || !userId || !toTier) return null;
  try {
    await ensureUpgradeTables();
    const r = await db.query(
      `UPDATE plan_upgrade_approvals SET status = 'completed', completed_at = now()
        WHERE id = (
          SELECT id FROM plan_upgrade_approvals
           WHERE user_id = $1 AND to_tier = $2 AND status = 'pending'
           ORDER BY created_at DESC LIMIT 1
        )
       RETURNING id`,
      [userId, toTier]
    );
    return r.rows.length ? r.rows[0].id : null;
  } catch (err) {
    console.error('[billing] completeUpgradeApproval failed:', err.message);
    return null;
  }
}

function approvalRow(r, accountEmail) {
  return {
    id: r.id,
    user_id: r.user_id,
    account_email: accountEmail || r.account_email || null,
    approver_user_id: r.approver_user_id,
    approver_email: r.approver_email,
    from_tier: r.from_tier,
    to_tier: r.to_tier,
    method: r.method,
    status: r.status,
    stripe_subscription_id: r.stripe_subscription_id,
    created_at: r.created_at,
    completed_at: r.completed_at,
  };
}

// listUpgradeApprovals(userId): this account's upgrade history, newest first.
async function listUpgradeApprovals(userId) {
  if (!db.isEnabled()) return [];
  await ensureUpgradeTables();
  const r = await db.query(
    `SELECT * FROM plan_upgrade_approvals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [userId]
  );
  return r.rows.map((row) => approvalRow(row));
}

// listAllUpgradeApprovals(limit): every account's upgrades, newest first,
// for the Admin view. Includes the account email for each row.
async function listAllUpgradeApprovals(limit) {
  if (!db.isEnabled()) return [];
  await ensureUpgradeTables();
  const r = await db.query(
    `SELECT a.*, u.email AS account_email
       FROM plan_upgrade_approvals a
       LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC LIMIT $1`,
    [Math.max(1, Math.min(500, Number(limit) || 200))]
  );
  return r.rows.map((row) => approvalRow(row, row.account_email));
}

module.exports = {
  TIERS,
  PLAN_META,
  QUOTA_LIMITS,
  currentPeriod,
  normalizeTier,
  planMeta,
  nextTier,
  upgradeOfferFor,
  effectiveTier,
  quotesLimit,
  isAdminEmail,
  getBillingState,
  checkQuota,
  incrementQuota,
  tryIncrementQuota,
  setSubscription,
  ensureUpgradeTables,
  recordUpgradeApproval,
  completeUpgradeApproval,
  listUpgradeApprovals,
  listAllUpgradeApprovals,
};
