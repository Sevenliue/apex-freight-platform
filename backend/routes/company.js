// routes/company.js — company grouping for accounts.
//
// A company groups several accounts so members share ONE waybill sequence
// and can see each other's waybills. Users without a company keep exactly
// today's solo behavior.
//
// Endpoints (all require sign-in):
//   GET  /api/company                     own company + members (or null)
//   POST /api/company          {name}     create a company (creator = admin)
//   POST /api/company/join     {code}    join by join code (flagged
//                                        domains get a pending request
//                                        instead of instant membership)
//   POST /api/company/leave               leave (admin transfers / dissolves)
//   POST /api/company/members/:id/remove  admin removes a member (not self)
//   GET  /api/company/my-requests         caller's own pending join requests
//   GET  /api/company join_requests       (on GET /api/company, admins only)
//   POST /api/company/join-requests/:id/approve  company admin approves
//   POST /api/company/join-requests/:id/decline  company admin declines
//
// COMPANY-JOIN FLAG (2026-10-28, authorized): a signup whose email domain
// is tied to a DIFFERENT company, or who claims an existing company name
// their domain was never seen under, is flagged — they get NO company_id
// until a company admin approves the pending request. Freemail domains
// never count as company domains, so freemail signups are never flagged.
// Existing members are never retro-flagged. Individual quoting still
// works while flagged: only company access waits.
//
// Tables are created on boot (CREATE TABLE IF NOT EXISTS). Joining or
// leaving never alters or deletes any existing waybills, except that when
// the LAST member leaves the company dissolves and its waybills revert to
// their creators' solo lists (company_id -> NULL, numbers unchanged).
'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const billing = require('../lib/billing');
const companyRates = require('../lib/company-rates');
const joinFlag = require('../lib/company-join-flag');

const router = express.Router();

async function ensureCompanyTables() {
  if (!db.isEnabled()) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      join_code TEXT NOT NULL UNIQUE,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  // company_id is a plain uuid (no FK) so this stays idempotent regardless
  // of statement order; membership is enforced by the application.
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS company_id UUID`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS logo TEXT`);
  await db.query(`CREATE INDEX IF NOT EXISTS users_company_idx ON users (company_id)`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS company_waybill_counters (
      company_id UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      last_no INTEGER NOT NULL DEFAULT 0
    )`);
  // Pending company-join requests (see header). Status values:
  // pending / approved / declined / superseded (user joined elsewhere).
  await db.query(`
    CREATE TABLE IF NOT EXISTS company_join_requests (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      decided_at TIMESTAMPTZ,
      decided_by UUID REFERENCES users(id) ON DELETE SET NULL
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS company_join_requests_company_idx ON company_join_requests (company_id, status)`);
  await db.query(`CREATE INDEX IF NOT EXISTS company_join_requests_user_idx ON company_join_requests (user_id, status)`);
}
ensureCompanyTables().catch((e) => console.error('[company] table setup failed:', e.message));

function needUser(req, res) {
  if (!req.user) { res.status(401).json({ error: 'Sign in to manage a company.' }); return false; }
  return true;
}
function needDb(res) {
  if (!db.isEnabled()) { res.status(503).json({ error: 'Company features are unavailable right now.' }); return false; }
  return true;
}

// Max numeric waybill suffix a user already holds (solo or company), e.g.
// WB-000042 -> 42. Used to seed/bump a company counter above pre-join numbers.
async function maxWaybillNo(userId) {
  const r = await db.query(
    `SELECT waybill_no FROM waybills WHERE user_id = $1`, [userId]);
  let max = 0;
  for (const row of r.rows) {
    const m = /^WB-0*(\d+)$/.exec(String(row.waybill_no || ''));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

const JOIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
async function genJoinCode() {
  for (let i = 0; i < 10; i++) {
    let code = '';
    const bytes = crypto.randomBytes(8);
    for (const b of bytes) code += JOIN_ALPHABET[b % JOIN_ALPHABET.length];
    const r = await db.query('SELECT id FROM companies WHERE join_code = $1 LIMIT 1', [code]);
    if (!r.rows.length) return code;
  }
  throw new Error('Could not generate a unique join code.');
}

async function getMyCompany(userId) {
  const r = await db.query(
    // c.* (not an explicit column list) so this never errors on the first
    // boot after a companies-column migration lands; portal_enabled simply
    // arrives once the boot ALTER has run. c.id duplicates u.company_id
    // with the same value.
    `SELECT u.company_id AS id, c.*
       FROM users u LEFT JOIN companies c ON c.id = u.company_id
      WHERE u.id = $1 LIMIT 1`, [userId]);
  const row = r.rows[0];
  if (!row || !row.id) return null;
  return row;
}

async function listMembers(companyId) {
  const r = await db.query(
    `SELECT id, email, full_name AS name FROM users WHERE company_id = $1 ORDER BY full_name NULLS LAST, email`,
    [companyId]);
  return r.rows;
}

// --- Company-join flag helpers (see header) ---

// Exactly-one company by name (case-insensitive). Zero or multiple
// matches are ambiguous: return null and create no pending request — the
// user can still join with a code, where the flag check runs again.
async function findCompanyByName(name) {
  const r = await db.query(
    `SELECT id, name FROM companies WHERE lower(name) = lower($1)`, [name]);
  if (r.rows.length !== 1) return null;
  return r.rows[0];
}

// Domains of a company's CURRENT members (users.company_id). Former
// members do not tie a domain to a company.
async function memberDomains(companyId) {
  const r = await db.query(
    `SELECT email FROM users WHERE company_id = $1`, [companyId]);
  const out = new Set();
  for (const row of r.rows) {
    const d = joinFlag.emailDomain(row.email);
    if (d) out.add(d);
  }
  return out;
}

// Map domain -> Set of company ids the domain is currently tied to.
async function domainCompanyMap() {
  const r = await db.query(
    `SELECT email, company_id FROM users WHERE company_id IS NOT NULL`);
  const map = new Map();
  for (const row of r.rows) {
    const d = joinFlag.emailDomain(row.email);
    if (!d) continue;
    if (!map.has(d)) map.set(d, new Set());
    map.get(d).add(String(row.company_id));
  }
  return map;
}

// Flag reason for (email domain, target company), or null when not flagged.
async function checkJoinFlag(email, companyId) {
  const domain = joinFlag.emailDomain(email);
  if (!domain) return null;
  return joinFlag.flagReason({
    domain,
    claimedCompanyId: companyId,
    claimedMemberDomains: await memberDomains(companyId),
    domainCompanyMap: await domainCompanyMap(),
  });
}

// Reuse an existing pending request for (user, company); else insert one.
async function createPendingRequest(userId, companyId, reason) {
  const existing = await db.query(
    `SELECT id, created_at FROM company_join_requests
      WHERE user_id = $1 AND company_id = $2 AND status = 'pending' LIMIT 1`,
    [userId, companyId]);
  if (existing.rows.length) return existing.rows[0];
  const id = crypto.randomUUID();
  const r = await db.query(
    `INSERT INTO company_join_requests (id, user_id, company_id, reason)
     VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
    [id, userId, companyId, reason || null]);
  return r.rows[0];
}

