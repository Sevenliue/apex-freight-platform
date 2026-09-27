// routes/rates.js — POST /api/rates
// Quotes a shipment from the carrier rate matrix (ALWAYS included) and,
// when EASYPOST_API_KEY is set, from EasyPost parcel carriers (appended).
//
// Body:
//   origin {street1, city, state, zip, country}, destination {...}
//   packages[] — {qty, package_type, product_name, weight_lb, length, width,
//                 height, stackable, dg, un_number, freight_class, pkg_group}
//     (legacy single `parcel` {weight, length, width, height} still works)
//   accessorials[] — catalog codes from lib/accessorials.js
//   shipper {}, consignee {} — carried through for Save/Complete
//   user_id (optional)
//
// Pricing: total package weight prices off the rate matrix (engine untouched).
// Accessorial fees (+ auto DG fee when any line is flagged DG) are added to
// the carrier freight cost BEFORE the platform markup, so retail is the
// shipper's sell price excluding tax. Rates are ranked cheapest-first.
'use strict';

const express = require('express');
const config = require('../config');
const db = require('../db');
const matrix = require('../lib/matrix');
const easypost = require('../lib/easypost');
const { store, id } = require('../lib/store');
const { round2, applyMarkup } = require('../lib/money');
const acc = require('../lib/accessorials');

const router = express.Router();

function bad(res, code, error, detail) {
  return res.status(code).json(detail ? { error, detail } : { error });
}

function num(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

// Normalize the package lines. Falls back to the legacy single parcel.
function normalizePackages(packages, parcel) {
  let list = Array.isArray(packages) && packages.length ? packages : null;
  if (!list) {
    list = [
      {
        qty: 1,
        package_type: 'Pallet',
        product_name: '',
        weight_lb: parcel.weight,
        length: parcel.length,
        width: parcel.width,
        height: parcel.height,
        stackable: false,
        dg: false,
      },
    ];
  }
  return list.map((p, i) => {
    const qty = Math.max(1, Math.floor(num(p.qty, 1)));
    const weight = num(p.weight_lb ?? p.weight, NaN);
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error(`packages[${i}].weight_lb must be a positive number`);
    }
    return {
      qty,
      package_type: String(p.package_type || 'Pallet').slice(0, 40),
      product_name: String(p.product_name || '').slice(0, 120),
      weight_lb: round2(weight),
      length: p.length != null && p.length !== '' ? round2(num(p.length)) : null,
      width: p.width != null && p.width !== '' ? round2(num(p.width)) : null,
      height: p.height != null && p.height !== '' ? round2(num(p.height)) : null,
      stackable: !!p.stackable,
      dg: !!p.dg,
      un_number: String(p.un_number || '').slice(0, 20),
      freight_class: String(p.freight_class || p.class || '').slice(0, 20),
      pkg_group: String(p.pkg_group || '').slice(0, 20),
    };
  });
}

// Expand package lines into EasyPost parcels (one parcel per handling unit),
// capped so a huge qty doesn't balloon the rating request.
function expandParcels(pkgs) {
  const units = [];
  for (const p of pkgs) {
    for (let i = 0; i < p.qty && units.length < 200; i++) {
      units.push({ weight_lbs: p.weight_lb, length: p.length, width: p.width, height: p.height });
    }
  }
  if (units.length <= 25) return units;
  // Aggregate into 25 parcels when the unit count is large.
  const totalW = units.reduce((s, u) => s + u.weight_lbs, 0);
  const first = units[0];
  return Array.from({ length: 25 }, () => ({
    weight_lbs: round2(totalW / 25),
    length: first.length,
    width: first.width,
    height: first.height,
  }));
}

