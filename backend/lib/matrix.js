// lib/matrix.js — resolves the sibling rate-matrix engine and validates its
// contract shape: quoteMatrix({originCity, originProv, destCity, destProv,
// weightLbs, skidCount?, packages?}), billableWeight(actualLbs, packages, floor?),
// densityFloorFor(carrierId), setDensityFloor(carrierId, floor), upsertCarrier(carrier),
// listCarriers(), getAccessorials(carrierId), upsertCarrierRows(carrierId, rows).
//
// Lookup order:
//   1. ./rates/matrix-engine.js   (sibling's actual location)
//   2. ../rates/matrix-engine.js  (original contract location)
//   3. ./matrix-fallback.js       (built-in SAMPLE data, demo/testing only)
'use strict';

const path = require('path');

const REQUIRED = ['quoteMatrix', 'listCarriers', 'getAccessorials', 'upsertCarrierRows', 'suggestCity'];

function shapeOk(mod) {
  return mod && REQUIRED.every((fn) => typeof mod[fn] === 'function');
}

function tryLoad(p) {
  try {
    const mod = require(p);
    if (shapeOk(mod)) {
      console.log(`[matrix] using engine at ${p}`);
      return mod;
    }
    console.warn(`[matrix] engine at ${p} is missing exports; skipping`);
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') console.warn(`[matrix] failed to load ${p}: ${err.message}`);
  }
  return null;
}

const engine =
  tryLoad(path.join(__dirname, '..', 'rates', 'matrix-engine.js')) ||
  tryLoad(path.join(__dirname, '..', '..', 'rates', 'matrix-engine.js')) ||
  (() => {
    console.warn('[matrix] no sibling engine found — using built-in SAMPLE fallback (demo data only)');
    return require('./matrix-fallback.js');
  })();

module.exports = engine;
