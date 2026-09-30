// routes/bids.js — carrier bidding and award flow.
//   POST /api/bids/submit  upsert a carrier bid (one bid per posting+carrier)
//   POST /api/bids/accept   award a bid: computes shipper price with markup,
//                           charges via Stripe when configured, records the
//                           platform's arbitrage profit.
'use strict';

const express = require('express');
const db = require('../db');
const stripeLib = require('../lib/stripe');
const { store, id } = require('../lib/store');
const { round2 } = require('../lib/money');
const markupLib = require('../lib/markup');

const router = express.Router();
const now = () => new Date().toISOString();

router.post('/submit', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  const { shipment_posting_id, bid_amount, estimated_transit_days, notes } = req.body || {};
  const missing = [];
  if (!shipment_posting_id) missing.push('shipment_posting_id');
  const amount = Number(bid_amount);
  if (!Number.isFinite(amount) || amount <= 0) missing.push('bid_amount (positive number)');
  if (missing.length) {
    return res.status(400).json({ error: `Missing/invalid fields: ${missing.join(', ')}` });
  }

  const load = store.loads.get(shipment_posting_id);
  if (!load) return res.status(404).json({ error: 'Shipment posting not found' });
  if (load.status !== 'open_for_bids') {
    return res.status(409).json({ error: `Posting is ${load.status}; no longer open for bids` });
  }

  // The bidder is always the signed-in account — never a client-supplied id.
  const carrierId = req.user.id;

  // Upsert on (posting, carrier): a carrier gets one live bid per posting.
  let bid = [...store.bids.values()].find(
    (x) => x.shipment_posting_id === shipment_posting_id && x.carrier_id === carrierId
  );
  let created = false;
  if (bid) {
    bid.bid_amount = round2(amount);
    if (estimated_transit_days != null) bid.estimated_transit_days = Number(estimated_transit_days);
    if (notes !== undefined) bid.notes = notes;
    bid.status = 'submitted';
    bid.updated_at = now();
  } else {
    created = true;
    bid = {
      id: db.newId('bid'),
      shipment_posting_id,
      carrier_id: carrierId,
      bid_amount: round2(amount),
      estimated_transit_days: estimated_transit_days != null ? Number(estimated_transit_days) : null,
      notes: notes || null,
      status: 'submitted',
      created_at: now(),
      updated_at: now(),
    };
    store.bids.set(bid.id, bid);
  }

  if (db.isEnabled()) {
    try {
      await db.query(
        `INSERT INTO carrier_bids (id, shipment_posting_id, carrier_id, bid_amount, estimated_transit_days, notes, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (shipment_posting_id, carrier_id)
         DO UPDATE SET bid_amount = EXCLUDED.bid_amount,
                       estimated_transit_days = EXCLUDED.estimated_transit_days,
                       notes = EXCLUDED.notes,
                       status = 'submitted'`,
        [bid.id, bid.shipment_posting_id, bid.carrier_id, bid.bid_amount,
         bid.estimated_transit_days, bid.notes, bid.status]
      );
    } catch (err) {
      console.error('[bids/submit] DB upsert failed (non-fatal):', err.message);
    }
  }

  return res.status(created ? 201 : 200).json({ bid });
});

router.post('/accept', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  const { userCanShip } = require('../lib/shipping-approval');
  if (!(await userCanShip(req.user.id))) {
    return res.status(403).json({ error: 'Shipping approval required.' });
  }
  const { bid_id, payment_method_id } = req.body || {};
  if (!bid_id) return res.status(400).json({ error: 'bid_id is required' });

  const bid = store.bids.get(bid_id);
  if (!bid) return res.status(404).json({ error: 'Bid not found' });
  if (bid.status !== 'submitted') {
    return res.status(409).json({ error: `Bid is ${bid.status}; only submitted bids can be accepted` });
  }

  const load = store.loads.get(bid.shipment_posting_id);
  // Only the shipper who posted the load can accept a bid on it.
  const acceptShipperId = req.user.id;
  if (load && load.shipper_id !== acceptShipperId) {
    return res.status(403).json({ error: 'Only the posting shipper can accept bids' });
  }

  // Arbitrage math: shipper pays bid + markup; platform keeps the spread.
  // The accepting shipper's per-account markup override applies when set.
  const carrierBid = round2(bid.bid_amount);
  const acceptMarkup = await markupLib.effectiveMarkup(acceptShipperId);
  const shipperPrice = round2(carrierBid * (1 + acceptMarkup / 100));
  const platformProfit = round2(shipperPrice - carrierBid);

  let payment_status = 'pending_payment';
  let stripe_payment_intent_id = null;

  if (stripeLib.isEnabled() && payment_method_id) {
    try {
      const stripe = stripeLib.getClient();
      const pi = await stripe.paymentIntents.create({
        amount: Math.round(shipperPrice * 100), // cents
        currency: 'cad',
        payment_method: payment_method_id,
        confirm: true,
        description: `ShipRate load ${bid.shipment_posting_id} — accepted bid ${bid.id}`,
      });
      stripe_payment_intent_id = pi.id;
      payment_status = 'paid';
    } catch (err) {
      return res.status(502).json({ error: 'Stripe payment failed', detail: err.message });
    }
  }

  // Flip statuses: accepted bid wins, other submitted bids are rejected, posting awarded.
  bid.status = 'accepted';
  bid.updated_at = now();
  for (const other of store.bids.values()) {
    if (other.shipment_posting_id === bid.shipment_posting_id && other.id !== bid.id && other.status === 'submitted') {
      other.status = 'rejected';
      other.updated_at = now();
    }
  }
  if (load) {
    load.status = 'awarded';
    load.updated_at = now();
  }

  const txn = {
    id: id('txn'),
    bid_id: bid.id,
    posting_id: bid.shipment_posting_id,
    shipper_id: shipper_id || (load && load.shipper_id) || null,
    carrier_id: bid.carrier_id,
    carrier_payout: carrierBid,
    shipper_charge: shipperPrice,
    platform_profit: platformProfit,
    payment_status,
    stripe_payment_intent_id,
    created_at: now(),
  };
  store.transactions.push(txn);

  if (db.isEnabled()) {
    try {
      const txnShipperId = acceptShipperId || (load && load.shipper_id);
      await db.query(
        `INSERT INTO marketplace_transactions
           (bid_id, shipment_id, shipper_id, carrier_id, gross_shipper_paid,
            carrier_payout, stripe_charge_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [bid.id, bid.shipment_posting_id, txnShipperId, bid.carrier_id, shipperPrice,
         carrierBid, stripe_payment_intent_id, payment_status]
      );
      await db.query(`UPDATE carrier_bids SET status='accepted' WHERE id=$1`, [bid.id]);
      await db.query(
        `UPDATE carrier_bids SET status='rejected'
          WHERE shipment_posting_id=$1 AND id<>$2 AND status='submitted'`,
        [bid.shipment_posting_id, bid.id]
      );
      await db.query(`UPDATE shipment_postings SET status='awarded' WHERE id=$1`, [bid.shipment_posting_id]);
    } catch (err) {
      console.error('[bids/accept] DB write failed (non-fatal):', err.message);
    }
  }

  const body = {
    charged_to_shipper: shipperPrice,
    carrier_payout: carrierBid,
    your_platform_profit: platformProfit,
    payment_status,
    bid_id: bid.id,
    posting_id: bid.shipment_posting_id,
    transaction_id: txn.id,
  };
  if (stripe_payment_intent_id) body.stripe_payment_intent_id = stripe_payment_intent_id;
  return res.json(body);
});

module.exports = router;
