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

router.post('/buy', async (req, res) => {
  const { shipment_id, rate_id, db_quote_id = null, user_id = null, charged_amount } = req.body || {};

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
      user_id,
      carrier: bought.carrier || rate.carrier,
      service: bought.service || rate.service,
      tracking_code: bought.tracking_code,
      label_url: (bought.postage_label && bought.postage_label.label_url) || null,
      status: 'purchased',
      charged_amount: charged_amount != null ? round2(charged_amount) : rate.retail_cad,
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
