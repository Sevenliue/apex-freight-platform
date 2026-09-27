// routes/pickups.js — customer-booked carrier pickups.
//   GET    /api/pickups        — list own requests (newest first)
//   POST   /api/pickups        — create {order_id*, pickup_date*, time_window,
//                               contact_name, contact_phone, notes}
//   POST   /api/pickups/:id/cancel — cancel own request (while 'requested')
//   PATCH  /api/pickups/:id    — admin: set status
// Order ownership is enforced server-side. Admins manage statuses in the
// Admin → Pickup requests queue.
'use strict';

const express = require('express');
const db = require('../db');
const notifyLib = require('../lib/notify');
const { requireAdmin } = require('./admin');

const router = express.Router();

const TIME_WINDOWS = ['morning', 'afternoon', 'evening'];
const WINDOW_LABELS = { morning: 'Morning (8am–12pm)', afternoon: 'Afternoon (12–5pm)', evening: 'Evening (5–9pm)' };
const STATUSES = ['requested', 'confirmed', 'completed', 'cancelled'];

router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  next();
});

function needDb(res) {
  if (!db.isEnabled()) {
    res.status(501).json({ error: 'Pickup scheduling needs a database.' });
    return true;
  }
  return false;
}

function str(v, max) {
  return String(v == null ? '' : v).slice(0, max).trim();
}

function rowToPickup(r) {
  return {
    id: r.id,
    order_id: r.order_id,
    order_ref: r.tracking_code || r.shipper_order_no || null,
    carrier: r.carrier || null,
    pickup_date: r.pickup_date,
    time_window: r.time_window,
    time_window_label: WINDOW_LABELS[r.time_window] || r.time_window,
    contact_name: r.contact_name,
    contact_phone: r.contact_phone,
    notes: r.notes,
    status: r.status,
    created_at: r.created_at,
  };
}

// GET /api/pickups — own requests, newest first.
router.get('/', async (req, res) => {
  if (needDb(res)) return;
  try {
    const r = await db.query(
      `SELECT p.*, o.tracking_code, o.shipper_order_no, o.carrier
         FROM pickup_requests p
         LEFT JOIN orders o ON o.id = p.order_id
        WHERE p.user_id = $1
        ORDER BY p.created_at DESC`,
      [req.user.id]
    );
    res.json({ pickups: r.rows.map(rowToPickup) });
  } catch (err) {
    console.error('[pickups] list failed:', err.message);
    res.status(500).json({ error: 'Could not load pickup requests.' });
  }
});

// GET /api/pickups/orders — the customer's orders, for the pickup form.
router.get('/orders', async (req, res) => {
  if (needDb(res)) return;
  try {
    const r = await db.query(
      `SELECT id, tracking_code, shipper_order_no, carrier, status, created_at
         FROM orders
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 100`,
      [req.user.id]
    );
    res.json({
      orders: r.rows.map((o) => ({
        id: o.id,
        ref: o.tracking_code || o.shipper_order_no || o.id.slice(0, 8),
        carrier: o.carrier,
        status: o.status,
      })),
    });
  } catch (err) {
    console.error('[pickups] orders failed:', err.message);
    res.status(500).json({ error: 'Could not load orders.' });
  }
});

