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
// Grimshaw has no matrix lanes yet (account rates pending from the rep),
// so the override sits ready and applies the moment lanes are added.
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
  CARRIER_FSC_TABLES,
};
