// config.js — runtime configuration for the Apex Freight backend.
// Loads ../.env (platform root) via dotenv. Every credential comes from the
// environment; nothing is invented here. All money is CAD.
'use strict';

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

module.exports = {
  // Port the HTTP server listens on.
  port: num(process.env.PORT, 5000),

  // Percent markup applied to carrier buy rates when quoting shippers
  // and when pricing awarded marketplace bids. 15 => cost x 1.15.
  markupPercent: num(process.env.MARKUP_PERCENT, 15),

  // Optional integrations. Empty string = disabled; related endpoints
  // return 501 with a clear message instead of failing at boot.
  easypostKey: process.env.EASYPOST_API_KEY || '',
  stripeKey: process.env.STRIPE_SECRET_KEY || '',

  // Google Places API key for server-side address autocomplete proxy.
  // Empty string = disabled; /api/places/* answers { configured: false }.
  placesKey: process.env.GOOGLE_PLACES_API_KEY || '',

  // Optional Postgres persistence. Empty = in-memory demo mode.
  databaseUrl: process.env.DATABASE_URL || '',

  // Public origin of the frontend (used for Stripe redirect/callback URLs).
  frontendOrigin: process.env.FRONTEND_ORIGIN || '',

  // Optional auth stub. Unset = auth disabled (see middleware/auth.js).
  authToken: process.env.AUTH_TOKEN || '',
};