// Pending requests for a company, with requester identity. Admins only —
 // never returned to regular members (applicant emails are not theirs).
async function listPendingRequests(companyId) {
  const r = await db.query(
    `SELECT r.id, r.user_id, r.reason, r.created_at, u.email, u.full_name AS name
       FROM company_join_requests r JOIN users u ON u.id = r.user_id
      WHERE r.company_id = $1 AND r.status = 'pending'
      ORDER BY r.created_at ASC`,
    [companyId]);
  return r.rows.map((row) => ({
    id: row.id,
    user_id: row.user_id,
    email: row.email,
    name: row.name || null,
    reason: row.reason || null,
    created_at: row.created_at,
  }));
}

// True when the caller may manage membership for this company: the
// companies.created_by admin, a company_admin-role member, or site admin.
function canManageCompany(req, companyRow) {
  if (!companyRow) return false;
  if (String(companyRow.created_by) === String(req.user.id)) return true;
  if (req.user.role === 'company_admin') return true;
  if (req.everestAdmin) return true;
  try {
    if (billing.isAdminEmail(req.user.email)) return true;
  } catch { /* billing helper unavailable: fall through */ }
  return false;
}

// Email the company's admins about a new pending request. Best-effort,
// never throws, never blocks the request that triggered it. Recipients:
// the companies.created_by admin + company_admin-role members.
async function notifyCompanyAdmins(companyId, requester) {
  try {
    const r = await db.query(
      `SELECT id, email FROM users WHERE company_id = $1 AND role = 'company_admin'`,
      [companyId]);
    const c = await db.query(
      `SELECT created_by FROM companies WHERE id = $1 LIMIT 1`, [companyId]);
    const emails = new Set();
    for (const row of r.rows) if (row.email) emails.add(row.email);
    if (c.rows.length && c.rows[0].created_by) {
      const a = await db.query(
        `SELECT email FROM users WHERE id = $1 LIMIT 1`, [c.rows[0].created_by]);
      if (a.rows.length && a.rows[0].email) emails.add(a.rows[0].email);
    }
    const { sendEmail } = require('../lib/notify');
    const companyName = (await db.query(
      `SELECT name FROM companies WHERE id = $1 LIMIT 1`, [companyId])).rows[0];
    const name = companyName ? companyName.name : 'your company';
    const who = `${requester.full_name || requester.email || 'A new account'}` +
      (requester.email ? ` (${requester.email})` : '');
    for (const to of emails) {
      try {
        await sendEmail({
          to,
          subject: `ShipRate: new member request for ${name}`,
          text: `${who} asked to join ${name} on ShipRate.\n\n` +
            `Their email domain does not match your company's accounts, so the request ` +
            `is waiting for your confirmation. Approve or decline it in My Company → People ` +
            `(or Settings → Company).\n\n` +
            `Until you approve, they have no access to your company's quotes, address book, ` +
            `waybills or portal — they can only quote on their own.`,
          event: 'company_join_request',
        });
      } catch { /* one bad recipient must not block the others */ }
    }
  } catch (e) {
    console.error('[company] join-request notify failed:', e.message);
  }
}

