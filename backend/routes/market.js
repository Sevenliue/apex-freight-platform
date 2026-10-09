// GET /api/market/fx — CAD/USD daily rate from the Bank of Canada Valet API
// (free, no key). FXCADUSD = US dollars per Canadian dollar.
// Cached 12h; falls back to last good data on failure.
const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const BOC_URL = 'https://www.bankofcanada.ca/valet/observations/FXCADUSD/json?recent=5';
const CACHE_FILE = path.join(__dirname, '..', 'data', 'fx-cache.json');
const CACHE_TTL_MS = 12 * 3600 * 1000;

let memCache = null;

router.get('/fx', async (req, res) => {
  const now = Date.now();
  if (memCache && now - memCache.fetched_at < CACHE_TTL_MS) {
    return res.json({ ...memCache, stale: false });
  }
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (cached && now - cached.fetched_at < CACHE_TTL_MS) {
      memCache = cached;
      return res.json({ ...cached, stale: false });
    }
  } catch (e) { /* no usable cache */ }
  try {
    const r = await fetch(BOC_URL, {
      headers: { 'User-Agent': 'ShipRate/1.0 (fx-widget)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error('BoC status ' + r.status);
    const data = await r.json();
    const obs = (data.observations || [])
      .filter((o) => o && o.FXCADUSD && Number.isFinite(Number(o.FXCADUSD.v)))
      .map((o) => ({ date: o.d, rate: Number(o.FXCADUSD.v) }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (obs.length < 1) throw new Error('BoC parse: no observations');
    const last = obs[obs.length - 1];
    const prev = obs.length > 1 ? obs[obs.length - 2] : null;
    const payload = {
      updated_at: new Date().toISOString(),
      fetched_at: now,
      pair: 'CAD/USD',
      rate: last.rate,
      change: prev ? last.rate - prev.rate : null,
      date: last.date,
      prev_date: prev ? prev.date : null,
      source: 'Bank of Canada',
      source_url: 'https://www.bankofcanada.ca/rates/exchange/daily-exchange-rates/',
    };
    memCache = payload;
    try {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(payload));
    } catch (e) { /* cache is best-effort */ }
    return res.json({ ...payload, stale: false });
  } catch (err) {
    console.error('[market] BoC FX fetch failed:', err.message);
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (cached && cached.rate) {
        memCache = cached;
        return res.json({ ...cached, stale: true });
      }
    } catch (e) { /* no cache */ }
    return res.status(502).json({ error: 'Exchange rate unavailable right now.' });
  }
});

module.exports = router;
