// lib/fsc-auto.js — Automated fuel surcharge updater.
//
// Pulls weekly diesel price indexes (US DOE, NRCan Canada) and maps them
// through each carrier's FSC table to compute the current surcharge.
//
// Carrier tables are configured in CARRIER_FSC_TABLES below. Each table maps
// diesel price ranges (per gallon USD for DOE, per litre CAD for NRCan) to
// an FSC percentage. Seven gets these tables from his carrier reps.
//
// Usage:
//   const { updateAllCarrierFsc } = require('./lib/fsc-auto');
//   await updateAllCarrierFsc(); // fetches indexes, updates DB overrides
'use strict';

const db = require('../db');
const matrix = require('./matrix');

// ---------------------------------------------------------------------------
// Carrier FSC tables.
//
// Format per carrier:
//   {
//     index: 'doe' | 'nrcan',   // which diesel price index to use
//     table: [                  // sorted by price ascending
//       { maxPrice: 3.50, fsc: 25.0 },  // diesel <= $3.50 → 25%
//       { maxPrice: 3.60, fsc: 26.0 },  // diesel <= $3.60 → 26%
//       ...
//     ],
//     tlTable: [...] (optional) // separate table for TL (10,000+ lb)
//   }
//
// Add tables here as carriers reply to Seven's email. Until a carrier has a
// table, their FSC stays manual (via Admin → Fuel Surcharges).
// ---------------------------------------------------------------------------
const CARRIER_FSC_TABLES = {
  // Example (DO NOT USE — replace with real carrier table):
  // jays: {
  //   index: 'doe',
  //   table: [
  //     { maxPrice: 3.50, fsc: 70.0 },
  //     { maxPrice: 3.60, fsc: 72.5 },
  //   ],
  // },
};

// ---------------------------------------------------------------------------
// Diesel price index fetchers.
// ---------------------------------------------------------------------------

// US DOE On-Highway Diesel Price (weekly, Monday ~4pm ET).
// Source: US Energy Information Administration.
// Returns USD per gallon, or null on failure.
async function fetchDoeDieselPrice() {
  try {
    // EIA v2 API requires a key. Without one, fall back to the weekly
    // retail page scrape. For now, return null — Seven can add EIA_API_KEY.
    const apiKey = process.env.EIA_API_KEY;
    if (!apiKey) {
      console.log('[fsc-auto] EIA_API_KEY not set, skipping DOE fetch');
      return null;
    }
    const url = `https://api.eia.gov/v2/petroleum/pri/gnd/data/?api_key=${apiKey}&frequency=weekly&data[0]=value&facets[duoarea][]=NUS&facets[product][]=EPD2DXL0&sort[0][column]=period&sort[0][direction]=desc&length=1`;
    const res = await fetch(url);
    const data = await res.json();
    const val = data?.response?.data?.[0]?.value;
    return val != null ? Number(val) : null;
  } catch (err) {
    console.error('[fsc-auto] DOE fetch failed:', err.message);
    return null;
  }
}

