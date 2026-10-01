// build-matrix.js — one-off seed-data generator for matrix-data.json.
// Reads the carrier rate CSVs from ~/workspace/shiprate-freight/rate_tables/ (READ ONLY)
// and writes the normalized matrix-data.json consumed by matrix-engine.js.
// Usage: node build-matrix.js
// Zero dependencies, Node >= 18.
'use strict';

const fs = require('fs');
const path = require('path');

const TABLES_DIR = path.join(process.env.HOME, 'workspace/shiprate-freight/rate_tables');
const OUT_FILE = path.join(__dirname, 'matrix-data.json');

const TOP_BREAK = 999999; // open-ended top break sentinel

// ---------------------------------------------------------------------------
// Minimal CSV parser (handles quoted fields, no external deps).
// ---------------------------------------------------------------------------
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0].trim() !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const num = (v) => {
  const n = parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : null;
};

// Normalize "ACHESON AB" + empty prov -> city ACHESON, prov AB.
// Only splits when prov is empty, so real city names like "BOW VALLEY PROV PK" are untouched.
function splitCityProv(city, prov) {
  city = String(city).trim().toUpperCase();
  prov = String(prov).trim().toUpperCase();
  if (!prov && city) {
    const m = city.match(/^(.*?)\s+([A-Z]{2})$/);
    if (m) { city = m[1].trim(); prov = m[2]; }
  }
  return { city, prov };
}

// ---------------------------------------------------------------------------
// Per-carrier break column mappings: csv column -> max_lb (ascending).
// ---------------------------------------------------------------------------
const BREAK_MAPS = {
  hifab: [
    ['rate_l5c_cwt', 499],   // L5C = <500 lb
    ['rate_5c_cwt', 999],    // 5C
    ['rate_1m_cwt', 1999],   // 1M
    ['rate_2m_cwt', 4999],   // 2M
    ['rate_5m_cwt', 9999],   // 5M
    ['rate_10m_cwt', 19999], // 10M
    ['rate_20m_cwt', TOP_BREAK], // 20M (open-ended)
  ],
  guilbault: [
    ['rate_ltl_cwt', 499],   // LTL <500 lb
    ['rate_500_cwt', 999],
    ['rate_1000_cwt', 1999],
    ['rate_2000_cwt', 4999],
    ['rate_5000_cwt', 9999],
    ['rate_10000_cwt', 19999],
    ['rate_20000_cwt', TOP_BREAK], // 20,000+ lb
  ],
  rosenau: [
    ['rate_1_499_cwt', 499],
    ['rate_500_999_cwt', 999],
    ['rate_1000_1999_cwt', 1999],
    ['rate_2000_4999_cwt', 4999],
    ['rate_5000_9999_cwt', 9999],
    ['rate_10000_19999_cwt', 19999],
    ['rate_20000_29999_cwt', 29999],
    ['rate_30000_39999_cwt', 39999],
    ['rate_40000_49999_cwt', 49999],
    ['rate_50000_plus_cwt', TOP_BREAK], // 50,000+ lb
  ],
  jrhall: [
    ['rate_1000_cwt', 1999],   // 1000+ lb
    ['rate_2000_cwt', 4999],   // 2000+ lb
    ['rate_5000_cwt', 9999],   // 5000+ lb
    ['rate_10000_cwt', 19999], // 10,000+ lb
    ['rate_20000_cwt', TOP_BREAK], // 20,000+ lb (open-ended)
  ],
  jays: [
    ['rate_ltl_cwt', 499],     // LTL <500 lb
    ['rate_500_cwt', 999],
    ['rate_1000_cwt', 1999],
    ['rate_2000_cwt', 4999],
    ['rate_5000_cwt', 9999],
    ['rate_10000_cwt', 19999],
    ['rate_20000_cwt', TOP_BREAK], // 20,000+ lb
  ],
  willys: [
    ['rate_ltl_cwt', 499],     // L5C <500 lb
    ['rate_500_cwt', 999],     // 5C
    ['rate_1000_cwt', 1999],   // 1M
    ['rate_2000_cwt', 4999],   // 2M
    ['rate_5000_cwt', 9999],   // 5M
    ['rate_10000_cwt', 19999], // 10M
    ['rate_20000_cwt', TOP_BREAK], // sheet publishes no 20M break — 10M rate carried forward
  ],
};

const SOURCE_FILES = {
  hifab: 'hifab_2026_ltl.csv',
  guilbault: 'guilbault_2026_ltl.csv',
  rosenau: 'rosenau_2026_ltl.csv',
  jrhall: 'jrhall_2026_ltl.csv',
  jays: 'jays_2026_ltl.csv',
  willys: 'willys_2026_ltl.csv',
};

