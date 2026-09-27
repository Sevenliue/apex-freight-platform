// lib/session.js — session-token helpers for shipper account auth.
//
// Sessions live in the sessions table (see db/schema.sql): token (pk),
// user_id, created_at, expires_at. Tokens are opaque 32-byte hex strings
// presented as `Authorization: Bearer <token>`. They are revocable (logout)
// and expire after SESSION_TTL_DAYS (30).
//
// Without a database (db.isEnabled() === false) every helper degrades
// gracefully: lookups return null, minting throws a clear error so routes
// can answer 501.
'use strict';

const crypto = require('crypto');
const db = require('../db');

const SESSION_TTL_DAYS = 30;

function mintToken() {
  return crypto.randomBytes(32).toString('hex');
}

function expiryDate() {
  return new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

// sanitizeUser(row): the public shape of a user — password_hash is NEVER
// included.
function sanitizeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.full_name || null,
    company: row.company_name || null,
    email: row.email,
    role: row.role,
    shipping_approved: !!row.shipping_approved,
  };
}

function extractBearer(authHeader) {
  const m = /^Bearer\s+(.+)$/i.exec(String(authHeader || '').trim());
  return m ? m[1].trim() : null;
}

// lookupSession(authHeader): validate a Bearer <redacted> a live session.
// Returns the sanitized user or null (unknown/expired token, no DB, DB error).
async function lookupSession(authHeader) {
  const token = extractBearer(authHeader);
  if (!token || !db.isEnabled()) return null;
  try {
    const r = await db.query(
      `SELECT u.id, u.email, u.full_name, u.company_name, u.role,
              u.shipping_approved
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token = $1 AND s.expires_at > now()
        LIMIT 1`,
      [token]
    );
    return r.rows.length ? sanitizeUser(r.rows[0]) : null;
  } catch (err) {
    console.error('[session] lookup failed:', err.message);
    return null;
  }
}

// createSession(userId): mint a token + row. Throws when the DB is off.
async function createSession(userId) {
  if (!db.isEnabled()) {
    throw new Error('Account sign-in requires a database: set DATABASE_URL.');
  }
  const token = mintToken();
  await db.query(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
    [token, userId, expiryDate()]
  );
  return token;
}

// revokeSession(token): delete one session row. Idempotent.
async function revokeSession(token) {
  if (!token || !db.isEnabled()) return;
  try {
    await db.query('DELETE FROM sessions WHERE token = $1', [token]);
  } catch (err) {
    console.error('[session] revoke failed:', err.message);
  }
}

// pruneExpiredSessions(): opportunistic cleanup, called on login/signup.
async function pruneExpiredSessions() {
  if (!db.isEnabled()) return;
  try {
    await db.query('DELETE FROM sessions WHERE expires_at <= now()');
  } catch (err) {
    console.error('[session] prune failed:', err.message);
  }
}

module.exports = {
  SESSION_TTL_DAYS,
  mintToken,
  extractBearer,
  sanitizeUser,
  lookupSession,
  createSession,
  revokeSession,
  pruneExpiredSessions,
};
