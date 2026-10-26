// routes/webuy.js — We Buy group buying (Northline ONLY).
//
// Two buy types under one flow, per the Oct 25 spec + Seven's decisions:
//   - container: import group buy. The unit price is ALL-IN — the seller
//     covers freight, broker fee, import fees and duties. Fill target =
//     units per container. When full, the seller ships the container.
//   - local: local group buy. The buyer chooses fulfillment at claim time —
//     delivery, pickup, or shipping — and each option carries its own cost,
//     set by the seller on the listing (flat per claim, on top of units x
//     unit price). Fill target = minimum quantity.
//
// Money (honest v1 state): claims are a ledger. Each claim starts 'held';
// receipt confirmation releases it to the seller per buyer; expiry,
// cancellation, and admin resolution refund it. No card is charged in v1:
// Stripe checkout is not connected yet (testing phase), so payment_reference
// stays null until checkout goes live — the ledger records what SHOULD be
// held/released/refunded. Nothing here moves real money.
//
// Gating: server.js mounts this router behind northlineOnly (brand must be
// 'Northline Freight', never the employer profile) + requireApprovedAccount.
// Tables are created idempotently here, same pattern as shipper-rates.
'use strict';

const express = require('express');
const db = require('../db');
const billing = require('../lib/billing');
const { requireAdmin } = require('./admin');

const router = express.Router();

const LISTING_STATUSES = ['open', 'full', 'shipped', 'completed', 'refunded', 'cancelled'];
const CLAIM_STATUSES = ['held', 'released', 'refunded', 'disputed'];
const LOCAL_OPTIONS = ['delivery', 'pickup', 'shipping'];

