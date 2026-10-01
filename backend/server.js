// server.js — ShipRate backend (Express).
// Currency CAD. Boots with zero configuration: no API keys and no database
// needed — matrix quoting and the load-board marketplace run in-memory, while
// EasyPost/Stripe/DB-backed routes answer 501 with clear messages when their
// credentials are absent.
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');

const config = require('./config');
const db = require('./db');
const authStub = require('./middleware/auth');
const { securityHeaders, corsPolicy } = require('./lib/security');

const app = express();

// Baseline security headers on every response (incl. static + errors).
app.use(securityHeaders());
// Same-origin-first CORS: the frontend is served from this same origin, so
// browsers never need cross-origin access. Cross-origin callers must be
// allowlisted via CORS_ORIGINS (see lib/security.js).
app.use(corsPolicy());

// Stripe webhook needs the RAW request body for signature verification, so
// it is mounted BEFORE express.json(). Stripe authenticates via the webhook
// signature (STRIPE_WEBHOOK_SECRET), not a Bearer <redacted> so the auth-token
// gate below never sees it.
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), require('./routes/stripe-webhook'));

// EasyPost webhooks need the RAW request body for HMAC signature
// verification, so this is mounted BEFORE express.json() too.
app.post('/api/webhooks/easypost', express.raw({ type: 'application/json' }), require('./routes/webhooks').easypostWebhook);

app.use(express.json({ limit: '1mb' }));

// Minimal morgan-style request log.
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    console.log(
      `${new Date().toISOString()} ${req.method} ${req.originalUrl} -> ${res.statusCode} ${Date.now() - started}ms`
    );
  });
  next();
});

// Shipper account auth (signup/login) must stay reachable even when the
// API-token gate is on, so it is mounted BEFORE the gate.
app.use('/api/auth', require('./routes/auth'));

// Auth stub (disabled unless AUTH_TOKEN is set).
app.use('/api', authStub);

// Session enrichment (always on): a valid Bearer <redacted> attaches
// req.user = {id, email, name, company, role}. Public routes stay public;
// they simply see req.user when a session is present.
app.use('/api', async (req, res, next) => {
  if (!req.user) {
    try {
      req.user = await require('./lib/session').lookupSession(req.headers.authorization);
    } catch {
      req.user = null;
    }
  }
  next();
});

// Optional email-verification gate: when REQUIRE_EMAIL_VERIFICATION=true,
// signed-in accounts must have a verified email to get rates. Off by default
// (leave off until the email provider is configured, or new accounts could
// never receive their verification link).
function requireVerified(req, res, next) {
  if (String(process.env.REQUIRE_EMAIL_VERIFICATION || '').toLowerCase() !== 'true') {
    return next();
  }
  if (req.user && req.user.is_verified) return next();
  return res.status(403).json({
    error: 'Please verify your email address first — check your inbox for the verification link.',
  });
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'online', timestamp: new Date().toISOString() });
});

// Public site configuration the frontend needs before rendering
// (no auth required; contains no secrets).
app.get('/api/site-config', (req, res) => {
  res.json({ siteMode: config.siteMode });
});

app.use('/api/rates', requireVerified, require('./routes/rates'));
app.use('/api/contact', require('./routes/contact'));
app.use('/api/billing', require('./routes/billing'));
app.use('/api/quotes', require('./routes/quotes'));
app.use('/api/shipments', require('./routes/shipments'));
app.use('/api/tracking', require('./routes/tracking'));
app.use('/api/easypost', require('./routes/easypost'));
app.use('/api/places', require('./routes/places'));
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/loads', require('./routes/loads'));
app.use('/api/bids', require('./routes/bids'));
app.use('/api/carrier-rates', require('./routes/carrier-rates'));
app.use('/api/address-book', require('./routes/addressbook'));
app.use('/api/custom-lists', require('./routes/custom-lists'));
app.use('/api/carriers', require('./routes/carriers'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/pickups', require('./routes/pickups'));
app.use('/api/holidays', require('./routes/holidays'));
app.use('/api/store', require('./routes/store'));
app.use('/api/inventory', require('./routes/inventory'));

// Serve the sibling-built static frontend (same origin as the API).
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
app.use(express.static(FRONTEND_DIR));
app.get('/', (req, res) => {
  const index = path.join(FRONTEND_DIR, 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  return res.status(404).json({
    error: 'Frontend not built yet — frontend/index.html is missing',
    api: 'backend is running; try GET /api/health',
  });
});

// SEO basics: robots.txt + sitemap.xml for the public pages.
function siteOrigin(req) {
  const env = String(process.env.PUBLIC_URL || process.env.FRONTEND_ORIGIN || '').trim().replace(/\/+$/, '');
  if (env) return env;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${req.headers.host}`;
}
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    `User-agent: *\nAllow: /\nSitemap: ${siteOrigin(req)}/sitemap.xml\n`
  );
});
app.get('/sitemap.xml', (req, res) => {
  const origin = siteOrigin(req);
  const pages = ['', '/terms', '/privacy', '/contact', '/faq', '/about'];
  const urls = pages
    .map((p) => `  <url><loc>${origin}${p || '/'}</loc><changefreq>monthly</changefreq></url>`)
    .join('\n');
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`
  );
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// SPA deep-link fallback: emailed links like /reset-password?token=… or
// /terms must render the app instead of "Cannot GET". Only for GETs outside
// /api and without a file extension (real missing assets still 404).
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
  if (path.extname(req.path)) {
    return res.status(404).send('Not found');
  }
  const index = path.join(FRONTEND_DIR, 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  return next();
});

// Central error handler (keeps stack traces out of responses).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err && err.message);
  res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
  (async () => {
    // Idempotent schema setup when a database is configured: db/schema.sql
    // is safe to run more than once. A failure is logged and does not stop
    // the server (DB-backed routes fall back to in-memory behavior).
    if (db.isEnabled()) {
      try {
        const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
        await db.query(fs.readFileSync(schemaPath, 'utf8'));
        console.log('[db] schema ensured');
      } catch (err) {
        console.error('[db] schema setup failed (continuing):', err.message);
      }
    }
    app.listen(config.port, () => {
      console.log(
        `ShipRate backend listening on :${config.port} ` +
          `(markup ${config.markupPercent}%, db ${db.isEnabled() ? 'enabled' : 'disabled — in-memory mode'}, ` +
          `easypost ${config.easypostKey ? 'on' : 'off'}, stripe ${config.stripeKey ? 'on' : 'off'})`
      );
    });
    // Fuel-surcharge overrides: load admin-set values into the rate-matrix
    // engine, and refresh them every 5 minutes in case they changed.
    try {
      const { loadFscOverrides } = require('./lib/fsc');
      await loadFscOverrides();
      const t = setInterval(() => { loadFscOverrides(); }, 5 * 60 * 1000);
      if (t.unref) t.unref();
    } catch (err) {
      console.error('[fsc] init failed (continuing):', err.message);
    }
  })();
}

module.exports = app;
