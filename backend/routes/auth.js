// routes/auth.js — shipper account signup / login / logout / me, plus
// password reset, email verification, password change, profile updates and
// account deletion.
//
//   POST /api/auth/signup             {name, company?, email, password}
//   POST /api/auth/login              {email, password}
//   POST /api/auth/logout             — revokes the calling Bearer <redacted>
//   GET  /api/auth/me                — current session user (401 without one)
//   POST /api/auth/forgot-password    {email} — always a generic 200
//   POST /api/auth/reset-password     {token, password}
//   POST /api/auth/verify-email       {token}
//   POST /api/auth/resend-verification — signed-in account only
//   POST /api/auth/change-password    {current_password, new_password}
//   PATCH /api/auth/me                {name?, company?, email?}
//   DELETE /api/auth/me               {password} — deletes the whole account
//
// Passwords are hashed with bcryptjs (10 rounds) and stored in
// users.password_hash. password_hash is never included in any response.
// Sessions are opaque 32-byte hex tokens (see lib/session.js), valid for
// 30 days, revocable via logout. Account auth requires the database:
// without DATABASE_URL these endpoints answer 501 with a clear message.
//
// Reset/verification tokens: the raw token is emailed once and never stored;
// only its SHA-256 hash lives in auth_tokens, single-use, with an expiry.
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { randomUUID } = require('crypto');
const db = require('../db');
const sessionLib = require('../lib/session');
const { rateLimit } = require('../lib/rate-limit');

const router = express.Router();

const BCRYPT_ROUNDS = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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

function publicSiteUrl() {
  const env = String(process.env.PUBLIC_URL || process.env.FRONTEND_ORIGIN || '').trim().replace(/\/+$/, '');
  return env || 'https://shiprate-freight-platform.onrender.com';
}

// Token helpers -----------------------------------------------------------
function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// mintToken(purpose, userId, ttlMs): stores only the hash, returns the raw
// token for emailing. Invalidates older unused tokens of the same purpose.
async function mintToken(purpose, userId, ttlMs) {
  const raw = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.query(
    `UPDATE auth_tokens SET used_at = now()
      WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`,
    [userId, purpose]
  );
  await db.query(
    `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, purpose, tokenHash, expiresAt]
  );
  return raw;
}

// consumeToken(purpose, raw): returns the user_id if the token is valid,
// unused and unexpired; marks it used. Otherwise null.
async function consumeToken(purpose, raw) {
  if (!raw || typeof raw !== 'string' || raw.length > 256) return null;
  const tokenHash = hashToken(raw);
  const r = await db.query(
    `UPDATE auth_tokens SET used_at = now()
      WHERE token_hash = $1 AND purpose = $2
        AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [tokenHash, purpose]
  );
  return r.rows.length ? r.rows[0].user_id : null;
}

// sendAccountEmail(to, subject, text, event, linkForLogs): best-effort email
// via the notify layer. When no email provider is configured the link is
// written to the server log (Render logs) so the owner can complete the
// flow manually — it is NEVER returned in an API response.
async function sendAccountEmail(to, subject, text, event, linkForLogs) {
  const { sendEmail } = require('../lib/notify');
  const result = await sendEmail({ to, subject, text, event });
  if (result && (result.skipped || result.logged || result.failed)) {
    console.log(`[auth] email not delivered (${result.skipped || result.logged ? 'no provider' : result.failed}) — ${event} link for ${to}: ${linkForLogs}`);
  }
  return result;
}

async function authedUser(req, res) {
  const user = await sessionLib.lookupSession(req.headers.authorization);
  if (!user) {
    bad(res, 401, 'Not signed in.');
    return null;
  }
  return user;
}

// Auth rate limits (per IP): brute-force throttles, not quotas.
const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'login' });
const signupLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: 'signup' });
const forgotLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: 'forgot' });
const resetLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: 'reset' });
const verifyLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, message: 'verify' });
const changePwLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'changepw' });