async function ensureSchema() {
  if (!db.isEnabled()) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS webuy_listings (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      seller_id          uuid REFERENCES users(id) ON DELETE CASCADE,
      seller_email       varchar(255) NOT NULL DEFAULT '',
      buy_type           varchar(20) NOT NULL CHECK (buy_type IN ('container', 'local')),
      title              varchar(200) NOT NULL,
      description        text NOT NULL DEFAULT '',
      video_url          text,
      price_per_unit_cad numeric(12, 2) NOT NULL,
      target_qty         int NOT NULL CHECK (target_qty >= 1),
      deadline           timestamptz NOT NULL,
      origin             varchar(160) NOT NULL,
      delivery_cost_cad  numeric(12, 2),
      pickup_cost_cad    numeric(12, 2),
      shipping_cost_cad  numeric(12, 2),
      status             varchar(20) NOT NULL DEFAULT 'open',
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now()
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS webuy_claims (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      listing_id         uuid NOT NULL REFERENCES webuy_listings(id) ON DELETE CASCADE,
      buyer_id           uuid REFERENCES users(id) ON DELETE CASCADE,
      buyer_email        varchar(255) NOT NULL DEFAULT '',
      qty                int NOT NULL CHECK (qty >= 1),
      unit_price_cad     numeric(12, 2) NOT NULL,
      fulfillment        varchar(20) NOT NULL,
      fulfillment_cost_cad numeric(12, 2) NOT NULL DEFAULT 0,
      amount_cad         numeric(12, 2) NOT NULL,
      status             varchar(20) NOT NULL DEFAULT 'held',
      payment_reference  text,
      created_at         timestamptz NOT NULL DEFAULT now()
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

function isAdminReq(req) {
  try {
    if (req.everestAdmin) return true;
    return !!(req.user && billing.isAdminEmail(req.user.email));
  } catch {
    return false;
  }
}

function r2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Expired open groups refund themselves on read: held claims -> refunded,
// listing -> refunded. No cron needed for v1 correctness.
async function sweepExpired() {
  if (!db.isEnabled()) return;
  await db.query(
    `UPDATE webuy_claims SET status='refunded'
     WHERE status='held' AND listing_id IN
       (SELECT id FROM webuy_listings WHERE status='open' AND deadline < now())`
  );
  await db.query(
    `UPDATE webuy_listings SET status='refunded', updated_at=now()
     WHERE status='open' AND deadline < now()`
  );
}

async function claimedQty(listingId) {
  const r = await db.query(
    `SELECT COALESCE(SUM(qty), 0) AS n FROM webuy_claims
     WHERE listing_id = $1 AND status IN ('held', 'released')`,
    [listingId]
  );
  return Number(r.rows[0].n);
}

// A shipped listing completes once no claim is still held or disputed.
async function maybeComplete(listingId) {
  const r = await db.query(
    `SELECT COUNT(*) AS n FROM webuy_claims
     WHERE listing_id = $1 AND status IN ('held', 'disputed')`,
    [listingId]
  );
  if (Number(r.rows[0].n) === 0) {
    await db.query(
      `UPDATE webuy_listings SET status='completed', updated_at=now()
       WHERE id = $1 AND status='shipped'`,
      [listingId]
    );
  }
}

function listingRow(r) {
  return {
    id: r.id,
    seller_id: r.seller_id,
    seller_email: r.seller_email,
    buy_type: r.buy_type,
    title: r.title,
    description: r.description,
    video_url: r.video_url,
    price_per_unit_cad: Number(r.price_per_unit_cad),
    target_qty: r.target_qty,
    claimed_qty: Number(r.claimed_qty || 0),
    deadline: r.deadline,
    origin: r.origin,
    delivery_cost_cad: r.delivery_cost_cad == null ? null : Number(r.delivery_cost_cad),
    pickup_cost_cad: r.pickup_cost_cad == null ? null : Number(r.pickup_cost_cad),
    shipping_cost_cad: r.shipping_cost_cad == null ? null : Number(r.shipping_cost_cad),
    status: r.status,
    created_at: r.created_at,
    my_claim: r.my_claim_id
      ? {
          id: r.my_claim_id,
          qty: r.my_claim_qty,
          status: r.my_claim_status,
          fulfillment: r.my_claim_fulfillment,
          amount_cad: Number(r.my_claim_amount),
        }
      : null,
  };
}

// GET /api/webuy — all listings with progress + the caller's own claim.
router.get('/', async (req, res) => {
  if (needDb(res)) return;
  try {
    await sweepExpired();
    const userId = req.user ? req.user.id : null;
    const r = await db.query(
      `SELECT l.*,
        COALESCE((SELECT SUM(qty) FROM webuy_claims c
          WHERE c.listing_id = l.id AND c.status IN ('held', 'released')), 0) AS claimed_qty,
        mc.id AS my_claim_id, mc.qty AS my_claim_qty, mc.status AS my_claim_status,
        mc.fulfillment AS my_claim_fulfillment, mc.amount_cad AS my_claim_amount
       FROM webuy_listings l
       LEFT JOIN webuy_claims mc ON mc.listing_id = l.id AND mc.buyer_id = $1
       ORDER BY l.created_at DESC`,
      [userId]
    );
    return res.json({ listings: r.rows.map(listingRow) });
  } catch (err) {
    return res.status(502).json({ error: 'Could not load group buys: ' + err.message });
  }
});

// POST /api/webuy — seller posts a listing.
router.post('/', async (req, res) => {
  if (needDb(res)) return;
  if (!req.user) return res.status(401).json({ error: 'Sign in to post a group buy.' });
  try {
    const b = req.body || {};
    const buyType = String(b.buy_type || '');
    if (buyType !== 'container' && buyType !== 'local') {
      return res.status(400).json({ error: 'buy_type must be container or local.' });
    }
    const title = String(b.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Title is required.' });
    const price = Number(b.price_per_unit_cad);
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ error: 'Unit price must be greater than 0.' });
    }
    const targetQty = parseInt(b.target_qty, 10);
    if (!Number.isFinite(targetQty) || targetQty < 1) {
      return res.status(400).json({ error: 'Target quantity must be at least 1.' });
    }
    const origin = String(b.origin || '').trim();
    if (!origin) return res.status(400).json({ error: 'Origin is required.' });
    let deadline;
    if (b.deadline) {
      deadline = new Date(b.deadline);
      if (Number.isNaN(deadline.getTime())) {
        return res.status(400).json({ error: 'Deadline is not a valid date.' });
      }
      if (deadline.getTime() <= Date.now()) {
        return res.status(400).json({ error: 'Deadline must be in the future.' });
      }
    } else {
      deadline = new Date(Date.now() + 30 * 864e5);
    }
    const videoUrl = String(b.video_url || '').trim();
    if (videoUrl && !/^https?:\/\//.test(videoUrl)) {
      return res.status(400).json({ error: 'Video URL must start with http:// or https://.' });
    }
    let delivery = null;
    let pickup = null;
    let shipping = null;
    if (buyType === 'local') {
      delivery = numOrNull(b.delivery_cost_cad);
      pickup = numOrNull(b.pickup_cost_cad);
      shipping = numOrNull(b.shipping_cost_cad);
      for (const [label, v] of [['delivery', delivery], ['pickup', pickup], ['shipping', shipping]]) {
        if (v != null && v < 0) {
          return res.status(400).json({ error: label + ' cost cannot be negative.' });
        }
      }
      if (delivery == null && pickup == null && shipping == null) {
        return res.status(400).json({ error: 'Local listings need at least one fulfillment cost (delivery, pickup, or shipping).' });
      }
    }
    const r = await db.query(
      `INSERT INTO webuy_listings
        (seller_id, seller_email, buy_type, title, description, video_url,
         price_per_unit_cad, target_qty, deadline, origin,
         delivery_cost_cad, pickup_cost_cad, shipping_cost_cad, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'open')
       RETURNING *`,
      [
        req.user.id, req.user.email || '', buyType, title.slice(0, 200),
        String(b.description || ''), videoUrl || null, r2(price), targetQty,
        deadline.toISOString(), origin.slice(0, 160), delivery, pickup, shipping,
      ]
    );
    const row = r.rows[0];
    row.claimed_qty = 0;
    return res.json({ listing: listingRow(row) });
  } catch (err) {
    return res.status(502).json({ error: 'Could not create listing: ' + err.message });
  }
});

// GET /api/webuy/:id — detail + claims (admin/seller see all; buyers own only).
router.get('/:id', async (req, res) => {
  if (needDb(res)) return;
  try {
    await sweepExpired();
    const r = await db.query('SELECT * FROM webuy_listings WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Listing not found.' });
    const listing = r.rows[0];
    listing.claimed_qty = await claimedQty(listing.id);
    const admin = isAdminReq(req);
    const isSeller = !!(req.user && listing.seller_id === req.user.id);
    let claims = [];
    if (admin || isSeller) {
      const cr = await db.query(
        'SELECT * FROM webuy_claims WHERE listing_id = $1 ORDER BY created_at ASC',
        [listing.id]
      );
      claims = cr.rows;
    } else if (req.user) {
      const cr = await db.query(
        'SELECT * FROM webuy_claims WHERE listing_id = $1 AND buyer_id = $2 ORDER BY created_at ASC',
        [listing.id, req.user.id]
      );
      claims = cr.rows;
    }
    return res.json({
      listing: listingRow({ ...listing, my_claim_id: null }),
      claims: claims.map((c) => ({
        id: c.id,
        buyer_email: c.buyer_email,
        qty: c.qty,
        unit_price_cad: Number(c.unit_price_cad),
        fulfillment: c.fulfillment,
        fulfillment_cost_cad: Number(c.fulfillment_cost_cad),
        amount_cad: Number(c.amount_cad),
        status: c.status,
        created_at: c.created_at,
      })),
    });
  } catch (err) {
    return res.status(502).json({ error: 'Could not load listing: ' + err.message });
  }
});

