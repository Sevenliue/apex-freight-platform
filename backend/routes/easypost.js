// routes/easypost.js — dedicated EasyPost endpoints.
//   POST /api/easypost/rates — live parcel rates for an address pair
//   POST /api/easypost/buy   — purchase a label for a rated shipment
//   GET  /api/easypost/track/:code — live tracking events/status
// Every endpoint answers { configured: false } when EASYPOST_API_KEY is
// unset, and the rest of the site keeps working off the rate sheets.
// The API key is used server-side only; it is never sent to the frontend.
'use strict';

const express = require('express');
const config = require('../config');
const db = require('../db');
const easypost = require('../lib/easypost');
const { store, id } = require('../lib/store');
const { round2, applyMarkup } = require('../lib/money');
const { userCanShip } = require('../lib/shipping-approval');

const router = express.Router();

function notConfigured(res) {
  return res.json({
    configured: false,
    message: 'EasyPost is not connected. Set EASYPOST_API_KEY on the server to enable live rates, labels, and tracking.',
  });
}

function bad(res, code, error, detail) {
  return res.status(code).json(detail ? { error, detail } : { error });
}

// Normalize a rate object from EasyPost into our quote shape.
function toRate(r) {
  const cost = Number(r.rate);
  return {
    rate_id: r.id,
    carrier: r.carrier,
    service: r.service,
    cost_cad: round2(cost),
    retail_cad: applyMarkup(cost, config.markupPercent),
    currency: r.currency || 'CAD',
    delivery_days: r.delivery_days != null ? String(r.delivery_days) : 'varies',
    delivery_date: r.delivery_date || r.est_delivery_date || null,
    source: 'easypost',
  };
}

// ---------------------------------------------------------------------------
// POST /api/easypost/rates
// Body: from_city, from_province (or from_state), from_postal (optional),
//       to_city, to_province (or to_state), to_postal (optional),
//       weight_lb, pieces (optional, default 1),
//       from_country / to_country (optional, default CA).
// weight_lb is the TOTAL shipment weight; it is split across `pieces`.
// ---------------------------------------------------------------------------
router.post('/rates', async (req, res) => {
  if (!req.user) return bad(res, 401, 'Sign in required.');
  if (!easypost.isEnabled()) return notConfigured(res);

  // Quota: a Worldwide EasyPost rating counts like any other quote.
  const billing = require('../lib/billing');
  let quotaState = null;
  try {
    const q = await billing.checkQuota(req.user.id);
    quotaState = q.state;
    if (!q.allowed) {
      return res.status(402).json({ error: q.reason || 'Monthly quote limit reached.', upgrade_required: true });
    }
  } catch (err) {
    return bad(res, 503, 'Billing is unavailable right now — please try again.');
  }

  const b = req.body || {};
  const fromCity = b.from_city;
  const fromProv = b.from_province || b.from_state;
  const toCity = b.to_city;
  const toProv = b.to_province || b.to_state;
  const weightLb = Number(b.weight_lb);
  // Cap pieces: each piece becomes a parcel in the EasyPost call.
  const pieces = Math.min(50, Math.max(1, Math.floor(Number(b.pieces) || 1)));

  if (!fromCity || !fromProv || !toCity || !toProv) {
    return bad(res, 400, 'from_city, from_province, to_city and to_province are required');
  }
  if (!Number.isFinite(weightLb) || weightLb <= 0) {
    return bad(res, 400, 'weight_lb must be a positive number');
  }

  const perPieceLb = weightLb / pieces;
  const parcels = Array.from({ length: pieces }, () => ({ weight_lbs: perPieceLb }));

  try {
    const shipment = await easypost.createShipment({
      from: {
        city: fromCity,
        state: fromProv,
        zip: b.from_postal || undefined,
        country: b.from_country || 'CA',
      },
      to: {
        city: toCity,
        state: toProv,
        zip: b.to_postal || undefined,
        country: b.to_country || 'CA',
      },
      parcels,
    });

    // Currency guard: the platform charges in CAD. A non-CAD EasyPost rate
    // must never be passed off as CAD (the customer would be under- or
    // over-charged). Drop non-CAD rates until real FX conversion exists.
    const rates = (shipment.rates || [])
      .filter((r) => String(r.currency || 'CAD').toUpperCase() === 'CAD')
      .map(toRate);
    const quoteId = id('epq');
    store.quotes.set(quoteId, {
      shipment_id: quoteId,
      easypost_shipment_id: shipment.id,
      origin: { city: fromCity, state: fromProv },
      destination: { city: toCity, state: toProv },
      rates,
      created_at: new Date().toISOString(),
    });

    // Count the rating against the monthly quota (atomic — a lost race is a
    // 402, so hard caps hold). Admins are never counted.
    if (rates.length && !(quotaState && quotaState.isAdmin)) {
      let counted = false;
      try {
        counted = await billing.tryIncrementQuota(req.user.id, quotaState ? quotaState.quotesLimit : null);
      } catch (err) {
        return bad(res, 503, 'Billing is unavailable right now — please try again.');
      }
      if (!counted) {
        return res.status(402).json({ error: 'Monthly quote limit reached.', upgrade_required: true });
      }
    }

    return res.json({
      configured: true,
      shipment_id: quoteId,
      easypost_shipment_id: shipment.id,
      rates,
    });
  } catch (err) {
    if (err.code === 'NOT_CONFIGURED') return notConfigured(res);
    return bad(res, 502, 'EasyPost rating failed', err.message);
  }
});

