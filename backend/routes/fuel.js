// GET /api/fuel/diesel — 4-week Canada average retail diesel price history.
// Source: Natural Resources Canada weekly prices (same feed as the FSC monitor
// in lib/fsc-auto.js). Cached 24h; falls back to last good data on failure.
const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

// NRCan weekly diesel, locationID=66 = Canada national average, cents/litre.
const NRCAN_URL = 'https://www2.nrcan.gc.ca/eneene/sources/pripri/prices_bycity_e.cfm'
  + '?productID=5&locationID=66&frequency=W&priceYear=' + new Date().getFullYear();
const CACHE_FILE = path.join(__dirname, '..', 'data', 'diesel-cache.json');
const CACHE_TTL_MS = 24 * 3600 * 1000;
const WEEKS = 4;

// Verified 2026-10-07 against NRCan. Used only if NRCan is unreachable and no
// cache exists. Filtered by date at serve time like live data.
const FALLBACK = [
  { date: '2026-09-15', cents_per_litre: 258.9 },
  { date: '2026-09-22', cents_per_litre: 274.1 },
  { date: '2026-09-29', cents_per_litre: 263.1 },
  { date: '2026-10-06', cents_per_litre: 259.2 },
];

let memCache = null;

function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (raw && Array.isArray(raw.prices) && Date.now() - raw.fetched_at < CACHE_TTL_MS) {
      return raw;
    }
  } catch (e) { /* no usable cache */ }
  return null;
}

function writeCache(payload) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(payload));
  } catch (e) { /* cache is best-effort */ }
}

async function fetchNrcan() {
  // Global fetch honors proxy env (NODE_USE_ENV_PROXY) in sandboxed dev and
  // connects directly on Render.
  const res = await fetch(NRCAN_URL, {
    headers: { 'User-Agent': 'ShipRate/1.0 (diesel-price-widget)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('NRCan status ' + res.status);
  return res.text();
}

// Parse weekly rows: <td>2026-10-06</td><td ...>259.2</td> ...
// NRCan sometimes publishes the upcoming week early; drop any date after today
// and return the latest WEEKS completed weeks, oldest first.
function parseWeeklyDiesel(html) {
  const rows = [];
  const re = /(\d{4}-\d{2}-\d{2})<\/td>\s*<td[^>]*>([\d.]+)</g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const cents = parseFloat(m[2]);
    if (Number.isFinite(cents)) rows.push({ date: m[1], cents_per_litre: cents });
  }
  if (!rows.length) throw new Error('NRCan parse: no price rows');
  const today = new Date().toISOString().slice(0, 10);
  const valid = rows.filter((r) => r.date <= today);
  if (valid.length < WEEKS) throw new Error('NRCan parse: not enough completed weeks');
  return valid.slice(-WEEKS);
}

router.get('/diesel', async (req, res) => {
  const now = Date.now();
  if (memCache && now - memCache.fetched_at < CACHE_TTL_MS) {
    return res.json({ ...memCache, stale: false });
  }
  const cached = readCache();
  if (cached) {
    memCache = cached;
    return res.json({ ...cached, stale: false });
  }
  try {
    const html = await fetchNrcan();
    const prices = parseWeeklyDiesel(html);
    const payload = {
      updated_at: new Date().toISOString(),
      fetched_at: now,
      source: 'Natural Resources Canada',
      source_url: 'https://www2.nrcan.gc.ca/eneene/sources/pripri/prices_byfuel_e.cfm',
      unit: 'cents_per_litre',
      prices,
    };
    memCache = payload;
    writeCache(payload);
    return res.json({ ...payload, stale: false });
  } catch (err) {
    console.error('[fuel] NRCan fetch failed:', err.message);
    if (cached) {
      memCache = cached;
      return res.json({ ...cached, stale: true });
    }
    const today = new Date().toISOString().slice(0, 10);
    const prices = FALLBACK.filter((r) => r.date <= today).slice(-WEEKS);
    return res.json({
      updated_at: new Date().toISOString(),
      fetched_at: now,
      source: 'Natural Resources Canada',
      source_url: 'https://www2.nrcan.gc.ca/eneene/sources/pripri/prices_byfuel_e.cfm',
      unit: 'cents_per_litre',
      prices,
      stale: true,
    });
  }
});

module.exports = router;