// POST /api/webuy/:id/claims — buyer claims units (hard stop at target).
router.post('/:id/claims', async (req, res) => {
  if (needDb(res)) return;
  if (!req.user) return res.status(401).json({ error: 'Sign in to claim.' });
  try {
    const r = await db.query('SELECT * FROM webuy_listings WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Listing not found.' });
    const listing = r.rows[0];
    if (listing.status !== 'open') {
      return res.status(400).json({ error: 'This group buy is no longer open (status: ' + listing.status + ').' });
    }
    if (listing.seller_id === req.user.id) {
      return res.status(400).json({ error: 'Sellers cannot claim their own listing.' });
    }
    // One active claim per buyer per listing (cancel it to change quantity);
    // this also keeps the list query's buyer join to a single row.
    const existing = await db.query(
      `SELECT id FROM webuy_claims WHERE listing_id = $1 AND buyer_id = $2
       AND status IN ('held', 'released', 'disputed') LIMIT 1`,
      [listing.id, req.user.id]
    );
    if (existing.rows.length) {
      return res.status(400).json({ error: 'You already have an active claim on this listing.' });
    }
    const qty = parseInt((req.body || {}).qty, 10);
    if (!Number.isFinite(qty) || qty < 1) {
      return res.status(400).json({ error: 'Quantity must be at least 1.' });
    }
    let fulfillment;
    let optionCost = 0;
    if (listing.buy_type === 'container') {
      fulfillment = 'ship';
    } else {
      fulfillment = String((req.body || {}).fulfillment || '');
      if (!LOCAL_OPTIONS.includes(fulfillment)) {
        return res.status(400).json({ error: 'Choose delivery, pickup, or shipping.' });
      }
      const costField = fulfillment + '_cost_cad';
      if (listing[costField] == null) {
        return res.status(400).json({ error: 'That fulfillment option is not offered on this listing.' });
      }
      optionCost = Number(listing[costField]);
    }
    const claimed = await claimedQty(listing.id);
    if (claimed + qty > listing.target_qty) {
      return res.status(400).json({
        error: 'Only ' + (listing.target_qty - claimed) + ' unit(s) left before this group fills.',
      });
    }
    const unitPrice = Number(listing.price_per_unit_cad);
    const amount = r2(qty * unitPrice + optionCost);
    const cr = await db.query(
      `INSERT INTO webuy_claims
        (listing_id, buyer_id, buyer_email, qty, unit_price_cad, fulfillment,
         fulfillment_cost_cad, amount_cad, status, payment_reference)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'held', NULL)
       RETURNING *`,
      [listing.id, req.user.id, req.user.email || '', qty, unitPrice, fulfillment, optionCost, amount]
    );
    if (claimed + qty >= listing.target_qty) {
      await db.query(
        `UPDATE webuy_listings SET status='full', updated_at=now() WHERE id = $1`,
        [listing.id]
      );
    }
    return res.json({
      claim: {
        id: cr.rows[0].id,
        qty: cr.rows[0].qty,
        fulfillment: cr.rows[0].fulfillment,
        fulfillment_cost_cad: Number(cr.rows[0].fulfillment_cost_cad),
        amount_cad: Number(cr.rows[0].amount_cad),
        status: cr.rows[0].status,
      },
      group_full: claimed + qty >= listing.target_qty,
    });
  } catch (err) {
    return res.status(502).json({ error: 'Could not claim: ' + err.message });
  }
});

