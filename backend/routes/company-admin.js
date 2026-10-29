// routes/company-admin.js — "My Company" for shipper company admins.
//
// A company admin (users.role = 'company_admin', assigned ONLY by the site
// admin — see POST /api/admin/users/:id/company-admin) manages their own
// company's people, quote history and address book. Site admins may also
// open the section; they see it scoped to their own company, if any.
// Carriers do not get this layer, and regular users get 403 everywhere
// below.
//
// SECURITY MODEL
// - The company scope ALWAYS comes from the caller's own account row
//   (req.user.company_id, re-read from the users table by the session
//   lookup on every request). It is never taken from request input.
// - Quote payloads are built field-by-field and contain ONLY what the
//   company itself was quoted: lane, carrier, service, delivery estimate
//   and the retail total. Carrier cost / base / FSC / accessorial amounts
//   / markup are never copied into this payload — the admin quote log
//   (routes/admin.js) is the only place those exist.
// - People edits whitelist full_name + phone. role, shipping_approved,
//   markup_percent, email and password are not writable through here;
//   approvals always stay with the site admin.
'use strict';

const express = require('express');
const db = require('../db');
const billing = require('../lib/billing');

const router = express.Router();

// Boot migration: the user_role enum predates this feature. Adding the new
// value is idempotent and runs as its own implicit transaction (the value
// is only USED by later requests, after this commits). Fresh databases get
// the value from db/schema.sql instead. Failures are logged, never fatal.
async function ensureRoleValue() {
  if (!db.isEnabled()) return;
  try {
    await db.query(`ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'company_admin'`);
  } catch (e1) {
    try {
      await db.query(`ALTER TYPE user_role ADD VALUE 'company_admin'`);
    } catch (e2) {
      if (!/already exists|duplicate/i.test(String(e2.message))) {
        console.error('[company-admin] role enum setup failed:', e2.message);
      }
    }
  }
}
ensureRoleValue().catch(() => {});

// Gate for every route below: signed in AND (company_admin OR site admin).
// Attaches req.companyScope = { companyId, isSiteAdmin }.
function requireCompanyAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  if (!db.isEnabled()) {
    return res.status(503).json({ error: 'Company features are unavailable right now.' });
  }
  const isSiteAdmin = !!req.everestAdmin || billing.isAdminEmail(req.user.email);
  if (req.user.role === 'company_admin' || isSiteAdmin) {
    req.companyScope = { companyId: req.user.company_id || null, isSiteAdmin };
    return next();
  }
  return res.status(403).json({ error: 'Company admin access required.' });
}
router.use(requireCompanyAdmin);

async function companyRow(companyId) {
  if (!companyId) return null;
  const r = await db.query('SELECT id, name FROM companies WHERE id = $1 LIMIT 1', [companyId]);
  return r.rows.length ? { id: r.rows[0].id, name: r.rows[0].name } : null;
}

function personShape(u, callerId) {
  return {
    id: u.id,
    name: u.full_name || null,
    email: u.email,
    phone: u.phone || null,
    role: u.role,
    shipping_approved: !!u.shipping_approved,
    is_you: String(u.id) === String(callerId),
  };
}

// GET /api/company-admin/people — the caller's company's accounts, plus
// pending company-join requests awaiting this admin's confirmation
// (company-join flag, 2026-10-28). Requests carry no cost/margin data.
router.get('/people', async (req, res) => {
  const { companyId } = req.companyScope;
  try {
    if (!companyId) return res.json({ company: null, people: [], join_requests: [] });
    const company = await companyRow(companyId);
    const r = await db.query(
      `SELECT id, email, full_name, phone, role, shipping_approved
         FROM users WHERE company_id = $1
        ORDER BY full_name NULLS LAST, email`,
      [companyId]
    );
    let joinRequests = [];
    try {
      const { listPendingRequests } = require('./company').joinFlagHelpers;
      joinRequests = await listPendingRequests(companyId);
    } catch (e) {
      console.error('[company-admin] join requests failed:', e.message);
    }
    return res.json({ company, people: r.rows.map((u) => personShape(u, req.user.id)), join_requests: joinRequests });
  } catch (err) {
    return res.status(502).json({ error: 'Could not load company people: ' + err.message });
  }
});