function buildLanes(carrierId) {
  const file = path.join(TABLES_DIR, SOURCE_FILES[carrierId]);
  const rows = parseCSV(fs.readFileSync(file, 'utf8'));
  const header = rows[0].map((h) => h.trim());
  const map = BREAK_MAPS[carrierId];
  const lanes = [];
  const skipped = [];
  const seen = new Set();
  let duplicates = 0;

  for (const r of rows.slice(1)) {
    const cell = (col) => r[header.indexOf(col)] ?? '';
    const { city: origin_city, prov: origin_prov } = splitCityProv(cell('origin_city'), cell('origin_prov'));
    const dest_city = String(cell('dest_city')).trim().toUpperCase();
    const dest_prov = String(cell('dest_prov')).trim().toUpperCase();
    const min_charge_cad = num(cell('min_charge_cad'));

    const breaks = [];
    let ok = min_charge_cad !== null && origin_city && dest_city;
    for (const [col, max_lb] of map) {
      const rate_cwt = num(cell(col));
      if (rate_cwt === null || rate_cwt <= 0) { ok = false; break; }
      breaks.push({ max_lb, rate_cwt });
    }
    if (!ok) {
      skipped.push(`${origin_city},${origin_prov} -> ${dest_city},${dest_prov}`);
      continue;
    }

    const lane = { carrier_id: carrierId, origin_city, origin_prov, dest_city, dest_prov, min_charge_cad, breaks };
    const svc = (carrierId === 'hifab' || carrierId === 'jrhall') ? num(cell('service_days')) : null;
    if (svc !== null) lane.service_days = svc;

    const key = [carrierId, origin_city, origin_prov, dest_city, dest_prov].join('|');
    if (seen.has(key)) { duplicates++; continue; } // keep first occurrence
    seen.add(key);
    lanes.push(lane);
  }
  return { lanes, skipped, duplicates };
}

function buildAccessorials() {
  const file = path.join(TABLES_DIR, 'guilbault_2026_accessorials.csv');
  const rows = parseCSV(fs.readFileSync(file, 'utf8'));
  const header = rows[0].map((h) => h.trim());
  const out = [];
  for (const r of rows.slice(1)) {
    const cell = (col) => (r[header.indexOf(col)] ?? '').trim();
    const code = cell('code');
    if (!code) continue;
    const amount_cad = cell('amount_cad') === '' ? null : num(cell('amount_cad'));
    const min_cad = cell('min_cad') === '' ? null : num(cell('min_cad'));
    out.push({
      carrier_id: 'guilbault',
      code,
      name: cell('name'),
      basis: cell('basis'),
      amount_cad,
      min_cad,
      conditions: cell('conditions'),
    });
  }
  return out;
}

function main() {
  const carriers = [
    { carrier_id: 'hifab', carrier_label: 'HiFab Transport', fsc_percent: 39, fsc_as_of: '2026-09', fsc_cadence: 'monthly', fsc_note: 'Update monthly.' },
    { carrier_id: 'guilbault', carrier_label: 'Guilbault Transport', fsc_percent: 41, fsc_as_of: '2026-09-25', fsc_cadence: 'per_sheet', fsc_note: 'FCA LTL % per rate sheet 17172 (effective 2026-04-01 to 2027-03-31).' },
    { carrier_id: 'rosenau', carrier_label: 'Rosenau Transport', fsc_percent: 65.74, fsc_as_of: '2026-09-25', fsc_cadence: 'per_sheet', fsc_note: 'Published LTL rate. TL override 105.44% applies at 10,000+ lb.' },
    { carrier_id: 'jrhall', carrier_label: 'J&R Hall Transport', fsc_percent: 0, fsc_as_of: '2026-10-01', fsc_cadence: 'weekly', fsc_note: 'FSC updated weekly on carrier site — set via Admin > Fuel surcharges. Tariff eff. 2026-11-01.' },
    { carrier_id: 'jays', carrier_label: "Jay's Transportation Group", fsc_percent: 0, fsc_as_of: '2026-10-01', fsc_cadence: 'monthly', fsc_note: 'FSC — set via Admin > Fuel surcharges. Rate sheets received 2026-10-01 (ship-from Saskatoon/Regina, intra-SK); VAS/off-route terms eff. 2025-11-15.' },
    { carrier_id: 'willys', carrier_label: "Willy's Trucking Service", fsc_percent: 0, fsc_as_of: '2026-10-01', fsc_cadence: 'monthly', fsc_note: 'FSC not on rate proposal — set via Admin > Fuel surcharges. Proposal eff. 2025-04-01 to 2027-09-30; Edmonton/Acheson origins; sheet publishes no 20,000+ lb break (10M rate carried forward).' },
  ];

  const lanes = [];
  const stats = {};
  for (const c of carriers) {
    const { lanes: ls, skipped, duplicates } = buildLanes(c.carrier_id);
    lanes.push(...ls);
    stats[c.carrier_id] = { lanes: ls.length, skipped: skipped.length, duplicates };
    if (skipped.length) console.log(`[${c.carrier_id}] skipped:`, skipped.join(' | '));
  }

  const accessorials = buildAccessorials();

  fs.writeFileSync(OUT_FILE, JSON.stringify({ carriers, lanes, accessorials }));
  console.log('wrote', OUT_FILE);
  for (const [id, s] of Object.entries(stats)) {
    console.log(`  ${id}: ${s.lanes} lanes (skipped ${s.skipped}, duplicates dropped ${s.duplicates})`);
  }
  console.log(`  accessorials: ${accessorials.length} (all guilbault)`);
  console.log(`  total lanes: ${lanes.length}`);
}

main();
