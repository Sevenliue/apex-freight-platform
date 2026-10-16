// routes/waybills.js — saved waybills (bills of lading) with auto-sequenced numbers.
//
// Each account gets its own sequence: WB-000001, WB-000002, … minted
// atomically on save (no gaps burned by abandoned drafts). Waybill bodies are
// stored as JSON and listed/loaded as full history.
//
// Endpoints (all require sign-in):
//   GET    /api/waybills        list saved waybills, newest first
//   POST   /api/waybills        save new {bol_json, shipment_id?} -> assigns waybill_no
//   GET    /api/waybills/:id    fetch one
//   PUT    /api/waybills/:id    update {bol_json} (keeps its number)
//   POST   /api/waybills/:id/email  email the saved waybill to shipper + receiver
//   DELETE /api/waybills/:id    delete one
//
// Tables are created on boot (CREATE TABLE IF NOT EXISTS).
'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');

const router = express.Router();

async function ensureWaybillTables() {
  if (!db.isEnabled()) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS waybill_counters (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      last_no INTEGER NOT NULL DEFAULT 0
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS waybills (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      waybill_no TEXT NOT NULL,
      shipment_id TEXT,
      bol_json JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, waybill_no)
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS waybills_user_idx ON waybills (user_id, created_at DESC)`);
  // Company grouping (added 2026-10-16): company waybills carry the
  // company id so members can see each other's waybills. Plain uuid (no FK)
  // so this stays idempotent regardless of statement order.
  await db.query(`ALTER TABLE waybills ADD COLUMN IF NOT EXISTS company_id UUID`);
  await db.query(`CREATE INDEX IF NOT EXISTS waybills_company_idx ON waybills (company_id, created_at DESC)`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS waybills_company_no_uidx ON waybills (company_id, waybill_no) WHERE company_id IS NOT NULL`);
}
ensureWaybillTables().catch((e) => console.error('[waybills] table setup failed:', e.message));

function needUser(req, res) {
  if (!req.user) { res.status(401).json({ error: 'Sign in to use waybills.' }); return false; }
  return true;
}
function needDb(res) {
  if (!db.isEnabled()) { res.status(503).json({ error: 'Waybill history is unavailable right now.' }); return false; }
  return true;
}
function cleanStr(v, max) {
  return String(v || '').trim().slice(0, max) || null;
}
function fmtNo(n) { return 'WB-' + String(n).padStart(6, '0'); }

// Mint the next sequence number for this user, atomically.
async function nextWaybillNo(userId) {
  const r = await db.query(`
    INSERT INTO waybill_counters (user_id, last_no) VALUES ($1, 1)
    ON CONFLICT (user_id) DO UPDATE SET last_no = waybill_counters.last_no + 1
    RETURNING last_no`, [userId]);
  return fmtNo(r.rows[0].last_no);
}

// Mint the next sequence number for a company, atomically. Company members
// share ONE sequence; the counter is seeded above all members' pre-join
// numbers when the company is created / joined (see routes/company.js).
async function nextCompanyWaybillNo(companyId) {
  const r = await db.query(`
    INSERT INTO company_waybill_counters (company_id, last_no) VALUES ($1, 1)
    ON CONFLICT (company_id) DO UPDATE SET last_no = company_waybill_counters.last_no + 1
    RETURNING last_no`, [companyId]);
  return fmtNo(r.rows[0].last_no);
}

// The caller's company id (null when solo). Read fresh per request so a
// join/leave takes effect immediately.
async function callerCompanyId(userId) {
  try {
    const r = await db.query('SELECT company_id FROM users WHERE id = $1 LIMIT 1', [userId]);
    return (r.rows[0] && r.rows[0].company_id) || null;
  } catch { return null; }
}

const LIST_COLS = 'w.id, w.waybill_no, w.shipment_id, w.bol_json, w.created_at, w.updated_at, w.user_id, w.company_id, u.full_name AS created_by_name, u.email AS created_by_email';
const LIST_FROM = 'FROM waybills w JOIN users u ON u.id = w.user_id';

// Company members see all waybills of their company; everyone sees their
// own. Solo users (company_id null) see only their own.
function visibilitySql(userId, companyId, params) {
  params.push(userId);
  if (companyId) {
    params.push(companyId);
    return `(w.user_id = $${params.length - 1} OR (w.company_id IS NOT NULL AND w.company_id = $${params.length}))`;
  }
  return `(w.user_id = $${params.length})`;
}

