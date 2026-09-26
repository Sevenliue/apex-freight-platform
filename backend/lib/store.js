// lib/store.js — in-memory stores so the marketplace flow (quotes, loads,
// bids, awards, orders) is fully demoable with zero setup. When DATABASE_URL
// is set, routes ALSO write to Postgres; these maps remain the fast path for
// quote lookups (needed by /api/shipments/buy).
'use strict';

const { randomUUID } = require('crypto');

const store = {
  quotes: new Map(), // shipment_id -> { shipment_id, origin, destination, parcel, user_id, rates, easypost_shipment_id, created_at }
  loads: new Map(), // load id -> load posting
  bids: new Map(), // bid id -> bid
  transactions: [], // accepted bid transactions
  orders: [], // purchased labels
};

function id(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

module.exports = { store, id };
