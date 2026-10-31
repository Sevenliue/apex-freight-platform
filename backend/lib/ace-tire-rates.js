// lib/ace-tire-rates.js — ACE Courier Total Tire tire rates (portal own-rate).
//
// Source: Ace_Rate_sheet_for_Total_Tire_Tire_rates_Oct_30_2026.xlsx, LEFT
// copy (Seven-confirmed Oct 30 2026; the file's right copy still carries
// the old 2000 values on 8 rows and is ignored). Data file holds the 249
// Kelowna-area destination rows: min / ltl ($/cwt) / 2000 ($/cwt) /
// trailer load 44800 (flat, blank = price on request for trailer).
//
// Rating rules (Seven, Oct 30 2026):
// - Origins: Kelowna, West Kelowna, Lake Country (same table from each).
// - Both ways: origin-area ↔ table town prices from the same row.
// - Min is a FLOOR, not a band: price = max(min, weight x rate). A fixed
//   300 lb cutoff was rejected: at 350 lb the LTL price falls below the
//   min on every checked lane, and the crossover varies by lane.
// - LTL $/cwt below 2,000 lb; 2000-rate $/cwt at/above 2,000 lb.
// - Trailer threshold = trailer flat / 2000-rate (cwt x 100 = lb). At the
//   threshold the CWT price exactly equals the flat, so no price jump;
//   at/above it the flat applies. Blank trailer = CWT only.
// - FSC added on top: 53.9% LTL, 68.9% trailer (rep, Oct 30 2026); admin
//   carrier_fsc overrides win per component when present.
// - Actual weight only (dim ignored for v1 — Seven authorized ignore;
//   the rep's "cube out" remark needs a divisor before dim can be coded).
// - Board comparison is PRE-TAX (freight + fuel); GST added at booking
//   like every other row.
// - Table town names carry day notes ("ALERT BAY (THURS)") and combined
//   names ("PORT HARDY/MCNEILL"); lookup strips parentheticals and splits
//   "A/B" into aliases, first-wins, never overwriting an exact row.
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'ace-tire-data.json');
const FSC_LTL_DEFAULT = 0.539;
const FSC_TRAILER_DEFAULT = 0.689;

const round2 = (n) => Math.round(n * 100) / 100;
const norm = (s) => String(s || '').trim().toUpperCase();

let lookup = null;
function loadLookup() {
  if (lookup) return lookup;
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const map = new Map();
  for (const [raw, row] of Object.entries(data.lanes)) {
    const base = norm(raw).replace(/\s*\([^)]*\)\s*$/, '');
    const names = base.split('/').map((x) => x.trim()).filter(Boolean);
    for (const name of names) {
      if (!map.has(name)) map.set(name, row);
    }
  }
  lookup = { map, origins: new Set(data.origins.map(norm)) };
  return lookup;
}

// Returns { freight, fuel, total, rateBasis, fscPercent } (pre-tax) or
// { rate_on_request: true, reason }.
function aceTireQuote({ originCity, destCity, weightLbs, fscLtlPct, fscTrailerPct }) {
  const { map, origins } = loadLookup();
  const o = norm(originCity);
  const d = norm(destCity);
  const w = Number(weightLbs);
  if (!(w > 0)) return { rate_on_request: true, reason: 'weight must be positive' };
  let row = null;
  if (origins.has(o) && map.has(d)) row = map.get(d);
  else if (origins.has(d) && map.has(o)) row = map.get(o);
  if (!row) return { rate_on_request: true, reason: 'lane outside ACE Total Tire table' };
  const ltlPct = (typeof fscLtlPct === 'number' && fscLtlPct >= 0) ? fscLtlPct : FSC_LTL_DEFAULT;
  const trPct = (typeof fscTrailerPct === 'number' && fscTrailerPct >= 0) ? fscTrailerPct : FSC_TRAILER_DEFAULT;
  let freight;
  let pct;
  let basis;
  if (row.trailer != null && row.rate2000 > 0) {
    const thresholdLb = (row.trailer / row.rate2000) * 100;
    if (w >= thresholdLb) {
      freight = row.trailer;
      pct = trPct;
      basis = 'trailer';
    }
  }
  if (freight === undefined) {
    const rate = w < 2000 ? row.ltl : row.rate2000;
    freight = Math.max(row.min, (w / 100) * rate);
    pct = ltlPct;
    basis = 'cwt';
  }
  freight = round2(freight);
  const fuel = round2(freight * pct);
  return { freight, fuel, total: round2(freight + fuel), rateBasis: basis, fscPercent: pct };
}

module.exports = { aceTireQuote, FSC_LTL_DEFAULT, FSC_TRAILER_DEFAULT };