// NRCan Canadian Diesel Price (weekly national average).
// Source: Natural Resources Canada, weekly retail diesel prices.
// URL pattern: productID=5 (diesel), locationID=66 (Canada), frequency=W (weekly).
// Returns CAD per litre, or null on failure.
async function fetchNrcanDieselPrice() {
  try {
    const year = new Date().getFullYear();
    const url = `https://www2.nrcan.gc.ca/eneene/sources/pripri/prices_bycity_e.cfm?productID=5&locationID=66&frequency=W&priceYear=${year}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ShipRate/1.0 (fuel-surcharge-monitor)' },
    });
    if (!res.ok) {
      console.error('[fsc-auto] NRCan HTTP', res.status);
      return null;
    }
    const html = await res.text();
    // Table rows: <td>2026-10-06</td><td ...>261.4</td> ...
    // Grab all week-ending prices, take the last (most recent).
    const re = /(\d{4}-\d{2}-\d{2})<\/td>\s*<td[^>]*>([\d.]+)</g;
    let m, last = null;
    while ((m = re.exec(html)) !== null) {
      last = { week: m[1], cents: parseFloat(m[2]) };
    }
    if (!last || !Number.isFinite(last.cents)) {
      console.error('[fsc-auto] NRCan parse failed: no price rows found');
      return null;
    }
    const cadPerLitre = last.cents / 100;
    console.log(`[fsc-auto] NRCan diesel ${last.week}: ${cadPerLitre.toFixed(3)} CAD/L`);
    return cadPerLitre;
  } catch (err) {
    console.error('[fsc-auto] NRCan fetch failed:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// FSC table lookup.
// ---------------------------------------------------------------------------
function lookupFsc(table, dieselPrice) {
  if (!Array.isArray(table) || table.length === 0) return null;
  if (dieselPrice == null || !Number.isFinite(dieselPrice)) return null;
  for (const row of table) {
    if (dieselPrice <= row.maxPrice) return row.fsc;
  }
  // Above the highest bracket: use the last row's FSC.
  return table[table.length - 1].fsc;
}

// ---------------------------------------------------------------------------
// Main updater.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Grimshaw Trucking LP — direct FSC scrape (2026-10-13).
//
// Grimshaw is the first carrier with a PUBLIC FSC page: their News tab
// (https://www.grimshaw-trucking.com/news) publishes the current surcharge
// with its effective date, split LTL (<10,000 lb) / TL (10,000+ lb).
// No diesel-index table needed — read their numbers directly.
//
// fetchGrimshawFsc() returns { effective, fsc_ltl, fsc_tl } or null.
// updateGrimshawFsc() writes the values to carrier_fsc + the in-memory
// override, but ONLY when they differ from the stored override — the
// server runs this daily, so most runs are no-ops.
// Grimshaw has 60 Edmonton LTL lanes in matrix-data.json (TOTTIEDM02
// Rate ID 23863, eff. 2025-01-01 to 2026-12-31); the override applies to
// them the moment the server loads the matrix.
// ---------------------------------------------------------------------------
const GRIMSHAW_NEWS_URL = 'https://www.grimshaw-trucking.com/news';

function parseGrimshawFsc(html) {
  if (typeof html !== 'string' || !html) return null;
  // The page embeds JSON with \uXXXX escapes; decode them first.
  const decoded = html.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16)));
  const text = decoded
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ');
  // Anchor on "Current FSC" so the older "FSC Until ..." block below it
  // is never picked up.
  const anchor = text.indexOf('Current FSC');
  if (anchor < 0) return null;
  const seg = text.slice(anchor, anchor + 400);
  const eff = /Effective as of ([A-Za-z]+ \d+(?:st|nd|rd|th), \d{4})/.exec(seg);
  const ltl = /less than 10,000 lbs\s*=\s*([\d.]+)\s*%/.exec(seg);
  const tl = /10,000 lbs or more\s*=\s*([\d.]+)\s*%/.exec(seg);
  if (!eff || !ltl || !tl) return null;
  const fscLtl = Number(ltl[1]);
  const fscTl = Number(tl[1]);
  if (!Number.isFinite(fscLtl) || !Number.isFinite(fscTl)) return null;
  return { effective: eff[1], fsc_ltl: fscLtl, fsc_tl: fscTl };
}

async function fetchGrimshawFsc() {
  try {
    const res = await fetch(GRIMSHAW_NEWS_URL, {
      headers: { 'User-Agent': 'ShipRate/1.0 (fuel-surcharge-monitor)' },
    });
    if (!res.ok) {
      console.error('[fsc-auto] Grimshaw HTTP', res.status);
      return null;
    }
    const html = await res.text();
    const parsed = parseGrimshawFsc(html);
    if (!parsed) console.error('[fsc-auto] Grimshaw parse failed: current FSC block not found');
    return parsed;
  } catch (err) {
    console.error('[fsc-auto] Grimshaw fetch failed:', err.message);
    return null;
  }
}

async function updateGrimshawFsc() {
  if (!db.isEnabled()) {
    console.log('[fsc-auto] Grimshaw: DB not enabled, skipping');
    return { updated: false, reason: 'db-disabled' };
  }
  const fresh = await fetchGrimshawFsc();
  if (!fresh) return { updated: false, reason: 'fetch-parse-failed' };
  // Change-only: compare against the stored override, if any.
  try {
    const cur = await db.query(
      'SELECT fsc_ltl_percent, fsc_tl_percent FROM carrier_fsc WHERE carrier_id = $1',
      ['grimshaw']
    );
    const row = cur.rows[0];
    if (
      row &&
      Number(row.fsc_ltl_percent) === fresh.fsc_ltl &&
      Number(row.fsc_tl_percent) === fresh.fsc_tl
    ) {
      console.log(`[fsc-auto] Grimshaw: FSC unchanged (${fresh.fsc_ltl}% / ${fresh.fsc_tl}%, eff. ${fresh.effective})`);
      return { updated: false, reason: 'unchanged', ...fresh };
    }
  } catch (err) {
    console.error('[fsc-auto] Grimshaw current-value check failed (continuing):', err.message);
  }
  try {
    await db.query(
      `INSERT INTO carrier_fsc (carrier_id, fsc_ltl_percent, fsc_tl_percent, updated_at)
       VALUES ('grimshaw', $1, $2, now())
       ON CONFLICT (carrier_id) DO UPDATE SET
         fsc_ltl_percent = EXCLUDED.fsc_ltl_percent,
         fsc_tl_percent = EXCLUDED.fsc_tl_percent,
         updated_at = EXCLUDED.updated_at`,
      [fresh.fsc_ltl, fresh.fsc_tl]
    );
    if (typeof matrix.setFscOverride === 'function') {
      matrix.setFscOverride('grimshaw', {
        ltl: fresh.fsc_ltl,
        tl: fresh.fsc_tl,
        updated_at: new Date().toISOString(),
      });
    }
    console.log(`[fsc-auto] Grimshaw: FSC → ${fresh.fsc_ltl}% LTL / ${fresh.fsc_tl}% TL (eff. ${fresh.effective})`);
    return { updated: true, ...fresh };
  } catch (err) {
    console.error('[fsc-auto] Grimshaw update failed:', err.message);
    return { updated: false, reason: 'db-write-failed' };
  }
}

// ---------------------------------------------------------------------------
// Rockfall Freightways — direct FSC scrape (2026-10-14, Seven-approved
// weekly auto-pull).
//
// Rockfall publishes its current surcharge in a banner at the top of its
// homepage (https://www.rockfallfreightways.com/): "Current FSC Rate 18%
// Effective September 28th" — live page text in an <h2>, not an image.
// No year is stated on the page, so the parser returns the effective
// string as printed (e.g. "September 28th") without inventing one.
// Rockfall has no TL tier on its sheet, so only the LTL value is managed;
// any existing TL override is left untouched.
//
// fetchRockfallFsc() returns { effective, fsc_ltl, fsc_tl: null } or null.
// updateRockfallFsc() writes the LTL value to carrier_fsc + the in-memory
// override, but ONLY when it differs from the stored override — the
// server runs this weekly plus once at boot, so most runs are no-ops.
// ---------------------------------------------------------------------------
const ROCKFALL_HOME_URL = 'https://www.rockfallfreightways.com/';

function parseRockfallFsc(html) {
  if (typeof html !== 'string' || !html) return null;
  const decoded = html.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16)));
  const text = decoded
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ');
  const m = /Current FSC Rate\s*([\d.]+)\s*%\s*Effective\s+([A-Za-z]+\s+\d+(?:st|nd|rd|th))/.exec(text);
  if (!m) return null;
  const fscLtl = Number(m[1]);
  if (!Number.isFinite(fscLtl)) return null;
  return { effective: m[2], fsc_ltl: fscLtl, fsc_tl: null };
}

async function fetchRockfallFsc() {
  try {
    const res = await fetch(ROCKFALL_HOME_URL, {
      headers: { 'User-Agent': 'ShipRate/1.0 (fuel-surcharge-monitor)' },
    });
    if (!res.ok) {
      console.error('[fsc-auto] Rockfall HTTP', res.status);
      return null;
    }
    const html = await res.text();
    const parsed = parseRockfallFsc(html);
    if (!parsed) console.error('[fsc-auto] Rockfall parse failed: FSC banner not found');
    return parsed;
  } catch (err) {
    console.error('[fsc-auto] Rockfall fetch failed:', err.message);
    return null;
  }
}

async function updateRockfallFsc() {
  if (!db.isEnabled()) {
    console.log('[fsc-auto] Rockfall: DB not enabled, skipping');
    return { updated: false, reason: 'db-disabled' };
  }
  const fresh = await fetchRockfallFsc();
  if (!fresh) return { updated: false, reason: 'fetch-parse-failed' };
  // Change-only: compare against the stored LTL override, if any.
  // Rockfall has no TL tier — preserve whatever TL value is stored.
  let existingTl = null;
  try {
    const cur = await db.query(
      'SELECT fsc_ltl_percent, fsc_tl_percent FROM carrier_fsc WHERE carrier_id = $1',
      ['rockfall']
    );
    const row = cur.rows[0];
    if (row) {
      existingTl = row.fsc_tl_percent == null ? null : Number(row.fsc_tl_percent);
      if (Number(row.fsc_ltl_percent) === fresh.fsc_ltl) {
        console.log(`[fsc-auto] Rockfall: FSC unchanged (${fresh.fsc_ltl}%, eff. ${fresh.effective})`);
        return { updated: false, reason: 'unchanged', ...fresh };
      }
    }
  } catch (err) {
    console.error('[fsc-auto] Rockfall current-value check failed (continuing):', err.message);
  }
  try {
    await db.query(
      `INSERT INTO carrier_fsc (carrier_id, fsc_ltl_percent, fsc_tl_percent, updated_at)
       VALUES ('rockfall', $1, NULL, now())
       ON CONFLICT (carrier_id) DO UPDATE SET
         fsc_ltl_percent = EXCLUDED.fsc_ltl_percent,
         updated_at = EXCLUDED.updated_at`,
      [fresh.fsc_ltl]
    );
    if (typeof matrix.setFscOverride === 'function') {
      matrix.setFscOverride('rockfall', {
        ltl: fresh.fsc_ltl,
        tl: existingTl,
        updated_at: new Date().toISOString(),
      });
    }
    console.log(`[fsc-auto] Rockfall: FSC → ${fresh.fsc_ltl}% LTL (eff. ${fresh.effective})`);
    return { updated: true, ...fresh };
  } catch (err) {
    console.error('[fsc-auto] Rockfall update failed:', err.message);
    return { updated: false, reason: 'db-write-failed' };
  }
}

// ---------------------------------------------------------------------------
// Minimax GO Direct — direct FSC scrape (2026-10-23, per Seven's ruling
// that Minimax posts its FSC on its website with an auto-pull like
// Grimshaw/Rockfall).
//
// Minimax posts its current surcharge in a banner module on its homepage
// (https://minimaxexpress.com/): "Fuel Surcharge / October 26th to
// November 1st 2026 / LTL 45.7% TL 107.5%" — a dated weekly period with
// both class percents in live page text. (The Fees & Surcharges page and
// its Accessorial Charges PDF state the mechanism only — "Per FCA
// recommended fuel surcharge. TL rate applied over 10000lbs or 20 feet
// of trailer" — the numeric posting lives in the homepage banner;
// minimaxgodirect.com shows the same values in its own banner.)
// The banner posts the upcoming week's values in advance; the pull takes
// whatever period/values are currently posted.
//
// fetchMinimaxFsc() returns { effective, fsc_ltl, fsc_tl } or null.
// updateMinimaxFsc() writes the values to carrier_fsc ('minimax_ltl') +
// the in-memory override, but ONLY when they differ from the stored
// override — the server runs this daily plus once at boot, so most runs
// are no-ops.
// ---------------------------------------------------------------------------
const MINIMAX_HOME_URL = 'https://minimaxexpress.com/';

function parseMinimaxFsc(html) {
  if (typeof html !== 'string' || !html) return null;
  const decoded = html.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16)));
  const text = decoded
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ');
  const m = /Fuel Surcharge\s+([A-Za-z]+ \d+(?:st|nd|rd|th)\s+to\s+[A-Za-z]+ \d+(?:st|nd|rd|th)\s+\d{4})\s+LTL\s+([\d.]+)\s*%\s+TL\s+([\d.]+)\s*%/.exec(text);
  if (!m) return null;
  const fscLtl = Number(m[2]);
  const fscTl = Number(m[3]);
  if (!Number.isFinite(fscLtl) || !Number.isFinite(fscTl)) return null;
  return { effective: m[1], fsc_ltl: fscLtl, fsc_tl: fscTl };
}

async function fetchMinimaxFsc() {
  try {
    const res = await fetch(MINIMAX_HOME_URL, {
      headers: { 'User-Agent': 'ShipRate/1.0 (fuel-surcharge-monitor)' },
    });
    if (!res.ok) {
      console.error('[fsc-auto] Minimax HTTP', res.status);
      return null;
    }
    const html = await res.text();
    const parsed = parseMinimaxFsc(html);
    if (!parsed) console.error('[fsc-auto] Minimax parse failed: homepage FSC banner not found');
    return parsed;
  } catch (err) {
    console.error('[fsc-auto] Minimax fetch failed:', err.message);
    return null;
  }
}

async function updateMinimaxFsc() {
  if (!db.isEnabled()) {
    console.log('[fsc-auto] Minimax: DB not enabled, skipping');
    return { updated: false, reason: 'db-disabled' };
  }
  const fresh = await fetchMinimaxFsc();
  if (!fresh) return { updated: false, reason: 'fetch-parse-failed' };
  // Change-only: compare against the stored override, if any.
  try {
    const cur = await db.query(
      'SELECT fsc_ltl_percent, fsc_tl_percent FROM carrier_fsc WHERE carrier_id = $1',
      ['minimax_ltl']
    );
    const row = cur.rows[0];
    if (
      row &&
      Number(row.fsc_ltl_percent) === fresh.fsc_ltl &&
      Number(row.fsc_tl_percent) === fresh.fsc_tl
    ) {
      console.log(`[fsc-auto] Minimax: FSC unchanged (${fresh.fsc_ltl}% / ${fresh.fsc_tl}%, ${fresh.effective})`);
      return { updated: false, reason: 'unchanged', ...fresh };
    }
  } catch (err) {
    console.error('[fsc-auto] Minimax current-value check failed (continuing):', err.message);
  }
  try {
    await db.query(
      `INSERT INTO carrier_fsc (carrier_id, fsc_ltl_percent, fsc_tl_percent, updated_at)
       VALUES ('minimax_ltl', $1, $2, now())
       ON CONFLICT (carrier_id) DO UPDATE SET
         fsc_ltl_percent = EXCLUDED.fsc_ltl_percent,
         fsc_tl_percent = EXCLUDED.fsc_tl_percent,
         updated_at = EXCLUDED.updated_at`,
      [fresh.fsc_ltl, fresh.fsc_tl]
    );
    if (typeof matrix.setFscOverride === 'function') {
      matrix.setFscOverride('minimax_ltl', {
        ltl: fresh.fsc_ltl,
        tl: fresh.fsc_tl,
        updated_at: new Date().toISOString(),
      });
    }
    console.log(`[fsc-auto] Minimax: FSC → ${fresh.fsc_ltl}% LTL / ${fresh.fsc_tl}% TL (${fresh.effective})`);
    return { updated: true, ...fresh };
  } catch (err) {
    console.error('[fsc-auto] Minimax update failed:', err.message);
    return { updated: false, reason: 'db-write-failed' };
  }
}

// ---------------------------------------------------------------------------
// Groupe Morneau — direct FSC scrape (2026-10-26, Seven asked for auto-pull).
//
// Morneau publishes its current surcharge on its public fuel-surcharge page
// (https://www.groupemorneau.com/en/fuel-surcharge): a weekly table with
// an "Upcoming week" row (N/A until posted), a "Current week" row (date +
// LTL % + TL %), and "Previous weeks" rows. The parser anchors on
// "Current week" so the N/A upcoming row is never picked up.
//
// fetchMorneauFsc() returns { effective, fsc_ltl, fsc_tl } or null.
// updateMorneauFsc() writes the values to carrier_fsc ('morneau') + the
// in-memory override, but ONLY when they differ from the stored override —
// the server runs this weekly plus once at boot, so most runs are no-ops.
// ---------------------------------------------------------------------------
const MORNEAU_FSC_URL = 'https://www.groupemorneau.com/en/fuel-surcharge';

function parseMorneauFsc(html) {
  if (typeof html !== 'string' || !html) return null;
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ');
  // Anchor on "Current week" so the "Upcoming week" (N/A) row above it and
  // the "Previous weeks" rows below it are never picked up.
  const anchor = text.indexOf('Current week');
  if (anchor < 0) return null;
  const seg = text.slice(anchor, anchor + 200);
  const m = /Current week\s*,?\s*(\d{4}-\d{2}-\d{2})\s*,?\s*([\d.]+)\s*%\s*,?\s*([\d.]+)\s*%/.exec(seg);
  if (!m) return null;
  const fscLtl = Number(m[2]);
  const fscTl = Number(m[3]);
  if (!Number.isFinite(fscLtl) || !Number.isFinite(fscTl)) return null;
  if (fscLtl <= 0 || fscLtl >= 300 || fscTl <= 0 || fscTl >= 300) return null;
  return { effective: m[1], fsc_ltl: fscLtl, fsc_tl: fscTl };
}

async function fetchMorneauFsc() {
  try {
    const res = await fetch(MORNEAU_FSC_URL, {
      headers: { 'User-Agent': 'ShipRate/1.0 (fuel-surcharge-monitor)' },
    });
    if (!res.ok) {
      console.error('[fsc-auto] Morneau HTTP', res.status);
      return null;
    }
    const html = await res.text();
    const parsed = parseMorneauFsc(html);
    if (!parsed) console.error('[fsc-auto] Morneau parse failed: current-week row not found');
    return parsed;
  } catch (err) {
    console.error('[fsc-auto] Morneau fetch failed:', err.message);
    return null;
  }
}

async function updateMorneauFsc() {
  if (!db.isEnabled()) {
    console.log('[fsc-auto] Morneau: DB not enabled, skipping');
    return { updated: false, reason: 'db-disabled' };
  }
  const fresh = await fetchMorneauFsc();
  if (!fresh) return { updated: false, reason: 'fetch-parse-failed' };
  // Change-only: compare against the stored override, if any.
  try {
    const cur = await db.query(
      'SELECT fsc_ltl_percent, fsc_tl_percent FROM carrier_fsc WHERE carrier_id = $1',
      ['morneau']
    );
    const row = cur.rows[0];
    if (
      row &&
      Number(row.fsc_ltl_percent) === fresh.fsc_ltl &&
      Number(row.fsc_tl_percent) === fresh.fsc_tl
    ) {
      console.log(`[fsc-auto] Morneau: FSC unchanged (${fresh.fsc_ltl}% / ${fresh.fsc_tl}%, eff. ${fresh.effective})`);
      return { updated: false, reason: 'unchanged', ...fresh };
    }
  } catch (err) {
    console.error('[fsc-auto] Morneau current-value check failed (continuing):', err.message);
  }
  try {
    await db.query(
      `INSERT INTO carrier_fsc (carrier_id, fsc_ltl_percent, fsc_tl_percent, updated_at)
       VALUES ('morneau', $1, $2, now())
       ON CONFLICT (carrier_id) DO UPDATE SET
         fsc_ltl_percent = EXCLUDED.fsc_ltl_percent,
         fsc_tl_percent = EXCLUDED.fsc_tl_percent,
         updated_at = EXCLUDED.updated_at`,
      [fresh.fsc_ltl, fresh.fsc_tl]
    );
    if (typeof matrix.setFscOverride === 'function') {
      matrix.setFscOverride('morneau', {
        ltl: fresh.fsc_ltl,
        tl: fresh.fsc_tl,
        updated_at: new Date().toISOString(),
      });
    }
    console.log(`[fsc-auto] Morneau: FSC → ${fresh.fsc_ltl}% LTL / ${fresh.fsc_tl}% TL (eff. ${fresh.effective})`);
    return { updated: true, ...fresh };
  } catch (err) {
    console.error('[fsc-auto] Morneau update failed:', err.message);
    return { updated: false, reason: 'db-write-failed' };
  }
}

// Red River Messenger — direct FSC scrape (2026-10-28, Seven asked for
// auto-pull). Their fuel-surcharge page posts a single current % in the
// line "Our Present Fuel Surcharge as of October 16th, 2026 is 33%".
// The parser anchors on that line, so the historical percentages further
// down the page (2008–2012 narrative) are never picked up.
//
// fetchRedRiverFsc() returns { effective, fsc } or null.
// updateRedRiverFsc() writes the value to carrier_fsc ('redriver', both
// LTL and TL columns — the carrier charges one % for all services) + the
// in-memory override, but ONLY when it differs from the stored override —
// the server runs this weekly plus once at boot, so most runs are no-ops.
// ---------------------------------------------------------------------------
const REDRIVER_FSC_URL = 'https://redrivermessenger.com/fuel-surcharge/';

function parseRedRiverFsc(html) {
  if (typeof html !== 'string' || !html) return null;
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ');
  const m = /Present Fuel Surcharge as of\s+(.+?)\s+is\s+([\d.]+)\s*%/.exec(text);
  if (!m) return null;
  const pct = Number(m[2]);
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 300) return null;
  return { effective: m[1].trim(), fsc: pct };
}

async function fetchRedRiverFsc() {
  try {
    const res = await fetch(REDRIVER_FSC_URL, {
      headers: { 'User-Agent': 'ShipRate/1.0 (fuel-surcharge-monitor)' },
    });
    if (!res.ok) {
      console.error('[fsc-auto] Red River HTTP', res.status);
      return null;
    }
    const html = await res.text();
    const parsed = parseRedRiverFsc(html);
    if (!parsed) console.error('[fsc-auto] Red River parse failed: present-surcharge line not found');
    return parsed;
  } catch (err) {
    console.error('[fsc-auto] Red River fetch failed:', err.message);
    return null;
  }
}

async function updateRedRiverFsc() {
  if (!db.isEnabled()) {
    console.log('[fsc-auto] Red River: DB not enabled, skipping');
    return { updated: false, reason: 'db-disabled' };
  }
  const fresh = await fetchRedRiverFsc();
  if (!fresh) return { updated: false, reason: 'fetch-parse-failed' };
  // Change-only: compare against the stored override, if any.
  try {
    const cur = await db.query(
      'SELECT fsc_ltl_percent, fsc_tl_percent FROM carrier_fsc WHERE carrier_id = $1',
      ['redriver']
    );
    const row = cur.rows[0];
    if (
      row &&
      Number(row.fsc_ltl_percent) === fresh.fsc &&
      Number(row.fsc_tl_percent) === fresh.fsc
    ) {
      console.log(`[fsc-auto] Red River: FSC unchanged (${fresh.fsc}%, eff. ${fresh.effective})`);
      return { updated: false, reason: 'unchanged', ...fresh };
    }
  } catch (err) {
    console.error('[fsc-auto] Red River current-value check failed (continuing):', err.message);
  }
  try {
    await db.query(
      `INSERT INTO carrier_fsc (carrier_id, fsc_ltl_percent, fsc_tl_percent, updated_at)
       VALUES ('redriver', $1, $2, now())
       ON CONFLICT (carrier_id) DO UPDATE SET
         fsc_ltl_percent = EXCLUDED.fsc_ltl_percent,
         fsc_tl_percent = EXCLUDED.fsc_tl_percent,
         updated_at = EXCLUDED.updated_at`,
      [fresh.fsc, fresh.fsc]
    );
    if (typeof matrix.setFscOverride === 'function') {
      matrix.setFscOverride('redriver', {
        ltl: fresh.fsc,
        tl: fresh.fsc,
        updated_at: new Date().toISOString(),
      });
    }
    console.log(`[fsc-auto] Red River: FSC → ${fresh.fsc}% (eff. ${fresh.effective})`);
    return { updated: true, ...fresh };
  } catch (err) {
    console.error('[fsc-auto] Red River update failed:', err.message);
    return { updated: false, reason: 'db-write-failed' };
  }
}

async function updateAllCarrierFsc() {
  if (!db.isEnabled()) {
    console.log('[fsc-auto] DB not enabled, skipping');
    return { updated: 0, skipped: 0 };
  }

  const doePrice = await fetchDoeDieselPrice();
  const nrcanPrice = await fetchNrcanDieselPrice();
  console.log(`[fsc-auto] Diesel indexes — DOE: ${doePrice}, NRCan: ${nrcanPrice}`);

  let updated = 0;
  let skipped = 0;

  for (const [carrierId, cfg] of Object.entries(CARRIER_FSC_TABLES)) {
    const price = cfg.index === 'doe' ? doePrice : nrcanPrice;
    if (price == null) {
      console.log(`[fsc-auto] ${carrierId}: no diesel price, skipping`);
      skipped++;
      continue;
    }
    const fscLtl = lookupFsc(cfg.table, price);
    const fscTl = cfg.tlTable ? lookupFsc(cfg.tlTable, price) : null;
    if (fscLtl == null) {
      console.log(`[fsc-auto] ${carrierId}: table lookup failed, skipping`);
      skipped++;
      continue;
    }

    try {
      await db.query(
        `INSERT INTO carrier_fsc (carrier_id, fsc_ltl_percent, fsc_tl_percent, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (carrier_id) DO UPDATE SET
           fsc_ltl_percent = EXCLUDED.fsc_ltl_percent,
           fsc_tl_percent = EXCLUDED.fsc_tl_percent,
           updated_at = EXCLUDED.updated_at`,
        [carrierId, fscLtl, fscTl]
      );
      // Update in-memory cache too.
      if (typeof matrix.setFscOverride === 'function') {
        matrix.setFscOverride(carrierId, {
          ltl: fscLtl,
          tl: fscTl,
          updated_at: new Date().toISOString(),
        });
      }
      console.log(`[fsc-auto] ${carrierId}: FSC → ${fscLtl}% (diesel ${price})`);
      updated++;
    } catch (err) {
      console.error(`[fsc-auto] ${carrierId} update failed:`, err.message);
      skipped++;
    }
  }

  return { updated, skipped, doePrice, nrcanPrice };
}

module.exports = {
  updateAllCarrierFsc,
  lookupFsc,
  fetchDoeDieselPrice,
  fetchNrcanDieselPrice,
  fetchGrimshawFsc,
  updateGrimshawFsc,
  parseGrimshawFsc,
  fetchRockfallFsc,
  updateRockfallFsc,
  parseRockfallFsc,
  fetchMinimaxFsc,
  updateMinimaxFsc,
  parseMinimaxFsc,
  fetchMorneauFsc,
  updateMorneauFsc,
  parseMorneauFsc,
  fetchRedRiverFsc,
  updateRedRiverFsc,
  parseRedRiverFsc,
  CARRIER_FSC_TABLES,
};
