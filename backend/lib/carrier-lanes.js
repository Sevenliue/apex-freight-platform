// lib/carrier-lanes.js — loads carrier lanes from the carrier_matrix_rates
// DB table into the rate-matrix engine's in-memory cache. This covers both
// admin-managed tariff uploads and approved self-serve carrier uploads. The
// engine's quoteMatrix() is synchronous, so lanes are cached rather than
// read per quote. Refresh at startup, on a timer, and after admin approval.
// Merge is idempotent (same lane key overwrites).
'use strict';

const db = require('../db');
const matrix = require('./matrix');

async function loadCarrierLanes() {
  if (!db.isEnabled()) return 0;
  if (typeof matrix.upsertCarrier !== 'function' || typeof matrix.upsertCarrierRows !== 'function') return 0;
  try {
    const r = await db.query(
      `SELECT carrier_id, carrier_label, fsc_percent,
              origin_city, origin_prov, dest_city, dest_prov,
              min_charge_cad, breaks_json
       FROM carrier_matrix_rates`
    );
    const byCarrier = new Map();
    for (const row of r.rows) {
      if (!row.carrier_id) continue;
      if (!byCarrier.has(row.carrier_id)) byCarrier.set(row.carrier_id, { info: row, lanes: [] });
      byCarrier.get(row.carrier_id).lanes.push({
        origin_city: row.origin_city,
        origin_prov: row.origin_prov,
        dest_city: row.dest_city,
        dest_prov: row.dest_prov,
        min_charge_cad: Number(row.min_charge_cad),
        breaks: row.breaks_json,
      });
    }
    let n = 0;
    for (const [carrierId, g] of byCarrier) {
      matrix.upsertCarrier({
        carrier_id: carrierId,
        carrier_label: g.info.carrier_label || carrierId,
        fsc_percent: g.info.fsc_percent == null ? 0 : Number(g.info.fsc_percent),
        fsc_as_of: new Date().toISOString().slice(0, 10),
        fsc_note: 'database tariff',
      });
      n += matrix.upsertCarrierRows(carrierId, g.lanes);
    }
    if (n) console.log(`[carrier-lanes] loaded ${n} lane(s) from ${byCarrier.size} database carrier(s)`);
    return n;
  } catch (err) {
    console.error('[carrier-lanes] load failed (continuing):', err.message);
    return 0;
  }
}

module.exports = { loadCarrierLanes };
