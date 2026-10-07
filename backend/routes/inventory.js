// routes/inventory.js — Northline Ops inventory (scan in / scan out + verification).
//
// ScanFlow-style functions: lot / serial / expiry capture on every scan,
// damaged-stock segregation, expiry + low-stock + damage alerts, pick/pack
// verification against an expected list, a dashboard, and an audit trail.
//
// No ERP integration: each account keeps its own live item list.
// Endpoints (all require sign-in):
//   GET  /api/inventory/items              list items (sku, name, qty, expiry_date, low_stock_at, damaged_qty)
//   POST /api/inventory/items              create/rename an item {sku, name, low_stock_at?}
//   POST /api/inventory/scan               record a movement {sku, direction: 'in'|'out', qty?, name?,
//                                          lot?, expiry_date? (YYYY-MM-DD), serial?, condition?: 'ok'|'damaged'}
//   GET  /api/inventory/movements          recent movements (latest first; lot/expiry/serial/condition + who)
//   GET  /api/inventory/dashboard          today's in/out units, totals, low-stock / expiring-soon / damaged alerts
//   POST /api/inventory/verify             pick/pack check {expected: [{sku, qty}], scanned: [{sku, qty}]}
//                                          -> {ok, matched, shorts, overages, unknown}
//
// Tables are created on boot (CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS).
'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

async function ensureInventoryTables() {
  if (!db.isEnabled()) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_items (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id),
      sku TEXT NOT NULL,
      name TEXT NOT NULL,
      qty INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, sku)
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_movements (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id),
      item_id UUID REFERENCES inventory_items(id) ON DELETE SET NULL,
      sku TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
      qty INTEGER NOT NULL CHECK (qty > 0),
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS inventory_items_user_idx ON inventory_items (user_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS inventory_movements_user_idx ON inventory_movements (user_id, created_at DESC)`);
  // ScanFlow v1 columns — safe to re-run.
  await db.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS expiry_date DATE`);
  await db.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS low_stock_at INTEGER NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS damaged_qty INTEGER NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS lot TEXT`);
  await db.query(`ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS expiry_date DATE`);
  await db.query(`ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS serial TEXT`);
  await db.query(`ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS condition TEXT NOT NULL DEFAULT 'ok' CHECK (condition IN ('ok','damaged'))`);
}
ensureInventoryTables().catch((e) => console.error('[inventory] table init failed:', e.message));

function needDb(res) {
  if (!db.isEnabled()) { res.status(503).json({ error: 'Inventory is unavailable right now.' }); return false; }
  return true;
}
function needUser(req, res) {
  if (!req.user) { res.status(401).json({ error: 'Sign in to use inventory.' }); return false; }
  return true;
}

function cleanStr(v, max) {
  return String(v || '').trim().slice(0, max) || null;
}
function cleanDate(v) {
  const s = String(v || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  return isNaN(d.getTime()) ? null : s;
}

const ITEM_COLS = 'id, sku, name, qty, expiry_date, low_stock_at, damaged_qty';

router.get('/items', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  try {
    const r = await db.query(
      `SELECT ${ITEM_COLS} FROM inventory_items WHERE user_id = $1 ORDER BY updated_at DESC`,
      [req.user.id]
    );
    res.json({ items: r.rows });
  } catch (e) { res.status(500).json({ error: 'Could not load inventory.' }); }
});

router.post('/items', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  const sku = String(req.body.sku || '').trim().slice(0, 64);
  const name = String(req.body.name || '').trim().slice(0, 160);
  const lowStockAt = Math.max(0, Math.min(999999, Math.floor(Number(req.body.low_stock_at) || 0)));
  if (!sku || !name) return res.status(400).json({ error: 'Barcode and item name are required.' });
  try {
    const r = await db.query(
      `INSERT INTO inventory_items (id, user_id, sku, name, qty, low_stock_at)
       VALUES ($1, $2, $3, $4, 0, $5)
       ON CONFLICT (user_id, sku) DO UPDATE SET name = EXCLUDED.name, low_stock_at = EXCLUDED.low_stock_at, updated_at = now()
       RETURNING ${ITEM_COLS}`,
      [db.newId('inv'), req.user.id, sku, name, lowStockAt]
    );
    res.json({ item: r.rows[0] });
  } catch (e) { res.status(500).json({ error: 'Could not save item.' }); }
});

router.post('/scan', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  const sku = String(req.body.sku || '').trim().slice(0, 64);
  const direction = req.body.direction === 'out' ? 'out' : 'in';
  const qty = Math.max(1, Math.min(9999, Math.floor(Number(req.body.qty) || 1)));
  const name = String(req.body.name || '').trim().slice(0, 160);
  const lot = cleanStr(req.body.lot, 64);
  const serial = cleanStr(req.body.serial, 64);
  const expiryDate = cleanDate(req.body.expiry_date);
  const condition = req.body.condition === 'damaged' ? 'damaged' : 'ok';
  if (!sku) return res.status(400).json({ error: 'Barcode is required.' });
  try {
    let r = await db.query(
      `SELECT ${ITEM_COLS} FROM inventory_items WHERE user_id = $1 AND sku = $2`,
      [req.user.id, sku]
    );
    let item = r.rows[0];
    if (!item) {
      if (direction === 'out') {
        return res.status(404).json({ error: 'Unknown barcode. Scan it IN first to create the item.' });
      }
      if (!name) {
        return res.status(409).json({ error: 'New item — a name is needed.', needsName: true, sku });
      }
      r = await db.query(
        `INSERT INTO inventory_items (id, user_id, sku, name, qty) VALUES ($1,$2,$3,$4,0) RETURNING ${ITEM_COLS}`,
        [db.newId('inv'), req.user.id, sku, name]
      );
      item = r.rows[0];
    }
    // Damaged stock is segregated from sellable qty.
    const field = condition === 'damaged' ? 'damaged_qty' : 'qty';
    const have = item[field] || 0;
    const next = have + (direction === 'in' ? qty : -qty);
    if (next < 0) {
      return res.status(400).json({ error: `Not enough ${condition === 'damaged' ? 'damaged' : ''} stock (have ${have}, tried to take ${qty}).`, item });
    }
    // Track the nearest known expiry on inbound scans.
    let expirySql = '', expiryParams = [];
    if (direction === 'in' && expiryDate && (!item.expiry_date || expiryDate < item.expiry_date)) {
      expirySql = ', expiry_date = $3';
      expiryParams = [expiryDate];
    }
    r = await db.query(
      `UPDATE inventory_items SET ${field} = $2, updated_at = now()${expirySql} WHERE id = $1 RETURNING ${ITEM_COLS}`,
      [item.id, next, ...expiryParams]
    );
    const updated = r.rows[0];
    await db.query(
      `INSERT INTO inventory_movements (id, user_id, item_id, sku, direction, qty, note, lot, expiry_date, serial, condition)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [db.newId('invm'), req.user.id, updated.id, sku, direction, qty,
       req.body.note ? String(req.body.note).slice(0, 200) : null, lot, expiryDate, serial, condition]
    );
    res.json({ item: updated, movement: { sku, direction, qty, lot, expiry_date: expiryDate, serial, condition } });
  } catch (e) { res.status(500).json({ error: 'Could not record scan.' }); }
});

