// lib/shipping-approval.js — the shipping-approval gate shared by routes.
// userCanShip(userId): admins (ADMIN_EMAILS) always pass; ordinary accounts
// must be approved by an admin in Admin → Account approvals. New accounts
// start quote-only.
//
// ACCOUNT-approval lock (Oct 2026): carriers don't yet know their rates are
// posted, so a new signup must not see ANYTHING until an admin approves
// them — not just shipping, but quotes, waybills, store, everything.
// requireApprovedAccount enforces that at the API level (server.js applies
// it to the signed-in data routes); the frontend shows a "waiting for
// approval" page instead of the app shell while locked.
//
// TO REVERSE (restore quote-only for new signups once carriers are aware
// their rates are posted): set ACCOUNT_LOCK_ENABLED to false below.
// That single flip disables both the API gate and the frontend pending
// page (the flag is exposed via GET /api/site-config).
//
'use strict';

const db = require('../db');

async function userCanShip(userId) {
  if (!userId) return false;
  try {
    if (db.isEnabled()) {
      const r = await db.query('SELECT shipping_approved FROM users WHERE id = $1 LIMIT 1', [userId]);
      if (r.rows.length && r.rows[0].shipping_approved) return true;
    }
  } catch { /* fall through to the billing/admin check */ }
  try {
    const billing = require('./billing');
    return !!((await billing.getBillingState(userId) || {}).isAdmin);
  } catch {
    return false;
  }
}

// Single flip for the account-approval lock. true = unapproved accounts see
// only the "waiting for approval" page and get 403 from the signed-in data
// routes. false = back to quote-only for new signups.
const ACCOUNT_LOCK_ENABLED = true;

// requireApprovedAccount: Express middleware for the signed-in data routes.
// Passes through when the lock is off, when there is no session (the route's
// own auth answers 401), for the Everest service key (admin-equivalent),
// for approved accounts, and for staff/admin emails (auto-approved).
// Otherwise 403 with pending_approval: true so the frontend can show the
// waiting page instead of a generic error.
function requireApprovedAccount(req, res, next) {
  try {
    if (!ACCOUNT_LOCK_ENABLED) return next();
    if (req.everestAdmin) return next();
    const user = req.user;
    if (!user) return next();
    if (user.shipping_approved) return next();
    try {
      const { isAdminEmail } = require('./billing');
      if (isAdminEmail(user.email)) return next();
    } catch { /* fall through to the 403 */ }
    return res.status(403).json({
      error: 'Your account is pending approval — you will be notified once it is approved.',
      pending_approval: true,
    });
  } catch (e) {
    try { require('./crashlog').capture(e); } catch {}
    return next();
  }
}

module.exports = { userCanShip, requireApprovedAccount, ACCOUNT_LOCK_ENABLED };
