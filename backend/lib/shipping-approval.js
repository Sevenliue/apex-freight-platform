// lib/shipping-approval.js — the shipping-approval gate shared by routes.
// userCanShip(userId): admins (ADMIN_EMAILS) always pass; ordinary accounts
// must be approved by an admin in Admin → Account approvals. New accounts
// start quote-only.
//
// Lives in lib/ (not routes/shipments.js) so any route can require it
// without creating a routes/ <-> routes/ circular dependency.
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

module.exports = { userCanShip };