// POST /api/auth/signup — {name, company?, email, password}
router.post('/signup', signupLimit, async (req, res) => {
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
       VALUES ($1, $2, $3, $4, 'shipper', false, $5, $6)
       RETURNING id, email, full_name, company_name, role, is_verified, shipping_approved`,
      [id, email, name, company || null, hash, approved]
    );
    await sessionLib.pruneExpiredSessions();
    const token = await sessionLib.createSession(r.rows[0].id);
    // Verification email (best-effort; never blocks signup).
    try {
      const raw = await mintToken('email_verify', id, VERIFY_TTL_MS);
      const link = `${publicSiteUrl()}/verify-email?token=${raw}`;
      await sendAccountEmail(
        email,
        'Verify your ShipRate email',
        `Welcome to ShipRate.\n\nPlease verify your email address (link expires in 24 hours):\n${link}\n\nIf you didn't create this account, just ignore this email.`,
        'verify_email',
        link
      );
    } catch (e) {
      console.error('[auth/signup] verification email failed:', e.message);
    }
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
router.post('/login', loginLimit, async (req, res) => {
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
      'SELECT id, email, full_name, company_name, role, is_verified, shipping_approved, password_hash FROM users WHERE email = $1 LIMIT 1',
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

// POST /api/auth/forgot-password — {email}. ALWAYS answers 200 with the same
// generic message so the endpoint can't be used to enumerate accounts.
router.post('/forgot-password', forgotLimit, async (req, res) => {
  if (needDb(res)) return;
  const generic = 'If an account exists for that email, a reset link is on its way (check spam too).';
  const email = cleanEmail((req.body || {}).email);
  if (!validEmail(email)) return res.json({ ok: true, message: generic });
  try {
    const r = await db.query('SELECT id, email FROM users WHERE email = $1 LIMIT 1', [email]);
    const row = r.rows[0];
    if (row && row.email) {
      const raw = await mintToken('password_reset', row.id, RESET_TTL_MS);
      const link = `${publicSiteUrl()}/reset-password?token=${raw}`;
      await sendAccountEmail(
        row.email,
        'Reset your ShipRate password',
        `Someone requested a password reset for your ShipRate account.\n\nReset it here (link expires in 1 hour, one-time use):\n${link}\n\nIf that wasn't you, just ignore this email — your password stays the same.`,
        'password_reset',
        link
      );
    }
  } catch (err) {
    console.error('[auth/forgot-password] failed:', err.message);
    // Still generic: never leak whether the account exists.
  }
  return res.json({ ok: true, message: generic });
});

// POST /api/auth/reset-password — {token, password}. Single-use, 1h expiry.
// On success every session for the account is revoked.
router.post('/reset-password', resetLimit, async (req, res) => {
  if (needDb(res)) return;
  const b = req.body || {};
  if (!validPassword(b.password)) {
    return bad(res, 400, 'Password must be at least 8 characters.');
  }
  try {
    const userId = await consumeToken('password_reset', b.token);
    if (!userId) {
      return bad(res, 400, 'This reset link is invalid or has expired. Request a new one.');
    }
    const hash = await bcrypt.hash(b.password, BCRYPT_ROUNDS);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, userId]);
    // Revoke all sessions: anyone signed in (including an attacker holding a
    // stolen token) must sign in again with the new password.
    await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    return res.json({ ok: true, message: 'Password updated. Please sign in again.' });
  } catch (err) {
    console.error('[auth/reset-password] failed:', err.message);
    return bad(res, 502, 'Could not reset the password: ' + err.message);
  }
});

// POST /api/auth/verify-email — {token}. Marks the account verified.
router.post('/verify-email', verifyLimit, async (req, res) => {
  if (needDb(res)) return;
  try {
    const userId = await consumeToken('email_verify', (req.body || {}).token);
    if (!userId) {
      return bad(res, 400, 'This verification link is invalid or has expired.');
    }
    await db.query('UPDATE users SET is_verified = true WHERE id = $1', [userId]);
    return res.json({ ok: true, message: 'Email verified — thanks!' });
  } catch (err) {
    console.error('[auth/verify-email] failed:', err.message);
    return bad(res, 502, 'Could not verify the email: ' + err.message);
  }
});

// POST /api/auth/resend-verification — signed-in account only.
router.post('/resend-verification', verifyLimit, async (req, res) => {
  if (needDb(res)) return;
  const user = await authedUser(req, res);
  if (!user) return;
  try {
    const r = await db.query('SELECT email, is_verified FROM users WHERE id = $1 LIMIT 1', [user.id]);
    const row = r.rows[0];
    if (!row) return bad(res, 404, 'Account not found.');
    if (row.is_verified) return res.json({ ok: true, message: 'Your email is already verified.' });
    const raw = await mintToken('email_verify', user.id, VERIFY_TTL_MS);
    const link = `${publicSiteUrl()}/verify-email?token=${raw}`;
    await sendAccountEmail(
      row.email,
      'Verify your ShipRate email',
      `Here's a fresh verification link (expires in 24 hours):\n${link}\n\nIf you didn't ask for this, just ignore it.`,
      'verify_email',
      link
    );
    return res.json({ ok: true, message: 'Verification email sent — check your inbox (and spam).' });
  } catch (err) {
    console.error('[auth/resend-verification] failed:', err.message);
    return bad(res, 502, 'Could not send the verification email: ' + err.message);
  }
});

