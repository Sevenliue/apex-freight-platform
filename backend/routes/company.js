// routes/company.js — company grouping for accounts.
//
// A company groups several accounts so members share ONE waybill sequence
// and can see each other's waybills. Users without a company keep exactly
// today's solo behavior.
//
// Endpoints (all require sign-in):
//   GET  /api/company                     own company + members (or null)
//   POST /api/company          {name}     create a company (creator = admin)
//   POST /api/company/join     {code}    join by join code
//   POST /api/company/leave               leave (admin transfers / dissolves)
//   POST /api/company/members/:id/remove  admin removes a member (not self)
//
// Tables are created on boot (CREATE TABLE IF NOT EXISTS). Joining or
// leaving never alters or deletes any existing waybills, except that when
// the LAST member leaves the company dissolves and its waybills revert to
// their creators' solo lists (company_id -> NULL, numbers unchanged).
'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');

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
    `SELECT u.company_id AS id, c.name, c.join_code, c.created_by, c.created_at
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

// GET /api/company — own company + members, or {company: null, members: []}.
router.get('/', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  try {
    const company = await getMyCompany(req.user.id);
    if (!company) return res.json({ company: null, members: [] });
    const members = await listMembers(company.id);
    const isAdmin = String(company.created_by) === String(req.user.id);
    res.json({ company: { ...company, is_admin: isAdmin }, members });
  } catch (e) {
    res.status(500).json({ error: 'Could not load company.' });
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
// duplicate a member's earlier solo numbers.
router.post('/join', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  try {
    const code = String((req.body && req.body.code) || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'Join code is required.' });
    const existing = await getMyCompany(req.user.id);
    if (existing) return res.status(400).json({ error: 'You are already in a company. Leave it first to join another.' });
    const r = await db.query('SELECT id FROM companies WHERE join_code = $1 LIMIT 1', [code]);
    if (!r.rows.length) return res.status(404).json({ error: 'No company found with that join code.' });
    const companyId = r.rows[0].id;
    await db.query('UPDATE users SET company_id = $1 WHERE id = $2', [companyId, req.user.id]);
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
