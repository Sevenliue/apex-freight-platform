// lib/fsc.js — loads admin-set fuel-surcharge overrides from the
// carrier_fsc DB table into the rate-matrix engine's in-memory cache.
// The engine's quoteMatrix() is synchronous, so overrides are cached rather
// than read per quote. Refresh at startup, on a timer, and after admin writes.
'use strict';

const db = require('../db');
const matrix = require('./matrix');

async function loadFscOverrides() {
  if (!db.isEnabled()) return 0;
  if (typeof matrix.setFscOverride !== 'function') return 0; // fallback engine
  try {
    const r = await db.query(
      'SELECT carrier_id, fsc_ltl_percent, fsc_tl_percent, updated_at FROM carrier_fsc'
    );
    let n = 0;
    for (const row of r.rows) {
      matrix.setFscOverride(row.carrier_id, {
        ltl: Number(row.fsc_ltl_percent),
        tl: row.fsc_tl_percent == null ? null : Number(row.fsc_tl_percent),
        updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      });
      n += 1;
    }
    if (n) console.log(`[fsc] loaded ${n} fuel-surcharge override(s)`);
    return n;
  } catch (err) {
    console.error('[fsc] override load failed (continuing with rate-sheet values):', err.message);
    return 0;
  }
}

module.exports = { loadFscOverrides };