// POST /api/auth/change-password — {current_password, new_password}.
// Signed-in only. Revokes every session, so the caller must sign in again.
router.post('/change-password', changePwLimit, async (req, res) => {
  if (needDb(res)) return;
  const user = await authedUser(req, res);
  if (!user) return;
  const b = req.body || {};
  if (!validPassword(b.new_password)) {
    return bad(res, 400, 'The new password must be at least 8 characters.');
  }
  try {
    const r = await db.query('SELECT password_hash FROM users WHERE id = $1 LIMIT 1', [user.id]);
    const row = r.rows[0];
    const ok = row && row.password_hash
      ? await bcrypt.compare(String(b.current_password || ''), row.password_hash)
      : false;
    if (!ok) return bad(res, 401, 'Your current password is incorrect.');
    const hash = await bcrypt.hash(b.new_password, BCRYPT_ROUNDS);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, user.id]);
    await db.query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
    return res.json({ ok: true, message: 'Password changed. Please sign in again.' });
  } catch (err) {
    console.error('[auth/change-password] failed:', err.message);
    return bad(res, 502, 'Could not change the password: ' + err.message);
  }
});

// PATCH /api/auth/me — {name?, company?, email?}. Signed-in only. Changing
// the email resets verification and sends a fresh verification email.
router.patch('/me', async (req, res) => {
  if (needDb(res)) return;
  const user = await authedUser(req, res);
  if (!user) return;
  const b = req.body || {};
  const sets = [];
  const vals = [];
  let i = 1;
  let emailChanged = false;
  let newEmail = null;

  if (b.name !== undefined) {
    const name = String(b.name || '').trim().slice(0, 255);
    if (!name) return bad(res, 400, 'Name is required.');
    sets.push(`full_name = $${i++}`);
    vals.push(name);
  }
  if (b.company !== undefined) {
    sets.push(`company_name = $${i++}`);
    vals.push(String(b.company || '').trim().slice(0, 255) || null);
  }
  if (b.email !== undefined) {
    newEmail = cleanEmail(b.email);
    if (!validEmail(newEmail)) return bad(res, 400, 'A valid email address is required.');
    if (newEmail !== user.email) {
      const taken = await db.query('SELECT id FROM users WHERE email = $1 AND id <> $2 LIMIT 1', [newEmail, user.id]);
      if (taken.rows.length) return bad(res, 409, 'That email is already used by another account.');
      sets.push(`email = $${i++}`, 'is_verified = false');
      vals.push(newEmail);
      emailChanged = true;
    }
  }
  if (!sets.length) return bad(res, 400, 'Nothing to update.');

  try {
    vals.push(user.id);
    const r = await db.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${i}
       RETURNING id, email, full_name, company_name, role, is_verified, shipping_approved`,
      vals
    );
    if (emailChanged) {
      try {
        const raw = await mintToken('email_verify', user.id, VERIFY_TTL_MS);
        const link = `${publicSiteUrl()}/verify-email?token=${raw}`;
        await sendAccountEmail(
          newEmail,
          'Verify your new ShipRate email',
          `Your account email was changed. Please verify the new address (link expires in 24 hours):\n${link}`,
          'verify_email',
          link
        );
      } catch (e) {
        console.error('[auth/me] verification email failed:', e.message);
      }
    }
    return res.json({ user: sessionLib.sanitizeUser(r.rows[0]) });
  } catch (err) {
    if (err && err.code === '23505') return bad(res, 409, 'That email is already used by another account.');
    console.error('[auth/me] patch failed:', err.message);
    return bad(res, 502, 'Could not update the profile: ' + err.message);
  }
});

// DELETE /api/auth/me — {password}. Signed-in only. Deletes the account and
// everything owned by it (quotes, addresses, sessions cascade; orders and
// marketplace rows are detached via ON DELETE SET NULL). Irreversible.
router.delete('/me', async (req, res) => {
  if (needDb(res)) return;
  const user = await authedUser(req, res);
  if (!user) return;
  try {
    const r = await db.query('SELECT password_hash FROM users WHERE id = $1 LIMIT 1', [user.id]);
    const row = r.rows[0];
    const ok = row && row.password_hash
      ? await bcrypt.compare(String((req.body || {}).password || ''), row.password_hash)
      : false;
    if (!ok) return bad(res, 401, 'Your password is incorrect.');
    await db.query('DELETE FROM users WHERE id = $1', [user.id]);
    return res.json({ ok: true, message: 'Your account has been deleted.' });
  } catch (err) {
    console.error('[auth/me] delete failed:', err.message);
    return bad(res, 502, 'Could not delete the account: ' + err.message);
  }
});

module.exports = router;
