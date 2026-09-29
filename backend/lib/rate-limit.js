// lib/rate-limit.js — tiny in-memory sliding-window rate limiter.
//
// No external dependency on purpose (keeps the deploy footprint unchanged).
// Limits are per client IP per route prefix. State lives in this process, so
// on multi-instance deployments each instance enforces its own share —
// documented, and fine for abuse-throttling auth endpoints (not for exact
// billing quotas, which stay in the database).
'use strict';

// buckets: Map<key, number[]> of request timestamps (ms).
const buckets = new Map();

function clientIp(req) {
  // Render / proxies put the real client first in x-forwarded-for.
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

// rateLimit({ windowMs, max, message }): Express middleware. Answers 429
// with a Retry-After header when the client exceeds `max` requests inside
// the sliding `windowMs`.
function rateLimit({ windowMs, max, message }) {
  const scope = message || 'rate';
  return (req, res, next) => {
    const now = Date.now();
    const key = `${scope}:${clientIp(req)}:${req.path}`;
    let hits = buckets.get(key);
    if (!hits) {
      hits = [];
      buckets.set(key, hits);
    }
    // Drop timestamps outside the window.
    while (hits.length && hits[0] <= now - windowMs) hits.shift();
    if (hits.length >= max) {
      const retryAfter = Math.ceil((hits[0] + windowMs - now) / 1000);
      res.set('Retry-After', String(Math.max(retryAfter, 1)));
      return res.status(429).json({
        error: 'Too many attempts — please wait a minute and try again.',
      });
    }
    hits.push(now);
    next();
  };
}

// Prune empty buckets every few minutes so the map can't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of buckets) {
    while (hits.length && hits[0] <= now - 60 * 60 * 1000) hits.shift();
    if (!hits.length) buckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

module.exports = { rateLimit };
