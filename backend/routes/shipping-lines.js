// routes/shipping-lines.js — Shipping line rate hub (Northline ONLY).
//
// Built from scratch Oct 25, 2026: Seven confirmed there are no shipping
// line rates on file at all, so v1 is the structure — lines, port-to-port
// container rates, and broker entries (freight brokers + import/export
// customs brokers with their fees) — filled in by admin over time. The hub
// prices We Buy container listings: a seller looks up the ocean leg +
// broker fees here to build the all-in unit price (freight, broker fee,
// import fees, duties, all covered by the seller).
//
// v1 is a rate book, not auto-pricing: nothing here re-rates a listing
// automatically, because there is no rate data yet and no port mapping
// from free-text listing origins. That wiring comes once rates exist.
//
// Gating: server.js mounts this router behind northlineOnly + 
// requireApprovedAccount. Reads are open to approved accounts; writes are
// admin-only (requireAdmin, same pattern as carrier-uploads).
// Tables are created idempotently here, same pattern as shipper-rates.
'use strict';

const express = require('express');
const db = require('../db');
const { requireAdmin } = require('./admin');

const router = express.Router();

const CONTAINER_SIZES = ['20ft', '40ft', '40ft HC'];
const BROKER_TYPES = ['freight', 'customs'];

async function ensureSchema() {
  if (!db.isEnabled()) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS shipping_lines (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name       varchar(160) NOT NULL,
      website    text,
      phone      varchar(60),
      notes      text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS shipping_line_rates (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      line_id      uuid NOT NULL REFERENCES shipping_lines(id) ON DELETE CASCADE,
      origin_port  varchar(120) NOT NULL,
      dest_port    varchar(120) NOT NULL,
      container_size varchar(20) NOT NULL CHECK (container_size IN ('20ft', '40ft', '40ft HC')),
      rate_cad     numeric(12, 2) NOT NULL,
      valid_from   date,
      valid_to     date,
      notes        text NOT NULL DEFAULT '',
      created_at   timestamptz NOT NULL DEFAULT now()
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS shipping_brokers (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      broker_type varchar(20) NOT NULL CHECK (broker_type IN ('freight', 'customs')),
      name       varchar(160) NOT NULL,
      phone      varchar(60),
      email      varchar(160),
      fee_cad    numeric(12, 2),
      fee_note   text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
}
ensureSchema().catch(() => {});

function needDb(res) {
  if (!db.isEnabled()) {
    res.status(502).json({ error: 'Database unavailable' });
    return true;
  }
  return false;
}

// GET /api/shipping-lines — lines with their rates + brokers.
router.get('/', async (req, res) => {
  if (needDb(res)) return;
  try {
    const lines = await db.query('SELECT * FROM shipping_lines ORDER BY name ASC');
    const rates = await db.query(
      'SELECT * FROM shipping_line_rates ORDER BY origin_port ASC, dest_port ASC, container_size ASC'
    );
    const brokers = await db.query(
      'SELECT * FROM shipping_brokers ORDER BY broker_type ASC, name ASC'
    );
    const byLine = {};
    for (const rate of rates.rows) {
      (byLine[rate.line_id] = byLine[rate.line_id] || []).push({
        id: rate.id,
        origin_port: rate.origin_port,
        dest_port: rate.dest_port,
        container_size: rate.container_size,
        rate_cad: Number(rate.rate_cad),
        valid_from: rate.valid_from,
        valid_to: rate.valid_to,
        notes: rate.notes,
      });
    }
    return res.json({
      lines: lines.rows.map((l) => ({
        id: l.id,
        name: l.name,
        website: l.website,
        phone: l.phone,
        notes: l.notes,
        rates: byLine[l.id] || [],
      })),
      brokers: brokers.rows.map((b) => ({
        id: b.id,
        broker_type: b.broker_type,
        name: b.name,
        phone: b.phone,
        email: b.email,
        fee_cad: b.fee_cad == null ? null : Number(b.fee_cad),
        fee_note: b.fee_note,
      })),
    });
  } catch (err) {
    return res.status(502).json({ error: 'Could not load shipping lines: ' + err.message });
  }
});

// POST /api/shipping-lines/lines — admin adds a shipping line.
router.post('/lines', async (req, res) => {
  if (needDb(res)) return;
  if (!(await requireAdmin(req, res))) return;
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Line name is required.' });
    const r = await db.query(
      'INSERT INTO shipping_lines (name, website, phone, notes) VALUES ($1, $2, $3, $4) RETURNING *',
      [name.slice(0, 160), String(b.website || '').trim() || null, String(b.phone || '').trim() || null, String(b.notes || '')]
    );
    return res.json({ line: r.rows[0] });
  } catch (err) {
    return res.status(502).json({ error: 'Could not add line: ' + err.message });
  }
});

// POST /api/shipping-lines/rates — admin adds a port-to-port container rate.
router.post('/rates', async (req, res) => {
  if (needDb(res)) return;
  if (!(await requireAdmin(req, res))) return;
  try {
    const b = req.body || {};
    const rate = Number(b.rate_cad);
    if (!Number.isFinite(rate) || rate <= 0) {
      return res.status(400).json({ error: 'Rate must be greater than 0.' });
    }
    if (!CONTAINER_SIZES.includes(String(b.container_size || ''))) {
      return res.status(400).json({ error: 'Container size must be 20ft, 40ft, or 40ft HC.' });
    }
    const origin = String(b.origin_port || '').trim();
    const dest = String(b.dest_port || '').trim();
    if (!origin || !dest) {
      return res.status(400).json({ error: 'Origin and destination ports are required.' });
    }
    const line = await db.query('SELECT id FROM shipping_lines WHERE id = $1', [b.line_id]);
    if (!line.rows.length) return res.status(404).json({ error: 'Shipping line not found.' });
    const r = await db.query(
      `INSERT INTO shipping_line_rates
        (line_id, origin_port, dest_port, container_size, rate_cad, valid_from, valid_to, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        b.line_id, origin.slice(0, 120), dest.slice(0, 120), b.container_size, rate,
        b.valid_from || null, b.valid_to || null, String(b.notes || ''),
      ]
    );
    return res.json({ rate: r.rows[0] });
  } catch (err) {
    return res.status(502).json({ error: 'Could not add rate: ' + err.message });
  }
});

// POST /api/shipping-lines/brokers — admin adds a freight/customs broker.
router.post('/brokers', async (req, res) => {
  if (needDb(res)) return;
  if (!(await requireAdmin(req, res))) return;
  try {
    const b = req.body || {};
    if (!BROKER_TYPES.includes(String(b.broker_type || ''))) {
      return res.status(400).json({ error: 'Broker type must be freight or customs.' });
    }
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Broker name is required.' });
    let fee = null;
    if (b.fee_cad !== null && b.fee_cad !== undefined && b.fee_cad !== '') {
      fee = Number(b.fee_cad);
      if (!Number.isFinite(fee) || fee < 0) {
        return res.status(400).json({ error: 'Fee cannot be negative.' });
      }
    }
    const r = await db.query(
      `INSERT INTO shipping_brokers (broker_type, name, phone, email, fee_cad, fee_note)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        b.broker_type, name.slice(0, 160), String(b.phone || '').trim() || null,
        String(b.email || '').trim() || null, fee, String(b.fee_note || ''),
      ]
    );
    return res.json({ broker: r.rows[0] });
  } catch (err) {
    return res.status(502).json({ error: 'Could not add broker: ' + err.message });
  }
});

module.exports = router;
