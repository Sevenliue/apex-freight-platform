// routes/admin.js — GET /api/admin/overview
// Platform-wide aggregates from Postgres. Requires DATABASE_URL; without it
// answers 501 with a clear message. Table names match the backend's own
// writes (shipment_postings, bids, marketplace_transactions).
'use strict';

const express = require('express');
const db = require('../db');
const config = require('../config');
const { round2 } = require('../lib/money');
const { sanitizeMarkup } = require('../lib/markup');

const router = express.Router();

router.get('/overview', async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
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
  if (!(await requireAdmin(req, res))) return;
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
// Exported so other routes can reuse the admin gate.
module.exports.requireAdmin = requireAdmin;

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
      `SELECT id, email, full_name, company_name, phone, shipping_approved, markup_percent, created_at
         FROM users ORDER BY created_at DESC LIMIT 500`
    );
    const users = r.rows.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.full_name,
      company: u.company_name,
      phone: u.phone,
      shipping_approved: !!u.shipping_approved,
      markup_percent: u.markup_percent == null ? null : Number(u.markup_percent),
      is_admin: billing.isAdminEmail(u.email),
      created_at: u.created_at,
    }));
    return res.json({ users, default_markup: config.markupPercent });
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

// POST /api/admin/users/:id/markup — set a per-customer freight markup
// override (percent). Body {markup_percent}: a number 0–100, or null/blank
// to reset the account to the global default.
router.post('/users/:id/markup', async (req, res) => {
  if (needDb(res)) return;
  if (!(await requireAdmin(req, res))) return;
  const markup = sanitizeMarkup(req.body && req.body.markup_percent);
  if (markup === undefined) {
    return res.status(400).json({ error: 'markup_percent must be a number between 0 and 100, or blank to use the default.' });
  }
  try {
    const r = await db.query(
      'UPDATE users SET markup_percent = $1 WHERE id = $2 RETURNING id, markup_percent',
      [markup, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Unknown account.' });
    return res.json({
      id: r.rows[0].id,
      markup_percent: r.rows[0].markup_percent == null ? null : Number(r.rows[0].markup_percent),
      default_markup: config.markupPercent,
    });
  } catch (err) {
    return res.status(502).json({ error: 'Could not update markup: ' + err.message });
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

// ---------- Northline Ops Bookstore ----------

// GET /api/admin/store/orders — digital product orders, newest first.
router.get('/store/orders', async (req, res) => {
  if (needDb(res)) return;
  if (!(await requireAdmin(req, res))) return;
  try {
    const r = await db.query(
      `SELECT o.id, o.amount_cents, o.currency, o.status, o.created_at,
              u.email AS user_email, p.title AS product_title, p.slug AS product_slug
       FROM digital_orders o
       JOIN users u ON u.id = o.user_id
       JOIN products p ON p.id = o.product_id
       ORDER BY o.created_at DESC LIMIT 200`
    );
    res.json({ orders: r.rows });
  } catch (err) {
    res.status(502).json({ error: 'Could not load store orders: ' + err.message });
  }
});

// GET /api/admin/store/products — all products including inactive.
router.get('/store/products', async (req, res) => {
  if (needDb(res)) return;
  if (!(await requireAdmin(req, res))) return;
  try {
    const r = await db.query(`SELECT * FROM products ORDER BY sort_order, created_at`);
    res.json({ products: r.rows });
  } catch (err) {
    res.status(502).json({ error: 'Could not load products: ' + err.message });
  }
});

// PUT /api/admin/store/products/:id — update title, pricing, visibility.
router.put('/store/products/:id', async (req, res) => {
  if (needDb(res)) return;
  if (!(await requireAdmin(req, res))) return;
  const b = req.body || {};
  const fields = [];
  const vals = [];
  let i = 1;
  for (const k of ['title', 'subtitle', 'description']) {
    if (typeof b[k] === 'string') { fields.push(`${k} = $${i++}`); vals.push(b[k]); }
  }
  if (Number.isFinite(Number(b.price_cents))) {
    const cents = Math.round(Number(b.price_cents));
    if (cents < 0) return res.status(400).json({ error: 'price_cents cannot be negative.' });
    fields.push(`price_cents = $${i++}`); vals.push(cents);
  }
  if (typeof b.active === 'boolean') { fields.push(`active = $${i++}`); vals.push(b.active); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });
  try {
    vals.push(req.params.id);
    const r = await db.query(`UPDATE products SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, vals);
    if (!r.rows.length) return res.status(404).json({ error: 'Unknown product.' });
    res.json({ product: r.rows[0] });
  } catch (err) {
    res.status(502).json({ error: 'Could not update product: ' + err.message });
  }
});
