// routes/quotes.js — saved quotes for the Smart Shipping-style flow.
//   GET  /api/quotes/accessorials      — pick-up/delivery service catalog
//   POST /api/quotes/:id/save          — save a quote for later retrieval
//   GET  /api/quotes/saved?user_id=    — list saved quotes
//   GET  /api/quotes/:id               — full quote (params + rates) for reload
//
// :id accepts either the in-memory shipment_id (q_...) or the DB uuid.
// With no database, saved quotes live in memory for the server's lifetime.
'use strict';

const express = require('express');
const db = require('../db');
const { store } = require('../lib/store');
const acc = require('../lib/accessorials');

const router = express.Router();

function bad(res, code, error) {
  return res.status(code).json({ error });
}

router.get('/accessorials', (req, res) => {
  res.json({ accessorials: acc.list() });
});

function rowToQuote(row) {
  const j = (v) => {
    if (v == null) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return null; }
  };
  return {
    id: row.id,
    shipment_id: row.id,
    quote_name: row.quote_name,
    user_id: row.user_id,
    origin: {
      street1: row.origin_street1, city: row.origin_city, state: row.origin_state,
      zip: row.origin_zip, country: row.origin_country,
    },
    destination: {
      street1: row.dest_street1, city: row.dest_city, state: row.dest_state,
      zip: row.dest_zip, country: row.dest_country,
    },
    shipper: j(row.shipper_json) || {},
    consignee: j(row.consignee_json) || {},
    packages: j(row.packages_json) || [],
    accessorials: j(row.accessorials_json) || [],
    rates: j(row.rates_json) || [],
    region: row.region || 'canada_usa',
    direction: row.direction || 'outbound',
    freight_charges: row.freight_charges || 'prepaid',
    bill_to: j(row.bill_to_json) || {},
    depot_dropoff: !!row.depot_dropoff,
    depot_pickup: !!row.depot_pickup,
    total_weight_lbs: row.parcel_weight != null ? Number(row.parcel_weight) : null,
    created_at: row.created_at,
    is_saved: !!row.is_saved,
  };
}

function memToQuote(q) {
  return {
    id: q.db_quote_id || q.shipment_id,
    shipment_id: q.shipment_id,
    quote_name: q.quote_name || null,
    user_id: q.user_id || null,
    origin: q.origin,
    destination: q.destination,
    shipper: q.shipper || {},
    consignee: q.consignee || {},
    packages: q.packages || [],
    accessorials: q.accessorials || [],
    rates: q.rates || [],
    region: q.region || 'canada_usa',
    direction: q.direction || 'outbound',
    freight_charges: q.freight_charges || 'prepaid',
    bill_to: q.bill_to || {},
    depot_dropoff: !!q.depot_dropoff,
    depot_pickup: !!q.depot_pickup,
    total_weight_lbs: q.total_weight_lbs ?? null,
    created_at: q.created_at,
    is_saved: true,
  };
}

// POST /api/quotes/:id/save — { name? }
router.post('/:id/save', async (req, res) => {
  const { id } = req.params;
  const name = String((req.body || {}).name || '').slice(0, 255) || null;

  // In-memory record first (fast path; also the only path without a DB).
  const mem = store.quotes.get(id);
  if (mem) {
    mem.quote_name = name;
    mem.is_saved = true;
    store.savedQuotes.set(mem.shipment_id, mem);
    if (db.isEnabled() && mem.db_quote_id) {
      try {
        await db.query('UPDATE quotes SET is_saved = true, quote_name = $2 WHERE id = $1', [mem.db_quote_id, name]);
      } catch (err) {
        return bad(res, 502, 'Could not mark quote saved: ' + err.message);
      }
    }
    return res.json({ saved: true, quote: memToQuote(mem) });
  }

  // Fall back to a DB row by uuid (e.g. after a server restart).
  if (db.isEnabled()) {
    try {
      const r = await db.query('UPDATE quotes SET is_saved = true, quote_name = COALESCE($2, quote_name) WHERE id = $1 RETURNING *', [id, name]);
      if (!r.rows.length) return bad(res, 404, 'Unknown quote id — request a fresh quote first');
      return res.json({ saved: true, quote: rowToQuote(r.rows[0]) });
    } catch (err) {
      return bad(res, 502, 'Could not save quote: ' + err.message);
    }
  }

  return bad(res, 404, 'Unknown quote id — request a fresh quote first');
});

// GET /api/quotes/saved?user_id= — the logged-in account wins over the
// optional guest user_id label.
router.get('/saved', async (req, res) => {
  const userId = (req.user && req.user.id) || req.query.user_id || null;
  if (db.isEnabled()) {
    try {
      const params = [];
      let where = 'WHERE is_saved = true';
      if (userId) {
        const uuid = await db.ensureUser(userId, 'shipper');
        params.push(uuid);
        where += ` AND user_id = $${params.length}`;
      }
      const r = await db.query(
        `SELECT * FROM quotes ${where} ORDER BY created_at DESC LIMIT 50`, params
      );
      return res.json({ quotes: r.rows.map(rowToQuote) });
    } catch (err) {
      return bad(res, 502, 'Could not list saved quotes: ' + err.message);
    }
  }
  const all = [...store.savedQuotes.values()]
    .filter((q) => !userId || q.user_id === userId)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, 50);
  return res.json({ quotes: all.map(memToQuote) });
});

// GET /api/quotes/:id
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const mem = store.quotes.get(id) || store.savedQuotes.get(id);
  if (mem) return res.json({ quote: memToQuote(mem) });
  if (db.isEnabled()) {
    try {
      const r = await db.query('SELECT * FROM quotes WHERE id = $1', [id]);
      if (!r.rows.length) return bad(res, 404, 'Unknown quote id');
      return res.json({ quote: rowToQuote(r.rows[0]) });
    } catch (err) {
      return bad(res, 502, 'Could not load quote: ' + err.message);
    }
  }
  return bad(res, 404, 'Unknown quote id');
});

module.exports = router;
