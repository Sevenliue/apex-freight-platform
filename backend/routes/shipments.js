// routes/shipments.js — POST /api/shipments/buy
// Purchases a shipping label for a quoted rate via EasyPost.
// 501 when EASYPOST_API_KEY is not set. Only EasyPost-sourced rates can be
// bought here; matrix rates are carrier-direct LTL quotes, not parcel labels.
'use strict';

const express = require('express');
const config = require('../config');
const db = require('../db');
const easypost = require('../lib/easypost');
const { store, id } = require('../lib/store');
const { round2 } = require('../lib/money');

const router = express.Router();

// The shipping-approval gate lives in lib/ so every route can share it
// without a routes/ <-> routes/ circular dependency.
const { userCanShip } = require('../lib/shipping-approval');

router.post('/buy', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Sign in required.' });
  }
  if (!(await userCanShip(req.user.id))) {
    return res.status(403).json({ error: 'Shipping approval required.' });
  }
  const { shipment_id, rate_id, db_quote_id = null } = req.body || {};
  // The logged-in account is always the attribution; never trust a client id.
  const effectiveUserId = req.user.id;

  if (!shipment_id || !rate_id) {
    return res.status(400).json({ error: 'shipment_id and rate_id are required' });
  }
  if (!easypost.isEnabled()) {
    return res.status(501).json({ error: 'Label purchase requires EASYPOST_API_KEY' });
  }

  const quote = store.quotes.get(shipment_id);
  if (!quote) {
    return res.status(404).json({ error: 'Unknown shipment_id — request a fresh quote first' });
  }
  const rate = quote.rates.find((r) => r.rate_id === rate_id);
  if (!rate) {
    return res.status(404).json({ error: 'Unknown rate_id for this shipment' });
  }
  if ((quote.packages || []).some((p) => p && p.dg)) {
    return res.status(403).json({ error: 'Dangerous-goods shipments require admin review before purchase.' });
  }
  if (rate.source !== 'easypost' || !quote.easypost_shipment_id) {
    return res.status(400).json({
      error: 'Only EasyPost rates can be purchased here; matrix rates are carrier-direct quotes',
    });
  }

  try {
    const bought = await easypost.buyLabel(quote.easypost_shipment_id, rate_id);

    const order = {
      id: id('ord'),
      shipment_id,
      rate_id,
      db_quote_id,
      user_id: effectiveUserId,
      carrier: bought.carrier || rate.carrier,
      service: bought.service || rate.service,
      tracking_code: bought.tracking_code,
      label_url: (bought.postage_label && bought.postage_label.label_url) || null,
      status: 'purchased',
      charged_amount: rate.retail_cad,
      created_at: new Date().toISOString(),
    };
    store.orders.push(order);

    if (db.isEnabled()) {
      try {
        await db.query(
          `INSERT INTO orders (shipment_id, rate_id, user_id, carrier, service, tracking_code, label_url, status, charged_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [order.shipment_id, order.rate_id, order.user_id, order.carrier, order.service,
           order.tracking_code, order.label_url, order.status, order.charged_amount]
        );
      } catch (err) {
        console.error('[shipments/buy] order DB insert failed (non-fatal):', err.message);
      }
    }

    return res.json({
      tracking_code: order.tracking_code,
      carrier: order.carrier,
      service: order.service,
      label_url: order.label_url,
      shipment_id,
      rate_id,
      order_id: order.id,
      status: order.status,
    });
  } catch (err) {
    return res.status(502).json({ error: 'EasyPost label purchase failed', detail: err.message });
  }
});

module.exports = router;

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// POST /api/shipments/complete — "Complete This Shipment".
// Body: shipment_id (quote id from POST /api/rates), rate_id, plus
//   shipper {}, consignee {}, references {}, delivery notes, user_id,
//   region/direction/freight_charges/bill_to/depot flags.
//
// Two paths:
// - POST /api/shipments/checkout (new, pay-first): creates the pending order,
//   then a Stripe Checkout Session for the full retail freight amount. The
//   Stripe webhook finalizes the order (label buy / PRO mint) on payment.
// - POST /api/shipments/complete (legacy): direct scheduling with no payment,
//   used when Stripe is not configured (test mode). The order is recorded
//   unpaid so the tender queue can tell it apart.
// ---------------------------------------------------------------------------
const easypostRoute = require('./easypost');
const billing = require('../lib/billing');

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  throw e;
}

// prepareOrder(): validate quote+rate, build the order and BOL, persist as
// awaiting_payment/unpaid. Shared by /complete and /checkout.
async function prepareOrder(body, effectiveUserId) {
  const {
    shipment_id, rate_id,
    shipper = {}, consignee = {}, references = {},
    delivery_note_1 = null, delivery_note_2 = null, delivery_notes = '',
    private_notes = '',
    add_insurance = false, declared_value = 0,
    region = null, direction = null, freight_charges = null, bill_to = null,
    depot_dropoff = null, depot_pickup = null, terms_accepted = false,
  } = body || {};

  if (!shipment_id || !rate_id) fail(400, 'shipment_id and rate_id are required');
  if (!terms_accepted) fail(400, 'You must accept the Terms of Service to schedule a shipment.');
  const quote = store.quotes.get(shipment_id);
  if (!quote) fail(404, 'Unknown shipment_id — request a fresh quote first');
  const rate = (quote.rates || []).find((r) => r.rate_id === rate_id);
  if (!rate) fail(404, 'Unknown rate_id for this shipment');

  // Shipment type + freight charges: prefer the completion payload, fall back
  // to what was stored on the quote.
  const shipRegion = region || quote.region || 'canada_usa';
  const shipDirection = direction || quote.direction || 'outbound';
  const shipFreight = freight_charges || quote.freight_charges || 'prepaid';
  const shipBillTo = bill_to || quote.bill_to || {};
  // Depot flags: prefer the completion payload, fall back to the quote.
  const shipDepotDropoff = depot_dropoff != null ? !!depot_dropoff : !!quote.depot_dropoff;
  const shipDepotPickup = depot_pickup != null ? !!depot_pickup : !!quote.depot_pickup;
  // Requested pickup date comes from the quote (required at rating time).
  const shipPickupDate = quote.pickup_date || null;
  // Delivery notes: prefer the completion payload, fall back to the quote
  // (legacy single delivery_notes maps to Box 1).
  const pickNote = (v, fb) => (v === undefined || v === null) ? String(fb || '') : String(v).slice(0, 60);
  const shipNote1 = pickNote(delivery_note_1, quote.delivery_note_1 || delivery_notes);
  const shipNote2 = pickNote(delivery_note_2, quote.delivery_note_2);
  const shipPrivateNotes = String(private_notes || quote.private_notes || '').slice(0, 4000);

  // Cargo insurance is chosen at shipment creation (not at rating time):
  // 1% of declared value, $20 minimum, added to the total at cost.
  const cmAddIns = add_insurance === true || add_insurance === 'true' || add_insurance === 'on';
  const cmDeclared = Math.max(0, round2(parseFloat(declared_value) || 0));
  const rateIns = round2(rate.insurance_cad || 0);
  let insurance_cad = rateIns;
  let insurance_declared_value = rate.insurance_declared_value || null;
  if (cmAddIns && cmDeclared > 0 && !rateIns) {
    insurance_cad = Math.max(20, round2(cmDeclared * 0.01));
    insurance_declared_value = cmDeclared;
  }

  // Shipper's order # + receiver's PO #: required on every shipment so
  // reports can be run against them later. Stored as real columns (not just
  // inside the BOL JSON) for querying.
  const refs = references || {};
  const shipper_order_no = String(refs['Ref #'] || refs.ref_number || refs.shipper_order_no || '').trim().slice(0, 255);
  const receiver_po_no = String(refs['PO #'] || refs.po_number || refs.receiver_po_no || '').trim().slice(0, 255);
  if (!shipper_order_no || !receiver_po_no) {
    fail(400, "Shipper's order number and receiver's PO number are both required.");
  }

  const order = {
    id: null,
    quote_id: quote.db_quote_id || null,
    shipment_id,
    rate_id,
    user_id: effectiveUserId,
    carrier: rate.carrier,
    service: rate.service,
    cost_cad: rate.cost_cad,
    charged_amount: round2(rate.retail_cad + (insurance_cad - rateIns)),
    currency: rate.currency || 'CAD',
    // Dangerous goods are held for admin review before the shipment can be
    // completed or paid: status 'dg_review' instead of 'awaiting_payment'.
    status: (quote.packages || []).some((p) => p.dg) ? 'dg_review' : 'awaiting_payment',
    payment_status: 'unpaid',
    tracking_code: null,
    label_url: null,
    shipper_order_no,
    receiver_po_no,
    easypost_shipment_id: quote.easypost_shipment_id || null,
    region: shipRegion,
    direction: shipDirection,
    freight_charges: shipFreight,
    bill_to: shipBillTo,
    tendered: false,
    carrier_pro: null,
    pickup_date: shipPickupDate,
    created_at: new Date().toISOString(),
  };

  const bol = {
    shipper, consignee, references, delivery_note_1: shipNote1, delivery_note_2: shipNote2,
    private_notes: shipPrivateNotes,
    packages: quote.packages || [],
    total_weight_lbs: quote.total_weight_lbs ?? null,
    accessorials_applied: rate.accessorials_applied || [],
    accessorial_total_cad: rate.accessorial_total_cad || 0,
    carrier: order.carrier,
    service: order.service,
    delivery_days: rate.delivery_days || null,
    cost_cad: order.cost_cad,
    charged_amount: order.charged_amount,
    region: shipRegion,
    direction: shipDirection,
    freight_charges: shipFreight,
    bill_to: shipBillTo,
    depot_dropoff: shipDepotDropoff,
    depot_pickup: shipDepotPickup,
    pickup_date: shipPickupDate,
    insurance_declared_value: insurance_declared_value,
    insurance_cad: insurance_cad || null,
    dg_hold: order.status === 'dg_review',
    terms_accepted_at: new Date().toISOString(),
  };
  order.bol = bol;

  if (db.isEnabled()) {
    const userUuid = effectiveUserId ? await db.ensureUser(effectiveUserId, 'shipper') : null;
    const r = await db.query(
      `INSERT INTO orders (quote_id, user_id, easypost_shipment_id, easypost_rate_id,
                           tracking_code, carrier, service_level, cost_amount,
                           charged_amount, currency, label_url, status, payment_status,
                           shipper_order_no, receiver_po_no, bol_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [order.quote_id, userUuid, order.easypost_shipment_id, rate.source === 'easypost' ? rate_id : null,
       order.tracking_code, order.carrier, order.service, order.cost_cad,
       order.charged_amount, order.currency, order.label_url, order.status, order.payment_status,
       order.shipper_order_no, order.receiver_po_no,
       JSON.stringify(bol)]
    );
    order.id = r.rows[0].id;
    order.user_id = userUuid || effectiveUserId;
  } else {
    order.id = id('ord');
  }
  // Auto-save the entered addresses into this customer's address book so
  // each address stays attached to their customer name. Best-effort: a
  // save failure must never break order creation.
  try {
    const ab = require('./addressbook');
    if (typeof ab.savePartyAddresses === 'function') {
      await ab.savePartyAddresses(order.user_id, shipper, consignee);
    }
  } catch (err) {
    console.error('address-book auto-save failed:', err && err.message);
  }
  store.orders.push(order);
  // Notifications are best-effort and must never break order creation.
  try {
    const notifyLib = require('../lib/notify');
    notifyLib.notify(order.status === 'dg_review' ? 'dg_review' : 'order_created', order, {
      customerEmail: (shipper && shipper.email) || null,
    });
  } catch (err) { console.error('[notify] hook failed (non-fatal):', err.message); }
  return { order, quote, rate };
}

// finalizeShipmentPayment(dbOrderId, paymentIntentId): the Stripe webhook
// calls this after a successful shipment Checkout. Idempotent — replaying a
// paid order is a no-op. Parcel (EasyPost): buys the label now that the
// customer has paid. Matrix LTL: mints the internal PRO and marks scheduled.
async function finalizeShipmentPayment(dbOrderId, paymentIntentId) {
  if (!db.isEnabled()) throw new Error('finalizeShipmentPayment requires a database');
  // Row-locked transaction: concurrent webhook redeliveries serialize here,
  // so a retried event can never buy the label twice (M2).
  const client = await db.getPool().connect();
  let out;
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [dbOrderId]);
    if (!r.rows.length) {
      const e = new Error('order not found: ' + dbOrderId);
      e.permanent = true; // no point in Stripe retrying an unknown order
      throw e;
    }
    const row = r.rows[0];
    if (row.payment_status === 'paid') {
      out = { already: true, id: row.id, status: row.status, tracking_code: row.tracking_code };
    } else if (row.status !== 'awaiting_payment') {
      // Never resurrect a cancelled / rejected / already-scheduled order with
      // a late payment (e.g. admin rejected a DG order while Checkout was open).
      const e = new Error('order not payable: status is ' + row.status);
      e.permanent = true;
      throw e;
    } else {
      let status = 'scheduled';
      let tracking = row.tracking_code;
      let labelUrl = row.label_url;
      let carrier = row.carrier;
      let service = row.service_level;
      const epShipment = row.easypost_shipment_id;
      const epRate = row.easypost_rate_id;
      if (epShipment && epRate && easypost.isEnabled()) {
        const bought = await easypostRoute.buyEasypostLabel(epShipment, epRate);
        status = 'purchased';
        tracking = bought.tracking_code || null;
        labelUrl = (bought.postage_label && bought.postage_label.label_url) || null;
        carrier = bought.carrier || carrier;
        service = bought.service || service;
      } else if (!tracking) {
        tracking = 'APX-' + Math.random().toString(36).slice(2, 8).toUpperCase();
      }
      await client.query(
        `UPDATE orders SET status = $2, tracking_code = $3, label_url = $4, payment_status = 'paid',
                          stripe_payment_intent_id = $5, carrier = $6, service_level = $7
         WHERE id = $1`,
        [dbOrderId, status, tracking, labelUrl, paymentIntentId || null, carrier, service]
      );
      const mem = store.orders.find((o) => o.id === dbOrderId);
      if (mem) {
        mem.status = status; mem.tracking_code = tracking; mem.label_url = labelUrl;
        mem.payment_status = 'paid'; mem.carrier = carrier; mem.service = service;
      }
      out = {
        id: dbOrderId,
        status,
        tracking_code: tracking,
        carrier,
        service,
        charged_amount: row.charged_amount != null ? Number(row.charged_amount) : null,
        label_url: labelUrl,
        bol_url: `/api/shipments/bol/${encodeURIComponent(dbOrderId)}`,
        shipper_order_no: row.shipper_order_no || null,
        bol: (() => { try { const bj = row.bol_json; return typeof bj === 'object' ? bj || {} : JSON.parse(bj || '{}'); } catch { return {}; } })(),
      };
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* no transaction to roll back */ }
    throw err;
  } finally {
    client.release();
  }
  // Payment confirmation (best-effort, only for a fresh finalization).
  if (!out.already) {
    try {
      const notifyLib = require('../lib/notify');
      notifyLib.notify('payment_succeeded', {
        carrier: out.carrier, charged_amount: out.charged_amount, tracking_code: out.tracking_code,
        shipper_order_no: out.shipper_order_no, bol: out.bol,
      });
    } catch (err) { console.error('[notify] hook failed (non-fatal):', err.message); }
  }
  return out;
}

