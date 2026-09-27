// routes/carriers.js — carrier directory + exclusion list (mirrors the
// Smart Shipping Carriers page: list left, exclusion panel right).
//   GET    /api/carriers              — list carriers
//   POST   /api/carriers              — create {name*, city, province, phone, email}
//   PUT    /api/carriers/:id          — update
//   DELETE /api/carriers/:id          — delete
//   GET    /api/carriers/exclusions            — list excluded carrier names
//   POST   /api/carriers/exclusions            — {name*} exclude a carrier
//   DELETE /api/carriers/exclusions/:name      — remove an exclusion
// Excluded carriers are filtered out of the matrix-ranked quote board in
// routes/rates.js (case-insensitive on the carrier label). EasyPost live
// rates are NOT filtered.
// With no database, everything lives in memory for the server's lifetime.
'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

// In-memory fallback.
const memCarriers = new Map(); // id -> record
const memExclusions = new Map(); // userId -> Map(lowercased name -> original-case name)

function memExclFor(userId) {
  let m = memExclusions.get(userId);
  if (!m) { m = new Map(); memExclusions.set(userId, m); }
  return m;
}

// Carriers the rate matrix already quotes (must match carrier_label in
// backend/rates/build-matrix.js).
const SEEDED_CARRIERS = ['Rosenau Transport', 'Guilbault Transport', 'HiFab Transport'];

function seedMemory() {
  if (memCarriers.size) return;
  for (const name of SEEDED_CARRIERS) {
    const rec = {
      id: db.newId('c'),
      name,
      city: '',
      province: '',
      phone: '',
      email: '',
      created_at: new Date().toISOString(),
    };
    memCarriers.set(rec.id, rec);
  }
}
seedMemory();

function str(v, max) {
  return String(v == null ? '' : v).slice(0, max);
}

function rowToCarrier(row) {
  return {
    id: row.id,
    name: row.name,
    city: row.city,
    province: row.province,
    phone: row.phone,
    email: row.email,
    created_at: row.created_at,
  };
}

router.get('/', async (req, res) => {
  if (db.isEnabled()) {
    try {
      const r = await db.query('SELECT * FROM carriers ORDER BY name ASC');
      return res.json({ carriers: r.rows.map(rowToCarrier) });
    } catch (err) {
      return res.status(502).json({ error: 'Could not list carriers: ' + err.message });
    }
  }
  seedMemory();
  const all = [...memCarriers.values()].sort((a, b) => a.name.localeCompare(b.name));
  res.json({ carriers: all });
});

