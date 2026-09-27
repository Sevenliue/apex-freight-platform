// routes/admin.js — GET /api/admin/overview
// Platform-wide aggregates from Postgres. Requires DATABASE_URL; without it
// answers 501 with a clear message. Table names match the backend's own
// writes (shipment_postings, bids, marketplace_transactions).
'use strict';

const express = require('express');
const db = require('../db');
const { round2 } = require('../lib/money');

const router = express.Router();

router.get('/overview', async (req, res) => {
  if (!db.isEnabled()) {
    return res.status(501).json({ error: 'Admin overview requires a database. Set DATABASE_URL to enable it.' });
  }
  try {
    const [loads, money, bids] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='open_for_bids')::int AS open FROM shipment_postings`),
      db.query(`SELECT COALESCE(SUM(gross_shipper_paid),0) AS gross,
                       COALESCE(SUM(carrier_payout),0) AS payouts,
                       COALESCE(SUM(platform_fee),0) AS net
                  FROM marketplace_transactions`),
      db.query('SELECT COUNT(*)::int AS total FROM carrier_bids'),
    ]);
    return res.json({
      total_loads: loads.rows[0].total,
      open_loads: loads.rows[0].open,
      gross_revenue: round2(money.rows[0].gross),
      carrier_payouts: round2(money.rows[0].payouts),
      net_profit: round2(money.rows[0].net),
      total_bids: bids.rows[0].total,
    });
  } catch (err) {
    return res.status(502).json({
      error: 'Admin overview query failed — check that shipment_postings, bids and marketplace_transactions exist',
      detail: err.message,
    });
  }
});

// DELETE /api/admin/loads/:id — remove a posting and its bids/transactions.
router.delete('/loads/:id', async (req, res) => {
  if (!db.isEnabled()) {
    return res.status(501).json({ error: 'Deleting loads requires a database. Set DATABASE_URL to enable it.' });
  }
  try {
    const { id } = req.params;
    await db.query('DELETE FROM marketplace_transactions WHERE shipment_id = $1', [id]);
    const b = await db.query('DELETE FROM carrier_bids WHERE shipment_posting_id = $1', [id]);
    const p = await db.query('DELETE FROM shipment_postings WHERE id = $1', [id]);
    return res.json({ deleted_loads: p.rowCount, deleted_bids: b.rowCount });
  } catch (err) {
    return res.status(502).json({ error: 'Delete failed', detail: err.message });
  }
});

module.exports = router;

// ---------------------------------------------------------------------------
// Account approvals (added 2026-09-27): every new account starts quote-only.
// Admins approve accounts here; only approved accounts can schedule/pay for
// shipments (see userCanShip in routes/shipments.js).
// ---------------------------------------------------------------------------

const billing = require('../lib/billing');
const notify = require('../lib/notify');

function needDb(res) {
  if (!db.isEnabled()) {
    res.status(501).json({ error: 'Admin requires a database. Set DATABASE_URL to enable it.' });
    return true;
  }
  return false;
}

async function requireAdmin(req, res) {
  if (!req.user) {
    res.status(401).json({ error: 'Sign in required.' });
    return false;
  }
  try {
    const state = await billing.getBillingState(req.user.id);
    if (state && state.isAdmin) return true;
  } catch { /* fall through */ }
  res.status(403).json({ error: 'Admin access required.' });
  return false;
}

// GET /api/admin/users — all accounts, newest first, with approval status.
router.get('/users', async (req, res) => {
  if (needDb(res)) return;
  if (!(await requireAdmin(req, res))) return;
  try {
    const r = await db.query(
      `SELECT id, email, full_name, company_name, phone, shipping_approved, created_at
         FROM users ORDER BY created_at DESC LIMIT 500`
    );
    const users = r.rows.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.full_name,
      company: u.company_name,
      phone: u.phone,
      shipping_approved: !!u.shipping_approved,
      is_admin: billing.isAdminEmail(u.email),
      created_at: u.created_at,
    }));
    return res.json({ users });
  } catch (err) {
    return res.status(502).json({ error: 'Could not list accounts: ' + err.message });
  }
});

// POST /api/admin/users/:id/approve — approve an account for shipping.
router.post('/users/:id/approve', async (req, res) => {
  if (needDb(res)) return;
  if (!(await requireAdmin(req, res))) return;
  try {
    const r = await db.query(
      'UPDATE users SET shipping_approved = true WHERE id = $1 RETURNING id, email, full_name',
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Unknown account.' });
    const u = r.rows[0];
    try {
      notify.notify('shipping_approved', null, { user: { email: u.email, name: u.full_name } });
    } catch { /* notify never throws */ }
    return res.json({ approved: true, id: u.id });
  } catch (err) {
    return res.status(502).json({ error: 'Could not approve account: ' + err.message });
  }
});

// POST /api/admin/users/:id/revoke — remove shipping approval (quote-only).
router.post('/users/:id/revoke', async (req, res) => {
  if (needDb(res)) return;
  if (!(await requireAdmin(req, res))) return;
  try {
    const r = await db.query(
      'UPDATE users SET shipping_approved = false WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Unknown account.' });
    return res.json({ approved: false, id: r.rows[0].id });
  } catch (err) {
    return res.status(502).json({ error: 'Could not update account: ' + err.message });
  }
});