router.get('/', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  try {
    const companyId = await callerCompanyId(req.user.id);
    const params = [];
    const vis = visibilitySql(req.user.id, companyId, params);
    let where = vis;
    // ?member=<user_id> — filter to one member's waybills (company only).
    if (req.query.member) {
      params.push(String(req.query.member));
      where += ` AND w.user_id = $${params.length}`;
    }
    // ?sort=date|number|user & ?dir=asc|desc. Defaults: newest first.
    const sortKey = String(req.query.sort || 'date');
    const dir = String(req.query.dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const orderBy = sortKey === 'number' ? `w.waybill_no ${dir}`
      : sortKey === 'user' ? `u.full_name ${dir}, w.created_at DESC`
      : `w.created_at ${dir}`;
    const r = await db.query(
      `SELECT ${LIST_COLS} ${LIST_FROM} WHERE ${where} ORDER BY ${orderBy} LIMIT 500`,
      params);
    res.json({ rows: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'Could not load waybill history.' });
  }
});

router.post('/', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  try {
    const bolJson = req.body && typeof req.body.bol_json === 'object' && req.body.bol_json
      ? req.body.bol_json : {};
    const shipmentId = cleanStr(req.body && req.body.shipment_id, 64);
    // Company members draw from the ONE shared company sequence and the
    // waybill is tagged with the company; solo users keep their own counter.
    const companyId = await callerCompanyId(req.user.id);
    const waybillNo = companyId
      ? await nextCompanyWaybillNo(companyId)
      : await nextWaybillNo(req.user.id);
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO waybills (id, user_id, company_id, waybill_no, shipment_id, bol_json)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, req.user.id, companyId, waybillNo, shipmentId, JSON.stringify(bolJson)]);
    const r = await db.query(
      `SELECT ${LIST_COLS} ${LIST_FROM} WHERE w.id = $1`, [id]);
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error('[waybills] save failed:', e.message);
    res.status(500).json({ error: 'Could not save the waybill.' });
  }
});

