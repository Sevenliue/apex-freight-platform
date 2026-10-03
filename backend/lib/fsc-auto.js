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
  CARRIER_FSC_TABLES,
};
