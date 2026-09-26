// lib/stripe.js — lazy Stripe client. Returns null when STRIPE_SECRET_KEY is
// not set; bid acceptance then stays in 'pending_payment' status.
'use strict';

const config = require('../config');

function getClient() {
  if (!config.stripeKey) return null;
  return require('stripe')(config.stripeKey);
}

function isEnabled() {
  return !!config.stripeKey;
}

module.exports = { getClient, isEnabled };
