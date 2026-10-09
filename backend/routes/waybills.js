// routes/waybills.js — saved waybills (bills of lading) with auto-sequenced numbers.
//
// Each account gets its own sequence: WB-000001, WB-000002, … minted
// atomically on save (no gaps burned by abandoned drafts). Waybill bodies are
// stored as JSON and listed/loaded as full history.
//
// Endpoints (all require sign-in):
//   GET    /api/waybills        list saved waybills, newest first
//   POST   /api/waybills        save new {bol_json, shipment_id?} -> assigns waybill_no
//   GET    /api/waybills/:id    fetch one
//   PUT    /api/waybills/:id    update {bol_json} (keeps its number)
//   DELETE /api/waybills/:id    delete one
//
// Tables are created on boot (CREATE TABLE IF NOT EXISTS).
'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');

const router = express.Router();

async function ensureWaybillTables() {
  if (!db.isEnabled()) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS waybill_counters (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      last_no INTEGER NOT NULL DEFAULT 0
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS waybills (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      waybill_no TEXT NOT NULL,
      shipment_id TEXT,
      bol_json JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, waybill_no)
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS waybills_user_idx ON waybills (user_id, created_at DESC)`);
}
ensureWaybillTables().catch((e) => console.error('[waybills] table setup failed:', e.message));

function needUser(req, res) {
  if (!req.user) { res.status(401).json({ error: 'Sign in to use waybills.' }); return false; }
  return true;
}
function needDb(res) {
  if (!db.isEnabled()) { res.status(503).json({ error: 'Waybill history is unavailable right now.' }); return false; }
  return true;
}
function cleanStr(v, max) {
  return String(v || '').trim().slice(0, max) || null;
}
function fmtNo(n) { return 'WB-' + String(n).padStart(6, '0'); }

// Mint the next sequence number for this user, atomically.
async function nextWaybillNo(userId) {
  const r = await db.query(`
    INSERT INTO waybill_counters (user_id, last_no) VALUES ($1, 1)
    ON CONFLICT (user_id) DO UPDATE SET last_no = waybill_counters.last_no + 1
    RETURNING last_no`, [userId]);
  return fmtNo(r.rows[0].last_no);
}

const LIST_COLS = 'id, waybill_no, shipment_id, bol_json, created_at, updated_at';

router.get('/', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  try {
    const r = await db.query(
      `SELECT ${LIST_COLS} FROM waybills WHERE user_id = $1 ORDER BY created_at DESC LIMIT 500`,
      [req.user.id]);
    res.json({ rows: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'Could not load waybill history.' });
  }
});

router.post('/', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  try {
    const bolJson = req.body && typeof req.body.bol_json === 'object' && req.body.bol_json
      ? req.body.bol_json : {};
    const shipmentId = cleanStr(req.body && req.body.shipment_id, 64);
    const waybillNo = await nextWaybillNo(req.user.id);
    const id = crypto.randomUUID();
    const r = await db.query(
      `INSERT INTO waybills (id, user_id, waybill_no, shipment_id, bol_json)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${LIST_COLS}`,
      [id, req.user.id, waybillNo, shipmentId, JSON.stringify(bolJson)]);
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error('[waybills] save failed:', e.message);
    res.status(500).json({ error: 'Could not save the waybill.' });
  }
});

router.get('/:id', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  try {
    const r = await db.query(
      `SELECT ${LIST_COLS} FROM waybills WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Waybill not found.' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Could not load the waybill.' });
  }
});

router.put('/:id', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  try {
    const bolJson = req.body && typeof req.body.bol_json === 'object' && req.body.bol_json
      ? req.body.bol_json : {};
    const r = await db.query(
      `UPDATE waybills SET bol_json = $1, updated_at = now()
       WHERE id = $2 AND user_id = $3
       RETURNING ${LIST_COLS}`,
      [JSON.stringify(bolJson), req.params.id, req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Waybill not found.' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Could not update the waybill.' });
  }
});

router.delete('/:id', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  try {
    const r = await db.query(
      `DELETE FROM waybills WHERE id = $1 AND user_id = $2 RETURNING waybill_no`,
      [req.params.id, req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Waybill not found.' });
    res.json({ deleted: r.rows[0].waybill_no });
  } catch (e) {
    res.status(500).json({ error: 'Could not delete the waybill.' });
  }
});

module.exports = router;
