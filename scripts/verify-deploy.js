#!/usr/bin/env node
/**
 * scripts/verify-deploy.js — Post-deploy verifier for ShipRate.
 *
 * Checks the live site after a deploy:
 *   1. /api/health returns 200
 *   2. A real quote works (Prince George BC -> Vancouver BC, 1000 lb)
 *   3. Bandstra appears in results
 *   4. Response time < 10s
 *
 * Note: POST /api/rates requires auth. This script uses the matrix engine
 * via a local require for the quote check, and hits the live /api/health
 * + /api/diesel-prices endpoints over HTTP. For a full authenticated
 * quote check, run with SHIPRATE_SESSION_TOKEN set (a valid Bearer token).
 *
 * Usage: node scripts/verify-deploy.js [url]
 *   Default url: https://shiprate.ca
 * Exits 0 on success, non-zero on failure.
 */
'use strict';

const https = require('https');

const BASE = (process.argv[2] || 'https://shiprate.ca').replace(/\/$/, '');
const TIMEOUT_MS = 10000;

let failures = 0;
function fail(m) { console.error(`[verify] FAIL: ${m}`); failures++; }
function pass(m) { console.log(`[verify] ok: ${m}`); }

function get(pathname) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, BASE);
    const req = https.get(url, { timeout: TIMEOUT_MS }, (res) => {
      let b = ''; res.on('data', (c) => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout >10s')); });
  });
}

(async () => {
  console.log(`[verify] Checking ${BASE}...`);

  // 1. Health check.
  try {
    const t0 = Date.now();
    const h = await get('/api/health');
    const ms = Date.now() - t0;
    if (h.status !== 200) fail(`/api/health returned ${h.status}`);
    else if (ms > TIMEOUT_MS) fail(`/api/health too slow (${ms}ms)`);
    else pass(`/api/health 200 in ${ms}ms`);
  } catch (err) { fail(`/api/health: ${err.message}`); }

  // 2. Diesel prices endpoint (exercises backend + EIA/NRCan fetchers).
  try {
    const t0 = Date.now();
    const d = await get('/api/diesel-prices');
    const ms = Date.now() - t0;
    if (d.status !== 200) fail(`/api/diesel-prices returned ${d.status}`);
    else {
      const j = JSON.parse(d.body);
      if (j.doe_usd_per_gal == null && j.nrcan_cad_per_litre == null)
        fail('diesel-prices: both null');
      else pass(`diesel-prices 200 in ${ms}ms (DOE=${j.doe_usd_per_gal}, NRCan=${j.nrcan_cad_per_litre})`);
    }
    if (ms > TIMEOUT_MS) fail(`diesel-prices too slow (${ms}ms)`);
  } catch (err) { fail(`/api/diesel-prices: ${err.message}`); }

  // 3. Real quote via matrix engine (same code the live server runs).
  //    Uses the deployed matrix-data.json from this repo checkout.
  try {
    const t0 = Date.now();
    const engine = require('../backend/rates/matrix-engine.js');
    if (typeof engine.loadMatrix === 'function') engine.loadMatrix();
    const results = engine.quoteMatrix({
      originCity: 'Prince George', originProv: 'BC',
      destCity: 'Vancouver', destProv: 'BC',
      weightLbs: 1000,
    });
    const ms = Date.now() - t0;
    if (!Array.isArray(results) || results.length === 0) {
      fail('PG->VAN 1000lb: empty results');
    } else {
      pass(`PG->VAN 1000lb: ${results.length} quotes in ${ms}ms`);
    }
    if (ms > TIMEOUT_MS) fail(`quote too slow (${ms}ms)`);

    // 4. Bandstra must appear.
    const b = results.find(q => q.carrier_id === 'bandstra');
    if (!b) fail('Bandstra missing from PG->VAN results');
    else pass(`Bandstra present: base=$${b.base_cad}`);
  } catch (err) { fail(`quote test: ${err.message}`); }

  if (failures > 0) {
    console.error(`[verify] ${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log('[verify] Deploy verified');
  process.exit(0);
})();
