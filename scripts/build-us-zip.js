#!/usr/bin/env node
/* Builds frontend/us-zip.json — compact offline US ZIP5 -> [city, state] lookup.
 *
 * Source: GeoNames postal-code dump for the US (https://download.geonames.org/export/zip/US.zip),
 * licensed CC-BY 4.0 (https://www.geonames.org). Attribution is kept in this
 * header and in frontend/postal-autofill.js. Re-run any time to refresh:
 * node scripts/build-us-zip.js
 *
 * Output format: {"90210":["Beverly Hills","CA"],...} (one row per ZIP5).
 * A ZIP with several place names keeps the FIRST row in the dump. The file is
 * fetched on demand by postal-autofill.js (only when a US-looking ZIP is
 * typed), so it does not bloat the initial page load.
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const URL = 'http://download.geonames.org/export/zip/US.zip';
const OUT = path.join(__dirname, '..', 'frontend', 'us-zip.json');

function cleanPlace(raw) {
  return String(raw || '')
    .replace(/\s*\(.*\)\s*$/, '')
    .trim();
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uszip-'));
  try {
    const zip = path.join(tmp, 'US.zip');
    console.log('downloading', URL);
    execFileSync('curl', ['-sSL', '-o', zip, URL], { stdio: 'inherit' });
    const txt = execFileSync('unzip', ['-p', zip, 'US.txt'], {
      maxBuffer: 64 * 1024 * 1024,
    }).toString('utf8');

    const out = {};
    let rows = 0;
    for (const line of txt.split('\n')) {
      if (!line) continue;
      const cols = line.split('\t');
      // GeoNames US.txt: country, postal, place, admin1 name, admin1 code, ...
      const zip5 = (cols[1] || '').trim();
      if (!/^\d{5}$/.test(zip5)) continue;
      if (out[zip5]) continue; // first place name wins
      const city = cleanPlace(cols[2]);
      const state = (cols[4] || '').trim();
      if (!city || !state) continue;
      out[zip5] = [city, state];
      rows++;
    }
    fs.writeFileSync(OUT, JSON.stringify(out));
    console.log(`wrote ${OUT}: ${rows} ZIPs, ${fs.statSync(OUT).size} bytes`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();
