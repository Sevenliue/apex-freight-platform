// routes/reports.js — shipper & carrier financial reports.
//   GET /api/reports/shipper/:shipper_id?start_date&end_date&search
//   GET /api/reports/carrier/:carrier_id?start_date&end_date&search
// Both read the sibling-owned financial_reports_view, so they require a
// database: without DATABASE_URL they answer 501 with a clear message.
// The view's exact columns are owned by the DB sibling; this route adapts to
// common column candidates and documents the assumption.
'use strict';

const express = require('express');
const db = require('../db');
const { round2 } = require('../lib/money');

const router = express.Router();

const NO_DB = 'Reports require a database. Set DATABASE_URL to enable reporting.';

// First present numeric field wins (covers the sibling's view naming).
function pickAmount(row, candidates) {
  for (const k of candidates) {
    const v = Number(row[k]);
    if (Number.isFinite(v)) return v;
  }
  return 0;
}

function pickDate(row) {
  for (const k of ['shipment_date', 'created_at', 'date', 'transaction_date']) {
    if (row[k]) {
      const d = new Date(row[k]);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
}

function filterRows(rows, { start_date, end_date, search }) {
  const start = start_date ? new Date(start_date) : null;
  const end = end_date ? new Date(end_date) : null;
  const term = String(search || '').trim().toLowerCase();
  return rows.filter((row) => {
    if (start || end) {
      const d = pickDate(row);
      if (!d) return false;
      if (start && !Number.isNaN(start.getTime()) && d < start) return false;
      if (end && !Number.isNaN(end.getTime()) && d > end) return false;
    }
    if (term && !JSON.stringify(row).toLowerCase().includes(term)) return false;
    return true;
  });
}

async function buildReport(res, { idColumn, idValue, amountFields, summaryFor, req }) {
  if (!db.isEnabled()) return res.status(501).json({ error: NO_DB });
  const { start_date, end_date, search, q } = req.query;
  try {
    const r = await db.query(`SELECT * FROM financial_reports_view WHERE ${idColumn} = $1`, [idValue]);
    const rows = filterRows(r.rows, { start_date, end_date, search: search || q || '' });
    const total = round2(rows.reduce((sum, row) => sum + pickAmount(row, amountFields), 0));
    const count = rows.length;
    return res.json({
      summary: {
        ...summaryFor(count, total),
      },
      shipments: rows,
    });
  } catch (err) {
    return res.status(502).json({
      error: 'Report query failed — is financial_reports_view defined?',
      detail: err.message,
    });
  }
}

router.get('/shipper/:shipper_id', (req, res) =>
  buildReport(res, {
    idColumn: 'shipper_id',
    idValue: req.params.shipper_id,
    amountFields: ['total_spent', 'amount', 'shipper_charge', 'cost', 'charge'],
    summaryFor: (count, total) => ({
      total_shipments: count,
      total_spent: total,
      average_cost_per_shipment: count ? round2(total / count) : 0,
    }),
    req,
  })
);

router.get('/carrier/:carrier_id', (req, res) =>
  buildReport(res, {
    idColumn: 'carrier_id',
    idValue: req.params.carrier_id,
    amountFields: ['total_revenue_earned', 'revenue', 'carrier_payout', 'amount'],
    summaryFor: (count, total) => ({
      total_loads_hauled: count,
      total_revenue_earned: total,
      average_revenue_per_load: count ? round2(total / count) : 0,
    }),
    req,
  })
);

module.exports = router;