// POST /api/pickups — book a pickup for one of your orders.
router.post('/', async (req, res) => {
  if (needDb(res)) return;
  try {
    const b = req.body || {};
    const orderId = str(b.order_id, 64);
    const pickupDate = str(b.pickup_date, 10);
    const timeWindow = TIME_WINDOWS.includes(b.time_window) ? b.time_window : 'morning';
    if (!orderId) return res.status(400).json({ error: 'Choose the shipment for this pickup.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) {
      return res.status(400).json({ error: 'Pick up date is required (YYYY-MM-DD).' });
    }
    const today = new Date().toISOString().slice(0, 10);
    if (pickupDate < today) return res.status(400).json({ error: 'Pick up date cannot be in the past.' });

    // The order must belong to the signed-in account.
    const own = await db.query('SELECT id, tracking_code, shipper_order_no, user_id FROM orders WHERE id = $1', [orderId]);
    if (!own.rows.length || String(own.rows[0].user_id) !== String(req.user.id)) {
      return res.status(404).json({ error: 'Shipment not found.' });
    }
    const order = own.rows[0];

    const r = await db.query(
      `INSERT INTO pickup_requests
         (user_id, order_id, pickup_date, time_window, contact_name, contact_phone, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        req.user.id,
        orderId,
        pickupDate,
        timeWindow,
        str(b.contact_name, 120) || null,
        str(b.contact_phone, 40) || null,
        str(b.notes, 2000) || null,
      ]
    );
    const pickup = r.rows[0];

    // Tell the admin; never blocks the request.
    let userEmail = null;
    try {
      const u = await db.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
      userEmail = u.rows.length ? u.rows[0].email : null;
    } catch { /* non-fatal */ }
    notifyLib.notify('pickup_requested', null, {
      pickup: {
        pickup_date: pickupDate,
        time_window: WINDOW_LABELS[timeWindow],
        contact_name: pickup.contact_name,
        contact_phone: pickup.contact_phone,
        notes: pickup.notes,
        order_ref: order.tracking_code || order.shipper_order_no || orderId.slice(0, 8),
        user_email: userEmail,
      },
    });

    res.status(201).json({ pickup: rowToPickup({ ...pickup, tracking_code: order.tracking_code, shipper_order_no: order.shipper_order_no }) });
  } catch (err) {
    console.error('[pickups] create failed:', err.message);
    res.status(500).json({ error: 'Could not book the pickup.' });
  }
});

// POST /api/pickups/:id/cancel — cancel your own request while still requested.
router.post('/:id/cancel', async (req, res) => {
  if (needDb(res)) return;
  try {
    const r = await db.query(
      `UPDATE pickup_requests
          SET status = 'cancelled', decided_at = now()
        WHERE id = $1 AND user_id = $2 AND status = 'requested'
        RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Pickup request not found or cannot be cancelled.' });
    res.json({ pickup: rowToPickup(r.rows[0]) });
  } catch (err) {
    console.error('[pickups] cancel failed:', err.message);
    res.status(500).json({ error: 'Could not cancel the pickup.' });
  }
});

// PATCH /api/pickups/:id — admin: confirm / complete / cancel.
router.patch('/:id', async (req, res) => {
  if (needDb(res)) return;
  if (!(await requireAdmin(req, res))) return;
  try {
    const status = str((req.body || {}).status, 40);
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    const r = await db.query(
      `UPDATE pickup_requests
          SET status = $2, decided_at = now()
        WHERE id = $1
        RETURNING *`,
      [req.params.id, status]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Pickup request not found.' });
    res.json({ pickup: rowToPickup(r.rows[0]) });
  } catch (err) {
    console.error('[pickups] admin update failed:', err.message);
    res.status(500).json({ error: 'Could not update the pickup.' });
  }
});

// GET /api/pickups/admin/queue — admin: all open requests.
router.get('/admin/queue', async (req, res) => {
  if (needDb(res)) return;
  if (!(await requireAdmin(req, res))) return;
  try {
    const r = await db.query(
      `SELECT p.*, o.tracking_code, o.shipper_order_no, o.carrier, u.email AS user_email
         FROM pickup_requests p
         LEFT JOIN orders o ON o.id = p.order_id
         LEFT JOIN users u ON u.id = p.user_id
        WHERE p.status IN ('requested', 'confirmed')
        ORDER BY p.pickup_date ASC, p.created_at ASC`
    );
    res.json({ pickups: r.rows.map((row) => ({ ...rowToPickup(row), user_email: row.user_email })) });
  } catch (err) {
    console.error('[pickups] admin queue failed:', err.message);
    res.status(500).json({ error: 'Could not load the pickup queue.' });
  }
});

module.exports = router;