router.get('/:id', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  try {
    // Owner, or a company member when the waybill belongs to their company.
    // Editing/deleting stays owner-only (PUT/DELETE below).
    const companyId = await callerCompanyId(req.user.id);
    const params = [req.params.id, req.user.id];
    let vis = `w.user_id = $2`;
    if (companyId) {
      params.push(companyId);
      vis = `(w.user_id = $2 OR (w.company_id IS NOT NULL AND w.company_id = $3))`;
    }
    const r = await db.query(
      `SELECT ${LIST_COLS} ${LIST_FROM} WHERE w.id = $1 AND ${vis}`,
      params);
    if (!r.rows.length) return res.status(404).json({ error: 'Waybill not found.' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Could not load the waybill.' });
  }
});

router.put('/:id', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  try {
    const bolJson = req.body && typeof req.body.bol_json === 'object' && req.body.bol_json
      ? req.body.bol_json : {};
    const r = await db.query(
      `UPDATE waybills SET bol_json = $1, updated_at = now()
       WHERE id = $2 AND user_id = $3
       RETURNING id`,
      [JSON.stringify(bolJson), req.params.id, req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Waybill not found.' });
    const full = await db.query(
      `SELECT ${LIST_COLS} ${LIST_FROM} WHERE w.id = $1`, [r.rows[0].id]);
    res.json(full.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Could not update the waybill.' });
  }
});

// POST /api/waybills/:id/email — email the saved waybill to the shipper and
// receiver addresses on file. Best-effort: per-recipient results are returned
// and email failure never affects the saved waybill (the frontend saves
// first, then calls this). No PDF attachment — the email carries the full
// waybill as HTML + plain text.
const { sendEmail } = require('../lib/notify');

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const LOGO_RE = /^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/;
function validLogo(v) {
  return typeof v === 'string' && v.length <= 900000 && LOGO_RE.test(v);
}
function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
}
function bolField(bol, flatKey, nestedObj) {
  const v = bol[flatKey];
  if (v != null && String(v).trim() !== '') return String(v);
  if (nestedObj && nestedObj.email) return String(nestedObj.email);
  return '';
}
function buildWaybillEmail(bol, waybillNo, logo) {
  const ship = {
    name: bol['shipper.name'] || '', street: bol['shipper.street'] || '',
    cityprov: bol['shipper.cityprov'] || '', postal: bol['shipper.postal'] || '',
    contact: bol['shipper.contact'] || '', phone: bol['shipper.phone'] || '',
    email: bolField(bol, 'shipper.email', bol.shipper),
  };
  const cons = {
    name: bol['consignee.name'] || '', street: bol['consignee.street'] || '',
    cityprov: bol['consignee.cityprov'] || '', postal: bol['consignee.postal'] || '',
    contact: bol['consignee.contact'] || '', phone: bol['consignee.phone'] || '',
    email: bolField(bol, 'consignee.email', bol.consignee),
  };
  const pkgs = Array.isArray(bol.pkgs) ? bol.pkgs : [];
  const totQty = pkgs.reduce((a, p) => a + (parseFloat(p.qty) || 0), 0);
  const totWt = pkgs.reduce((a, p) => a + (parseFloat(p.wt) || 0), 0);
  const meta = [
    ['BOL No.', waybillNo],
    ['Date', bol.date || ''],
    ['PO No.', bol.po_no || ''],
    ['Shipper ref', bol.shipper_ref || ''],
    ['Carrier', bol['carrier.name'] || ''],
    ['Trailer No.', bol['carrier.trailer'] || ''],
    ['Seal No.', bol['carrier.seal'] || ''],
    ['PRO No.', bol['carrier.pro'] || ''],
    ['Freight charges', bol.fterms || 'prepaid'],
    ['Bill to', bol.bill_to || ''],
  ];
  const subject = `Bill of Lading ${waybillNo} — ${ship.name || '?'} → ${cons.name || '?'}`;
  const partyText = (label, p) =>
    `${label}\n${p.name}\n${p.street}\n${p.cityprov} ${p.postal}\nContact: ${p.contact} · Phone: ${p.phone} · Email: ${p.email}`.replace(/\n+/g, '\n').trim();
  const itemLines = pkgs.map((p) =>
    `- Part: ${p.part || '—'} | ${p.desc || '—'} | Qty: ${p.qty || ''} ${p.units || ''} | Wt: ${p.wt || ''} lb | Dims: ${[p.l, p.w, p.h].filter((x) => x !== '' && x != null).join('×') || '—'} | Class: ${p.cls || '—'}`).join('\n');
  const dgLine = (bol.dg === true || bol.dg === 'true' || bol.dg === 'on')
    ? `\nDangerous goods: YES — UN No. ${bol.dg_un || '—'} · Class ${bol.dg_class || '—'}`
    : '';
  const text = [
    `Bill of Lading ${waybillNo}`,
    '', ...meta.map(([k, v]) => `${k}: ${v || '—'}`),
    '', partyText('SHIPPER (FROM)', ship),
    '', partyText('CONSIGNEE (TO)', cons),
    '', 'DESCRIPTION OF ARTICLES',
    itemLines || '(no items listed)',
    `Total pieces: ${totQty} · Total weight: ${totWt} lb`,
    dgLine,
    '', 'Please confirm receipt of this bill of lading. — ShipRate',
  ].join('\n');
  const itemRows = pkgs.map((p) => {
    const dims = [p.l, p.w, p.h].filter((x) => x !== '' && x != null).join(' × ') || '—';
    return `<tr><td>${escHtml(p.part || '—')}</td><td>${escHtml(p.desc || '—')}</td><td style="text-align:right">${escHtml(p.qty || '')}</td><td>${escHtml(p.units || '')}</td><td style="text-align:right">${escHtml(p.wt || '')}</td><td>${escHtml(dims)}</td><td>${escHtml(p.cls || '—')}</td></tr>`;
  }).join('');
  const html = [
    `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1c1c1c;max-width:640px">`,
    ...(validLogo(logo) ? [`<img src="${logo}" alt="" style="max-height:48px;max-width:200px;object-fit:contain;margin-bottom:8px">`] : []),
    `<h2 style="margin:0 0 4px">Bill of Lading — ${escHtml(waybillNo)}</h2>`,
    `<table cellpadding="4" cellspacing="0" style="border-collapse:collapse;margin:10px 0">`,
    ...meta.map(([k, v]) => `<tr><td style="font-weight:bold;padding-right:10px">${escHtml(k)}</td><td>${escHtml(v || '—')}</td></tr>`),
    `</table>`,
    `<h3 style="margin:12px 0 4px">Shipper (from)</h3><p style="margin:0">${escHtml(ship.name)}<br>${escHtml(ship.street)}<br>${escHtml([ship.cityprov, ship.postal].filter(Boolean).join(' '))}<br>Contact: ${escHtml(ship.contact)} · Phone: ${escHtml(ship.phone)} · Email: ${escHtml(ship.email)}</p>`,
    `<h3 style="margin:12px 0 4px">Consignee (to)</h3><p style="margin:0">${escHtml(cons.name)}<br>${escHtml(cons.street)}<br>${escHtml([cons.cityprov, cons.postal].filter(Boolean).join(' '))}<br>Contact: ${escHtml(cons.contact)} · Phone: ${escHtml(cons.phone)} · Email: ${escHtml(cons.email)}</p>`,
    `<h3 style="margin:12px 0 4px">Description of articles</h3>`,
    `<table cellpadding="5" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:13px"><thead><tr style="background:#eef2f0"><th align="left">Part No.</th><th align="left">Description</th><th align="right">Qty</th><th align="left">Units</th><th align="right">Wt (lb)</th><th align="left">Dims</th><th align="left">Class</th></tr></thead><tbody>${itemRows || '<tr><td colspan="7">(no items listed)</td></tr>'}</tbody></table>`,
    `<p><strong>Total pieces:</strong> ${totQty} &nbsp;·&nbsp; <strong>Total weight:</strong> ${totWt} lb</p>`,
    dgLine ? `<p><strong>Dangerous goods:</strong> YES — UN No. ${escHtml(bol.dg_un || '—')} · Class ${escHtml(bol.dg_class || '—')}</p>` : '',
    `<p style="color:#6b7280;font-size:12px">Please confirm receipt of this bill of lading. — ShipRate</p>`,
    `</div>`,
  ].join('');
  return { subject, text, html, shipEmail: ship.email, consEmail: cons.email };
}

router.post('/:id/email', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  try {
    const r = await db.query(
      `SELECT waybill_no, bol_json, user_id FROM waybills WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Waybill not found.' });
    const row = r.rows[0];
    // Creator's logo for the emailed waybill (best effort; email sends
    // without it when none is set).
    let creatorLogo = null;
    try {
      const lr = await db.query('SELECT logo FROM users WHERE id = $1 LIMIT 1', [row.user_id]);
      if (lr.rows[0] && validLogo(lr.rows[0].logo)) creatorLogo = lr.rows[0].logo;
    } catch { /* logo stays null */ }
    let bol = {};
    try { bol = typeof row.bol_json === 'object' ? row.bol_json || {} : JSON.parse(row.bol_json || '{}'); } catch { /* ignore */ }
    const { subject, text, html, shipEmail, consEmail } = buildWaybillEmail(bol, row.waybill_no, creatorLogo);
    const targets = [
      { role: 'Shipper', to: shipEmail },
      { role: 'Receiver', to: consEmail },
    ];
    const results = [];
    for (const t of targets) {
      const to = String(t.to || '').trim();
      if (!to) { results.push({ role: t.role, to: t.role, skipped: true, reason: 'no email on file' }); continue; }
      if (!isEmail(to)) { results.push({ role: t.role, to, skipped: true, reason: 'invalid email address' }); continue; }
      const out = await sendEmail({ to, subject, text, html, event: 'waybill_email' });
      if (out.sent || out.logged) results.push({ role: t.role, to, sent: true });
      else if (out.skipped) results.push({ role: t.role, to, skipped: true, reason: out.skipped });
      else results.push({ role: t.role, to, failed: true, reason: out.failed || 'send failed' });
    }
    res.json({ results });
  } catch (e) {
    console.error('[waybills] email failed:', e.message);
    res.status(500).json({ error: 'Could not send the waybill email.' });
  }
});

router.delete('/:id', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  try {
    const r = await db.query(
      `DELETE FROM waybills WHERE id = $1 AND user_id = $2 RETURNING waybill_no`,
      [req.params.id, req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Waybill not found.' });
    res.json({ deleted: r.rows[0].waybill_no });
  } catch (e) {
    res.status(500).json({ error: 'Could not delete the waybill.' });
  }
});

module.exports = router;
