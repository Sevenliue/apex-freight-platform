// routes/waybills.js — saved waybills (bills of lading) with auto-sequenced numbers.
//
// Each account gets its own sequence: WB-000001, WB-000002, … minted
// atomically on save (no gaps burned by abandoned drafts). Waybill bodies are
// stored as JSON and listed/loaded as full history.
//
// Endpoints (all require sign-in, except pod-ingest which uses a shared
// secret — it is called by the Cloudflare Email Worker for pod@shiprate.ca,
// not by a signed-in user):
//   GET    /api/waybills        list saved waybills, newest first
//   POST   /api/waybills        save new {bol_json, shipment_id?} -> assigns waybill_no
//   GET    /api/waybills/:id    fetch one
//   PUT    /api/waybills/:id    update {bol_json} (keeps its number)
//   POST   /api/waybills/:id/email  email the saved waybill to shipper + receiver
//   DELETE /api/waybills/:id    delete one
//   POST   /api/waybills/pod-ingest   file a POD photo from an inbound email
//   GET    /api/waybills/pod-unmatched  admin: PODs that could not be matched
//   GET    /api/waybills/pod/:podId      admin: one POD, with its photo
//   POST   /api/waybills/pod/:podId/match  admin: file an unmatched POD to a waybill
//   DELETE /api/waybills/pod/:podId      admin: discard a POD
//   GET    /api/waybills/:id/pod        latest filed POD photo for one waybill
//
// Tables are created on boot (CREATE TABLE IF NOT EXISTS).
'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const billing = require('../lib/billing');

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
  // Proof-of-delivery photos, filed by email (pod@shiprate.ca) or matched
  // by hand. waybill_id is NULL while a POD is unmatched; image_data is a
  // data URL (capped ~9MB of base64 ≈ a 6-7MB phone photo).
  await db.query(`
    CREATE TABLE IF NOT EXISTS waybill_pods (
      id UUID PRIMARY KEY,
      waybill_id UUID REFERENCES waybills(id) ON DELETE CASCADE,
      waybill_no TEXT NOT NULL DEFAULT '',
      sender_email TEXT,
      subject TEXT,
      filename TEXT,
      mime_type TEXT,
      image_data TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'unmatched',
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS waybill_pods_waybill_idx ON waybill_pods (waybill_id, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS waybill_pods_status_idx ON waybill_pods (status, created_at DESC)`);  // Company grouping (added 2026-10-16): company waybills carry the
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

// ---- POD (proof of delivery) helpers ----
// A WB number looks like WB-000123. Extract the first one from free text
// (an email subject line), upper-cased, or null.
function extractWaybillNo(text) {
  var m = String(text || '').match(/WB-(\d{6})/i);
  return m ? 'WB-' + m[1] : null;
}
// POD photos arrive as data URLs. Cap ~9MB of base64 (~6-7MB of photo).
var POD_IMAGE_RE = /^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/;
function validPodImage(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 9000000 && POD_IMAGE_RE.test(v);
}
// Constant-time secret comparison (lengths must match first).
function secretsEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  var ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
// The pod-ingest endpoint is called by the Cloudflare Email Worker, not a
// signed-in user, so it authenticates with a shared secret instead.
function needPodSecret(req, res) {
  var secret = process.env.POD_INGEST_SECRET;
  if (!secret) { res.status(503).json({ error: 'POD ingest is not configured.' }); return false; }
  if (!secretsEqual(req.headers['x-pod-secret'] || '', secret)) { res.status(401).json({ error: 'Invalid POD secret.' }); return false; }
  return true;
}
// Admin-only POD endpoints (unmatched queue, manual matching) reuse the
// same ADMIN_EMAILS check as /api/admin.
async function requirePodAdmin(req, res) {
  if (!req.user) { res.status(401).json({ error: 'Sign in required.' }); return false; }
  try {
    var state = await billing.getBillingState(req.user.id);
    if (state && state.isAdmin) return true;
  } catch (e) { /* fall through */ }
  res.status(403).json({ error: 'Admin access required.' });
  return false;
}

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

