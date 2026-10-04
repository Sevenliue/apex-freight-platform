// lib/rate-upload.js — carrier self-serve rate-sheet template + validation.
//
// Carriers upload their tariff as CSV in the ShipRate template format (we do
// NOT try to parse arbitrary carrier layouts — every carrier formats
// differently). Uploads are validated here, stored pending, and only go live
// after Seven approves them in Admin.
'use strict';

const TOP_BREAK = 999999;

// Template columns: origin/dest, minimum charge, then CWT rates per weight
// break. Break i covers (prev_max_lb, max_lb].
const TEMPLATE_COLUMNS = [
  'origin_city',
  'origin_prov',
  'dest_city',
  'dest_prov',
  'min_charge_cad',
  'rate_lt500_cwt',
  'rate_500_cwt',
  'rate_1000_cwt',
  'rate_2000_cwt',
  'rate_5000_cwt',
  'rate_10000_cwt',
  'rate_20000_cwt',
];

const BREAK_MAP = [
  ['rate_lt500_cwt', 499],
  ['rate_500_cwt', 999],
  ['rate_1000_cwt', 1999],
  ['rate_2000_cwt', 4999],
  ['rate_5000_cwt', 9999],
  ['rate_10000_cwt', 19999],
  ['rate_20000_cwt', TOP_BREAK],
];

const MAX_LANES = 20000;
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

// Minimal CSV parser (handles quoted fields, no external deps).
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

function generateTemplate() {
  const header = TEMPLATE_COLUMNS.join(',');
  const ex1 = ['Calgary', 'AB', 'Edmonton', 'AB', '85.00', '18.50', '15.20', '12.80', '10.40', '8.90', '7.60', '6.90'].join(',');
  const ex2 = ['Edmonton', 'AB', 'Vancouver', 'BC', '120.00', '24.10', '19.80', '16.50', '13.20', '11.00', '9.40', '8.20'].join(',');
  return header + '\n' + ex1 + '\n' + ex2 + '\n';
}

// "Midland Transport Ltd." -> "midland-transport-ltd"
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'carrier';
}

const num = (v) => {
  if (v == null) return null;
  const n = parseFloat(String(v).trim().replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// Validate a template CSV. Returns { ok, errors[], warnings[], lanes[] }.
// lanes are in engine shape: {origin_city, origin_prov, dest_city, dest_prov,
// min_charge_cad, breaks:[{max_lb, rate_cwt}]}. Any row error rejects the
// whole file so the carrier fixes and re-uploads a clean sheet.
function validateUpload(csvText) {
  const errors = [];
  const warnings = [];
  const lanes = [];
  if (typeof csvText !== 'string' || !csvText.trim()) {
    return { ok: false, errors: ['The file is empty.'], warnings, lanes };
  }
  if (Buffer.byteLength(csvText, 'utf8') > MAX_BYTES) {
    return { ok: false, errors: ['The file is over 5 MB — please split it and upload in parts.'], warnings, lanes };
  }
  const rows = parseCSV(csvText);
  if (rows.length < 2) {
    return { ok: false, errors: ['No data rows found. Download the template and fill in one row per lane.'], warnings, lanes };
  }
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const missing = TEMPLATE_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) {
    return { ok: false, errors: [`Missing columns: ${missing.join(', ')}. Please use the template as-is.`], warnings, lanes };
  }
  const idx = Object.fromEntries(TEMPLATE_COLUMNS.map((c) => [c, header.indexOf(c)]));
  const seen = new Set();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const line = r + 1;
    const get = (c) => (row[idx[c]] == null ? '' : String(row[idx[c]]).trim());
    const oCity = get('origin_city').toUpperCase();
    const oProv = get('origin_prov').toUpperCase();
    const dCity = get('dest_city').toUpperCase();
    const dProv = get('dest_prov').toUpperCase();
    if (!oCity || !dCity) { errors.push(`Row ${line}: origin_city and dest_city are required.`); continue; }
    const minCharge = num(get('min_charge_cad'));
    if (minCharge == null || minCharge < 0) { errors.push(`Row ${line}: min_charge_cad must be 0 or more.`); continue; }

    const breaks = [];
    let bad = false;
    for (const [col, maxLb] of BREAK_MAP) {
      const rate = num(get(col));
      if (rate == null || rate <= 0) {
        errors.push(`Row ${line}: ${col} must be a number above 0 (got "${get(col)}").`);
        bad = true;
        break;
      }
      breaks.push({ max_lb: maxLb, rate_cwt: Math.round(rate * 100) / 100 });
    }
    if (bad) continue;

    // Warning: rates should generally fall as weight rises.
    for (let i = 1; i < breaks.length; i++) {
      if (breaks[i].rate_cwt > breaks[i - 1].rate_cwt) {
        warnings.push(`Row ${line}: rate rises with weight at ${BREAK_MAP[i][0]} — please check.`);
        break;
      }
    }
    const key = `${oCity}|${oProv}|${dCity}|${dProv}`;
    if (seen.has(key)) warnings.push(`Row ${line}: duplicate lane ${oCity} ${oProv} → ${dCity} ${dProv} — last one wins.`);
    seen.add(key);

    lanes.push({
      origin_city: oCity, origin_prov: oProv,
      dest_city: dCity, dest_prov: dProv,
      min_charge_cad: Math.round(minCharge * 100) / 100,
      breaks,
    });
    if (lanes.length > MAX_LANES) {
      return { ok: false, errors: [`More than ${MAX_LANES.toLocaleString()} lanes — please split into smaller files.`], warnings, lanes: [] };
    }
  }

  if (!lanes.length && !errors.length) errors.push('No valid lanes found.');
  return { ok: errors.length === 0 && lanes.length > 0, errors, warnings, lanes };
}

module.exports = { TEMPLATE_COLUMNS, BREAK_MAP, MAX_LANES, generateTemplate, parseCSV, slugify, validateUpload };
