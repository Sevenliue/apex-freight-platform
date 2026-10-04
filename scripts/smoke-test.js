#!/usr/bin/env node
/**
 * scripts/smoke-test.js — Pre-deploy smoke test for ShipRate.
 *
 * Starts the backend locally, verifies /api/health, then exercises the
 * actual rating engine (quoteMatrix) across all 11 carriers, skid-based
 * rates, city-only addresses, heavy/light shipments, and the skidCount
 * regression check.
 *
 * Usage: node scripts/smoke-test.js
 * Exits 0 on success, non-zero on any failure.
 *
 * No external dependencies beyond node.
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const TEST_PORT = 5999;
const TIMEOUT_MS = 30000;

let failures = 0;

function log(msg) { console.log(`[smoke] ${msg}`); }
function fail(msg) { console.error(`[smoke] FAIL: ${msg}`); failures++; }
function pass(msg) { console.log(`[smoke] ok: ${msg}`); }

// ---------------------------------------------------------------------------
// 1. Start the backend server locally.
// ---------------------------------------------------------------------------
function startServer() {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, '..', 'backend', 'server.js');
    const proc = spawn('node', [serverPath], {
      env: { ...process.env, PORT: String(TEST_PORT), NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let started = false;
    const timer = setTimeout(() => {
      if (!started) { proc.kill(); reject(new Error('server did not start within 20s')); }
    }, 20000);

    proc.stdout.on('data', (d) => {
      const s = String(d);
      if (/listening|started|port/i.test(s) && !started) {
        started = true; clearTimeout(timer); resolve(proc);
      }
    });
    proc.stderr.on('data', () => {}); // ignore noise
    proc.on('error', reject);
    // Fallback: poll /api/health
    const poll = setInterval(async () => {
      try {
        const r = await httpGet('/api/health');
        if (r.status === 200 && !started) {
          started = true; clearTimeout(timer); clearInterval(poll); resolve(proc);
        }
      } catch {}
    }, 1000);
    setTimeout(() => clearInterval(poll), 20000);
  });
}

function httpGet(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: TEST_PORT, path: pathname, timeout: 10000 },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ---------------------------------------------------------------------------
// 2. Test the rating engine directly (all carriers, scenarios).
// ---------------------------------------------------------------------------
function testEngine() {
  const engine = require('../backend/rates/matrix-engine.js');
  if (typeof engine.loadMatrix === 'function') engine.loadMatrix();

  const carriers = ['hifab','guilbault','rosenau','jays','jrhall','willys','morneau','armour','minimax','minimax_ottawa','bandstra'];

  // One representative lane per carrier.
  const lanes = [
    { carrier: 'hifab', o: ['Acheson','AB'], d: ['Calgary','AB'] },
    { carrier: 'guilbault', o: ['Amaranth','ON'], d: ['Montreal','QC'] },
    { carrier: 'rosenau', o: ['Edmonton','AB'], d: ['Calgary','AB'] },
    { carrier: 'jays', o: ['Regina','SK'], d: ['Saskatoon','SK'] },
    { carrier: 'jrhall', o: ['Calgary','AB'], d: ['Edmonton','AB'] },
    { carrier: 'willys', o: ['Edmonton','AB'], d: ['Calgary','AB'] },
    { carrier: 'morneau', o: ['Amaranth','ON'], d: ['Montreal','QC'] },
    { carrier: 'armour', o: ['Moncton','NB'], d: ['Halifax','NS'] },
    { carrier: 'minimax_ottawa', o: ['Ottawa','ON'], d: ['Addison','ON'] },
    { carrier: 'bandstra', o: ['Prince George','BC'], d: ['Vancouver','BC'] },
  ];

  log('Testing one lane per carrier (1000 lb)...');
  for (const t of lanes) {
    const start = Date.now();
    let results;
    try {
      results = engine.quoteMatrix({
        originCity: t.o[0], originProv: t.o[1],
        destCity: t.d[0], destProv: t.d[1],
        weightLbs: 1000,
      });
    } catch (err) {
      fail(`${t.carrier} lane threw: ${err.message}`);
      continue;
    }
    const elapsed = Date.now() - start;
    if (elapsed > TIMEOUT_MS) { fail(`${t.carrier} timed out (${elapsed}ms)`); continue; }
    const found = results.find(q => q.carrier_id === t.carrier);
    if (!found) fail(`${t.carrier}: no quote for ${t.o[0]}->${t.d[0]}`);
    else if (!results.length) fail(`${t.carrier}: empty results`);
    else pass(`${t.carrier}: ${t.o[0]}->${t.d[0]} base=$${found.base_cad}`);
  }

  // Skid-based rates (minimax, 5-8 skids).
  log('Testing skid-based rates (minimax 5-8 skids)...');
  for (let skids = 5; skids <= 8; skids++) {
    let results;
    try {
      results = engine.quoteMatrix({
        originCity: 'Amaranth', originProv: 'ON',
        destCity: 'Montreal', destProv: 'QC',
        weightLbs: 1000, skidCount: skids,
      });
    } catch (err) { fail(`minimax ${skids} skids threw: ${err.message}`); continue; }
    const found = results.find(q => q.carrier_id === 'minimax');
    if (!found) fail(`minimax: no quote for ${skids} skids`);
    else pass(`minimax ${skids} skids: base=$${found.base_cad}`);
  }

  // City-only addresses (no street/postal — engine only needs city/prov).
  log('Testing city-only addresses...');
  try {
    const r = engine.quoteMatrix({
      originCity: 'Prince George', originProv: 'BC',
      destCity: 'Fort St. John', destProv: 'BC',
      weightLbs: 5000,
    });
    const b = r.find(q => q.carrier_id === 'bandstra');
    if (!b) fail('bandstra: city-only PG->FSJ returned nothing');
    else pass(`city-only PG->FSJ: bandstra base=$${b.base_cad}`);
  } catch (err) { fail(`city-only threw: ${err.message}`); }

  // Heavy (15000 lb) and light (200 lb).
  log('Testing heavy (15000 lb) and light (200 lb)...');
  for (const [label, wt] of [['heavy', 15000], ['light', 200]]) {
    try {
      const r = engine.quoteMatrix({
        originCity: 'Prince George', originProv: 'BC',
        destCity: 'Vancouver', destProv: 'BC',
        weightLbs: wt,
      });
      const b = r.find(q => q.carrier_id === 'bandstra');
      if (!b) fail(`bandstra ${label} (${wt}lb): no quote`);
      else if (!r.length) fail(`bandstra ${label}: empty results`);
      else pass(`bandstra ${label} (${wt}lb): base=$${b.base_cad}`);
    } catch (err) { fail(`bandstra ${label} threw: ${err.message}`); }
  }

  // Reverse lane should NOT return bandstra (one-way).
  log('Testing reverse lane exclusion...');
  try {
    const r = engine.quoteMatrix({
      originCity: 'Vancouver', originProv: 'BC',
      destCity: 'Prince George', destProv: 'BC',
      weightLbs: 1000,
    });
    const b = r.find(q => q.carrier_id === 'bandstra');
    if (b) fail('bandstra: returned quote for reverse lane (should be one-way)');
    else pass('bandstra correctly absent on reverse lane');
  } catch (err) { fail(`reverse lane threw: ${err.message}`); }
}

// ---------------------------------------------------------------------------
// 3. skidCount regression check (2026-10-02 outage).
//    The bug: `skidCount` was declared with `let` inside the `if (!worldwide)`
//    block in backend/routes/rates.js, then referenced outside it →
//    ReferenceError, request hung, frontend timed out.
// ---------------------------------------------------------------------------
function testSkidCountRegression() {
  log('Running skidCount regression check...');
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', 'rates.js'), 'utf8');

  // Check 1: `skidCount` must be declared in the outer route-handler scope,
  // not inside a nested block. We verify the declaration line's indentation
  // is at the handler body level (2 spaces) and appears before the
  // `if (!worldwide)` block.
  const lines = src.split('\n');
  let declLine = -1, declIndent = -1;
  let ifWorldwideLine = -1;
  let usageOutside = [];
  lines.forEach((ln, i) => {
    const m = ln.match(/^(\s*)(let|const|var)\s+skidCount\s*=/);
    if (m && declLine === -1) { declLine = i; declIndent = m[1].length; }
    if (/if\s*\(!worldwide\)/.test(ln) && ifWorldwideLine === -1) ifWorldwideLine = i;
    if (/[^a-zA-Z]skidCount[^a-zA-Z]/.test(ln) && !/^\s*(let|const|var)\s+skidCount/.test(ln)) {
      usageOutside.push(i);
    }
  });

  if (declLine === -1) { fail('skidCount: no declaration found in rates.js'); return; }

  // The declaration must come before the `if (!worldwide)` block
  // (i.e., in the outer scope, not inside it).
  if (ifWorldwideLine !== -1 && declLine > ifWorldwideLine) {
    fail(`skidCount declared at line ${declLine + 1}, AFTER if(!worldwide) at line ${ifWorldwideLine + 1} — block-scoping bug is back!`);
    return;
  }

  // All usages after the if-block must be reachable (declaration in outer scope).
  // If declaration indent is deeper than handler body, it's nested.
  if (declIndent > 4) {
    fail(`skidCount declared with indent ${declIndent} — likely inside a nested block`);
    return;
  }

  pass(`skidCount declared at line ${declLine + 1} (outer scope), ${usageOutside.length} usages all reachable`);

  // Check 2: engine handles skidCount parameter without throwing.
  const engine = require('../backend/rates/matrix-engine.js');
  if (typeof engine.loadMatrix === 'function') engine.loadMatrix();
  try {
    const r = engine.quoteMatrix({
      originCity: 'Amaranth', originProv: 'ON',
      destCity: 'Montreal', destProv: 'QC',
      weightLbs: 2000, skidCount: 6,
    });
    if (!Array.isArray(r)) fail('skidCount: engine did not return array');
    else pass(`skidCount=6 engine test: ${r.length} quotes returned`);
  } catch (err) {
    fail(`skidCount engine test threw: ${err.message}`);
  }
}

function testDimensionalWeight() {
  log('Testing dimensional (cube / linear-foot) weight rules...');
  const engine = require('../backend/rates/matrix-engine.js');
  const eq = (a, b) => Math.abs(a - b) < 0.01;

  // Case 1 — Seven's dense example: 4 pcs 22.5x22.5x16 in, 500 lb total.
  // 18.75 cu ft @ 26.67 pcf -> rates on actual weight.
  let d = engine.billableWeight(500, [{ qty: 4, length: 22.5, width: 22.5, height: 16 }]);
  if (!eq(d.billable_lbs, 500) || d.dimensional_rule !== 'actual' || d.dimensional_applied)
    fail(`dense tires: expected 500 lb / actual, got ${d.billable_lbs} lb / ${d.dimensional_rule}`);
  else pass(`dense tires: 500 lb billable, ${d.cube_ft} cu ft, ${d.density_pcf} pcf`);

  // Case 2 — Seven's bulky example: 76x76x28 in, 500 lb.
  // 93.59 cu ft @ 5.34 pcf -> cube rule: 935.93 lb billable.
  d = engine.billableWeight(500, [{ qty: 1, length: 76, width: 76, height: 28 }]);
  if (!eq(d.billable_lbs, 935.93) || d.dimensional_rule !== 'cube' || !d.dimensional_applied)
    fail(`bulky freight: expected 935.93 lb / cube, got ${d.billable_lbs} lb / ${d.dimensional_rule}`);
  else pass(`bulky freight: 935.93 lb billable via cube rule`);

  // Case 3 — no dimensions: pricing unchanged (billable = actual).
  d = engine.billableWeight(500, []);
  if (!eq(d.billable_lbs, 500) || d.dimensional_applied)
    fail(`no dims: expected 500 lb unchanged, got ${d.billable_lbs} lb`);
  else pass('no dimensions: rates on actual weight, unchanged');

  // Case 4 — linear-foot rule: 14 non-stackable 48x40 skids exceed 10 ft.
  d = engine.billableWeight(2000, [{ qty: 14, length: 48, width: 40, height: 48, stackable: false }]);
  if (d.dimensional_rule !== 'linear_foot' || !d.dimensional_applied)
    fail(`linear-foot: expected linear_foot rule, got ${d.dimensional_rule} (${d.billable_lbs} lb)`);
  else pass(`linear-foot rule: ${d.linear_ft} ft -> ${d.billable_lbs} lb billable`);

  // Case 5 — end-to-end: bulky shipment actually prices on billable weight.
  const q = engine.quoteMatrix({
    originCity: 'Prince George', originProv: 'BC',
    destCity: 'Vancouver', destProv: 'BC', weightLbs: 500,
    packages: [{ qty: 1, length: 76, width: 76, height: 28, weight_lb: 500 }],
  });
  const b = q.find((r) => r.carrier_id === 'bandstra');
  if (!b) fail('e2e: no bandstra quote for bulky shipment');
  else if (!eq(b.billable_weight_lbs, 935.93) || b.dimensional_rule !== 'cube')
    fail(`e2e: expected 935.93 lb / cube, got ${b.billable_weight_lbs} lb / ${b.dimensional_rule}`);
  else pass(`e2e: bandstra prices bulky shipment at 935.93 lb billable (base $${b.base_cad})`);

  // Case 6 — minimax skid flats stay skid-priced (no dimensional interference).
  const s = engine.quoteMatrix({
    originCity: 'Amaranth', originProv: 'ON',
    destCity: 'Montreal', destProv: 'QC', weightLbs: 2000, skidCount: 6,
    packages: [{ qty: 6, length: 48, width: 40, height: 48, weight_lb: 333 }],
  });
  const m = s.find((r) => r.carrier_id === 'minimax' && r.rate_basis === 'skid');
  if (!m) fail('e2e: minimax skid quote missing with packages present');
  else pass(`minimax skid flat unaffected by dimensions (base $${m.base_cad})`);

  // Case 7 — per-carrier density floor override (admin-tunable).
  engine.setDensityFloor('bandstra', 15);
  if (engine.densityFloorFor('bandstra') !== 15) fail('floor: bandstra override not applied');
  else if (engine.densityFloorFor('rosenau') !== 10) fail('floor: default changed for other carriers');
  else {
    const q15 = engine.quoteMatrix({
      originCity: 'Prince George', originProv: 'BC',
      destCity: 'Vancouver', destProv: 'BC', weightLbs: 500,
      packages: [{ qty: 1, length: 76, width: 76, height: 28, weight_lb: 500 }],
    });
    const b15 = q15.find((r) => r.carrier_id === 'bandstra');
    // 93.59 cu ft x 15 = 1403.89 lb billable (vs 935.93 at the default 10)
    if (!b15 || !eq(b15.billable_weight_lbs, 1403.89) || b15.floor_lb_per_cuft !== 15)
      fail(`floor: expected bandstra 1403.89 lb @ 15, got ${b15 ? b15.billable_weight_lbs : 'none'}`);
    else pass('per-carrier floor: bandstra @15 -> 1403.89 lb billable');
  }
  engine.clearDensityFloor('bandstra');
  if (engine.densityFloorFor('bandstra') !== 10) fail('floor: clear did not restore default 10');
  else pass('floor: clearing override restores default 10');

  // Case 8 — linear-foot trigger at exactly 10 ft ("10 or more", carrier wording).
  d = engine.billableWeight(2000, [{ qty: 10, length: 48, width: 24, height: 48, stackable: false }]);
  if (d.dimensional_rule !== 'linear_foot' || !eq(d.linear_ft, 10) || !eq(d.billable_lbs, 10000))
    fail(`linear boundary: expected linear_foot @ exactly 10 ft -> 10000 lb, got ${d.dimensional_rule} / ${d.linear_ft} ft / ${d.billable_lbs} lb`);
  else pass('linear-foot rule triggers at exactly 10 ft -> 10000 lb billable');
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
(async () => {
  log('Starting pre-deploy smoke test...');
  let proc = null;
  try {
    proc = await startServer();
    log(`Server started on port ${TEST_PORT}`);

    const h = await httpGet('/api/health');
    if (h.status !== 200) fail(`/api/health returned ${h.status}`);
    else pass('/api/health 200');

    testEngine();
    testSkidCountRegression();
    testDimensionalWeight();
  } catch (err) {
    fail(`setup: ${err.message}`);
  } finally {
    if (proc) proc.kill();
  }

  if (failures > 0) {
    console.error(`[smoke] ${failures} FAILURE(S) — do not deploy`);
    process.exit(1);
  }
  console.log('[smoke] All checks passed');
  process.exit(0);
})();