const LIST_COLS = 'w.id, w.waybill_no, w.shipment_id, w.bol_json, w.created_at, w.updated_at, w.user_id, w.company_id, u.full_name AS created_by_name, u.email AS created_by_email, EXISTS (SELECT 1 FROM waybill_pods p WHERE p.waybill_id = w.id AND p.status IN (\'filed\', \'matched\')) AS has_pod';
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

// ---- POD (proof of delivery) routes ----
// These come before /:id so "pod-ingest" / "pod-unmatched" / "pod/:podId"
// are not swallowed by the :id parameter.

// POST /api/waybills/pod-ingest — called by the Cloudflare Email Worker
// when a photo arrives at pod@shiprate.ca. Shared-secret auth (no user
// session). Matches the WB number in the subject to a saved waybill; on a
// miss the photo lands in the unmatched queue and the sender gets an
// auto-reply asking for the number. Body:
//   { waybill_no?, from, subject, filename, mime_type, image_data }
// image_data is a data URL (data:image/...;base64,...).
router.post('/pod-ingest', async (req, res) => {
  if (!needPodSecret(req, res) || !needDb(res)) return;
  try {
    var body = req.body || {};
    var subject = cleanStr(body.subject, 500) || '';
    var sender = cleanStr(body.from || body.sender, 320) || '';
    var filename = cleanStr(body.filename, 200) || 'pod-photo';
    var mime = cleanStr(body.mime_type || body.mime, 100) || '';
    var image = body.image_data || body.image;
    if (!validPodImage(image)) {
      return res.status(400).json({ error: 'Missing or invalid POD photo (image data URL required).' });
    }
    var no = extractWaybillNo(subject) || extractWaybillNo(body.waybill_no || '');
    var waybillId = null;
    var status = 'unmatched';
    var note = null;
    var autoReply = false;
    if (!no) {
      note = 'No WB number found in the subject line.';
      autoReply = true;
    } else {
      var r = await db.query('SELECT id FROM waybills WHERE waybill_no = $1', [no]);
      if (r.rows.length === 1) {
        waybillId = r.rows[0].id;
        status = 'filed';
      } else if (r.rows.length === 0) {
        note = 'No waybill found with number ' + no + '.';
        autoReply = true;
      } else {
        note = 'Multiple waybills share ' + no + ' — needs manual matching.';
      }
    }
    var id = crypto.randomUUID();
    await db.query(
      `INSERT INTO waybill_pods (id, waybill_id, waybill_no, sender_email, subject, filename, mime_type, image_data, status, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, waybillId, no || '', sender, subject, filename, mime, image, status, note]);
    // Unmatched because the number was missing or unknown: tell the sender
    // how to resend. Ambiguous numbers stay quiet — the admin matches them.
    if (status === 'unmatched' && autoReply && isEmail(sender)) {
      var why = no
        ? 'The subject line showed "' + no + '", but no waybill with that number was found.'
        : 'The email subject line had no waybill number in it.';
      var replyText = [
        'Hi — we received your proof-of-delivery photo, but we could not match it to a waybill.',
        '',
        why,
        '',
        'Please resend the photo to pod@shiprate.ca with the BOL No. from the signed page in the subject line (for example: WB-000123).',
        '',
        '— ShipRate',
      ].join('\n');
      try {
        await sendEmail({
          to: sender,
          subject: 'POD could not be filed — waybill number needed',
          text: replyText,
          html: '<p>Hi — we received your proof-of-delivery photo, but we could not match it to a waybill.</p><p>' + escHtml(why) + '</p><p>Please resend the photo to pod@shiprate.ca with the BOL No. from the signed page in the subject line (for example: WB-000123).</p><p>— ShipRate</p>',
          event: 'pod_unmatched',
        });
      } catch (e) { /* best effort — the POD is already stored */ }
    }
    res.json({ ok: true, matched: status === 'filed', pod_id: id, waybill_id: waybillId, waybill_no: no || null });
  } catch (e) {
    console.error('[waybills] pod ingest failed:', e.message);
    res.status(500).json({ error: 'Could not file the POD.' });
  }
});

// GET /api/waybills/pod-unmatched — admin: PODs waiting to be matched.
// Photos are NOT included here (too heavy); fetch one POD to see its photo.
router.get('/pod-unmatched', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  if (!(await requirePodAdmin(req, res))) return;
  try {
    var r = await db.query(
      `SELECT id, waybill_no, sender_email, subject, filename, mime_type, status, note, created_at
       FROM waybill_pods WHERE status = 'unmatched' ORDER BY created_at DESC LIMIT 100`);
    res.json({ rows: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'Could not load unmatched PODs.' });
  }
});

// GET /api/waybills/pod/:podId — admin: one POD, with its photo.
router.get('/pod/:podId', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  if (!(await requirePodAdmin(req, res))) return;
  try {
    var r = await db.query('SELECT * FROM waybill_pods WHERE id = $1', [req.params.podId]);
    if (!r.rows.length) return res.status(404).json({ error: 'POD not found.' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Could not load the POD.' });
  }
});

// POST /api/waybills/pod/:podId/match — admin: file an unmatched POD to a
// waybill. Body: { waybill_id }.
router.post('/pod/:podId/match', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  if (!(await requirePodAdmin(req, res))) return;
  try {
    var waybillId = cleanStr(req.body && req.body.waybill_id, 64);
    if (!waybillId) return res.status(400).json({ error: 'waybill_id is required.' });
    var w = await db.query('SELECT waybill_no FROM waybills WHERE id = $1', [waybillId]);
    if (!w.rows.length) return res.status(404).json({ error: 'Waybill not found.' });
    var r = await db.query(
      `UPDATE waybill_pods SET waybill_id = $1, waybill_no = $2, status = 'matched', note = NULL
       WHERE id = $3 AND status = 'unmatched' RETURNING id`,
      [waybillId, w.rows[0].waybill_no, req.params.podId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Unmatched POD not found.' });
    res.json({ ok: true, pod_id: r.rows[0].id, waybill_id: waybillId });
  } catch (e) {
    res.status(500).json({ error: 'Could not match the POD.' });
  }
});

// DELETE /api/waybills/pod/:podId — admin: discard a POD (wrong photo, spam).
router.delete('/pod/:podId', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  if (!(await requirePodAdmin(req, res))) return;
  try {
    var r = await db.query('DELETE FROM waybill_pods WHERE id = $1 RETURNING id', [req.params.podId]);
    if (!r.rows.length) return res.status(404).json({ error: 'POD not found.' });
    res.json({ deleted: r.rows[0].id });
  } catch (e) {
    res.status(500).json({ error: 'Could not delete the POD.' });
  }
});

// GET /api/waybills/:id/pod — latest filed POD photo for one waybill.
// Owner, or a company member when the waybill belongs to their company.
router.get('/:id/pod', async (req, res) => {
  if (!needUser(req, res) || !needDb(res)) return;
  try {
    var companyId = await callerCompanyId(req.user.id);
    var params = [req.params.id, req.user.id];
    var vis = 'w.user_id = $2';
    if (companyId) {
      params.push(companyId);
      vis = '(w.user_id = $2 OR (w.company_id IS NOT NULL AND w.company_id = $3))';
    }
    var r = await db.query(
      `SELECT p.id, p.waybill_id, p.waybill_no, p.sender_email, p.subject, p.filename, p.mime_type, p.image_data, p.status, p.created_at
       FROM waybill_pods p JOIN waybills w ON w.id = p.waybill_id
       WHERE p.waybill_id = $1 AND ${vis} AND p.status IN ('filed', 'matched')
       ORDER BY p.created_at DESC LIMIT 1`,
      params);
    if (!r.rows.length) return res.status(404).json({ error: 'No POD on file for this waybill.' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Could not load the POD.' });
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