// POST /api/shipments/checkout — pay-first scheduling.
// Creates the pending order, then a Stripe Checkout Session for the full
// retail freight amount. 501 when Stripe (or the database) is not configured.
router.post('/checkout', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Sign in to schedule a shipment.' });
  }
  if (!db.isEnabled()) {
    return res.status(501).json({ error: 'Shipment payment requires a database. Set DATABASE_URL.' });
  }
  // Shipping approval: new accounts are quote-only until an admin approves
  // them in Admin → Account approvals.
  if (!(await userCanShip(req.user.id))) {
    return res.status(403).json({
      error: 'Your account is not approved for shipping yet. You can keep getting quotes — we will enable scheduling once your account is approved.',
    });
  }
  const stripeKey = config.stripeKey;
  if (!stripeKey) {
    return res.status(501).json({ error: 'Stripe is not configured: set STRIPE_SECRET_KEY on the server.' });
  }
  let prepared;
  try {
    prepared = await prepareOrder(req.body || {}, req.user.id);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
  const { order } = prepared;
  // Dangerous-goods hold: payment cannot start until an admin approves.
  if (order.status === 'dg_review') {
    return res.status(409).json({ error: 'This shipment contains dangerous goods and is under review. Payment opens after we confirm acceptance.' });
  }
  try {
    const stripe = require('stripe')(stripeKey);
    // Reuse the subscriber's Stripe customer so receipts thread together.
    let customerId = null;
    try { customerId = (await billing.getBillingState(req.user.id) || {}).stripeCustomerId || null; } catch { /* ignore */ }
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        name: req.user.name || undefined,
        metadata: { user_id: req.user.id, company: req.user.company || '' },
      });
      customerId = customer.id;
      try { await billing.setSubscription(req.user.id, { stripe_customer_id: customerId }); } catch { /* ignore */ }
    }
    const cents = Math.max(50, Math.round(Number(order.charged_amount) * 100));
    const b = order.bol || {};
    const city = (p) => [p && p.city, p && (p.province || p.state)].filter(Boolean).join(', ');
    const routeDesc = `${city(b.shipper) || '?'} → ${city(b.consignee) || '?'}`;
    const origin = `${req.protocol}://${req.get('host')}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      client_reference_id: req.user.id,
      line_items: [{
        price_data: {
          currency: 'cad',
          unit_amount: cents,
          product_data: {
            name: `Freight shipment — ${order.carrier}${order.service ? ' · ' + order.service : ''}`,
            description: routeDesc,
          },
        },
        quantity: 1,
      }],
      metadata: { type: 'shipment_payment', order_id: order.id, user_id: req.user.id },
      payment_intent_data: { metadata: { type: 'shipment_payment', order_id: order.id } },
      success_url: `${origin}/?shipment=paid&order_id=${encodeURIComponent(order.id)}`,
      cancel_url: `${origin}/?shipment=cancelled`,
    });
    await db.query('UPDATE orders SET stripe_checkout_session_id = $2 WHERE id = $1', [order.id, session.id]);
    return res.json({ url: session.url, order_id: order.id });
  } catch (err) {
    console.error('[shipments/checkout]', err.message);
    return res.status(502).json({ error: 'Could not start payment: ' + err.message });
  }
});

// POST /api/shipments/complete — legacy direct scheduling, no payment.
// Admin-only: ordinary users must pay through /checkout. This closes the
// hole where anyone could schedule a load unpaid while Stripe is unset.
router.post('/complete', async (req, res) => {
  let isAdmin = false;
  if (req.user) {
    try { isAdmin = !!((await billing.getBillingState(req.user.id) || {}).isAdmin); } catch { /* ignore */ }
  }
  if (!isAdmin) {
    return res.status(403).json({ error: 'Scheduling without payment is restricted to staff. Please pay online to schedule this shipment.' });
  }
  const effectiveUserId = (req.user && req.user.id) || (req.body || {}).user_id || null;
  let prepared;
  try {
    prepared = await prepareOrder(req.body || {}, effectiveUserId);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
  const { order, quote, rate } = prepared;

  // Dangerous-goods hold: the load stays in admin review — it is not
  // scheduled, no label is bought, and no PRO is minted until approved.
  if (order.status === 'dg_review') {
    return res.json({
      order_id: order.id,
      status: 'dg_review',
      carrier: order.carrier,
      service: order.service,
      tracking_code: null,
      label_url: null,
      charged_amount: order.charged_amount,
      payment: 'unpaid',
      payment_note: 'This shipment contains dangerous goods and is under review. We will confirm acceptance before any payment is collected.',
      bol_url: `/api/shipments/bol/${encodeURIComponent(order.id)}`,
    });
  }

  if (rate.source === 'easypost' && quote.easypost_shipment_id && easypost.isEnabled()) {
    try {
      const bought = await easypostRoute.buyEasypostLabel(quote.easypost_shipment_id, rate.rate_id);
      order.status = 'purchased';
      order.tracking_code = bought.tracking_code || null;
      order.label_url = (bought.postage_label && bought.postage_label.label_url) || null;
      order.carrier = bought.carrier || rate.carrier;
      order.service = bought.service || rate.service;
    } catch (err) {
      return res.status(502).json({ error: 'Label purchase failed', detail: err.message });
    }
  } else {
    // Matrix rate-sheet carrier: schedule the shipment, mint an internal PRO.
    order.status = 'scheduled';
    order.tracking_code = 'APX-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  }

  if (db.isEnabled() && /^[0-9a-f-]{36}$/i.test(order.id || '')) {
    try {
      await db.query(
        `UPDATE orders SET status = $2, tracking_code = $3, label_url = $4,
                            carrier = $5, service_level = $6 WHERE id = $1`,
        [order.id, order.status, order.tracking_code, order.label_url, order.carrier, order.service]
      );
    } catch (err) {
      console.error('[shipments/complete] order update failed (non-fatal):', err.message);
    }
  }

  return res.json({
    order_id: order.id,
    status: order.status,
    carrier: order.carrier,
    service: order.service,
    tracking_code: order.tracking_code,
    label_url: order.label_url,
    charged_amount: order.charged_amount,
    payment: 'unpaid',
    payment_note: 'Stripe is not configured — this load was scheduled without payment (test mode).',
    bol_url: `/api/shipments/bol/${encodeURIComponent(order.id)}`,
  });
});

// POST /api/shipments/:id/cancel — the customer cancels their own pending
// load; an admin can cancel any non-final load. Paid loads are refunded
// through Stripe; unpaid loads are simply cancelled.
router.post('/:id/cancel', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  const id = req.params.id;
  let row = null;
  if (db.isEnabled()) {
    try {
      const r = await db.query('SELECT * FROM orders WHERE id = $1', [id]);
      row = r.rows[0] || null;
    } catch (err) {
      return res.status(502).json({ error: 'Could not load shipment: ' + err.message });
    }
  } else {
    row = (store.orders || []).find((o) => String(o.id) === String(id)) || null;
  }
  if (!row) return res.status(404).json({ error: 'Shipment not found.' });
  let isAdmin = false;
  try { isAdmin = !!((await billing.getBillingState(req.user.id) || {}).isAdmin); } catch { /* ignore */ }
  const isOwner = row.user_id && String(row.user_id) === String(req.user.id);
  if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Not your shipment.' });

  if (row.status === 'cancelled') return res.status(409).json({ error: 'Already cancelled.' });
  if (row.tendered && !isAdmin) {
    return res.status(403).json({ error: 'This load is already booked with the carrier — contact us to cancel.' });
  }
  const cancellable = ['awaiting_payment', 'dg_review', 'scheduled', 'purchased'];
  if (!cancellable.includes(row.status) && !isAdmin) {
    return res.status(409).json({ error: `Cannot cancel a shipment with status "${row.status}".` });
  }

  let refunded = false;
  if (row.payment_status === 'paid') {
    if (!config.stripeKey) {
      return res.status(502).json({ error: 'Refunds need online payments configured — contact us and we will refund you manually.' });
    }
    if (!row.stripe_payment_intent_id) {
      return res.status(502).json({ error: 'No payment record found — contact us for a manual refund.' });
    }
    try {
      const stripe = require('stripe')(config.stripeKey);
      await stripe.refunds.create({ payment_intent: row.stripe_payment_intent_id });
      refunded = true;
    } catch (err) {
      return res.status(502).json({ error: 'Refund failed: ' + err.message });
    }
  }
  const newPayment = refunded ? 'refunded' : row.payment_status;
  if (db.isEnabled()) {
    try {
      await db.query('UPDATE orders SET status = $2, payment_status = $3 WHERE id = $1', [id, 'cancelled', newPayment]);
    } catch (err) {
      return res.status(502).json({ error: 'Could not cancel: ' + err.message });
    }
  }
  const mem = (store.orders || []).find((o) => String(o.id) === String(id));
  if (mem) { mem.status = 'cancelled'; mem.payment_status = newPayment; }
  // Cancellation notice (best-effort).
  try {
    const notifyLib = require('../lib/notify');
    let bol = {};
    const bj = row.bol_json !== undefined ? row.bol_json : (row.bol || {});
    try { bol = typeof bj === 'object' ? bj || {} : JSON.parse(bj || '{}'); } catch { /* ignore */ }
    notifyLib.notify('cancelled', {
      carrier: row.carrier, charged_amount: row.charged_amount,
      shipper_order_no: row.shipper_order_no, bol,
    }, { refunded });
  } catch (err) { console.error('[notify] hook failed (non-fatal):', err.message); }
  return res.json({ ok: true, status: 'cancelled', payment_status: newPayment, refunded });
});

// GET /api/shipments/order/:id — payment/scheduling status, for the
// post-checkout confirmation page. Requires sign-in; the caller must own the
// order or be an admin. (An unguessable uuid alone is not authorization.)
router.get('/order/:id', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  const order = await findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Shipment not found.' });
  if (order.user_id && order.user_id !== req.user.id) {
    let isAdmin = false;
    try { isAdmin = !!((await billing.getBillingState(req.user.id) || {}).isAdmin); } catch { /* ignore */ }
    if (!isAdmin) return res.status(403).json({ error: 'Not your shipment.' });
  }
  return res.json({
    order_id: order.id,
    status: order.status,
    payment_status: order.payment_status || (order.status === 'awaiting_payment' ? 'unpaid' : 'paid'),
    carrier: order.carrier,
    service: order.service,
    tracking_code: order.tracking_code,
    charged_amount: order.charged_amount,
    label_url: order.label_url,
    shipper_order_no: order.shipper_order_no || (order.bol && (order.bol.references || {})['Ref #']) || null,
    receiver_po_no: order.receiver_po_no || (order.bol && (order.bol.references || {})['PO #']) || null,
    bol_url: `/api/shipments/bol/${encodeURIComponent(order.id)}`,
  });
});

// Tender queue (admin only): paid loads still needing a manual carrier booking.
async function needAdmin(req, res) {
  if (!req.user) { res.status(401).json({ error: 'Sign in required.' }); return false; }
  if (!db.isEnabled()) { res.status(501).json({ error: 'Database required.' }); return false; }
  let isAdmin = false;
  try { isAdmin = !!((await billing.getBillingState(req.user.id) || {}).isAdmin); } catch { /* ignore */ }
  if (!isAdmin) { res.status(403).json({ error: 'Admin access required.' }); return false; }
  return true;
}

router.get('/tenders', async (req, res) => {
  if (!(await needAdmin(req, res))) return;
  try {
    const r = await db.query(
      `SELECT o.id, o.tracking_code, o.carrier, o.service_level, o.charged_amount,
              o.status, o.payment_status, o.tendered, o.carrier_pro, o.created_at, o.bol_json,
              o.shipper_order_no, o.receiver_po_no,
              u.email AS customer_email
       FROM orders o LEFT JOIN users u ON u.id = o.user_id
       WHERE o.status IN ('scheduled', 'purchased') AND o.tendered = false
       ORDER BY o.created_at DESC LIMIT 200`
    );
    const tenders = r.rows.map((row) => {
      let bol = {};
      try { bol = typeof row.bol_json === 'object' ? row.bol_json || {} : JSON.parse(row.bol_json || '{}'); } catch { /* ignore */ }
      const city = (p) => [p && p.city, p && (p.province || p.state)].filter(Boolean).join(', ');
      return {
        id: row.id,
        tracking_code: row.tracking_code,
        route: `${city(bol.shipper) || '?'} → ${city(bol.consignee) || '?'}`,
        carrier: row.carrier,
        service: row.service_level,
        charged_amount: row.charged_amount != null ? Number(row.charged_amount) : null,
        status: row.status,
        payment_status: row.payment_status,
        shipper_order_no: row.shipper_order_no,
        receiver_po_no: row.receiver_po_no,
        customer_email: row.customer_email,
        created_at: row.created_at,
        pickup_date: bol.pickup_date || null,
        bol_url: `/api/shipments/bol/${row.id}`,
      };
    });
    return res.json({ tenders });
  } catch (err) {
    return res.status(502).json({ error: 'Could not load tender queue: ' + err.message });
  }
});

router.post('/tenders/:id', async (req, res) => {
  if (!(await needAdmin(req, res))) return;
  const carrierPro = String((req.body || {}).carrier_pro || '').slice(0, 255) || null;
  try {
    const r = await db.query(
      'UPDATE orders SET tendered = true, carrier_pro = $2 WHERE id = $1 RETURNING id',
      [req.params.id, carrierPro]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Order not found.' });
    const mem = store.orders.find((o) => o.id === req.params.id);
    if (mem) { mem.tendered = true; mem.carrier_pro = carrierPro; }
    // Tell the customer their load is booked (best-effort).
    try {
      const notifyLib = require('../lib/notify');
      const or = await db.query('SELECT carrier, charged_amount, shipper_order_no, bol_json FROM orders WHERE id = $1', [req.params.id]);
      const trow = or.rows[0] || {};
      let bol = {};
      try { bol = typeof trow.bol_json === 'object' ? trow.bol_json || {} : JSON.parse(trow.bol_json || '{}'); } catch { /* ignore */ }
      notifyLib.notify('tendered', {
        carrier: trow.carrier, charged_amount: trow.charged_amount,
        carrier_pro: carrierPro, shipper_order_no: trow.shipper_order_no, bol,
      });
    } catch (err) { console.error('[notify] hook failed (non-fatal):', err.message); }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(502).json({ error: 'Could not update tender: ' + err.message });
  }
});

// Dangerous-goods review queue (admin only): DG loads held before
// completion. Approve releases the shipment to awaiting_payment so the
// customer can pay/schedule; reject cancels it.
function dgRow(row) {
  let bol = {};
  try { bol = typeof row.bol_json === 'object' ? row.bol_json || {} : JSON.parse(row.bol_json || '{}'); } catch { /* ignore */ }
  const city = (p) => [p && p.city, p && (p.province || p.state)].filter(Boolean).join(', ');
  const dgLines = ((bol.packages || []).filter((p) => p.dg) || []).map((p) => ({
    product: p.product_name || p.package_type || 'DG line',
    qty: p.qty,
    weight_lb: p.weight_lb,
    un_number: p.un_number || '—',
    class: p.freight_class || '—',
    pkg_group: p.pkg_group || '—',
  }));
  return {
    id: row.id,
    route: `${city(bol.shipper) || '?'} → ${city(bol.consignee) || '?'}`,
    carrier: row.carrier,
    service: row.service_level,
    charged_amount: row.charged_amount != null ? Number(row.charged_amount) : null,
    shipper_order_no: row.shipper_order_no,
    receiver_po_no: row.receiver_po_no,
    customer_email: row.customer_email,
    created_at: row.created_at,
    dg_lines: dgLines,
    bol_url: `/api/shipments/bol/${row.id}`,
  };
}

router.get('/dg-queue', async (req, res) => {
  if (!(await needAdmin(req, res))) return;
  try {
    const r = await db.query(
      `SELECT o.id, o.carrier, o.service_level, o.charged_amount,
              o.shipper_order_no, o.receiver_po_no, o.created_at, o.bol_json,
              u.email AS customer_email
       FROM orders o LEFT JOIN users u ON u.id = o.user_id
       WHERE o.status = 'dg_review'
       ORDER BY o.created_at DESC LIMIT 200`
    );
    const mem = (store.orders || []).filter((o) => o.status === 'dg_review').map((o) => ({
      id: o.id, carrier: o.carrier, service_level: o.service, charged_amount: o.charged_amount,
      shipper_order_no: o.shipper_order_no, receiver_po_no: o.receiver_po_no,
      created_at: o.created_at, bol_json: o.bol, customer_email: null,
    }));
    return res.json({ dg_queue: [...r.rows.map(dgRow), ...mem.map(dgRow)] });
  } catch (err) {
    return res.status(502).json({ error: 'Could not load DG review queue: ' + err.message });
  }
});

async function setDgStatus(id, status) {
  const r = await db.query('UPDATE orders SET status = $2 WHERE id = $1 RETURNING id', [id, status]);
  const mem = (store.orders || []).find((o) => String(o.id) === String(id));
  if (mem) mem.status = status;
  return r.rows.length > 0 || !!mem;
}

router.post('/dg-queue/:id/approve', async (req, res) => {
  if (!(await needAdmin(req, res))) return;
  try {
    const ok = await setDgStatus(req.params.id, 'awaiting_payment');
    if (!ok) return res.status(404).json({ error: 'Order not found.' });
    return res.json({ ok: true, status: 'awaiting_payment' });
  } catch (err) {
    return res.status(502).json({ error: 'Could not approve: ' + err.message });
  }
});

router.post('/dg-queue/:id/reject', async (req, res) => {
  if (!(await needAdmin(req, res))) return;
  try {
    const ok = await setDgStatus(req.params.id, 'cancelled');
    if (!ok) return res.status(404).json({ error: 'Order not found.' });
    return res.json({ ok: true, status: 'cancelled' });
  } catch (err) {
    return res.status(502).json({ error: 'Could not reject: ' + err.message });
  }
});

// GET /api/shipments/bol/:id — printable bill of lading for a completed
// shipment. Self-contained HTML with a Print button.
// ---------------------------------------------------------------------------
const escHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cadFmt = (n) =>
  n === null || n === undefined || n === ''
    ? '—'
    : '$' + Number(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function findOrder(id) {
  const mem = store.orders.find((o) => o.id === id);
  if (mem) return { ...mem, bol: mem.bol || {} };
  if (db.isEnabled()) {
    try {
      const r = await db.query('SELECT * FROM orders WHERE id = $1', [id]);
      if (!r.rows.length) return null;
      const row = r.rows[0];
      let bol = {};
      try { bol = typeof row.bol_json === 'object' ? row.bol_json || {} : JSON.parse(row.bol_json || '{}'); } catch { /* ignore */ }
      return {
        id: row.id, status: row.status, carrier: row.carrier, service: row.service_level,
        tracking_code: row.tracking_code, label_url: row.label_url,
        user_id: row.user_id, payment_status: row.payment_status,
        cost_cad: row.cost_amount != null ? Number(row.cost_amount) : null,
        charged_amount: row.charged_amount != null ? Number(row.charged_amount) : null,
        created_at: row.created_at,
        shipper_order_no: row.shipper_order_no || null,
        receiver_po_no: row.receiver_po_no || null,
        bol,
      };
    } catch { return null; }
  }
  return null;
}

router.get('/bol/:id', async (req, res) => {
  if (!req.user) return res.status(401).send('Sign in required.');
  const order = await findOrder(req.params.id);
  if (!order) return res.status(404).send('Shipment not found');
  // BOLs carry full PII — only the order owner or an admin may view.
  const billing = require('../lib/billing');
  let isAdmin = false;
  try { isAdmin = !!((await billing.getBillingState(req.user.id)) || {}).isAdmin; } catch { /* no */ }
  if (String(order.user_id) !== String(req.user.id) && !isAdmin) {
    return res.status(403).send('Not your shipment.');
  }
  const b = order.bol || {};
  const shipper = b.shipper || {};
  const consignee = b.consignee || {};
  const refs = b.references || {};
  const addr = (p) =>
    [p.street1 || p.street, [p.city, p.state || p.province].filter(Boolean).join(', '), p.zip || p.postal, p.country]
      .filter(Boolean).join('<br>');
  const pkgRows = (b.packages || [])
    .map(
      (p) => `<tr><td>${p.qty}</td><td>${escHtml(p.package_type)}</td><td>${escHtml(p.product_name)}</td>
        <td class="num">${p.weight_lb}</td><td class="num">${p.length ?? '—'}</td>
        <td class="num">${p.width ?? '—'}</td><td class="num">${p.height ?? '—'}</td>
        <td>${p.stackable ? 'Yes' : 'No'}</td><td>${p.dg ? 'Yes' : 'No'}</td></tr>`
    )
    .join('');
  const accRows = (b.accessorials_applied || [])
    .map((a) => `<tr><td>${escHtml(a.label)}</td><td class="num">${cadFmt(a.fee_cad)}</td></tr>`)
    .join('');
  const refRows = Object.entries(refs)
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr><td>${escHtml(k)}</td><td>${escHtml(v)}</td></tr>`)
    .join('');

  // Freight Charges / Bill To: who pays, and the address to bill.
  const FREIGHT_LABELS = {
    prepaid: 'Prepaid — bill shipper',
    collect: 'Collect — bill consignee',
    third_party: 'Third party — bill 3rd party',
  };
  const fc = b.freight_charges || 'prepaid';
  const fcLabel = FREIGHT_LABELS[fc] || fc;
  const payer = fc === 'collect' ? consignee : fc === 'third_party' ? (b.bill_to || {}) : shipper;
  const payerAddr = addr(payer);
  const payerName = payer.name ? `<strong>${escHtml(payer.name)}</strong><br>` : '';

  // Depot service options (competitor parity).
  const depotRows = [
    b.depot_dropoff ? '<tr><td>Pick-up</td><td><strong>Drop off at depot — do not dispatch</strong></td></tr>' : '',
    b.depot_pickup ? '<tr><td>Delivery</td><td><strong>Pick up at depot — no carrier delivery</strong></td></tr>' : '',
    b.pickup_date ? `<tr><td>Requested pickup date</td><td><strong>${escHtml(b.pickup_date)}</strong></td></tr>` : '',
  ].join('');

  res.send(`<!doctype html><html><head><meta charset="utf-8">
<title>Bill of Lading — ${escHtml(order.tracking_code || order.id)}</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;margin:32px;color:#111}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:20px 0 8px;border-bottom:2px solid #111;padding-bottom:4px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{border:1px solid #999;padding:6px 8px;text-align:left}
th{background:#eee}.num{text-align:right}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.box{border:1px solid #999;padding:10px;font-size:13px;line-height:1.5}
.sig{margin-top:28px;display:grid;grid-template-columns:1fr 1fr;gap:32px;font-size:13px}
.sig div{border-top:1px solid #111;padding-top:6px}
.note{font-size:12px;color:#555;margin-top:12px}
@media print{.noprint{display:none}}
</style></head><body>
<div class="noprint" style="margin-bottom:16px"><button onclick="window.print()">Print</button></div>
<h1>Bill of Lading</h1>
<p>PRO / Reference: <strong>${escHtml(order.tracking_code || order.id)}</strong> &nbsp;·&nbsp;
Status: <strong>${escHtml(order.status)}</strong> &nbsp;·&nbsp;
Date: ${escHtml(order.created_at ? new Date(order.created_at).toLocaleDateString('en-CA') : '')}</p>
<div class="grid">
<div><h2>Shipper</h2><div class="box"><strong>${escHtml(shipper.name)}</strong><br>${addr(shipper)}
${shipper.phone ? '<br>Tel: ' + escHtml(shipper.phone) : ''}${shipper.email ? '<br>' + escHtml(shipper.email) : ''}</div></div>
<div><h2>Consignee</h2><div class="box"><strong>${escHtml(consignee.name)}</strong><br>${addr(consignee)}
${consignee.phone ? '<br>Tel: ' + escHtml(consignee.phone) : ''}${consignee.email ? '<br>' + escHtml(consignee.email) : ''}</div></div>
</div>
<h2>Packages</h2>
<table><thead><tr><th>Qty</th><th>Type</th><th>Product</th><th>Weight (lb)</th><th>L (in)</th><th>W (in)</th><th>H (in)</th><th>Stackable</th><th>DG</th></tr></thead>
<tbody>${pkgRows || '<tr><td colspan="9">—</td></tr>'}</tbody></table>
<p>Total weight: <strong>${b.total_weight_lbs ?? '—'} lb</strong></p>
<h2>Carrier &amp; Charges</h2>
<table><tbody>
<tr><td>Carrier</td><td><strong>${escHtml(order.carrier)}${order.service ? ' — ' + escHtml(order.service) : ''}</strong></td></tr>
<tr><td>Estimated transit</td><td>${escHtml(b.delivery_days || '—')} (not guaranteed)</td></tr>
<tr><td>Freight cost</td><td class="num">${cadFmt(b.cost_cad != null && b.accessorial_total_cad ? Number(b.cost_cad) - Number(b.accessorial_total_cad) : b.cost_cad)}</td></tr>
${accRows}
${b.insurance_cad ? `<tr><td>Additional insurance (declared value ${cadFmt(b.insurance_declared_value)})</td><td class="num">${cadFmt(b.insurance_cad)}</td></tr>` : ''}
<tr><td><strong>Total (excl. tax)</strong></td><td class="num"><strong>${cadFmt(order.charged_amount)}</strong></td></tr>
</tbody></table>
<h2>Freight Charges / Bill To</h2>
<div class="box">${escHtml(fcLabel)}<br>${payerName}${payerAddr || '—'}
${payer.phone ? '<br>Tel: ' + escHtml(payer.phone) : ''}${payer.email ? '<br>' + escHtml(payer.email) : ''}</div>
${refRows ? `<h2>References</h2><table><tbody>${refRows}</tbody></table>` : ''}
${depotRows ? `<h2>Service Options</h2><table><tbody>${depotRows}</tbody></table>` : ''}
${(() => { const n = [b.delivery_note_1, b.delivery_note_2].filter(Boolean).map(escHtml).join('<br>'); return n ? `<h2>Delivery Instructions</h2><div class="box">${n}</div>` : ''; })()}
<div class="sig"><div>Shipper signature / date</div><div>Carrier signature / date</div></div>
<p class="note">Generated by Apex Freight &amp; Shipping Canada. Transit times are estimates, not guaranteed.</p>
</body></html>`);
});

// Exported for the Stripe webhook: finalize a paid shipment order.
module.exports.finalizeShipmentPayment = finalizeShipmentPayment;
// Exported for other routes that need the shipping-approval gate.
module.exports.userCanShip = userCanShip;
