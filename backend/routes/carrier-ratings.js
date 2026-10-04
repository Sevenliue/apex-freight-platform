// routes/carrier-ratings.js — shipper ratings for matrix carriers.
//
// Shippers rate a carrier after a booked shipment (one rating per order,
// only by the ordering shipper, only on paid orders). Scores roll up into
// carrier_scores and are shown on the quote board. A carrier needs >= 5
// visible ratings before a public score displays ("New" until then).
'use strict';

const express = require('express');
const db = require('../db');
const { requireAdmin } = require('./admin');

const router = express.Router();

const MIN_RATINGS_FOR_SCORE = 5;

const star = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
};

// Recompute the rollup row for one carrier from visible ratings.
async function recomputeScore(carrierId) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n,
            AVG(stars_on_time)::numeric(4,2) AS avg_on_time,
            AVG(stars_condition)::numeric(4,2) AS avg_condition,
            AVG(stars_communication)::numeric(4,2) AS avg_communication,
            AVG((stars_on_time + stars_condition + stars_communication) / 3.0)::numeric(4,2) AS avg_stars,
            MAX(carrier_label) AS carrier_label
     FROM carrier_ratings
     WHERE carrier_id = $1 AND hidden = false`,
    [carrierId]
  );
  const row = r.rows[0] || {};
  await db.query(
    `INSERT INTO carrier_scores (carrier_id, carrier_label, rated_shipments, avg_stars, avg_on_time, avg_condition, avg_communication, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now())
     ON CONFLICT (carrier_id) DO UPDATE SET
       carrier_label = EXCLUDED.carrier_label,
       rated_shipments = EXCLUDED.rated_shipments,
       avg_stars = EXCLUDED.avg_stars,
       avg_on_time = EXCLUDED.avg_on_time,
       avg_condition = EXCLUDED.avg_condition,
       avg_communication = EXCLUDED.avg_communication,
       updated_at = now()`,
    [carrierId, row.carrier_label || null, row.n || 0, row.avg_stars, row.avg_on_time, row.avg_condition, row.avg_communication]
  );
}

// Public: score map for the quote board. Only carriers with enough ratings
// get a published score; the rest are "new".
router.get('/scores', async (req, res) => {
  if (!db.isEnabled()) return res.json({ scores: {} });
  try {
    const r = await db.query('SELECT * FROM carrier_scores');
    const scores = {};
    for (const s of r.rows) {
      scores[s.carrier_id] = {
        carrier_id: s.carrier_id,
        carrier_label: s.carrier_label,
        rated_shipments: s.rated_shipments,
        published: (s.rated_shipments || 0) >= MIN_RATINGS_FOR_SCORE,
        avg_stars: s.avg_stars == null ? null : Number(s.avg_stars),
        avg_on_time: s.avg_on_time == null ? null : Number(s.avg_on_time),
        avg_condition: s.avg_condition == null ? null : Number(s.avg_condition),
        avg_communication: s.avg_communication == null ? null : Number(s.avg_communication),
      };
    }
    return res.json({ scores, min_ratings: MIN_RATINGS_FOR_SCORE });
  } catch (err) {
    return res.status(502).json({ error: 'Could not load scores: ' + err.message });
  }
});

// Public: recent visible reviews for one carrier.
router.get('/carrier/:carrier_id', async (req, res) => {
  if (!db.isEnabled()) return res.json({ reviews: [], score: null });
  try {
    const s = await db.query('SELECT * FROM carrier_scores WHERE carrier_id = $1', [req.params.carrier_id]);
    const r = await db.query(
      `SELECT stars_on_time, stars_condition, stars_communication, comment, created_at
       FROM carrier_ratings
       WHERE carrier_id = $1 AND hidden = false
       ORDER BY created_at DESC LIMIT 20`,
      [req.params.carrier_id]
    );
    return res.json({ score: s.rows[0] || null, reviews: r.rows });
  } catch (err) {
    return res.status(502).json({ error: 'Could not load reviews: ' + err.message });
  }
});

// Submit a rating. Auth required; the order must belong to the rater and be
// paid; one rating per order.
router.post('/', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  if (!db.isEnabled()) return res.status(501).json({ error: 'Ratings are unavailable right now.' });
  const b = req.body || {};
  const orderId = String(b.order_id || '').trim();
  const sOnTime = star(b.stars_on_time);
  const sCond = star(b.stars_condition);
  const sComm = star(b.stars_communication);
  if (!orderId) return res.status(400).json({ error: 'order_id is required.' });
  if (!sOnTime || !sCond || !sComm) {
    return res.status(400).json({ error: 'All three star ratings (1–5) are required.' });
  }
  const comment = String(b.comment || '').trim().slice(0, 1000) || null;
  try {
    const o = await db.query(
      'SELECT id, user_id, carrier, carrier_id, payment_status, status FROM orders WHERE id = $1',
      [orderId]
    );
    if (!o.rows.length) return res.status(404).json({ error: 'Order not found.' });
    const order = o.rows[0];
    if (String(order.user_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'You can only rate your own shipments.' });
    }
    if (order.payment_status !== 'paid' && !['purchased', 'tendered', 'delivered', 'completed'].includes(order.status)) {
      return res.status(400).json({ error: 'You can rate this shipment once it is paid and booked.' });
    }
    const carrierId = order.carrier_id || null;
    if (!carrierId) {
      return res.status(400).json({ error: 'Ratings are available for ShipRate tariff carriers only.' });
    }
    const dup = await db.query('SELECT id FROM carrier_ratings WHERE order_id = $1', [orderId]);
    if (dup.rows.length) return res.status(409).json({ error: 'This shipment has already been rated.' });
    await db.query(
      `INSERT INTO carrier_ratings (carrier_id, carrier_label, order_id, user_id,
              stars_on_time, stars_condition, stars_communication, comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [carrierId, order.carrier || null, orderId, req.user.id, sOnTime, sCond, sComm, comment]
    );
    await recomputeScore(carrierId);
    return res.status(201).json({ ok: true });
  } catch (err) {
    return res.status(502).json({ error: 'Could not save rating: ' + err.message });
  }
});

