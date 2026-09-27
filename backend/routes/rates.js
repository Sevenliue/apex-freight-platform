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
//   region (canada_usa|worldwide), direction (outbound|inbound|third_party),
//   freight_charges (prepaid|collect|third_party), bill_to {} — 3rd-party payer
//   user_id (optional)
// Worldwide skips the Canada-lane matrix and rates EasyPost-only; without an
// EasyPost key it answers 200 with worldwide_notice instead of crashing.
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
const { getExcludedNames } = require('./carriers');
const { round2, applyMarkup } = require('../lib/money');
const acc = require('../lib/accessorials');
const billingLib = require('../lib/billing');

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
  // Quoting requires a signed-in shipper account (no more guest quoting).
  if (!req.user) {
    return bad(res, 401, 'Sign in to get a quote — quoting needs an account.');
  }

  // Monthly quota: free 5 / starter 50 / pro unlimited per calendar month.
  let quotaState = null;
  try {
    const quota = await billingLib.checkQuota(req.user.id);
    quotaState = quota.state;
    if (!quota.allowed) {
      return res.status(402).json({
        error: quota.reason || 'Monthly quote limit reached.',
        upgrade_required: true,
        tier: quota.state && quota.state.tier,
        quotes_used: quota.state && quota.state.quotesUsed,
        quotes_limit: quota.state && quota.state.quotesLimit,
      });
    }
  } catch (err) {
    console.error('[rates] quota check failed:', err.message);
    return bad(res, 503, 'Billing is unavailable right now — please try again.');
  }

  const {
    origin = {},
    destination = {},
    parcel = {},
    packages: rawPackages = null,
    accessorials: rawAccessorials = [],
    shipper = {},
    consignee = {},
    user_id = null,
    region: rawRegion = 'canada_usa',
    direction: rawDirection = 'outbound',
    freight_charges: rawFreightCharges = 'prepaid',
    bill_to = {},
  } = req.body || {};

  // The logged-in account wins over the optional guest user_id label.
  // req.user.id is already a users uuid, so ensureUser passes it through.
  // Guests can no longer quote (401 above), but the label is kept for
  // backward compatibility with saved payloads.
  const effectiveUserId = (req.user && req.user.id) || user_id || null;

  // Shipment type + freight charges (parsed before validation: worldwide
  // addresses need city+country, not necessarily a state/province).
  const region = ['canada_usa', 'worldwide'].includes(rawRegion) ? rawRegion : 'canada_usa';
  const direction = ['outbound', 'inbound', 'third_party'].includes(rawDirection) ? rawDirection : 'outbound';
  const freight_charges = ['prepaid', 'collect', 'third_party'].includes(rawFreightCharges) ? rawFreightCharges : 'prepaid';

  if (region === 'worldwide') {
    if (!origin.city || !origin.country || !destination.city || !destination.country) {
      return bad(res, 400, 'origin.city/country and destination.city/country are required for worldwide quotes');
    }
  } else if (!origin.city || !origin.state || !destination.city || !destination.state) {
    return bad(res, 400, 'origin.city/state and destination.city/state are required');
  }
  const billTo = bill_to && typeof bill_to === 'object' ? {
    name: String(bill_to.name || '').slice(0, 120),
    street1: String(bill_to.street1 || bill_to.street || '').slice(0, 160),
    city: String(bill_to.city || '').slice(0, 80),
    state: String(bill_to.state || bill_to.province || '').slice(0, 40),
    zip: String(bill_to.zip || bill_to.postal || '').slice(0, 20),
    country: String(bill_to.country || 'CA').slice(0, 40),
  } : {};

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
  const worldwide = region === 'worldwide';

  // Worldwide: the matrix is Canada lanes only, so rating is EasyPost-only.
  if (worldwide && !easypost.isEnabled()) {
    const quoteRec = {
      shipment_id,
      origin, destination, shipper, consignee,
      packages, accessorials: accessorialCodes,
      region, direction, freight_charges, bill_to: billTo,
      parcel: { weight: totalWeightLbs },
      total_weight_lbs: totalWeightLbs,
      user_id: effectiveUserId,
      rates: [],
      easypost_shipment_id: null,
      created_at: new Date().toISOString(),
    };
    store.quotes.set(shipment_id, quoteRec);
    return res.json({
      shipment_id,
      rates: [],
      total_weight_lbs: totalWeightLbs,
      packages,
      region, direction, freight_charges, bill_to: billTo,
      worldwide_notice: true,
      message: 'Worldwide rates need live carrier connection — add your EasyPost key in Render (EASYPOST_API_KEY).',
    });
  }

  let matrixQuotes = [];
  if (!worldwide) {
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
  }

  // Carrier exclusions (from the Carriers tab): excluded carriers are
  // filtered out of the matrix-ranked board, case-insensitively.
  try {
    const excluded = await getExcludedNames();
    if (excluded.size) {
      matrixQuotes = matrixQuotes.filter(
        (q) => !excluded.has(String(q.carrier_label || '').toLowerCase())
      );
    }
  } catch (err) {
    console.error('[rates] exclusion filter failed (continuing):', err.message);
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
    region,
    direction,
    freight_charges,
    bill_to: billTo,
    parcel: { weight: totalWeightLbs },
    total_weight_lbs: totalWeightLbs,
    user_id: effectiveUserId,
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
      const userUuid = effectiveUserId ? await db.ensureUser(effectiveUserId, 'shipper') : null;
      const r = await db.query(
        `INSERT INTO quotes (user_id, origin_street1, origin_city, origin_state, origin_zip, origin_country,
                             dest_street1, dest_city, dest_state, dest_zip, dest_country,
                             parcel_weight, parcel_length, parcel_width, parcel_height,
                             shipper_json, consignee_json, packages_json, accessorials_json, rates_json,
                             region, direction, freight_charges, bill_to_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
         RETURNING id`,
        [
          userUuid,
          origin.street1 || null, origin.city, origin.state, origin.zip || null, origin.country || 'CA',
          destination.street1 || null, destination.city, destination.state, destination.zip || null, destination.country || 'CA',
          totalWeightLbs,
          packages[0].length, packages[0].width, packages[0].height,
          JSON.stringify(shipper || {}), JSON.stringify(consignee || {}),
          JSON.stringify(packages), JSON.stringify(accessorialCodes), JSON.stringify(rates),
          region, direction, freight_charges, JSON.stringify(billTo),
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
    region,
    direction,
    freight_charges,
    bill_to: billTo,
    accessorials_applied: rates[0] ? rates[0].accessorials_applied || [] : [],
  };
  if (db_quote_id != null) body.db_quote_id = db_quote_id;
  if (warnings.length) body.warnings = warnings;
  if (suggestions.length) body.suggestions = suggestions;
  // Count the quote against the monthly quota only when rates were produced.
  // Admins (owner/staff bypass) are never counted.
  if (rates.length && !(quotaState && quotaState.isAdmin)) {
    try {
      await billingLib.incrementQuota(req.user.id);
    } catch (err) {
      console.error('[rates] quota increment failed (non-fatal):', err.message);
    }
    if (quotaState) {
      body.quota = {
        tier: quotaState.tier,
        quotes_used: quotaState.quotesUsed + 1,
        quotes_limit: quotaState.quotesLimit, // null = unlimited
      };
    }
  }
  return res.json(body);
});

module.exports = router;
