// lib/density.js — loads admin-set per-carrier density floors from the
// carrier_density_floor DB table into the rate-matrix engine's in-memory
// cache. The engine's quoteMatrix() is synchronous, so floors are cached
// rather than read per quote. Refresh at startup and after admin writes.
'use strict';

const db = require('../db');
const matrix = require('./matrix');

async function loadDensityFloors() {
  if (!db.isEnabled()) return 0;
  if (typeof matrix.setDensityFloor !== 'function') return 0; // fallback engine
  try {
    const r = await db.query(
      'SELECT carrier_id, floor_lb_per_cuft, updated_at FROM carrier_density_floor'
    );
    let n = 0;
    for (const row of r.rows) {
      matrix.setDensityFloor(row.carrier_id, Number(row.floor_lb_per_cuft));
      n += 1;
    }
    if (n) console.log(`[density] loaded ${n} density-floor override(s)`);
    return n;
  } catch (err) {
    console.error('[density] floor load failed (continuing with default floor):', err.message);
    return 0;
  }
}

// loadDimWeightFlags(): per-carrier dimensional-weight on/off from the
// carrier_dim_weight DB table into the engine's in-memory set. Default is ON
// for every carrier; only carriers with an explicit enabled=false row are
// switched off (they rate on actual weight only).
async function loadDimWeightFlags() {
  if (!db.isEnabled()) return 0;
  if (typeof matrix.setDimWeightEnabled !== 'function') return 0; // fallback engine
  try {
    // Reconcile: clear any in-memory opt-outs first so carriers turned back
    // on (row deleted or enabled=true) don't stay off between refreshes.
    const current = typeof matrix.getDimWeightFlags === 'function' ? matrix.getDimWeightFlags() : {};
    for (const id of Object.keys(current)) matrix.setDimWeightEnabled(id, true);
    const r = await db.query(
      'SELECT carrier_id, enabled FROM carrier_dim_weight WHERE enabled = false'
    );
    let n = 0;
    for (const row of r.rows) {
      matrix.setDimWeightEnabled(row.carrier_id, false);
      n += 1;
    }
    if (n) console.log(`[density] loaded ${n} dim-weight opt-out(s)`);
    return n;
  } catch (err) {
    console.error('[density] dim-weight load failed (continuing with dim weight on):', err.message);
    return 0;
  }
}

module.exports = { loadDensityFloors, loadDimWeightFlags };