router.post('/', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  const name = str((req.body || {}).name, 160).trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const rec = {
    city: str((req.body || {}).city, 80).trim(),
    province: str((req.body || {}).province, 40).trim(),
    phone: str((req.body || {}).phone, 40).trim(),
    email: str((req.body || {}).email, 160).trim(),
  };
  if (db.isEnabled()) {
    try {
      const r = await db.query(
        `INSERT INTO carriers (name, city, province, phone, email)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [name, rec.city || null, rec.province || null, rec.phone || null, rec.email || null]
      );
      return res.status(201).json({ carrier: rowToCarrier(r.rows[0]) });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'A carrier with that name already exists' });
      return res.status(502).json({ error: 'Could not add carrier: ' + err.message });
    }
  }
  seedMemory();
  if ([...memCarriers.values()].some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: 'A carrier with that name already exists' });
  }
  const full = { id: db.newId('c'), name, ...rec, created_at: new Date().toISOString() };
  memCarriers.set(full.id, full);
  res.status(201).json({ carrier: full });
});

router.put('/:id', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  const name = str((req.body || {}).name, 160).trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const rec = {
    city: str((req.body || {}).city, 80).trim(),
    province: str((req.body || {}).province, 40).trim(),
    phone: str((req.body || {}).phone, 40).trim(),
    email: str((req.body || {}).email, 160).trim(),
  };
  if (db.isEnabled()) {
    try {
      const r = await db.query(
        `UPDATE carriers SET name=$2, city=$3, province=$4, phone=$5, email=$6
         WHERE id=$1 RETURNING *`,
        [req.params.id, name, rec.city || null, rec.province || null, rec.phone || null, rec.email || null]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Unknown carrier id' });
      return res.json({ carrier: rowToCarrier(r.rows[0]) });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'A carrier with that name already exists' });
      return res.status(502).json({ error: 'Could not update carrier: ' + err.message });
    }
  }
  const existing = memCarriers.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Unknown carrier id' });
  if ([...memCarriers.values()].some((c) => c.id !== req.params.id && c.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: 'A carrier with that name already exists' });
  }
  const updated = { ...existing, name, ...rec };
  memCarriers.set(existing.id, updated);
  res.json({ carrier: updated });
});

router.delete('/:id', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  if (db.isEnabled()) {
    try {
      const r = await db.query('DELETE FROM carriers WHERE id = $1 RETURNING id', [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'Unknown carrier id' });
      return res.json({ deleted: true });
    } catch (err) {
      return res.status(502).json({ error: 'Could not delete carrier: ' + err.message });
    }
  }
  if (!memCarriers.delete(req.params.id)) return res.status(404).json({ error: 'Unknown carrier id' });
  res.json({ deleted: true });
});

// --- Exclusions ------------------------------------------------------------

router.get('/exclusions', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  const userId = req.user.id;
  if (db.isEnabled()) {
    try {
      const r = await db.query(
        'SELECT carrier_name FROM carrier_exclusions WHERE user_id = $1 ORDER BY carrier_name ASC',
        [userId]
      );
      return res.json({ exclusions: r.rows.map((x) => x.carrier_name) });
    } catch (err) {
      return res.status(502).json({ error: 'Could not list exclusions: ' + err.message });
    }
  }
  const m = memExclusions.get(userId);
  res.json({ exclusions: m ? [...m.values()].sort() : [] });
});

router.post('/exclusions', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  const userId = req.user.id;
  const name = str((req.body || {}).name, 160).trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (db.isEnabled()) {
    try {
      await db.query(
        `INSERT INTO carrier_exclusions (user_id, carrier_name) VALUES ($1, $2)
         ON CONFLICT (user_id, carrier_name) DO NOTHING`,
        [userId, name]
      );
      return res.status(201).json({ excluded: name });
    } catch (err) {
      return res.status(502).json({ error: 'Could not add exclusion: ' + err.message });
    }
  }
  memExclFor(userId).set(name.toLowerCase(), name);
  res.status(201).json({ excluded: name });
});

router.delete('/exclusions/:name', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  const userId = req.user.id;
  const name = decodeURIComponent(req.params.name);
  if (db.isEnabled()) {
    try {
      const r = await db.query(
        'DELETE FROM carrier_exclusions WHERE user_id = $1 AND carrier_name = $2 RETURNING carrier_name',
        [userId, name]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'No such exclusion' });
      return res.json({ removed: name });
    } catch (err) {
      return res.status(502).json({ error: 'Could not remove exclusion: ' + err.message });
    }
  }
  const m = memExclusions.get(userId);
  if (!m || !m.delete(name.toLowerCase())) return res.status(404).json({ error: 'No such exclusion' });
  res.json({ removed: name });
});

// getExcludedNames(userId): lowercased set of the account's excluded carrier
// names, for the rates route. Exclusions are per-account: one user's hidden
// carrier must not disappear from another account's rate board. Unsigned
// callers (guest quotes) get no exclusions. Non-fatal: a DB error returns the
// (possibly empty) in-memory set so quoting never breaks.
async function getExcludedNames(userId) {
  if (!userId) return new Set();
  if (db.isEnabled()) {
    try {
      const r = await db.query('SELECT carrier_name FROM carrier_exclusions WHERE user_id = $1', [userId]);
      return new Set(r.rows.map((x) => String(x.carrier_name).toLowerCase()));
    } catch (err) {
      console.error('[carriers] exclusion lookup failed (continuing):', err.message);
      return new Set();
    }
  }
  const m = memExclusions.get(userId);
  return new Set(m ? m.keys() : []);
}

module.exports = router;
module.exports.getExcludedNames = getExcludedNames;
