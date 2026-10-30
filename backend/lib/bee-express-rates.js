// lib/bee-express-rates.js — Bee Express own-rate tables for Total Tire.
//
// Transcribed from Total_Tire_Acheson__Rate.pdf (Jan-25) and
// Total_Tire_Farm_Tire.pdf. Per-tire flat rates for the Acheson corridor,
// plus weight-band farm/implement rates. Board comparison is PRE-TAX
// (freight + fuel); GST is added at booking like every other row, so the
// PDF "Total" column (which includes GST) is NOT used here.
//
// Assumptions (flagged for Seven, 2026-10-29):
// - MT and Semi rates REPLACE the flat rate (PDF sections show standalone
//   per-tire amounts: 2 MT south = 2 x $9.68, not flat + surcharge).
// - Minimum charge of 2 tires applies: 1 tire bills as 2.
// - Penhold appears in both PDF town lists; assigned to SOUTH here.
// - Farm weight bands are PER TIRE (a farm tire weighs 150-1000 lb).
// - Fuel is 33% of freight (matches every PDF row to the cent except the
//   table-1 500-750 band, whose printed fuel $34.40 is stored exactly).
// - Corridor is picked from the destination town first, then the origin
//   town; direction does not change the flats.
'use strict';

const FUEL_PCT = 0.33;
const MIN_TIRES = 2;

const SOUTH_TOWNS = new Set([
  'EDMONTON', 'LEDUC', 'NISKU', 'CAMROSE', 'WETASKIWIN', 'PONOKA',
  'LACOMBE', 'BLACKFALDS', 'RED DEER', 'PENHOLD',
]);
const NORTH_TOWNS = new Set([
  'INNISFAIL', 'BOWDEN', 'OLDS', 'DIDSBURY', 'CARSTAIRS', 'CROSSFIELD',
  'AIRDRIE', 'CALGARY',
]);

// Per-tire freight (fuel added at 33% unless noted).
const FLATS = {
  south: { flat: 6.66, mt: 9.68, semi: 13.92 },
  north: { flat: 9.90, mt: 14.52, semi: 20.90 },
};

// Farm/implement weight bands: {maxLb, freight, fuel} exactly as printed.
// Table 1 = Acheson↔Red Deer / Calgary↔Red Deer (used for south corridor).
// Table 2 = Acheson south of Red Deer / Calgary north of Red Deer (north).
const FARM_BANDS = {
  south: [
    { maxLb: 250, freight: 53.67, fuel: 17.71 },
    { maxLb: 500, freight: 80.10, fuel: 26.43 },
    { maxLb: 750, freight: 104.51, fuel: 34.40 },
    { maxLb: 1000, freight: 128.98, fuel: 42.56 },
  ],
  north: [
    { maxLb: 250, freight: 61.39, fuel: 20.26 },
    { maxLb: 500, freight: 96.73, fuel: 31.92 },
    { maxLb: 750, freight: 123.73, fuel: 40.83 },
    { maxLb: 1000, freight: 150.73, fuel: 49.74 },
  ],
};

const round2 = (n) => Math.round(n * 100) / 100;
const norm = (s) => String(s || '').trim().toUpperCase();

function corridorFor(originCity, destCity) {
  const d = norm(destCity);
  const o = norm(originCity);
  if (SOUTH_TOWNS.has(d) || SOUTH_TOWNS.has(o)) return 'south';
  if (NORTH_TOWNS.has(d) || NORTH_TOWNS.has(o)) return 'north';
  return null;
}

// tires: { flat, mt, semi } counts; farmWeights: per-tire weights (lb).
// Returns { freight, fuel, total, detail } (pre-tax) or
// { rate_on_request: true, reason } when any input cannot be priced.
function beeExpressQuote({ originCity, destCity, flat = 0, mt = 0, semi = 0, farmWeights = [] }) {
  const corridor = corridorFor(originCity, destCity);
  if (!corridor) return { rate_on_request: true, reason: 'lane outside Bee Express Acheson corridor' };
  const rates = FLATS[corridor];
  const counts = { flat: Number(flat) || 0, mt: Number(mt) || 0, semi: Number(semi) || 0 };
  const totalTires = counts.flat + counts.mt + counts.semi;
  let freight = 0;
  const detail = [];
  if (totalTires > 0) {
    // Minimum charge of 2 tires: pad the flat count when under the minimum.
    let f = counts.flat;
    if (totalTires < MIN_TIRES) f += MIN_TIRES - totalTires;
    const parts = [
      ['flat', f, rates.flat],
      ['mt', counts.mt, rates.mt],
      ['semi', counts.semi, rates.semi],
    ];
    for (const [kind, qty, rate] of parts) {
      if (!qty) continue;
      freight += qty * rate;
      detail.push(`${qty} ${kind} @ $${rate.toFixed(2)}`);
    }
  }
  const bands = FARM_BANDS[corridor];
  for (const w of farmWeights) {
    const weight = Number(w);
    const band = bands.find((b) => weight >= 150 && weight <= b.maxLb);
    if (!band) return { rate_on_request: true, reason: `farm tire weight ${w} lb outside 150-1000 lb bands` };
    freight += band.freight;
    detail.push(`farm ${weight} lb @ $${band.freight.toFixed(2)}`);
  }
  if (freight <= 0) return { rate_on_request: true, reason: 'no priced tires' };
  freight = round2(freight);
  const fuel = round2(freight * FUEL_PCT);
  return { freight, fuel, total: round2(freight + fuel), detail: detail.join(', ') };
}

module.exports = {
  SOUTH_TOWNS: [...SOUTH_TOWNS],
  NORTH_TOWNS: [...NORTH_TOWNS],
  FLATS,
  FARM_BANDS,
  corridorFor,
  beeExpressQuote,
};