// PUT /api/company-admin/people/:id — edit a company member's name/phone.
// Anything else in the body (role, shipping_approved, email, markup, …) is
// ignored by construction: only the two whitelisted columns are ever set.
router.put('/people/:id', async (req, res) => {
  const { companyId } = req.companyScope;
  if (!companyId) return res.status(400).json({ error: 'Your account is not assigned to a company.' });
  const b = req.body || {};
  const sets = [];
  const vals = [];
  let i = 1;
  if (b.name !== undefined) {
    const name = String(b.name || '').trim().slice(0, 255);
    if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
    sets.push(`full_name = $${i++}`);
    vals.push(name);
  }
  if (b.phone !== undefined) {
    sets.push(`phone = $${i++}`);
    vals.push(String(b.phone || '').trim().slice(0, 50) || null);
  }
  if (!sets.length) {
    return res.status(400).json({ error: 'Nothing to update — only name and phone can be edited here.' });
  }
  try {
    vals.push(req.params.id, companyId);
    const r = await db.query(
      `UPDATE users SET ${sets.join(', ')}
        WHERE id = $${i++} AND company_id = $${i++}
        RETURNING id, email, full_name, phone, role, shipping_approved`,
      vals
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Person not found in your company.' });
    return res.json({ person: personShape(r.rows[0], req.user.id) });
  } catch (err) {
    return res.status(502).json({ error: 'Could not update person: ' + err.message });
  }
});

// GET /api/company-admin/quotes — quote history for the caller's company,
// with the totals the company was quoted (retail). Cost-side data is never
// selected into the response — see the header comment.
router.get('/quotes', async (req, res) => {
  const { companyId } = req.companyScope;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
  try {
    if (!companyId) return res.json({ company: null, quotes: [] });
    const company = await companyRow(companyId);
    const r = await db.query(
      `SELECT q.id, q.quote_no, q.created_at, q.origin_city, q.origin_state,
              q.dest_city, q.dest_state, q.parcel_weight, q.is_saved, q.rates_json,
              u.email AS user_email, u.full_name AS user_name
         FROM quotes q JOIN users u ON u.id = q.user_id
        WHERE u.company_id = $1
        ORDER BY q.created_at DESC LIMIT $2`,
      [companyId, limit]
    );
    const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
    const quotes = r.rows.map((row) => {
      let rates = [];
      try {
        const raw = typeof row.rates_json === 'string' ? JSON.parse(row.rates_json) : (row.rates_json || []);
        rates = (Array.isArray(raw) ? raw : [])
          .map((x) => ({
            carrier: x.carrier || null,
            service: x.service || null,
            delivery_days: x.delivery_days || null,
            est_delivery_date: x.est_delivery_date || null,
            // The total quoted to the customer. Retail only — base_cad,
            // fsc_*, accessorial amounts and cost_cad are deliberately
            // never copied into this payload.
            total_cad: num(x.retail_cad),
          }))
          .filter((x) => x.carrier || x.total_cad != null);
      } catch { /* malformed rates_json: leave empty */ }
      return {
        id: row.id,
        quote_no: row.quote_no || null,
        created_at: row.created_at,
        ran_by: row.user_name || row.user_email,
        ran_by_email: row.user_email,
        origin: [row.origin_city, row.origin_state].filter(Boolean).join(', '),
        destination: [row.dest_city, row.dest_state].filter(Boolean).join(', '),
        weight_lbs: num(row.parcel_weight),
        is_saved: !!row.is_saved,
        rates,
      };
    });
    return res.json({ company, quotes });
  } catch (err) {
    return res.status(502).json({ error: 'Could not load company quotes: ' + err.message });
  }
});

// ---------------------------------------------------------------------------
// Address book — entries owned by any user in the caller's company.
// New entries created here belong to the caller; they never touch another
// member's ★ primary flag.
// ---------------------------------------------------------------------------

function cleanAddress(body) {
  const b = body || {};
  const str = (v, max) => String(v == null ? '' : v).slice(0, max).trim();
  return {
    label: str(b.label, 120),
    company: str(b.company, 160),
    contact_name: str(b.contact_name, 120),
    street: str(b.street, 160),
    city: str(b.city, 80),
    province: str(b.province, 40),
    postal: str(b.postal, 20),
    country: str(b.country, 40) || 'CA',
    phone: str(b.phone, 40),
    email: str(b.email, 160),
  };
}

function addrShape(row) {
  return {
    id: row.id,
    user_id: row.user_id || null,
    owner_email: row.owner_email || null,
    owner_name: row.owner_name || null,
    label: row.label,
    company: row.company,
    contact_name: row.contact_name,
    street: row.street,
    city: row.city,
    province: row.province,
    postal: row.postal,
    country: row.country,
    phone: row.phone,
    email: row.email,
    is_primary: !!row.is_primary,
    created_at: row.created_at,
  };
}

const ADDR_SELECT = `
  SELECT a.*, u.email AS owner_email, u.full_name AS owner_name
    FROM address_book a JOIN users u ON u.id = a.user_id`;

router.get('/address-book', async (req, res) => {
  const { companyId } = req.companyScope;
  try {
    if (!companyId) return res.json({ company: null, addresses: [] });
    const company = await companyRow(companyId);
    const r = await db.query(
      `${ADDR_SELECT} WHERE u.company_id = $1 ORDER BY a.created_at DESC LIMIT 500`,
      [companyId]
    );
    return res.json({ company, addresses: r.rows.map(addrShape) });
  } catch (err) {
    return res.status(502).json({ error: 'Could not list company addresses: ' + err.message });
  }
});

router.post('/address-book', async (req, res) => {
  const { companyId } = req.companyScope;
  if (!companyId) return res.status(400).json({ error: 'Your account is not assigned to a company.' });
  const a = cleanAddress(req.body);
  if (!a.label || !a.city) return res.status(400).json({ error: 'label and city are required' });
  try {
    // Same per-account dedupe as the personal address book.
    const dup = await db.query(
      `SELECT id FROM address_book
        WHERE user_id = $1 AND lower(street) = lower($2) AND lower(city) = lower($3)
          AND lower(coalesce(postal,'')) = lower($4) LIMIT 1`,
      [req.user.id, a.street, a.city, a.postal]
    );
    if (dup.rows.length) {
      const r = await db.query(`${ADDR_SELECT} WHERE a.id = $1`, [dup.rows[0].id]);
      return res.json({ address: addrShape(r.rows[0]), duplicate: true });
    }
    const ins = await db.query(
      `INSERT INTO address_book (user_id, label, company, contact_name, street, city, province, postal, country, phone, email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [req.user.id, a.label, a.company || null, a.contact_name || null, a.street || null, a.city,
       a.province || null, a.postal || null, a.country, a.phone || null, a.email || null]
    );
    const r = await db.query(`${ADDR_SELECT} WHERE a.id = $1`, [ins.rows[0].id]);
    return res.status(201).json({ address: addrShape(r.rows[0]) });
  } catch (err) {
    return res.status(502).json({ error: 'Could not save address: ' + err.message });
  }
});

router.put('/address-book/:id', async (req, res) => {
  const { companyId } = req.companyScope;
  if (!companyId) return res.status(400).json({ error: 'Your account is not assigned to a company.' });
  const a = cleanAddress(req.body);
  if (!a.label || !a.city) return res.status(400).json({ error: 'label and city are required' });
  try {
    const r = await db.query(
      `UPDATE address_book
          SET label=$3, company=$4, contact_name=$5, street=$6, city=$7,
              province=$8, postal=$9, country=$10, phone=$11, email=$12
        WHERE id=$1
          AND user_id IN (SELECT id FROM users WHERE company_id = $2)
        RETURNING id`,
      [req.params.id, companyId, a.label, a.company || null, a.contact_name || null, a.street || null,
       a.city, a.province || null, a.postal || null, a.country, a.phone || null, a.email || null]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Address not found in your company.' });
    const full = await db.query(`${ADDR_SELECT} WHERE a.id = $1`, [req.params.id]);
    return res.json({ address: addrShape(full.rows[0]) });
  } catch (err) {
    return res.status(502).json({ error: 'Could not update address: ' + err.message });
  }
});

router.delete('/address-book/:id', async (req, res) => {
  const { companyId } = req.companyScope;
  if (!companyId) return res.status(400).json({ error: 'Your account is not assigned to a company.' });
  try {
    const r = await db.query(
      `DELETE FROM address_book
        WHERE id = $1 AND user_id IN (SELECT id FROM users WHERE company_id = $2)
        RETURNING id`,
      [req.params.id, companyId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Address not found in your company.' });
    return res.json({ deleted: true });
  } catch (err) {
    return res.status(502).json({ error: 'Could not delete address: ' + err.message });
  }
});

module.exports = router;
// Reused by the admin promote endpoint: setting role='company_admin' needs
// the enum value to exist even if this module's boot migration raced a
// fresh database's schema setup.
module.exports.ensureRoleValue = ensureRoleValue;
