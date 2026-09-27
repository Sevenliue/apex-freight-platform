// routes/auth.js — shipper account signup / login / logout / me.
//
//   POST /api/auth/signup  {name, company?, email, password}
//   POST /api/auth/login   {email, password}
//   POST /api/auth/logout — revokes the calling Bearer <redacted>
//   GET  /api/auth/me     — current session user (401 without one)
//
// Passwords are hashed with bcryptjs (10 rounds) and stored in
// users.password_hash. password_hash is never included in any response.
// Sessions are opaque 32-byte hex tokens (see lib/session.js), valid for
// 30 days, revocable via logout. Account auth requires the database:
// without DATABASE_URL these endpoints answer 501 with a clear message.
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const db = require('../db');
const sessionLib = require('../lib/session');

const router = express.Router();

const BCRYPT_ROUNDS = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function bad(res, code, error) {
  return res.status(code).json({ error });
}

function needDb(res) {
  if (!db.isEnabled()) {
    bad(res, 501, 'Accounts require a database: set DATABASE_URL on the server.');
    return true;
  }
  return false;
}

function cleanEmail(v) {
  return String(v || '').trim().toLowerCase();
}

function validEmail(email) {
  return email.length <= 254 && EMAIL_RE.test(email);
}

function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= 8 && pw.length <= 128;
}

// POST /api/auth/signup — {name, company?, email, password}
router.post('/signup', async (req, res) => {
  if (needDb(res)) return;
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 255);
  const company = String(b.company || '').trim().slice(0, 255);
  const email = cleanEmail(b.email);
  const password = b.password;

  if (!name) return bad(res, 400, 'Name is required.');
  if (!validEmail(email)) return bad(res, 400, 'A valid email address is required.');
  if (!validPassword(password)) {
    return bad(res, 400, 'Password must be at least 8 characters.');
  }

  try {
    const existing = await db.query('SELECT id FROM users WHERE email = $1 LIMIT 1', [email]);
    if (existing.rows.length) {
      return bad(res, 409, 'An account with that email already exists.');
    }
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const id = randomUUID();
    // New accounts start quote-only: an admin approves them for shipping in
    // Admin → Account approvals. Staff emails bypass approval automatically.
    const { isAdminEmail } = require('../lib/billing');
    const approved = isAdminEmail(email);
    const r = await db.query(
      `INSERT INTO users (id, email, full_name, company_name, role, is_verified, password_hash, shipping_approved)
       VALUES ($1, $2, $3, $4, 'shipper', true, $5, $6)
       RETURNING id, email, full_name, company_name, role, shipping_approved`,
      [id, email, name, company || null, hash, approved]
    );
    await sessionLib.pruneExpiredSessions();
    const token = await sessionLib.createSession(r.rows[0].id);
    // Tell the admin a new account is waiting (best-effort, never blocks).
    try {
      require('../lib/notify').notify('new_signup', null, {
        user: { name, email, company },
      });
    } catch { /* notify never throws; belt and suspenders */ }
    return res.status(201).json({ token, user: sessionLib.sanitizeUser(r.rows[0]) });
  } catch (err) {
    // Race on the UNIQUE(email) constraint between the check and insert.
    if (err && err.code === '23505') {
      return bad(res, 409, 'An account with that email already exists.');
    }
    console.error('[auth/signup] failed:', err.message);
    return bad(res, 502, 'Could not create account: ' + err.message);
  }
});

// POST /api/auth/login — {email, password}. Rotates to a fresh session token.
router.post('/login', async (req, res) => {
  if (needDb(res)) return;
  const b = req.body || {};
  const email = cleanEmail(b.email);
  const password = b.password;
  const genericFail = 'Email or password is incorrect.';

  if (!validEmail(email) || typeof password !== 'string' || !password) {
    return bad(res, 401, genericFail);
  }

  try {
    const r = await db.query(
      'SELECT id, email, full_name, company_name, role, shipping_approved, password_hash FROM users WHERE email = $1 LIMIT 1',
      [email]
    );
    const row = r.rows[0];
    // bcrypt.compare is the constant-time-ish check; a missing hash means
    // this account has no password login (e.g. minted by ensureUser).
    const ok = row && row.password_hash
      ? await bcrypt.compare(password, row.password_hash)
      : false;
    if (!ok) return bad(res, 401, genericFail);

    // Rotate: revoke the calling token (if any), then mint a fresh one.
    await sessionLib.revokeSession(sessionLib.extractBearer(req.headers.authorization));
    await sessionLib.pruneExpiredSessions();
    const token = await sessionLib.createSession(row.id);
    return res.json({ token, user: sessionLib.sanitizeUser(row) });
  } catch (err) {
    console.error('[auth/login] failed:', err.message);
    return bad(res, 502, 'Could not sign in: ' + err.message);
  }
});

// POST /api/auth/logout — revokes the calling session token. Idempotent.
router.post('/logout', async (req, res) => {
  if (needDb(res)) return;
  await sessionLib.revokeSession(sessionLib.extractBearer(req.headers.authorization));
  return res.json({ logged_out: true });
});

// GET /api/auth/me — current session user, or 401.
router.get('/me', async (req, res) => {
  if (needDb(res)) return;
  const user = await sessionLib.lookupSession(req.headers.authorization);
  if (!user) return bad(res, 401, 'Not signed in.');
  return res.json({ user });
});

module.exports = router;