// ---------------------------------------------------------------------------
// POST /api/easypost/buy
// Body: shipment_id (the id returned by POST /rates), rate_id.
// Buys the label, returns the label URL (PDF) and tracking code.
// The purchase is persisted to the orders table when a database is
// configured, and always kept in the in-memory order log.
// ---------------------------------------------------------------------------
router.post('/buy', async (req, res) => {
  if (!req.user) return bad(res, 401, 'Sign in required.');
  if (!(await userCanShip(req.user.id))) return bad(res, 403, 'Shipping approval required.');
  if (!easypost.isEnabled()) return notConfigured(res);

  const { shipment_id, rate_id } = req.body || {};
  if (!shipment_id || !rate_id) {
    return bad(res, 400, 'shipment_id and rate_id are required');
  }

  const quote = store.quotes.get(shipment_id);
  if (!quote || !quote.easypost_shipment_id) {
    return bad(res, 404, 'Unknown shipment_id — request fresh rates first');
  }
  const rate = (quote.rates || []).find((r) => r.rate_id === rate_id);
  if (!rate) {
    return bad(res, 404, 'Unknown rate_id for this shipment');
  }
  if ((quote.packages || []).some((p) => p && p.dg)) {
    return bad(res, 403, 'Dangerous-goods shipments require admin review before purchase.');
  }

  try {
    const bought = await easypost.buyLabel(quote.easypost_shipment_id, rate_id);

    const order = {
      id: id('ord'),
      shipment_id,
      easypost_shipment_id: quote.easypost_shipment_id,
      rate_id,
      carrier: bought.carrier || rate.carrier,
      service: bought.service || rate.service,
      tracking_code: bought.tracking_code,
      label_url: (bought.postage_label && bought.postage_label.label_url) || null,
      cost_cad: rate.cost_cad,
      charged_amount: rate.retail_cad,
      status: 'purchased',
      created_at: new Date().toISOString(),
    };
    store.orders.push(order);
    console.log('[easypost/buy] label purchased', {
      order_id: order.id,
      carrier: order.carrier,
      tracking_code: order.tracking_code,
      charged_amount: order.charged_amount,
    });

    if (db.isEnabled()) {
      try {
        await db.query(
          `INSERT INTO orders (easypost_shipment_id, easypost_rate_id, tracking_code,
                               carrier, service_level, cost_amount, charged_amount,
                               currency, label_url, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [order.easypost_shipment_id, order.rate_id, order.tracking_code,
           order.carrier, order.service, order.cost_cad, order.charged_amount,
           'CAD', order.label_url, order.status]
        );
      } catch (err) {
        console.error('[easypost/buy] order DB insert failed (non-fatal):', err.message);
      }
    }

    return res.json({
      configured: true,
      order_id: order.id,
      shipment_id,
      rate_id,
      carrier: order.carrier,
      service: order.service,
      tracking_code: order.tracking_code,
      label_url: order.label_url,
      charged_amount: order.charged_amount,
      status: order.status,
    });
  } catch (err) {
    if (err.code === 'NOT_CONFIGURED') return notConfigured(res);
    return bad(res, 502, 'EasyPost label purchase failed', err.message);
  }
});

// ---------------------------------------------------------------------------
// GET /api/easypost/track/:code[?carrier=]
// Creates (or refreshes) an EasyPost tracker and returns live status/events.
// ---------------------------------------------------------------------------
router.get('/track/:code', async (req, res) => {
  if (!easypost.isEnabled()) return notConfigured(res);

  const { code } = req.params;
  const carrier = req.query.carrier || undefined;
  if (!code) return bad(res, 400, 'tracking code is required');

  try {
    const tracker = await easypost.getTracking(code, carrier);
    const events = (tracker.tracking_details || []).map((d) => {
      const loc = d.tracking_location || {};
      return {
        status: d.status,
        message: d.message,
        datetime: d.datetime,
        location: [loc.city, loc.state, loc.country].filter(Boolean).join(', ') || null,
      };
    });
    return res.json({
      configured: true,
      tracking_code: code,
      carrier: tracker.carrier || carrier || null,
      status: tracker.status,
      est_delivery_date: tracker.est_delivery_date || null,
      events,
    });
  } catch (err) {
    if (err.code === 'NOT_CONFIGURED') return notConfigured(res);
    return bad(res, 502, 'EasyPost tracking lookup failed', err.message);
  }
});

module.exports = router;

// buyEasypostLabel(epShipmentId, rateId): shared label-purchase helper used by
// POST /api/shipments/complete so matrix and live rates complete through one
// code path. Throws on EasyPost errors (err.code === 'NOT_CONFIGURED' when
// the key is missing).
module.exports.buyEasypostLabel = async function buyEasypostLabel(epShipmentId, rateId) {
  return easypost.buyLabel(epShipmentId, rateId);
};
