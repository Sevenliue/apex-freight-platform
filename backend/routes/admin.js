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
