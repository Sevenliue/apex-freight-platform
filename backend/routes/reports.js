// routes/reports.js — real, runnable reports off the platform's own data.
//
//   GET /api/reports/shipments?start_date&end_date&q&format=json|xlsx
//   GET /api/reports/quotes?start_date&end_date&q&format=json|xlsx
//   GET /api/reports/revenue?start_date&end_date&format=json|xlsx
//
// Login required. Shippers see their own rows; admins (ADMIN_EMAILS) see
// everything. format=xlsx downloads a real Excel workbook; otherwise JSON
// for the on-screen table.
'use strict';

const express = require('express');
const db = require('../db');
const billing = require('../lib/billing');
const { round2 } = require('../lib/money');
const XLSX = require('xlsx');

const router = express.Router();

const NO_DB = 'Reports require a database. Set DATABASE_URL to enable reporting.';

function needLogin(req, res) {
  if (!req.user) {
    res.status(401).json({ error: 'Sign in to run reports.' });
    return false;
  }
  return true;
}

async function isAdmin(userId) {
  try {
    return !!((await billing.getBillingState(userId) || {}).isAdmin);
  } catch {
    return false;
  }
}

function dateRange(q) {
  const start = q.start_date ? new Date(q.start_date + 'T00:00:00') : null;
  const end = q.end_date ? new Date(q.end_date + 'T23:59:59') : null;
  return {
    start: start && !Number.isNaN(start.getTime()) ? start.toISOString() : null,
    end: end && !Number.isNaN(end.getTime()) ? end.toISOString() : null,
  };
}

function parseBol(v) {
  try {
    return typeof v === 'object' ? v || {} : JSON.parse(v || '{}');
  } catch {
    return {};
  }
}

function cityOf(p) {
  if (!p) return '';
  return [p.city, p.province || p.state].filter(Boolean).join(', ');
}

const num = (v) => (v == null || v === '' ? null : Number(v));

