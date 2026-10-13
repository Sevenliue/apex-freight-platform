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
//   J&R Hall bills a flat $100 (see CARRIER_OVERRIDES).
//
// Per-carrier overrides (J&R Hall, Nov 1 2026 tariff / 2026 T&C): the quote
// form's accessorial codes are shared across carriers, but J&R Hall prices
// several differently. feeFor/applyAccessorials/dgFee take an optional
// carrierId and apply these instead of the catalog defaults.
//
// J&R Hall T&C charges NOT in the quote form (post-shipment, not selectable
// at quote time): waiting $90/hr (first 1 hr TL / first 1/2 hr LTL free),
// after-hours/weekend delivery $250 + waiting, additional drops/pick-ups
// $100 each, missed pick-up $150, same-day cancellation $50 LTL / $200 TL,
// border cross $25, trailer detention $50/day beyond scheduled delivery,
// storage $5/skid/day beyond scheduled delivery, blanket wrap +15% of
// line-haul (min $300), insurance $2/lb included + 2% on declared value
// over $2/lb. After-hours and blanket wrap are quote-time in principle but
// stay out: the shared catalog applies every selected code to ALL carriers,
// so adding them would misprice the other carriers.
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

// Per-carrier price overrides, keyed by carrier_id. An entry replaces the
// catalog fee (fee_cad), percent (pct_of_freight), or minimum (min_cad) for
// that carrier only. Other carriers keep the catalog defaults.
const CARRIER_OVERRIDES = {
  // J&R Hall Transport — Nov 1 2026 tariff + 2026 Terms & Conditions.
  jrhall: {
    tailgate_pickup: { fee_cad: 150 }, // T&C: $150 minimum
    tailgate_delivery: { fee_cad: 150 }, // T&C: $150 minimum
    appointment_delivery: { fee_cad: 100 }, // T&C: $100 each
    freeze_protect: { pct_of_freight: 15, min_cad: 300 }, // T&C: heated +15%, min $300
  },
};

function overrideFor(carrierId, code) {
  if (!carrierId) return null;
  const ov = CARRIER_OVERRIDES[String(carrierId).toLowerCase()];
  return (ov && ov[code]) || null;
}

function list() {
  return CATALOG.map((a) => ({ ...a }));
}

function isKnown(code) {
  return BY_CODE.has(code);
}

// feeFor(code, freightCost, carrierId?): CAD fee for one accessorial against
// a freight cost. Percent-based entries scale with freight; a per-carrier
// override may replace the fee, the percent, or add a minimum.
function feeFor(code, freightCost, carrierId) {
  const a = BY_CODE.get(code);
  if (!a) return 0;
  const ov = overrideFor(carrierId, code);
  const pct = ov && ov.pct_of_freight != null ? ov.pct_of_freight : a.pct_of_freight;
  const min = ov && ov.min_cad != null ? ov.min_cad : null;
  if (pct) {
    const fee = round2(Number(freightCost) * (pct / 100));
    return min != null ? Math.max(fee, min) : fee;
  }
  const flat = ov && ov.fee_cad != null ? ov.fee_cad : a.fee_cad;
  return round2(flat || 0);
}

// applyAccessorials(codes, freightCost, carrierId?): dedupes codes, returns
// the applied line items and their total.
function applyAccessorials(codes, freightCost, carrierId) {
  const seen = new Set();
  const applied = [];
  for (const code of codes || []) {
    if (!code || seen.has(code) || !BY_CODE.has(code)) continue;
    seen.add(code);
    const a = BY_CODE.get(code);
    applied.push({ code, label: a.label, group: a.group, fee_cad: feeFor(code, freightCost, carrierId) });
  }
  const total_cad = round2(applied.reduce((s, x) => s + x.fee_cad, 0));
  return { applied, total_cad };
}

// dgFee(weightLbs, carrierId?): dangerous-goods surcharge per shipment.
// Guilbault basis by default; J&R Hall bills a flat $100.
function dgFee(weightLbs, carrierId) {
  if (String(carrierId || '').toLowerCase() === 'jrhall') return 100;
  return Number(weightLbs) > 20000 ? 128.6 : 80.2;
}

// declaredValueSurcharge(carrierId, declaredValue, weightLbs): the carrier's
// own declared-value surcharge. J&R Hall includes $2/lb coverage; when the
// declared value works out over $2/lb, they charge 2% of the declared value
// (standard tariff reading of the 2026 T&C's compressed wording).
function declaredValueSurcharge(carrierId, declaredValue, weightLbs) {
  if (String(carrierId || '').toLowerCase() !== 'jrhall') return 0;
  const dv = Number(declaredValue) || 0;
  const w = Number(weightLbs) || 0;
  if (!(dv > 0) || !(w > 0)) return 0;
  if (dv / w <= 2) return 0;
  return round2(dv * 0.02);
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

module.exports = { list, isKnown, feeFor, applyAccessorials, dgFee, declaredValueSurcharge, estimateTransit };
