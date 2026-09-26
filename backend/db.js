// db.js — pg connection pool wrapper.
// Works with no DATABASE_URL: isEnabled() returns false and query() throws a
// clear error. The server keeps running; routes use in-memory stores instead.
'use strict';

const { Pool } = require('pg');
const config = require('./config');

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

module.exports = { query, isEnabled, getPool: () => pool };
