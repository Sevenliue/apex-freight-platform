// routes/bids.js — carrier bidding and award flow.
//   POST /api/bids/submit  upsert a carrier bid (one bid per posting+carrier)
//   POST /api/bids/accept   award a bid: computes shipper price with markup,
//                           charges via Stripe when configured, records the
//                           platform's arbitrage profit.
'use strict';

const express = require('express');
const config = require('../config');
const db = require('../db');
const stripeLib = require('../lib/stripe');
const { store, id } = require('../lib/store');
const { round2 } = require('../lib/money');

const router = express.Router();
const now = () => new Date().toISOString();

router.post('/submit', async (req, res) => {
  const { shipment_posting_id, carrier_id, bid_amount, estimated_transit_days, notes } = req.body || {};
  const missing = [];
  if (!shipment_posting_id) missing.push('shipment_posting_id');
  if (!carrier_id) missing.push('carrier_id');
  const amount = Number(bid_amount);
  if (!Number.isFinite(amount) || amount <= 0) missing.push('bid_amount (positive number)');
  if (missing.length) {
    return res.status(400).json({ error: `Missing/invalid fields: ${missing.join(', ')}` });
  }

  const load = store.loads.get(shipment_posting_id);
  if (!load) return res.status(404).json({ error: 'Shipment posting not found' });
  if (load.status !== 'open') {
    return res.status(409).json({ error: `Posting is ${load.status}; no longer open for bids` });
  }

  // Upsert on (posting, carrier): a carrier gets one live bid per posting.
  let bid = [...store.bids.values()].find(
    (x) => x.shipment_posting_id === shipment_posting_id && x.carrier_id === carrier_id
  );
  let created = false;
  if (bid) {
    bid.bid_amount = round2(amount);
    if (estimated_transit_days != null) bid.estimated_transit_days = Number(estimated_transit_days);
    if (notes !== undefined) bid.notes = notes;
    bid.status = 'open';
    bid.updated_at = now();
  } else {
    created = true;
    bid = {
      id: id('bid'),
      shipment_posting_id,
      carrier_id,
      bid_amount: round2(amount),
      estimated_transit_days: estimated_transit_days != null ? Number(estimated_transit_days) : null,
      notes: notes || null,
      status: 'open',
      created_at: now(),
      updated_at: now(),
    };
    store.bids.set(bid.id, bid);
  }

  if (db.isEnabled()) {
    try {
      await db.query(
        `INSERT INTO bids (id, shipment_posting_id, carrier_id, bid_amount, estimated_transit_days, notes, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (shipment_posting_id, carrier_id)
         DO UPDATE SET bid_amount = EXCLUDED.bid_amount,
                       estimated_transit_days = EXCLUDED.estimated_transit_days,
                       notes = EXCLUDED.notes,
                       status = 'open', updated_at = now()`,
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
  const { bid_id, shipper_id, payment_method_id } = req.body || {};
  if (!bid_id) return res.status(400).json({ error: 'bid_id is required' });

  const bid = store.bids.get(bid_id);
  if (!bid) return res.status(404).json({ error: 'Bid not found' });
  if (bid.status !== 'open') {
    return res.status(409).json({ error: `Bid is ${bid.status}; only open bids can be accepted` });
  }

  const load = store.loads.get(bid.shipment_posting_id);
  if (shipper_id && load && load.shipper_id !== shipper_id) {
    return res.status(403).json({ error: 'Only the posting shipper can accept bids' });
  }

  // Arbitrage math: shipper pays bid + markup; platform keeps the spread.
  const carrierBid = round2(bid.bid_amount);
  const shipperPrice = round2(carrierBid * (1 + config.markupPercent / 100));
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
        description: `Apex Freight load ${bid.shipment_posting_id} — accepted bid ${bid.id}`,
      });
      stripe_payment_intent_id = pi.id;
      payment_status = 'paid';
    } catch (err) {
      return res.status(502).json({ error: 'Stripe payment failed', detail: err.message });
    }
  }

  // Flip statuses: accepted bid wins, other open bids are outbid, posting awarded.
  bid.status = 'accepted';
  bid.updated_at = now();
  for (const other of store.bids.values()) {
    if (other.shipment_posting_id === bid.shipment_posting_id && other.id !== bid.id && other.status === 'open') {
      other.status = 'outbid';
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
      await db.query(
        `INSERT INTO marketplace_transactions
           (bid_id, posting_id, shipper_id, carrier_id, carrier_payout, shipper_charge,
            platform_profit, payment_status, stripe_payment_intent_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [txn.bid_id, txn.posting_id, txn.shipper_id, txn.carrier_id, txn.carrier_payout,
         txn.shipper_charge, txn.platform_profit, txn.payment_status, txn.stripe_payment_intent_id]
      );
      await db.query(`UPDATE bids SET status='accepted', updated_at=now() WHERE id=$1`, [bid.id]);
      await db.query(
        `UPDATE bids SET status='outbid', updated_at=now()
          WHERE shipment_posting_id=$1 AND id<>$2 AND status='open'`,
        [bid.shipment_posting_id, bid.id]
      );
      await db.query(`UPDATE shipment_postings SET status='awarded', updated_at=now() WHERE id=$1`, [bid.shipment_posting_id]);
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
