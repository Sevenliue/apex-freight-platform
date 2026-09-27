// routes/rates.js — POST /api/rates
// Quotes a shipment from the carrier rate matrix (ALWAYS included) and,
// when EASYPOST_API_KEY is set, from EasyPost parcel carriers (appended).
// NOTE: parcel.weight is treated as POUNDS (lbs).
'use strict';

const express = require('express');
const config = require('../config');
const db = require('../db');
const matrix = require('../lib/matrix');
const easypost = require('../lib/easypost');
const { store, id } = require('../lib/store');
const { round2, applyMarkup } = require('../lib/money');

const router = express.Router();

function bad(res, code, error, detail) {
  return res.status(code).json(detail ? { error, detail } : { error });
}

router.post('/', async (req, res) => {
  const { origin = {}, destination = {}, parcel = {}, user_id = null } = req.body || {};

  if (!origin.city || !origin.state || !destination.city || !destination.state) {
    return bad(res, 400, 'origin.city/state and destination.city/state are required');
  }
  const weightLbs = Number(parcel.weight);
  if (!Number.isFinite(weightLbs) || weightLbs <= 0) {
    return bad(res, 400, 'parcel.weight (lbs) must be a positive number');
  }

  const shipment_id = id('q');

  let matrixQuotes;
  try {
    matrixQuotes = matrix.quoteMatrix({
      originCity: origin.city,
      originProv: origin.state,
      destCity: destination.city,
      destProv: destination.state,
      weightLbs,
    });
  } catch (err) {
    return bad(res, 502, 'Rate matrix failed', err.message);
  }

  const rates = (matrixQuotes || []).map((q, i) => ({
    rate_id: `matrix_${q.carrier_id}_${i}`,
    carrier: q.carrier_label,
    service: q.service,
    cost_cad: round2(q.total_cad),
    retail_cad: applyMarkup(q.total_cad, config.markupPercent),
    currency: 'CAD',
    fsc_percent: q.fsc_percent,
    delivery_days: 'varies',
    source: 'matrix',
    // Matrix transparency detail:
    weight_lbs: q.weight_lbs,
    rate_cwt_used: q.rate_cwt_used,
    base_cad: round2(q.base_cad),
    fsc_cad: round2(q.fsc_cad),
    min_charge_applied: !!q.min_charge_applied,
  }));

  // Keep the quote in memory so /api/shipments/buy can resolve rate_id.
  store.quotes.set(shipment_id, {
    shipment_id,
    origin,
    destination,
    parcel,
    user_id,
    rates,
    easypost_shipment_id: null,
    created_at: new Date().toISOString(),
  });

  const warnings = [];

  // EasyPost parcel rates (optional). Uses the fetch-based wrapper in
  // lib/easypost.js; nothing is charged for rating.
  if (easypost.isEnabled()) {
    try {
      const shipment = await easypost.createShipment({
        to: {
          street1: destination.street1,
          city: destination.city,
          state: destination.state,
          zip: destination.zip,
          country: destination.country || 'CA',
        },
        from: {
          street1: origin.street1,
          city: origin.city,
          state: origin.state,
          zip: origin.zip,
          country: origin.country || 'CA',
        },
        // EasyPost expects parcel weight in ounces (converted in the wrapper).
        parcels: [
          {
            weight_lbs: weightLbs,
            length: parcel.length,
            width: parcel.width,
            height: parcel.height,
          },
        ],
      });
      store.quotes.get(shipment_id).easypost_shipment_id = shipment.id;
      for (const r of shipment.rates || []) {
        const cost = Number(r.rate);
        rates.push({
          rate_id: r.id,
          carrier: r.carrier,
          service: r.service,
          cost_cad: round2(cost),
          retail_cad: applyMarkup(cost, config.markupPercent),
          currency: r.currency || 'CAD',
          delivery_days: r.delivery_days != null ? String(r.delivery_days) : 'varies',
          est_delivery_date: r.est_delivery_date || null,
          source: 'easypost',
        });
      }
    } catch (err) {
      warnings.push(`easypost_unavailable: ${err.message}`);
    }
  }

  // Persist the quote when a database is configured (non-fatal).
  let db_quote_id = null;
  if (db.isEnabled()) {
    try {
      const userUuid = user_id ? await db.ensureUser(user_id, 'shipper') : null;
      const r = await db.query(
        `INSERT INTO quotes (user_id, origin_city, origin_state, origin_zip,
                             dest_city, dest_state, dest_zip,
                             parcel_weight, parcel_length, parcel_width, parcel_height)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id`,
        [userUuid, origin.city, origin.state, origin.zip || null,
         destination.city, destination.state, destination.zip || null,
         weightLbs, parcel.length || null, parcel.width || null, parcel.height || null]
      );
      db_quote_id = r.rows[0] && r.rows[0].id;
    } catch (err) {
      warnings.push(`db_quote_not_saved: ${err.message}`);
    }
  }

  // Typo help: when nothing matched, suggest the closest known city spelling.
  const suggestions = [];
  if (!rates.length && typeof matrix.suggestCity === 'function') {
    for (const [field, place] of [['origin', origin], ['destination', destination]]) {
      const s = matrix.suggestCity(place.city, place.state);
      if (s) suggestions.push({ field, suggestion: s });
    }
  }

  const body = { shipment_id, rates };
  if (db_quote_id != null) body.db_quote_id = db_quote_id;
  if (warnings.length) body.warnings = warnings;
  if (suggestions.length) body.suggestions = suggestions;
  return res.json(body);
});

module.exports = router;