// POST /api/webuy/:id/ship — seller ships a full group (the ship trigger).
router.post('/:id/ship', async (req, res) => {
  if (needDb(res)) return;
  if (!req.user) return res.status(401).json({ error: 'Sign in.' });
  try {
    const r = await db.query('SELECT * FROM webuy_listings WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Listing not found.' });
    const listing = r.rows[0];
    if (listing.seller_id !== req.user.id && !isAdminReq(req)) {
      return res.status(403).json({ error: 'Only the seller can mark this shipped.' });
    }
    if (listing.status !== 'full') {
      return res.status(400).json({ error: 'Only a full group can be marked shipped.' });
    }
    await db.query(
      `UPDATE webuy_listings SET status='shipped', updated_at=now() WHERE id = $1`,
      [listing.id]
    );
    return res.json({ ok: true, status: 'shipped' });
  } catch (err) {
    return res.status(502).json({ error: 'Could not mark shipped: ' + err.message });
  }
});

// POST /api/webuy/:id/cancel — seller/admin cancels an open group (refunds held).
router.post('/:id/cancel', async (req, res) => {
  if (needDb(res)) return;
  if (!req.user) return res.status(401).json({ error: 'Sign in.' });
  try {
    const r = await db.query('SELECT * FROM webuy_listings WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Listing not found.' });
    const listing = r.rows[0];
    if (listing.seller_id !== req.user.id && !isAdminReq(req)) {
      return res.status(403).json({ error: 'Only the seller can cancel this listing.' });
    }
    if (listing.status !== 'open') {
      return res.status(400).json({ error: 'Only an open group can be cancelled.' });
    }
    await db.query(`UPDATE webuy_claims SET status='refunded' WHERE listing_id = $1 AND status='held'`, [listing.id]);
    await db.query(`UPDATE webuy_listings SET status='cancelled', updated_at=now() WHERE id = $1`, [listing.id]);
    return res.json({ ok: true, status: 'cancelled' });
  } catch (err) {
    return res.status(502).json({ error: 'Could not cancel: ' + err.message });
  }
});