// sendXlsx: stream a real .xlsx workbook download.
function sendXlsx(res, baseName, rows) {
  const sheetRows = rows.length ? rows : [{}];
  const ws = XLSX.utils.json_to_sheet(sheetRows);
  const keys = Object.keys(sheetRows[0]);
  ws['!cols'] = keys.map((k) => {
    let w = k.length + 2;
    for (const r of rows.slice(0, 200)) {
      const v = r[k];
      const len = v == null ? 0 : String(v).length;
      if (len + 2 > w) w = len + 2;
    }
    return { wch: Math.min(45, Math.max(12, w)) };
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Report');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fname = `${baseName}-${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  return res.send(buf);
}

function matchesQuery(row, q) {
  const term = String(q || '').trim().toLowerCase();
  if (!term) return true;
  return Object.values(row).some(
    (v) => v != null && String(v).toLowerCase().includes(term)
  );
}

function finalize(req, res, baseName, rows, summary) {
  const fmt = String(req.query.format || 'json').toLowerCase();
  if (fmt === 'xlsx') return sendXlsx(res, baseName, rows);
  return res.json({ summary, rows });
}

// ---------------------------------------------------------------------------
// GET /api/reports/shipments — every scheduled/purchased load.
// ---------------------------------------------------------------------------
router.get('/shipments', async (req, res) => {
  if (!needLogin(req, res)) return;
  if (!db.isEnabled()) return res.status(501).json({ error: NO_DB });
  const admin = await isAdmin(req.user.id);
  const { start, end } = dateRange(req.query);
  try {
    const params = [];
    let where = 'WHERE 1=1';
    if (start) { params.push(start); where += ` AND o.created_at >= $${params.length}`; }
    if (end) { params.push(end); where += ` AND o.created_at <= $${params.length}`; }
    if (!admin) { params.push(req.user.id); where += ` AND o.user_id = $${params.length}`; }
    const r = await db.query(
      `SELECT o.created_at, o.tracking_code, o.shipper_order_no, o.receiver_po_no,
              o.carrier, o.service_level, o.cost_amount, o.charged_amount,
              o.status, o.payment_status, o.tendered, o.carrier_pro, o.bol_json,
              u.email AS customer_email
       FROM orders o LEFT JOIN users u ON u.id = o.user_id
       ${where}
       ORDER BY o.created_at DESC LIMIT 5000`,
      params
    );
    let rows = r.rows.map((row) => {
      const bol = parseBol(row.bol_json);
      const cost = num(row.cost_amount);
      const charged = num(row.charged_amount);
      return {
        Date: row.created_at ? new Date(row.created_at).toISOString().slice(0, 10) : '',
        'PRO / Tracking': row.tracking_code || '',
        "Shipper's order #": row.shipper_order_no || '',
        "Receiver's PO #": row.receiver_po_no || '',
        Customer: row.customer_email || '',
        Origin: cityOf(bol.shipper),
        Destination: cityOf(bol.consignee),
        Carrier: row.carrier || '',
        Service: row.service_level || '',
        'Weight (lb)': num(bol.total_weight_lbs),
        'Cost (CAD)': cost,
        'Charged (CAD)': charged,
        'Margin (CAD)': cost != null && charged != null ? round2(charged - cost) : null,
        'Payment status': row.payment_status || '',
        Status: row.status || '',
        Tendered: row.tendered ? 'Yes' : 'No',
        'Carrier PRO': row.carrier_pro || '',
      };
    });
    rows = rows.filter((row) => matchesQuery(row, req.query.q));
    const sum = (k) => round2(rows.reduce((t, r) => t + (Number(r[k]) || 0), 0));
    return finalize(req, res, 'apex-shipments', rows, {
      shipments: rows.length,
      total_charged_cad: sum('Charged (CAD)'),
      total_cost_cad: sum('Cost (CAD)'),
      total_margin_cad: sum('Margin (CAD)'),
    });
  } catch (err) {
    return res.status(502).json({ error: 'Shipments report failed: ' + err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/reports/quotes — quoting activity and conversion.
// ---------------------------------------------------------------------------
router.get('/quotes', async (req, res) => {
  if (!needLogin(req, res)) return;
  if (!db.isEnabled()) return res.status(501).json({ error: NO_DB });
  const admin = await isAdmin(req.user.id);
  const { start, end } = dateRange(req.query);
  try {
    const params = [];
    let where = 'WHERE 1=1';
    if (start) { params.push(start); where += ` AND q.created_at >= $${params.length}`; }
    if (end) { params.push(end); where += ` AND q.created_at <= $${params.length}`; }
    if (!admin) { params.push(req.user.id); where += ` AND q.user_id = $${params.length}`; }
    const r = await db.query(
      `SELECT q.created_at, q.origin_city, q.origin_state, q.dest_city, q.dest_state,
              q.parcel_weight, q.is_saved, q.rates_json,
              u.email AS customer_email,
              EXISTS (SELECT 1 FROM orders o WHERE o.quote_id = q.id) AS converted
       FROM quotes q LEFT JOIN users u ON u.id = q.user_id
       ${where}
       ORDER BY q.created_at DESC LIMIT 5000`,
      params
    );
    let rows = r.rows.map((row) => {
      let rates = [];
      try {
        const v = row.rates_json;
        rates = Array.isArray(v) ? v : JSON.parse(v || '[]');
      } catch { /* ignore */ }
      const cheapest = rates.length
        ? Math.min(...rates.map((x) => Number(x.retail_cad)).filter(Number.isFinite))
        : null;
      return {
        Date: row.created_at ? new Date(row.created_at).toISOString().slice(0, 10) : '',
        Customer: row.customer_email || '',
        Origin: [row.origin_city, row.origin_state].filter(Boolean).join(', '),
        Destination: [row.dest_city, row.dest_state].filter(Boolean).join(', '),
        'Weight (lb)': num(row.parcel_weight),
        'Rates returned': rates.length,
        'Cheapest (CAD)': cheapest != null ? round2(cheapest) : null,
        Saved: row.is_saved ? 'Yes' : 'No',
        Shipped: row.converted ? 'Yes' : 'No',
      };
    });
    rows = rows.filter((row) => matchesQuery(row, req.query.q));
    const shipped = rows.filter((row) => row.Shipped === 'Yes').length;
    return finalize(req, res, 'apex-quotes', rows, {
      quotes: rows.length,
      shipped,
      conversion_rate: rows.length ? `${Math.round((shipped / rows.length) * 100)}%` : '—',
    });
  } catch (err) {
    return res.status(502).json({ error: 'Quotes report failed: ' + err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/reports/revenue — margin summary grouped by month and carrier.
// ---------------------------------------------------------------------------
router.get('/revenue', async (req, res) => {
  if (!needLogin(req, res)) return;
  if (!db.isEnabled()) return res.status(501).json({ error: NO_DB });
  const admin = await isAdmin(req.user.id);
  const { start, end } = dateRange(req.query);
  try {
    const params = [];
    let where = "WHERE o.status IN ('scheduled', 'purchased')";
    if (start) { params.push(start); where += ` AND o.created_at >= $${params.length}`; }
    if (end) { params.push(end); where += ` AND o.created_at <= $${params.length}`; }
    if (!admin) { params.push(req.user.id); where += ` AND o.user_id = $${params.length}`; }
    const r = await db.query(
      `SELECT o.created_at, o.carrier, o.cost_amount, o.charged_amount
       FROM orders o ${where}`,
      params
    );
    const groups = {};
    for (const row of r.rows) {
      const d = row.created_at ? new Date(row.created_at) : null;
      const month = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : 'unknown';
      const key = `${month}||${row.carrier || '—'}`;
      if (!groups[key]) {
        groups[key] = { Month: month, Carrier: row.carrier || '—', Shipments: 0, 'Gross (CAD)': 0, 'Cost (CAD)': 0 };
      }
      const g = groups[key];
      g.Shipments += 1;
      g['Gross (CAD)'] = round2(g['Gross (CAD)'] + (Number(row.charged_amount) || 0));
      g['Cost (CAD)'] = round2(g['Cost (CAD)'] + (Number(row.cost_amount) || 0));
    }
    let rows = Object.values(groups)
      .map((g) => ({ ...g, 'Margin (CAD)': round2(g['Gross (CAD)'] - g['Cost (CAD)']) }))
      .sort((a, b) => (a.Month < b.Month ? 1 : a.Month > b.Month ? -1 : 0));
    rows = rows.filter((row) => matchesQuery(row, req.query.q));
    const sum = (k) => round2(rows.reduce((t, r) => t + (Number(r[k]) || 0), 0));
    return finalize(req, res, 'apex-revenue', rows, {
      groups: rows.length,
      shipments: rows.reduce((t, r) => t + r.Shipments, 0),
      total_gross_cad: sum('Gross (CAD)'),
      total_margin_cad: sum('Margin (CAD)'),
    });
  } catch (err) {
    return res.status(502).json({ error: 'Revenue report failed: ' + err.message });
  }
});

module.exports = router;