router.post('/', async (req, res) => {
  const {
    origin = {},
    destination = {},
    parcel = {},
    packages: rawPackages = null,
    accessorials: rawAccessorials = [],
    shipper = {},
    consignee = {},
    user_id = null,
  } = req.body || {};

  if (!origin.city || !origin.state || !destination.city || !destination.state) {
    return bad(res, 400, 'origin.city/state and destination.city/state are required');
  }

  let packages;
  try {
    packages = normalizePackages(rawPackages, parcel);
  } catch (err) {
    return bad(res, 400, err.message);
  }
  const totalWeightLbs = round2(packages.reduce((s, p) => s + p.qty * p.weight_lb, 0));
  const accessorialCodes = (Array.isArray(rawAccessorials) ? rawAccessorials : [])
    .filter((c) => acc.isKnown(c));
  const hasDG = packages.some((p) => p.dg);

  const shipment_id = id('q');
  const transit = acc.estimateTransit(origin.state, destination.state);

  let matrixQuotes;
  try {
    matrixQuotes = matrix.quoteMatrix({
      originCity: origin.city,
      originProv: origin.state,
      destCity: destination.city,
      destProv: destination.state,
      weightLbs: totalWeightLbs,
    });
  } catch (err) {
    return bad(res, 502, 'Rate matrix failed', err.message);
  }

  // Price each matrix rate: freight + accessorials (+ DG) -> markup -> retail.
  const rates = (matrixQuotes || []).map((q, i) => {
    const freight = round2(q.total_cad);
    const accRes = acc.applyAccessorials(accessorialCodes, freight);
    const applied = accRes.applied.slice();
    let accTotal = accRes.total_cad;
    if (hasDG) {
      const dg = acc.dgFee(totalWeightLbs);
      applied.push({ code: 'dangerous_goods', label: 'Dangerous Goods', group: 'pickup', fee_cad: dg });
      accTotal = round2(accTotal + dg);
    }
    const cost = round2(freight + accTotal);
    return {
      rate_id: `matrix_${q.carrier_id}_${i}`,
      carrier: q.carrier_label,
      service: q.service,
      cost_cad: cost,
      retail_cad: applyMarkup(cost, config.markupPercent),
      currency: 'CAD',
      fsc_percent: q.fsc_percent,
      delivery_days: transit,
      transit_estimate: true,
      source: 'matrix',
      weight_lbs: totalWeightLbs,
      rate_cwt_used: q.rate_cwt_used,
      base_cad: round2(q.base_cad),
      fsc_cad: round2(q.fsc_cad),
      accessorials_applied: applied,
      accessorial_total_cad: accTotal,
      min_charge_applied: !!q.min_charge_applied,
    };
  });

  const quoteRec = {
    shipment_id,
    origin,
    destination,
    shipper,
    consignee,
    packages,
    accessorials: accessorialCodes,
    parcel: { weight: totalWeightLbs },
    total_weight_lbs: totalWeightLbs,
    user_id,
    rates,
    easypost_shipment_id: null,
    created_at: new Date().toISOString(),
  };
  store.quotes.set(shipment_id, quoteRec);

  const warnings = [];

  // EasyPost parcel rates (optional). Rating is free; nothing is charged.
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
        parcels: expandParcels(packages),
      });
      quoteRec.easypost_shipment_id = shipment.id;
      for (const r of shipment.rates || []) {
        const freight = round2(Number(r.rate));
        // Accessorials are LTL-style services; parcel rates carry the
        // freight cost only (documented simplification).
        rates.push({
          rate_id: r.id,
          carrier: r.carrier,
          service: r.service,
          cost_cad: freight,
          retail_cad: applyMarkup(freight, config.markupPercent),
          currency: r.currency || 'CAD',
          delivery_days: r.delivery_days != null ? String(r.delivery_days) : transit,
          transit_estimate: r.delivery_days == null,
          est_delivery_date: r.est_delivery_date || null,
          source: 'easypost',
          weight_lbs: totalWeightLbs,
        });
      }
    } catch (err) {
      warnings.push(`easypost_unavailable: ${err.message}`);
    }
  }

  // One ranked board: cheapest sell price first.
  rates.sort((a, b) => a.retail_cad - b.retail_cad);

  // Persist the quote when a database is configured (non-fatal).
  let db_quote_id = null;
  if (db.isEnabled()) {
    try {
      const userUuid = user_id ? await db.ensureUser(user_id, 'shipper') : null;
      const r = await db.query(
        `INSERT INTO quotes (user_id, origin_street1, origin_city, origin_state, origin_zip, origin_country,
                             dest_street1, dest_city, dest_state, dest_zip, dest_country,
                             parcel_weight, parcel_length, parcel_width, parcel_height,
                             shipper_json, consignee_json, packages_json, accessorials_json, rates_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         RETURNING id`,
        [
          userUuid,
          origin.street1 || null, origin.city, origin.state, origin.zip || null, origin.country || 'CA',
          destination.street1 || null, destination.city, destination.state, destination.zip || null, destination.country || 'CA',
          totalWeightLbs,
          packages[0].length, packages[0].width, packages[0].height,
          JSON.stringify(shipper || {}), JSON.stringify(consignee || {}),
          JSON.stringify(packages), JSON.stringify(accessorialCodes), JSON.stringify(rates),
        ]
      );
      db_quote_id = r.rows[0] && r.rows[0].id;
      quoteRec.db_quote_id = db_quote_id;
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

  const body = {
    shipment_id,
    rates,
    total_weight_lbs: totalWeightLbs,
    packages,
    accessorials_applied: rates[0] ? rates[0].accessorials_applied || [] : [],
  };
  if (db_quote_id != null) body.db_quote_id = db_quote_id;
  if (warnings.length) body.warnings = warnings;
  if (suggestions.length) body.suggestions = suggestions;
  return res.json(body);
});

module.exports = router;
