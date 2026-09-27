// lib/markup.js — per-customer freight markup resolution.
//
// The global default lives in config.markupPercent (MARKUP_PERCENT env, 15).
// An admin can override it per customer account via
// POST /api/admin/users/:id/markup. NULL/blank on the account = use the
// global default. The markup value is never exposed to customers — it is
// margin data, so it stays server-side only.
'use strict';

const config = require('../config');
const db = require('../db');

// userMarkupPercent(userId): the account's markup override (a number) or
// null when unset. Never throws — a lookup failure means "use the default".
async function userMarkupPercent(userId) {
  if (!userId || !db.isEnabled()) return null;
  try {
    const r = await db.query(
      'SELECT markup_percent FROM users WHERE id = $1 LIMIT 1',
      [userId]
    );
    if (!r.rows.length) return null;
    const m = r.rows[0].markup_percent;
    return m == null ? null : Number(m);
  } catch (err) {
    console.error('[markup] lookup failed, using default:', err.message);
    return null;
  }
}

// effectiveMarkup(userId): per-customer override, else the global default.
async function effectiveMarkup(userId) {
  const m = await userMarkupPercent(userId);
  return m == null || !Number.isFinite(m) ? config.markupPercent : m;
}

// sanitizeMarkup(v): validate an admin-supplied markup. Returns null to
// reset the account to the default, a number to store, or undefined when
// the input is invalid (admin must fix it, not silently store it).
function sanitizeMarkup(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) return undefined;
  return Math.round(n * 100) / 100;
}

module.exports = { userMarkupPercent, effectiveMarkup, sanitizeMarkup };