// The signed-in shipper's paid matrix-carrier orders that have not been
// rated yet — feeds the "Rate your carriers" UI.
router.get('/my-rateable', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  if (!db.isEnabled()) return res.json({ orders: [] });
  try {
    const r = await db.query(
      `SELECT o.id, o.tracking_code, o.shipper_order_no, o.carrier, o.carrier_id,
              o.status, o.created_at
       FROM orders o
       LEFT JOIN carrier_ratings cr ON cr.order_id = o.id
       WHERE o.user_id = $1
         AND o.carrier_id IS NOT NULL
         AND (o.payment_status = 'paid' OR o.status IN ('purchased','tendered','delivered','completed'))
         AND cr.id IS NULL
       ORDER BY o.created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    return res.json({
      orders: r.rows.map((o) => ({
        id: o.id,
        ref: o.tracking_code || o.shipper_order_no || String(o.id).slice(0, 8),
        carrier: o.carrier,
        carrier_id: o.carrier_id,
        status: o.status,
        created_at: o.created_at,
      })),
    });
  } catch (err) {
    return res.status(502).json({ error: 'Could not load rateable orders: ' + err.message });
  }
});

// ---------------------------------------------------------------------------
// Admin: moderate ratings.
// ---------------------------------------------------------------------------

router.get('/admin/list', async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  if (!db.isEnabled()) return res.status(501).json({ error: 'Admin requires a database.' });
  try {
    const r = await db.query(
      `SELECT cr.*, u.email AS rater_email
       FROM carrier_ratings cr
       LEFT JOIN users u ON u.id = cr.user_id
       ORDER BY cr.created_at DESC LIMIT 200`
    );
    const s = await db.query('SELECT * FROM carrier_scores ORDER BY rated_shipments DESC');
    return res.json({ ratings: r.rows, scores: s.rows, min_ratings: MIN_RATINGS_FOR_SCORE });
  } catch (err) {
    return res.status(502).json({ error: 'Could not list ratings: ' + err.message });
  }
});

router.post('/admin/:id/hide', async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  if (!db.isEnabled()) return res.status(501).json({ error: 'Admin requires a database.' });
  try {
    const r = await db.query('UPDATE carrier_ratings SET hidden = true WHERE id = $1 RETURNING carrier_id', [req.params.id]);
    if (r.rows.length) await recomputeScore(r.rows[0].carrier_id);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(502).json({ error: 'Could not hide rating: ' + err.message });
  }
});

router.post('/admin/:id/unhide', async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  if (!db.isEnabled()) return res.status(501).json({ error: 'Admin requires a database.' });
  try {
    const r = await db.query('UPDATE carrier_ratings SET hidden = false WHERE id = $1 RETURNING carrier_id', [req.params.id]);
    if (r.rows.length) await recomputeScore(r.rows[0].carrier_id);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(502).json({ error: 'Could not unhide rating: ' + err.message });
  }
});

module.exports = router;