// Mark the user's other pending requests superseded (they joined a
// company, so the other requests are moot). Excludes requestId when set.
async function supersedeOtherRequests(userId, requestId) {
  if (requestId) {
    await db.query(
      `UPDATE company_join_requests SET status = 'superseded', decided_at = now()
        WHERE user_id = $1 AND status = 'pending' AND id <> $2`,
      [userId, requestId]);
  } else {
    await db.query(
      `UPDATE company_join_requests SET status = 'superseded', decided_at = now()
        WHERE user_id = $1 AND status = 'pending'`,
      [userId]);
  }
}

// GET /api/company — own company + members, or {company: null, members: []}.
// Company admins also get join_requests (pending, this company only).
router.get('/', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  try {
    const company = await getMyCompany(req.user.id);
    if (!company) return res.json({ company: null, members: [] });
    const members = await listMembers(company.id);
    const isAdmin = String(company.created_by) === String(req.user.id);
    const out = { company: { ...company, is_admin: isAdmin }, members };
    if (canManageCompany(req, company)) {
      out.join_requests = await listPendingRequests(company.id);
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'Could not load company.' });
  }
});

// GET /api/company/own-rates — the signed-in user's OWN company's portal
// markers only (never another company's). No rate values: the frontend
// needs only visibility (which carriers have own-rate rows) and the Bee
// Express corridor town lists (geography, not prices). Rating itself
// happens server-side in the board merge.
router.get('/own-rates', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  try {
    const company = await getMyCompany(req.user.id);
    if (!company) return res.json({ portal: false, carriers: [] });
    const own = await companyRates.getCompanyOwnRates(company.id);
    if (!own) return res.json({ portal: false, carriers: [] });
    res.json({
      portal: true,
      carriers: [...own.carriers.keys()],
      bee_corridor: companyRates.BEE_CORRIDOR,
    });
  } catch (e) {
    res.status(500).json({ error: 'Could not load company rates.' });
  }
});

// POST /api/company/admin-portal — site admin only: enable or disable the
// company portal ($119/mo gate, decision 1A: offline flag, not Stripe).
// Disabling stops own-rate rows + white-label + carrier-direct booking;
// the company_rates rows are kept, so re-enabling restores the portal.
router.post('/admin-portal', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  if (!billing.isAdminEmail(req.user.email)) return res.status(403).json({ error: 'Site admin only.' });
  try {
    const companyId = String((req.body && req.body.company_id) || '');
    const enabled = (req.body && req.body.enabled) === true;
    if (!/^[0-9a-f-]{36}$/i.test(companyId)) return res.status(400).json({ error: 'company_id is required.' });
    const r = await db.query('UPDATE companies SET portal_enabled = $2 WHERE id = $1 RETURNING id, portal_enabled', [companyId, enabled]);
    if (!r.rows.length) return res.status(404).json({ error: 'Unknown company.' });
    res.json({ company_id: r.rows[0].id, portal_enabled: r.rows[0].portal_enabled });
  } catch (e) {
    res.status(500).json({ error: 'Could not update the portal flag.' });
  }
});

