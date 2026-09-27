// lib/accessorials.js — pick-up / delivery service catalog and fee math.
//
// Fee basis notes (all CAD):
// - Flat fees for tailgate ($65), inside ($65), residential ($94.50),
//   limited-access/school/construction ($94.50), trade show ($94.50),
//   appointment ($47.25) and notify/call-before ($47.25) are taken from the
//   seeded Guilbault 2026 accessorial schedule (getAccessorials('guilbault')).
// - Protect From Freezing follows Guilbault's "protective service - heated"
//   basis: 10% of the freight charge.
// - Courier special handling ($40), flat deck / special equipment ($150),
//   Amazon FBA ($55) and signature required ($8) are platform defaults —
//   confirm against the carrier's tariff before production use.
// - Special Request is $0 here (quoted case-by-case).
// - Dangerous goods: auto-added per shipment when any package line is flagged
//   DG — $80.20 (1-20,000 lb) / $128.60 (20,001+ lb), Guilbault basis.
//
// Accessorial fees are added to the carrier freight cost BEFORE the platform
// markup is applied, so the board's "Est. Total Cost" is the shipper's
// sell price excluding tax.
'use strict';

const { round2 } = require('./money');

const CATALOG = [
  // ---- Pick-up services ----
  { code: 'tailgate_pickup', group: 'pickup', label: 'Power Tailgate Service At Pick-up', fee_cad: 65 },
  { code: 'residential_pickup', group: 'pickup', label: 'Residential Pick-up', fee_cad: 94.5 },
  { code: 'limited_access_pickup', group: 'pickup', label: 'School / Construction Site / Limited Access Pick-up', fee_cad: 94.5 },
  { code: 'inside_pickup', group: 'pickup', label: 'Inside Pick-up', fee_cad: 65 },
  { code: 'trade_show_pickup', group: 'pickup', label: 'Trade Show Pick-up', fee_cad: 94.5 },
  { code: 'freeze_protect', group: 'pickup', label: 'Protect From Freezing', pct_of_freight: 10 },
  { code: 'courier_special', group: 'pickup', label: "Courier 'Special' Handling", fee_cad: 40 },
  { code: 'flat_deck', group: 'pickup', label: 'Flat Deck / Special Equipment', fee_cad: 150 },
  // ---- Delivery services ----
  { code: 'tailgate_delivery', group: 'delivery', label: 'Power Tailgate Service At Delivery', fee_cad: 65 },
  { code: 'residential_delivery', group: 'delivery', label: 'Residential Delivery', fee_cad: 94.5 },
  { code: 'limited_access_delivery', group: 'delivery', label: 'Limited Access Delivery', fee_cad: 94.5 },
  { code: 'inside_delivery', group: 'delivery', label: 'Inside Delivery', fee_cad: 65 },
  { code: 'trade_show_delivery', group: 'delivery', label: 'Trade Show Delivery', fee_cad: 94.5 },
  { code: 'appointment_delivery', group: 'delivery', label: 'Carrier Booked Appointment Delivery', fee_cad: 47.25 },
  { code: 'notify_consignee', group: 'delivery', label: 'Notify Consignee', fee_cad: 47.25 },
  { code: 'amazon_fba', group: 'delivery', label: 'Amazon FBA Delivery', fee_cad: 55 },
  { code: 'signature_required', group: 'delivery', label: 'Courier Delivery Signature Required', fee_cad: 8 },
  { code: 'special_request', group: 'delivery', label: 'Special Request (Time Critical / Rural Del / Etc)', fee_cad: 0 },
];

const BY_CODE = new Map(CATALOG.map((a) => [a.code, a]));

function list() {
  return CATALOG.map((a) => ({ ...a }));
}

function isKnown(code) {
  return BY_CODE.has(code);
}

// feeFor(code, freightCost): CAD fee for one accessorial against a freight
// cost. Percent-based entries (freeze protection) scale with freight.
function feeFor(code, freightCost) {
  const a = BY_CODE.get(code);
  if (!a) return 0;
  if (a.pct_of_freight) return round2(Number(freightCost) * (a.pct_of_freight / 100));
  return round2(a.fee_cad || 0);
}

// applyAccessorials(codes, freightCost): dedupes codes, returns the applied
// line items and their total.
function applyAccessorials(codes, freightCost) {
  const seen = new Set();
  const applied = [];
  for (const code of codes || []) {
    if (!code || seen.has(code) || !BY_CODE.has(code)) continue;
    seen.add(code);
    const a = BY_CODE.get(code);
    applied.push({ code, label: a.label, group: a.group, fee_cad: feeFor(code, freightCost) });
  }
  const total_cad = round2(applied.reduce((s, x) => s + x.fee_cad, 0));
  return { applied, total_cad };
}

// dgFee(weightLbs): dangerous-goods surcharge per shipment (Guilbault basis).
function dgFee(weightLbs) {
  return Number(weightLbs) > 20000 ? 128.6 : 80.2;
}

// estimateTransit(originProv, destProv): simple planning estimate in the
// reference tool's style ("1 Day(s)"). NEVER guaranteed — the board labels it
// as an estimate.
function estimateTransit(originProv, destProv) {
  const o = String(originProv || '').trim().toUpperCase();
  const d = String(destProv || '').trim().toUpperCase();
  if (o && d && o === d) return '1-2 Day(s)';
  return '2-5 Day(s)';
}

module.exports = { list, isKnown, feeFor, applyAccessorials, dgFee, estimateTransit };
