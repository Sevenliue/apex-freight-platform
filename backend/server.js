// server.js — Apex Freight & Shipping Canada backend (Express).
// Currency CAD. Boots with zero configuration: no API keys and no database
// needed — matrix quoting and the load-board marketplace run in-memory, while
// EasyPost/Stripe/DB-backed routes answer 501 with clear messages when their
// credentials are absent.
'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const config = require('./config');
const db = require('./db');
const authStub = require('./middleware/auth');

const app = express();

app.use(cors());

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

app.get('/api/health', (req, res) => {
  res.json({ status: 'online', timestamp: new Date().toISOString() });
});

// Public site configuration the frontend needs before rendering
// (no auth required; contains no secrets).
app.get('/api/site-config', (req, res) => {
  res.json({ siteMode: config.siteMode });
});

app.use('/api/rates', require('./routes/rates'));
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

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

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
        `Apex Freight backend listening on :${config.port} ` +
          `(markup ${config.markupPercent}%, db ${db.isEnabled() ? 'enabled' : 'disabled — in-memory mode'}, ` +
          `easypost ${config.easypostKey ? 'on' : 'off'}, stripe ${config.stripeKey ? 'on' : 'off'})`
      );
    });
  })();
}

module.exports = app;
