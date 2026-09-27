// routes/inventory.js — Northline Ops simple inventory (scan in / scan out).
//
// No ERP integration: each account keeps its own live item list.
// Endpoints (all require sign-in):
//   GET  /api/inventory/items              list items (sku, name, qty)
//   POST /api/inventory/items              create or rename an item {sku, name}
//   POST /api/inventory/scan               record a movement {sku, direction: 'in'|'out', qty?, name?}
//   GET  /api/inventory/movements          recent movements (latest first)
//
// Tables are created on boot (CREATE TABLE IF NOT EXISTS).
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

router.get('/items', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  try {
    const r = await db.query(
      `SELECT id, sku, name, qty FROM inventory_items WHERE user_id = $1 ORDER BY updated_at DESC`,
      [req.user.id]
    );
    res.json({ items: r.rows });
  } catch (e) { res.status(500).json({ error: 'Could not load inventory.' }); }
});

router.post('/items', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  const sku = String(req.body.sku || '').trim().slice(0, 64);
  const name = String(req.body.name || '').trim().slice(0, 160);
  if (!sku || !name) return res.status(400).json({ error: 'Barcode and item name are required.' });
  try {
    const r = await db.query(
      `INSERT INTO inventory_items (id, user_id, sku, name, qty)
       VALUES ($1, $2, $3, $4, 0)
       ON CONFLICT (user_id, sku) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
       RETURNING id, sku, name, qty`,
      [db.newId('inv'), req.user.id, sku, name]
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
  if (!sku) return res.status(400).json({ error: 'Barcode is required.' });
  try {
    let r = await db.query(
      `SELECT id, sku, name, qty FROM inventory_items WHERE user_id = $1 AND sku = $2`,
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
        `INSERT INTO inventory_items (id, user_id, sku, name, qty) VALUES ($1,$2,$3,$4,0) RETURNING id, sku, name, qty`,
        [db.newId('inv'), req.user.id, sku, name]
      );
      item = r.rows[0];
    }
    const next = item.qty + (direction === 'in' ? qty : -qty);
    if (next < 0) {
      return res.status(400).json({ error: `Not enough stock (have ${item.qty}, tried to take ${qty}).`, item });
    }
    r = await db.query(
      `UPDATE inventory_items SET qty = $1, updated_at = now() WHERE id = $2 RETURNING id, sku, name, qty`,
      [next, item.id]
    );
    const updated = r.rows[0];
    await db.query(
      `INSERT INTO inventory_movements (id, user_id, item_id, sku, direction, qty, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [db.newId('invm'), req.user.id, updated.id, sku, direction, qty, req.body.note ? String(req.body.note).slice(0, 200) : null]
    );
    res.json({ item: updated, movement: { sku, direction, qty } });
  } catch (e) { res.status(500).json({ error: 'Could not record scan.' }); }
});

router.get('/movements', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30));
  try {
    const r = await db.query(
      `SELECT m.sku, m.direction, m.qty, m.created_at, COALESCE(i.name, m.sku) AS name
       FROM inventory_movements m LEFT JOIN inventory_items i ON i.id = m.item_id
       WHERE m.user_id = $1 ORDER BY m.created_at DESC LIMIT $2`,
      [req.user.id, limit]
    );
    res.json({ movements: r.rows });
  } catch (e) { res.status(500).json({ error: 'Could not load history.' }); }
});

module.exports = router;
