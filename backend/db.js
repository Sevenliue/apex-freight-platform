// db.js — pg connection pool wrapper.
// Works with no DATABASE_URL: isEnabled() returns false and query() throws a
// clear error. The server keeps running; routes use in-memory stores instead.
'use strict';

const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const config = require('./config');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let pool = null;

if (config.databaseUrl) {
  const isLocal =
    config.databaseUrl.includes('localhost') || config.databaseUrl.includes('127.0.0.1');
  pool = new Pool({
    connectionString: config.databaseUrl,
    // Hosted Postgres (Render/Supabase/...) usually needs TLS; local dev does not.
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });
  pool.on('error', (err) => console.error('[db] pool error:', err.message));
}

function isEnabled() {
  return !!pool;
}

async function query(text, params) {
  if (!pool) {
    throw new Error('Database is not configured: set DATABASE_URL to enable persistence.');
  }
  return pool.query(text, params);
}

// newId(prefix): schema primary keys are uuid, so mint real uuids when the
// database is on; keep the readable prefixed ids for in-memory mode.
function newId(prefix) {
  if (!pool) return require('./lib/store').id(prefix);
  return randomUUID();
}

// ensureUser(userId, role): shipment/bid FKs need a users row. Accepts a uuid
// (uses it as-is) or any label (reuses the uuid minted for that label, or
// mints one and stores the label as full_name). Returns the uuid to use in
// FK columns — so the same label always resolves to the same user.
async function ensureUser(userId, role) {
  if (!pool) return userId;
  const raw = String(userId || '');
  const roleName = role === 'carrier' ? 'carrier' : 'shipper';
  if (UUID_RE.test(raw)) {
    await query(
      `INSERT INTO users (id, email, role) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [raw, `${raw}@apex.local`, roleName]
    );
    return raw;
  }
  const existing = await query('SELECT id FROM users WHERE full_name = $1 LIMIT 1', [raw]);
  if (existing.rows.length) return existing.rows[0].id;
  const uuid = randomUUID();
  await query(
    `INSERT INTO users (id, email, full_name, role) VALUES ($1, $2, $3, $4)`,
    [uuid, `${uuid}@apex.local`, raw || null, roleName]
  );
  return uuid;
}

module.exports = { query, isEnabled, getPool: () => pool, newId, ensureUser };