// POST /api/webuy/claims/:id/confirm — buyer confirms receipt (per-buyer release).
router.post('/claims/:id/confirm', async (req, res) => {
  if (needDb(res)) return;
  if (!req.user) return res.status(401).json({ error: 'Sign in.' });
  try {
    const r = await db.query(
      `SELECT c.*, l.status AS listing_status FROM webuy_claims c
       JOIN webuy_listings l ON l.id = c.listing_id WHERE c.id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Claim not found.' });
    const claim = r.rows[0];
    if (claim.buyer_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the buyer can confirm this claim.' });
    }
    if (claim.status !== 'held') {
      return res.status(400).json({ error: 'Only a held claim can be confirmed.' });
    }
    if (claim.listing_status !== 'shipped') {
      return res.status(400).json({ error: 'Receipt can only be confirmed after the group ships.' });
    }
    await db.query(`UPDATE webuy_claims SET status='released' WHERE id = $1`, [claim.id]);
    await maybeComplete(claim.listing_id);
    return res.json({ ok: true, status: 'released' });
  } catch (err) {
    return res.status(502).json({ error: 'Could not confirm receipt: ' + err.message });
  }
});

// POST /api/webuy/claims/:id/cancel — buyer cancels a held claim on an open group.
router.post('/claims/:id/cancel', async (req, res) => {
  if (needDb(res)) return;
  if (!req.user) return res.status(401).json({ error: 'Sign in.' });
  try {
    const r = await db.query(
      `SELECT c.*, l.status AS listing_status FROM webuy_claims c
       JOIN webuy_listings l ON l.id = c.listing_id WHERE c.id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Claim not found.' });
    const claim = r.rows[0];
    if (claim.buyer_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the buyer can cancel this claim.' });
    }
    if (claim.status !== 'held' || claim.listing_status !== 'open') {
      return res.status(400).json({ error: 'Only a held claim on an open group can be cancelled.' });
    }
    await db.query(`UPDATE webuy_claims SET status='refunded' WHERE id = $1`, [claim.id]);
    return res.json({ ok: true, status: 'refunded' });
  } catch (err) {
    return res.status(502).json({ error: 'Could not cancel claim: ' + err.message });
  }
});

// POST /api/webuy/claims/:id/dispute — buyer flags a held/released claim.
router.post('/claims/:id/dispute', async (req, res) => {
  if (needDb(res)) return;
  if (!req.user) return res.status(401).json({ error: 'Sign in.' });
  try {
    const r = await db.query('SELECT * FROM webuy_claims WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Claim not found.' });
    const claim = r.rows[0];
    if (claim.buyer_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the buyer can dispute this claim.' });
    }
    if (claim.status !== 'held' && claim.status !== 'released') {
      return res.status(400).json({ error: 'Only a held or released claim can be disputed.' });
    }
    await db.query(`UPDATE webuy_claims SET status='disputed' WHERE id = $1`, [claim.id]);
    return res.json({ ok: true, status: 'disputed' });
  } catch (err) {
    return res.status(502).json({ error: 'Could not dispute claim: ' + err.message });
  }
});

// POST /api/webuy/claims/:id/resolve — admin resolves a dispute.
router.post('/claims/:id/resolve', async (req, res) => {
  if (needDb(res)) return;
  if (!(await requireAdmin(req, res))) return;
  try {
    const to = String((req.body || {}).to || '');
    if (to !== 'released' && to !== 'refunded') {
      return res.status(400).json({ error: "Resolve to 'released' or 'refunded'." });
    }
    const r = await db.query('SELECT * FROM webuy_claims WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Claim not found.' });
    if (r.rows[0].status !== 'disputed') {
      return res.status(400).json({ error: 'Only a disputed claim can be resolved.' });
    }
    await db.query(`UPDATE webuy_claims SET status=$1 WHERE id = $2`, [to, req.params.id]);
    if (to === 'released') await maybeComplete(r.rows[0].listing_id);
    return res.json({ ok: true, status: to });
  } catch (err) {
    return res.status(502).json({ error: 'Could not resolve dispute: ' + err.message });
  }
});

// GET /api/webuy/admin/overview — admin view of groups + money (admin only).
router.get('/admin/overview', async (req, res) => {
  if (needDb(res)) return;
  if (!(await requireAdmin(req, res))) return;
  try {
    const lc = await db.query(
      'SELECT status, COUNT(*) AS n FROM webuy_listings GROUP BY status'
    );
    const mc = await db.query(
      `SELECT status, COALESCE(SUM(amount_cad), 0) AS total, COUNT(*) AS n
       FROM webuy_claims GROUP BY status`
    );
    const listings = {};
    for (const row of lc.rows) listings[row.status] = Number(row.n);
    const money = {};
    for (const row of mc.rows) {
      money[row.status] = { total_cad: Number(row.total), claims: Number(row.n) };
    }
    return res.json({ listings, money });
  } catch (err) {
    return res.status(502).json({ error: 'Could not load overview: ' + err.message });
  }
});

module.exports = router;
