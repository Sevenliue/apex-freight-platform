// lib/security.js — production security headers + same-origin CORS policy.
//
// The frontend is served from the SAME origin as this API, so the browser
// never needs cross-origin access. In production, cross-origin API calls are
// only allowed from origins listed in CORS_ORIGINS (comma-separated); when
// that is unset, only same-origin requests (no Origin header, or an Origin
// that matches the request Host) are answered — everything else gets no
// CORS headers. Development (NODE_ENV !== 'production') stays permissive.
'use strict';

function isProduction() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

function allowedOrigins() {
  const raw = String(process.env.CORS_ORIGINS || process.env.FRONTEND_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return raw;
}

// securityHeaders(): sets baseline headers. CSP allows the app's own inline
// scripts/styles (the frontend is a vanilla-JS SPA with inline code) while
// blocking everything else from loading off-origin.
function securityHeaders() {
  const allow = allowedOrigins();
  return (req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // HSTS only in production — never on plain-http local dev.
    if (isProduction()) {
      res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    // Inline scripts/styles are 'unsafe-inline' because the SPA ships them;
    // no remote scripts, plugins, or frames are needed (Stripe Checkout and
    // EasyPost are server-side redirects/API calls). unpkg is allowlisted
    // for the html5-qrcode scanner library loaded in index.html.
    res.set(
      'Content-Security-Policy',
      "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline' https://unpkg.com; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: https:; " +
        "font-src 'self' data:; " +
        "connect-src 'self' https:; " +
        'frame-ancestors \'self\'; ' +
        "base-uri 'self'; form-action 'self' https:"
    );
    next();
  };
}

// corsPolicy(): replaces the wide-open cors() default. Same-origin requests
// (the frontend) always work because browsers don't send preflights for
// same-origin fetches. Cross-origin requests need an allowlisted Origin.
function corsPolicy() {
  const allow = allowedOrigins();
  const allowSet = new Set(allow);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin) return next(); // same-origin / non-browser: no CORS needed
    let ok = allowSet.has(origin);
    if (!ok && !isProduction()) {
      ok = true; // permissive in development
    } else if (!ok && isProduction() && !allow.length) {
      // No allowlist configured in production: accept only an Origin that
      // matches this request's own host (i.e. effectively same-origin).
      try {
        const oHost = new URL(origin).host;
        const hHost = String(req.headers.host || '').split(',')[0].trim();
        ok = oHost === hHost;
      } catch {
        ok = false;
      }
    }
    if (ok) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      return res.status(ok ? 204 : 403).end();
    }
    next();
  };
}

module.exports = { securityHeaders, corsPolicy, isProduction };