router.get('/movements', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30));
  try {
    const r = await db.query(
      `SELECT m.sku, m.direction, m.qty, m.created_at, m.lot, m.expiry_date, m.serial, m.condition,
              COALESCE(i.name, m.sku) AS name, u.email AS user_email
       FROM inventory_movements m
       LEFT JOIN inventory_items i ON i.id = m.item_id
       LEFT JOIN users u ON u.id = m.user_id
       WHERE m.user_id = $1 ORDER BY m.created_at DESC LIMIT $2`,
      [req.user.id, limit]
    );
    res.json({ movements: r.rows });
  } catch (e) { res.status(500).json({ error: 'Could not load history.' }); }
});

router.get('/dashboard', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  try {
    const [flow, totals, low, exp, dmg] = await Promise.all([
      db.query(
        `SELECT direction, COALESCE(SUM(qty), 0)::int AS units
         FROM inventory_movements
         WHERE user_id = $1 AND created_at::date = CURRENT_DATE
         GROUP BY direction`,
        [req.user.id]
      ),
      db.query(
        `SELECT COUNT(*)::int AS skus, COALESCE(SUM(qty), 0)::int AS units
         FROM inventory_items WHERE user_id = $1`,
        [req.user.id]
      ),
      db.query(
        `SELECT sku, name, qty, low_stock_at FROM inventory_items
         WHERE user_id = $1 AND low_stock_at > 0 AND qty <= low_stock_at
         ORDER BY qty ASC LIMIT 20`,
        [req.user.id]
      ),
      db.query(
        `SELECT sku, name, qty, expiry_date, (expiry_date - CURRENT_DATE)::int AS days_left
         FROM inventory_items
         WHERE user_id = $1 AND expiry_date IS NOT NULL AND expiry_date <= CURRENT_DATE + 30 AND qty > 0
         ORDER BY expiry_date ASC LIMIT 20`,
        [req.user.id]
      ),
      db.query(
        `SELECT sku, name, damaged_qty FROM inventory_items
         WHERE user_id = $1 AND damaged_qty > 0
         ORDER BY damaged_qty DESC LIMIT 20`,
        [req.user.id]
      ),
    ]);
    const today = { in: 0, out: 0 };
    flow.rows.forEach((r) => { today[r.direction] = r.units; });
    res.json({
      today_in: today.in, today_out: today.out,
      total_skus: totals.rows[0].skus, total_units: totals.rows[0].units,
      low_stock: low.rows, expiring_soon: exp.rows, damaged: dmg.rows,
    });
  } catch (e) { res.status(500).json({ error: 'Could not load dashboard.' }); }
});

// Pick/pack verification: compare a scanned set against the expected list.
// Pure computation — nothing is written. {expected: [{sku, qty}], scanned: [{sku, qty}]}
router.post('/verify', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  const agg = (lines) => {
    const m = new Map();
    (Array.isArray(lines) ? lines : []).forEach((l) => {
      const sku = String((l && l.sku) || '').trim().slice(0, 64);
      const qty = Math.max(0, Math.floor(Number(l && l.qty) || 0));
      if (!sku || qty <= 0) return;
      m.set(sku, (m.get(sku) || 0) + qty);
    });
    return m;
  };
  const exp = agg(req.body.expected);
  const got = agg(req.body.scanned);
  const matched = [], shorts = [], overages = [], unknown = [];
  exp.forEach((eqty, sku) => {
    const gqty = got.get(sku) || 0;
    if (gqty === eqty) matched.push({ sku, qty: eqty });
    else if (gqty < eqty) shorts.push({ sku, expected: eqty, scanned: gqty });
    else overages.push({ sku, expected: eqty, scanned: gqty });
  });
  got.forEach((gqty, sku) => {
    if (!exp.has(sku)) unknown.push({ sku, qty: gqty });
  });
  res.json({ ok: shorts.length === 0 && overages.length === 0 && unknown.length === 0, matched, shorts, overages, unknown });
});

module.exports = router;