// GET /api/company/my-requests — the caller's own pending join requests,
// with company names. Lets a flagged user see their request is waiting.
router.get('/my-requests', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  try {
    const r = await db.query(
      `SELECT r.id, r.reason, r.created_at, c.id AS company_id, c.name AS company_name
         FROM company_join_requests r JOIN companies c ON c.id = r.company_id
        WHERE r.user_id = $1 AND r.status = 'pending'
        ORDER BY r.created_at DESC`,
      [req.user.id]);
    res.json({ requests: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'Could not load join requests.' });
  }
});

// POST /api/company {name} — create; caller becomes admin; counter seeds
// above the creator's existing waybill numbers.
router.post('/', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  try {
    const name = String((req.body && req.body.name) || '').trim().slice(0, 255);
    if (!name) return res.status(400).json({ error: 'Company name is required.' });
    const existing = await getMyCompany(req.user.id);
    if (existing) return res.status(400).json({ error: 'You are already in a company. Leave it first to create a new one.' });
    const code = await genJoinCode();
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO companies (id, name, join_code, created_by) VALUES ($1, $2, $3, $4)`,
      [id, name, code, req.user.id]);
    await db.query('UPDATE users SET company_id = $1 WHERE id = $2', [id, req.user.id]);
    const seed = await maxWaybillNo(req.user.id);
    await db.query(
      `INSERT INTO company_waybill_counters (company_id, last_no) VALUES ($1, $2)`,
      [id, seed]);
    const company = await getMyCompany(req.user.id);
    const members = await listMembers(id);
    res.status(201).json({ company: { ...company, is_admin: true }, members });
  } catch (e) {
    console.error('[company] create failed:', e.message);
    res.status(500).json({ error: 'Could not create the company.' });
  }
});

// POST /api/company/join {code} — join by code. Bumps the company counter
// above the joiner's pre-join waybill numbers so company numbers never
// duplicate a member's earlier solo numbers. FLAGGED domains (see header)
// do NOT join instantly: they get a pending request (HTTP 202) and must
// wait for a company admin's confirmation.
router.post('/join', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  try {
    const code = String((req.body && req.body.code) || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'Join code is required.' });
    const existing = await getMyCompany(req.user.id);
    if (existing) return res.status(400).json({ error: 'You are already in a company. Leave it first to join another.' });
    const r = await db.query('SELECT id, name FROM companies WHERE join_code = $1 LIMIT 1', [code]);
    if (!r.rows.length) return res.status(404).json({ error: 'No company found with that join code.' });
    const companyId = r.rows[0].id;
    const flag = await checkJoinFlag(req.user.email, companyId);
    if (flag) {
      const pending = await createPendingRequest(req.user.id, companyId, flag);
      notifyCompanyAdmins(companyId, req.user).catch(() => {});
      return res.status(202).json({
        pending: true,
        company: { id: companyId, name: r.rows[0].name },
        request: { id: pending.id },
        message: 'Your email domain does not match this company, so your join request is waiting for the company admin’s confirmation. You can still quote on your own.',
      });
    }
    await db.query('UPDATE users SET company_id = $1 WHERE id = $2', [companyId, req.user.id]);
    await supersedeOtherRequests(req.user.id, null);
    const joinerMax = await maxWaybillNo(req.user.id);
    await db.query(
      `UPDATE company_waybill_counters SET last_no = GREATEST(last_no, $1) WHERE company_id = $2`,
      [joinerMax, companyId]);
    const company = await getMyCompany(req.user.id);
    const members = await listMembers(companyId);
    res.json({ company: { ...company, is_admin: false }, members });
  } catch (e) {
    console.error('[company] join failed:', e.message);
    res.status(500).json({ error: 'Could not join the company.' });
  }
});

// Shared gate for join-request decisions: the caller must be in the
// request's company AND able to manage it (creator admin, company_admin
// role, or site admin). Returns the request row or sends the error.
async function loadDecidableRequest(req, res) {
  const r = await db.query(
    `SELECT r.*, c.name AS company_name, c.created_by
       FROM company_join_requests r JOIN companies c ON c.id = r.company_id
      WHERE r.id = $1 AND r.status = 'pending' LIMIT 1`,
    [req.params.id]);
  if (!r.rows.length) {
    res.status(404).json({ error: 'Join request not found or already decided.' });
    return null;
  }
  const row = r.rows[0];
  const company = await getMyCompany(req.user.id);
  if (!company || String(company.id) !== String(row.company_id) ||
      !canManageCompany(req, row)) {
    res.status(403).json({ error: 'Only a company admin can decide this request.' });
    return null;
  }
  return row;
}

// POST /api/company/join-requests/:id/approve — company admin approves.
// The requester gets company_id (same counter bump as a code join); their
// other pending requests become superseded.
router.post('/join-requests/:id/approve', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  try {
    const row = await loadDecidableRequest(req, res);
    if (!row) return;
    const u = await db.query(
      'SELECT company_id FROM users WHERE id = $1 LIMIT 1', [row.user_id]);
    if (!u.rows.length) return res.status(404).json({ error: 'Requester account not found.' });
    if (u.rows[0].company_id) {
      return res.status(400).json({ error: 'That account is already in a company.' });
    }
    await db.query('UPDATE users SET company_id = $1 WHERE id = $2', [row.company_id, row.user_id]);
    const joinerMax = await maxWaybillNo(row.user_id);
    await db.query(
      `UPDATE company_waybill_counters SET last_no = GREATEST(last_no, $1) WHERE company_id = $2`,
      [joinerMax, row.company_id]);
    await db.query(
      `UPDATE company_join_requests SET status = 'approved', decided_at = now(), decided_by = $1 WHERE id = $2`,
      [req.user.id, row.id]);
    await supersedeOtherRequests(row.user_id, row.id);
    res.json({ ok: true, approved: row.id });
  } catch (e) {
    console.error('[company] join-request approve failed:', e.message);
    res.status(500).json({ error: 'Could not approve the request.' });
  }
});

// POST /api/company/join-requests/:id/decline — company admin declines.
// The requester stays solo and can still quote on their own.
router.post('/join-requests/:id/decline', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  try {
    const row = await loadDecidableRequest(req, res);
    if (!row) return;
    await db.query(
      `UPDATE company_join_requests SET status = 'declined', decided_at = now(), decided_by = $1 WHERE id = $2`,
      [req.user.id, row.id]);
    res.json({ ok: true, declined: row.id });
  } catch (e) {
    console.error('[company] join-request decline failed:', e.message);
    res.status(500).json({ error: 'Could not decline the request.' });
  }
});

// POST /api/company/leave — leave. Admin transfers to the earliest-joined
// remaining member; if the leaver is the last member, the company dissolves
// and its waybills revert to their creators' solo lists (numbers unchanged).
router.post('/leave', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  try {
    const company = await getMyCompany(req.user.id);
    if (!company) return res.status(400).json({ error: 'You are not in a company.' });
    const members = await listMembers(company.id);
    const others = members.filter((m) => String(m.id) !== String(req.user.id));
    const isAdmin = String(company.created_by) === String(req.user.id);
    await db.query('UPDATE users SET company_id = NULL WHERE id = $1', [req.user.id]);
    if (others.length) {
      if (isAdmin) {
        // Transfer admin to the earliest remaining member (lowest member id
        // order is by name; use the first remaining member row).
        await db.query('UPDATE companies SET created_by = $1 WHERE id = $2', [others[0].id, company.id]);
      }
    } else {
      // Last member out: dissolve. Waybills keep their numbers; they just
      // stop being company waybills.
      await db.query('UPDATE waybills SET company_id = NULL WHERE company_id = $1', [company.id]);
      await db.query('DELETE FROM company_waybill_counters WHERE company_id = $1', [company.id]);
      await db.query('DELETE FROM companies WHERE id = $1', [company.id]);
    }
    res.json({ ok: true, left: company.name });
  } catch (e) {
    console.error('[company] leave failed:', e.message);
    res.status(500).json({ error: 'Could not leave the company.' });
  }
});

// POST /api/company/members/:id/remove — admin removes a member (not self).
// The removed member's company waybills stay with the company.
router.post('/members/:id/remove', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  try {
    const company = await getMyCompany(req.user.id);
    if (!company) return res.status(400).json({ error: 'You are not in a company.' });
    if (String(company.created_by) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Only the company admin can remove members.' });
    }
    const targetId = req.params.id;
    if (String(targetId) === String(req.user.id)) {
      return res.status(400).json({ error: 'To remove yourself, use Leave company.' });
    }
    const r = await db.query(
      'UPDATE users SET company_id = NULL WHERE id = $1 AND company_id = $2 RETURNING id',
      [targetId, company.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Member not found in this company.' });
    res.json({ ok: true, removed: targetId });
  } catch (e) {
    console.error('[company] remove failed:', e.message);
    res.status(500).json({ error: 'Could not remove the member.' });
  }
});

module.exports = router;
// Reused by the signup hook (routes/auth.js): the flag check + pending
// request creation must run on the same company tables, not a copy.
module.exports.joinFlagHelpers = {
  findCompanyByName, checkJoinFlag, createPendingRequest, notifyCompanyAdmins,
  listPendingRequests,
};
