// routes/loads.js — load board postings.
//   POST /api/loads/create        create a load posting (201 {load})
//   GET  /api/loads/open         open postings with bid counts + lowest bid
//   POST /api/loads/:id/probill  attach the carrier's PRO#/BOL# to a posting
// Works fully in-memory; writes to Postgres as well when DATABASE_URL is set.
'use strict';

const express = require('express');
const db = require('../db');
const { store } = require('../lib/store');
const { round2 } = require('../lib/money');

const router = express.Router();
const now = () => new Date().toISOString();

function place(v) {
  return { city: v.city, state: v.state, zip: v.zip || null };
}

router.post('/create', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  const b = req.body || {};
  const missing = [];
  if (!b.origin || !b.origin.city || !b.origin.state) missing.push('origin{city,state}');
  if (!b.destination || !b.destination.city || !b.destination.state) missing.push('destination{city,state}');
  if (!b.pickup_date) missing.push('pickup_date');
  if (!b.delivery_date) missing.push('delivery_date');
  const weightLbs = Number(b.weight_lbs);
  if (!Number.isFinite(weightLbs) || weightLbs <= 0) missing.push('weight_lbs (positive number)');
  if (missing.length) {
    return res.status(400).json({ error: `Missing/invalid fields: ${missing.join(', ')}` });
  }

  // The poster is always the signed-in account — never a client-supplied id.
  const shipperId = req.user.id;

  const load = {
    id: db.newId('load'),
    shipper_id: shipperId,
    shipper_order_number: b.shipper_order_number || null,
    origin: place(b.origin),
    destination: place(b.destination),
    pickup_date: b.pickup_date,
    delivery_date: b.delivery_date,
    weight_lbs: weightLbs,
    freight_type: b.freight_type || 'LTL',
    equipment_needed: b.equipment_needed || null,
    max_budget: b.max_budget != null ? round2(b.max_budget) : null,
    description: b.description || null,
    status: 'open_for_bids',
    carrier_probill_number: null,
    created_at: now(),
    updated_at: now(),
  };
  store.loads.set(load.id, load);

  if (db.isEnabled()) {
    try {
      await db.query(
        `INSERT INTO shipment_postings
           (id, shipper_id, shipper_order_number, origin_city, origin_state, origin_zip,
            dest_city, dest_state, dest_zip, pickup_date, delivery_date,
            weight_lbs, freight_type, equipment_needed, max_budget, description, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (id) DO NOTHING`,
        [load.id, load.shipper_id, load.shipper_order_number,
         b.origin.city, b.origin.state, b.origin.zip || null,
         b.destination.city, b.destination.state, b.destination.zip || null,
         load.pickup_date, load.delivery_date, load.weight_lbs,
         load.freight_type, load.equipment_needed, load.max_budget, load.description, load.status]
      );
    } catch (err) {
      console.error('[loads/create] DB insert failed (non-fatal):', err.message);
    }
  }

  return res.status(201).json({ load });
});

function withBidStats(load) {
  const bids = [...store.bids.values()].filter(
    (x) => x.shipment_posting_id === load.id && x.status !== 'rejected'
  );
  return {
    ...load,
    total_bids: bids.length,
    lowest_bid: bids.length ? Math.min(...bids.map((x) => Number(x.bid_amount))) : null,
  };
}

router.get('/open', async (req, res) => {
  if (db.isEnabled()) {
    try {
      const r = await db.query(
        `SELECT p.*,
                COUNT(b.id)::int AS total_bids,
                MIN(b.bid_amount) AS lowest_bid
           FROM shipment_postings p
           LEFT JOIN carrier_bids b
             ON b.shipment_posting_id = p.id AND b.status <> 'rejected'
          WHERE p.status = 'open_for_bids'
          GROUP BY p.id
          ORDER BY p.created_at DESC`
      );
      const loads = r.rows.map((row) => ({
        ...row,
        total_bids: Number(row.total_bids) || 0,
        lowest_bid: row.lowest_bid != null ? round2(row.lowest_bid) : null,
      }));
      return res.json({ loads });
    } catch (err) {
      console.error('[loads/open] DB query failed, falling back to memory:', err.message);
    }
  }
  const loads = [...store.loads.values()]
    .filter((l) => l.status === 'open_for_bids')
    .map(withBidStats)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return res.json({ loads });
});

router.post('/:id/probill', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  const load = store.loads.get(req.params.id);
  if (!load) return res.status(404).json({ error: 'Load not found' });
  // Only the posting shipper or the awarded carrier may set the PRO number.
  const me = req.user.id;
  const isShipper = load.shipper_id === me;
  const isCarrier = load.awarded_carrier_id === me || load.carrier_id === me;
  if (!isShipper && !isCarrier) {
    return res.status(403).json({ error: 'Only the posting shipper or awarded carrier can set the PRO number.' });
  }
  const { carrier_probill_number } = req.body || {};
  if (!carrier_probill_number) {
    return res.status(400).json({ error: 'carrier_probill_number is required' });
  }
  load.carrier_probill_number = carrier_probill_number;
  load.updated_at = now();

  if (db.isEnabled()) {
    try {
      await db.query(
        'UPDATE shipment_postings SET carrier_probill_number = $1 WHERE id = $2',
        [carrier_probill_number, load.id]
      );
    } catch (err) {
      console.error('[loads/probill] DB update failed (non-fatal):', err.message);
    }
  }

  return res.json({ load });
});

module.exports = router;
