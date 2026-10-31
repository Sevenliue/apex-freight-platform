// lib/ace-tariff-rates.js — ACE Courier General Freight Tariff (PUBLIC rate).
//
// Source: A.C.E. Courier Services (division of All-Can Express Ltd.),
// "Okanagan–Shuswap General Freight Tariff", effective March 1, 2024.
// Data file backend/lib/ace-tariff-data.json is a byte-identical copy of
// ~/workspace/tools/ace/tariff-data.json (the transcription audit source:
// 17 gateway origins x 91 destinations, 21 BC RATES brackets, 176
// additional points; 19 printed point asymmetries preserved as-is, never
// silently fixed — see the file's symmetryMismatches field).
//
// Rating rules (Seven, 2026-10-30: the tariff is the PUBLIC all-freight
// rate on both sites; the Excel sheet stays Total Tire only):
// - Origins: the 17 gateway towns only, BC. A quote FROM a non-gateway
//   town prices nothing on this path — the tariff prints gateway-origin
//   matrices only, and inbound-to-gateway rating is NOT invented in v1.
// - Point: origin row x destination column. Each direction uses its own
//   origin row (Golden->Kelowna point 9, Kelowna->Golden point 8).
// - Additional point: price = origin->gateway point price + the printed
//   +$ surcharge (tariff Step 1/Step 2: "shipping to Wynndel uses the
//   Creston rate"). 3 entries cannot price: Harrop (gateway Balfour)
//   and Mesachie Lake (gateway Lake Cowichan) have no matrix row for
//   their gateway; Blind Bay's gateway is a drop instruction, not a town.
// - Price: BC RATES FLAT bracket price for the weight bracket x point
//   (NOT per-cwt). 0–500 lb only; over 500 lb the tariff says call the
//   local office for skid rates -> no row in v1.
// - FSC 53.9% on top (rep, Oct 30 2026); admin carrier_fsc override for
//   'ace' (ltl column) wins when present. Pre-tax; GST at booking like
//   every other row. Actual weight only (no dim rule printed). No
//   service-day gating in v1 (day notes recorded in the data file only),
//   same as the ACE Excel shape.
// - Town matching: exact after normalization (uppercase, trim, strip
//   periods, collapse spaces); OK FALLS = OKANAGAN FALLS (same town:
//   gateway header vs destination label). No metro collapsing.
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'ace-tariff-data.json');
const FSC_LTL_DEFAULT = 0.539;

const round2 = (n) => Math.round(n * 100) / 100;
const norm = (s) => String(s || '').trim().toUpperCase().replace(/\./g, '').replace(/\s+/g, ' ');
// Alias: the origin row is keyed 'OK Falls' (gateway header) while the
// destination label is 'Okanagan Falls' — same town, one canonical key.
const ALIAS = { 'OK FALLS': 'OKANAGAN FALLS' };
const canon = (s) => ALIAS[norm(s)] || norm(s);

let lookup = null;
function loadLookup() {
  if (lookup) return lookup;
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const origins = new Map();
  for (const [originKey, row] of Object.entries(data.pointMatrix)) {
    const dests = new Map();
    for (const [destKey, point] of Object.entries(row)) dests.set(canon(destKey), { label: destKey, point });
    origins.set(canon(originKey), { label: originKey, dests });
  }
  const additional = new Map();
  for (const e of data.additionalPoints || []) {
    const key = canon(e.destination);
    if (!additional.has(key)) {
      additional.set(key, {
        label: e.destination,
        gateway: e.gateway ? canon(e.gateway) : null,
        gatewayLabel: e.gateway || null,
        surcharge: Number(e.surchargeCad) || 0,
      });
    }
  }
  lookup = { origins, additional, brackets: data.bcRates };
  return lookup;
}

// Returns an engine-shaped priced row, or null when the tariff prices
// nothing for this lane/weight (caller skips nulls).
function aceTariffQuote({ originCity, originProv, destCity, destProv, weightLbs, fscLtlPct }) {
  const { origins, additional, brackets } = loadLookup();
  const o = canon(originCity);
  const d = canon(destCity);
  const w = Number(weightLbs);
  if (!o || !d || !Number.isFinite(w) || w <= 0 || w > 500) return null;
  if (originProv && norm(originProv) !== 'BC') return null;
  if (destProv && norm(destProv) !== 'BC') return null;
  const origin = origins.get(o);
  if (!origin) return null;

  let point = null;
  let via = null;
  let surcharge = 0;
  const direct = origin.dests.get(d);
  if (direct) {
    if (direct.point == null) return null; // printed '*' = check with local office
    point = direct.point;
  } else {
    const add = additional.get(d);
    if (!add || !add.gateway) return null;
    const gw = origin.dests.get(add.gateway);
    if (!gw || gw.point == null) return null;
    point = gw.point;
    via = add.gatewayLabel;
    surcharge = add.surcharge;
  }

  const bracket = brackets.find((b) => w >= b.minLb && w <= b.maxLb);
  if (!bracket) return null;
  const price = bracket.pricesByPoint[String(point)];
  if (!Number.isFinite(price)) return null;

  const base = round2(price + surcharge);
  const fscPct = (typeof fscLtlPct === 'number' && fscLtlPct >= 0) ? fscLtlPct : FSC_LTL_DEFAULT;
  const fsc = round2(base * fscPct);
  return {
    carrier_id: 'ace',
    carrier_label: 'ACE Courier',
    service: 'LTL',
    weight_lbs: w,
    billable_weight_lbs: w,
    base_cad: base,
    fsc_percent: Math.round(fscPct * 10000) / 100,
    fsc_cad: fsc,
    total_cad: round2(base + fsc),
    min_charge_applied: false,
    currency: 'CAD',
    source: 'matrix',
    rate_basis: 'ace_tariff',
    lane_origin_city: origin.label,
    lane_origin_prov: 'BC',
    lane_dest_city: via || (direct && direct.label) || destCity,
    lane_dest_prov: 'BC',
    metro_matched: false,
    notes: via ? [`via ${via}${surcharge ? ` (+$${surcharge})` : ''}`] : [],
  };
}

module.exports = { aceTariffQuote };
