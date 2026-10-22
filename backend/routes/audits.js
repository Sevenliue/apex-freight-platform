// routes/audits.js — Invoice Audit (account-holder feature, Oct 2026).
//
// A shipper WITH their own carrier accounts submits a carrier invoice
// (manual entry and/or a PDF/photo upload) and ShipRate re-rates the same
// shipment with the existing rating engine at the PURE CARRIER RATE —
// markup is NEVER applied in audit math (the engine's quoteMatrix totals
// are cost-side by construction; markup is only added later, in
// routes/rates.js, which this feature never touches). The result is a
// line-by-line comparison: base freight, fuel surcharge, accessorials,
// total, with a MATCH / OVERCHARGED / UNDERCHARGED verdict and the dollar
// variance. AUDIT ONLY: no booking, no recovery workflow.
//
// ACCESS: approved shipper accounts, company_admin and site admins.
// Carrier-role accounts get 403 (enforced here, server-side). The whole
// feature is gated OFF under SITE_PROFILE=platform2 (that database has
// zero carrier rate data, so re-rating is impossible) — server.js never
// mounts this router there; the gate below is belt-and-suspenders.
//
// PRICING (data model only — Seven's locked tiers, Oct 19 2026):
//   starter   $29/mo ≤ 50 invoices      standard  $59/mo ≤ 100 invoices
//   business  $99/mo ≤ 200 invoices     pro       $119/mo ≤ 300 invoices
//   past 300: $0.35/invoice. Overage bills at the NEXT tier's per-invoice
//   rate, capped at the next tier's flat price, then auto-rolls up.
// The site is in FREE-TOOL MODE (testing phase): prices are never shown
// in this feature's payloads or UI, usage counts are tracked, and quotas
// NEVER block a submission. No Stripe here.
//
// PRIVACY RULE: audit payloads are built field-by-field and contain only
// the carrier's invoice figures and the pure carrier-rate re-rate. No
// markup percent, margin, or ShipRate fee figure ever appears.
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const config = require('../config');
const db = require('../db');
const matrix = require('../lib/matrix');
const billing = require('../lib/billing');
const { round2 } = require('../lib/money');

const router = express.Router();

// ---------------------------------------------------------------------------
// Pricing model (server-side only; prices never leave this module in a
// payload — usage responses carry tier key/name + counts, never dollars).
// ---------------------------------------------------------------------------
const AUDIT_TIERS = {
  starter:  { name: 'Starter',  monthly_cad: 29,  invoice_limit: 50,  overage_rate: 0.59 },
  standard: { name: 'Standard', monthly_cad: 59,  invoice_limit: 100, overage_rate: 0.50 },
  business: { name: 'Business', monthly_cad: 99,  invoice_limit: 200, overage_rate: 0.40 },
  pro:      { name: 'Pro',      monthly_cad: 119, invoice_limit: 300, overage_rate: 0.35 },
};
const AUDIT_TIER_ORDER = ['starter', 'standard', 'business', 'pro'];
const PAST_TOP_RATE = 0.35; // $/invoice past the top tier's limit

function normalizeAuditTier(t) {
  return AUDIT_TIERS[t] ? t : 'starter';
}

// auditBillingFor(tierKey, used): the data-model view of a month's usage —
// what WOULD be billed once monetization is switched on. During the
// testing phase nothing reads this except the usage endpoint's counts;
// it exists so the tiers/overage/auto-roll rules are implemented once.
function auditBillingFor(tierKey, used) {
  const tier = normalizeAuditTier(tierKey);
  const meta = AUDIT_TIERS[tier];
  const over = Math.max(0, used - meta.invoice_limit);
  let overage = 0;
  let rolledTo = null;
  if (over > 0) {
    if (tier === 'pro') {
      overage = round2(over * PAST_TOP_RATE);
    } else {
      const next = AUDIT_TIERS[AUDIT_TIER_ORDER[AUDIT_TIER_ORDER.indexOf(tier) + 1]];
      overage = round2(over * meta.overage_rate);
      const cap = round2(next.monthly_cad - meta.monthly_cad);
      if (overage >= cap) { overage = cap; rolledTo = AUDIT_TIER_ORDER[AUDIT_TIER_ORDER.indexOf(tier) + 1]; }
    }
  }
  return { tier, tier_name: meta.name, invoice_limit: meta.invoice_limit, used, over_by: over, rolled_to: rolledTo };
}

// ---------------------------------------------------------------------------
// Schema (idempotent; also in db/schema.sql for fresh databases).
// ---------------------------------------------------------------------------
async function ensureAuditSchema() {
  if (!db.isEnabled()) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS invoice_audits (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      company_id    uuid REFERENCES companies(id) ON DELETE SET NULL,
      carrier_name  varchar(160) NOT NULL,
      carrier_id    varchar(120),
      invoice_no    varchar(120) NOT NULL,
      invoice_date  date,
      origin_city   varchar(80) NOT NULL,
      origin_province varchar(40),
      dest_city     varchar(80) NOT NULL,
      dest_province varchar(40),
      total_weight_lb numeric NOT NULL DEFAULT 0,
      total_pieces  integer NOT NULL DEFAULT 0,
      pieces_json   jsonb NOT NULL DEFAULT '[]'::jsonb,
      charges_json  jsonb NOT NULL DEFAULT '{}'::jsonb,
      result_json   jsonb,
      status        varchar(30) NOT NULL DEFAULT 'cannot_rerate',
      verdict       varchar(20),
      variance_cad  numeric,
      file_name     varchar(255),
      file_path     text,
      file_mime     varchar(120),
      file_size     integer,
      created_at    timestamptz NOT NULL DEFAULT now()
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_invoice_audits_user ON invoice_audits (user_id, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_invoice_audits_company ON invoice_audits (company_id, created_at DESC)`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS audit_tier varchar(30) NOT NULL DEFAULT 'starter'`);
}
ensureAuditSchema().catch((e) => console.error('[audits] schema setup failed:', e.message));

// ---------------------------------------------------------------------------
// Access gate: signed in, not platform2, not a carrier-role account.
// requireApprovedAccount (server.js) has already rejected pending accounts.
// ---------------------------------------------------------------------------
function isSiteAdmin(req) {
  return !!req.everestAdmin || billing.isAdminEmail(req.user && req.user.email);
}

function requireAuditAccess(req, res, next) {
  if (config.siteProfile === 'platform2') {
    return res.status(404).json({ error: 'Not found' });
  }
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  if (!db.isEnabled()) {
    return res.status(503).json({ error: 'Invoice Audit is unavailable right now.' });
  }
  if (req.user.role === 'carrier' && !isSiteAdmin(req)) {
    return res.status(403).json({ error: 'Invoice Audit is for shipper accounts.' });
  }
  req.auditScope = { isSiteAdmin: isSiteAdmin(req) };
  return next();
}
router.use(requireAuditAccess);

// Visibility scope: site admins see all audits; a company admin sees their
// company's; everyone else sees only their own. Returns {clause, params}.
function scopeClause(req, firstParam) {
  if (req.auditScope.isSiteAdmin) return { clause: 'TRUE', params: [] };
  if (req.user.role === 'company_admin' && req.user.company_id) {
    return { clause: `user_id IN (SELECT id FROM users WHERE company_id = $${firstParam})`, params: [req.user.company_id] };
  }
  return { clause: `user_id = $${firstParam}`, params: [req.user.id] };
}

// ---------------------------------------------------------------------------
// Carrier matching + re-rate.
// ---------------------------------------------------------------------------
function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// matchCarrier(name): find the rated carrier for a free-form invoice name.
// Exact normalized label/id match first; a single unambiguous containment
// match second. Returns null when we hold no rate data for that carrier.
function matchCarrier(name) {
  const want = normalizeName(name);
  if (!want) return null;
  let carriers = [];
  try { carriers = matrix.listCarriers() || []; } catch { carriers = []; }
  for (const c of carriers) {
    if (normalizeName(c.carrier_label) === want || normalizeName(c.carrier_id) === want) return c;
  }
  const partial = carriers.filter((c) => {
    const label = normalizeName(c.carrier_label);
    return label && (label.includes(want) || want.includes(label));
  });
  return partial.length === 1 ? partial[0] : null;
}

const MATCH_TOLERANCE_CAD = 0.02; // rounding slack on the carrier's own math

// rerate(sub): re-price the shipment at the pure carrier rate and compare
// line-by-line with the invoice's charges. Pure function of the engine.
function rerate(sub) {
  const carrier = matchCarrier(sub.carrier_name);
  if (!carrier) {
    return {
      status: 'cannot_rerate', verdict: null, variance_cad: null, carrier_id: null,
      reason: 'no_rate_data',
      message: 'We don\'t hold rate data for this carrier yet, so this invoice was saved without a re-rate.',
    };
  }
  let quotes = [];
  try {
    quotes = matrix.quoteMatrix({
      originCity: sub.origin_city, originProv: sub.origin_province,
      destCity: sub.dest_city, destProv: sub.dest_province,
      weightLbs: sub.total_weight_lb, packages: sub.pieces,
    }) || [];
  } catch (err) {
    return {
      status: 'cannot_rerate', verdict: null, variance_cad: null, carrier_id: carrier.carrier_id,
      reason: 'rating_failed', message: 'The rating engine could not price this lane: ' + err.message,
    };
  }
  const q = quotes.find((x) => x.carrier_id === carrier.carrier_id);
  if (!q) {
    return {
      status: 'cannot_rerate', verdict: null, variance_cad: null, carrier_id: carrier.carrier_id,
      reason: 'no_lane_rate',
      message: `${carrier.carrier_label} has no rate for this lane/weight in the current rate data, so this invoice was saved without a re-rate.`,
    };
  }
  // quoteMatrix totals are the carrier's own charges (base + FSC). Markup
  // is applied only in routes/rates.js for shipper quotes — never here.
  const expectedBase = round2(q.base_cad);
  const expectedFsc = round2(q.fsc_cad);
  const expectedTotal = round2(q.total_cad);
  const expectedAcc = round2(expectedTotal - expectedBase - expectedFsc);
  const inv = sub.charges;
  const invAccTotal = round2((inv.accessorials || []).reduce((s, a) => s + (Number(a.amount_cad) || 0), 0));
  const lines = [
    { key: 'base', label: 'Base freight', invoiced_cad: round2(inv.base_cad), expected_cad: expectedBase, variance_cad: round2(inv.base_cad - expectedBase) },
    { key: 'fsc', label: 'Fuel surcharge', invoiced_cad: round2(inv.fsc_cad), expected_cad: expectedFsc, variance_cad: round2(inv.fsc_cad - expectedFsc) },
    { key: 'accessorials', label: 'Accessorials', invoiced_cad: invAccTotal, expected_cad: expectedAcc, variance_cad: round2(invAccTotal - expectedAcc) },
    { key: 'total', label: 'Total', invoiced_cad: round2(inv.total_cad), expected_cad: expectedTotal, variance_cad: round2(inv.total_cad - expectedTotal) },
  ];
  const variance = lines[3].variance_cad;
  const verdict = variance > MATCH_TOLERANCE_CAD ? 'OVERCHARGED'
    : variance < -MATCH_TOLERANCE_CAD ? 'UNDERCHARGED' : 'MATCH';
  return {
    status: 'rated', verdict, variance_cad: variance, carrier_id: carrier.carrier_id,
    carrier_label: carrier.carrier_label, service: q.service || null,
    billable_weight_lbs: q.billable_weight_lbs != null ? Number(q.billable_weight_lbs) : sub.total_weight_lb,
    fsc_percent: q.fsc_percent != null ? Number(q.fsc_percent) : null,
    expected: { base_cad: expectedBase, fsc_cad: expectedFsc, accessorials_cad: expectedAcc, total_cad: expectedTotal },
    lines,
  };
}

// ---------------------------------------------------------------------------
// Payload shaping — field-by-field; only invoice + carrier-rate data.
// ---------------------------------------------------------------------------
function jparse(v, dflt) {
  if (v == null) return dflt;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return dflt; }
}
const numOrNull = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

function auditShape(row) {
  const result = jparse(row.result_json, null);
  return {
    id: row.id,
    carrier_name: row.carrier_name,
    carrier_id: row.carrier_id || null,
    invoice_no: row.invoice_no,
    invoice_date: row.invoice_date
      ? (row.invoice_date instanceof Date
          ? `${row.invoice_date.getFullYear()}-${String(row.invoice_date.getMonth() + 1).padStart(2, '0')}-${String(row.invoice_date.getDate()).padStart(2, '0')}`
          : String(row.invoice_date).slice(0, 10))
      : null,
    origin: { city: row.origin_city, province: row.origin_province || '' },
    destination: { city: row.dest_city, province: row.dest_province || '' },
    total_weight_lb: numOrNull(row.total_weight_lb),
    total_pieces: row.total_pieces != null ? Number(row.total_pieces) : 0,
    pieces: jparse(row.pieces_json, []),
    charges: jparse(row.charges_json, {}),
    status: row.status,
    verdict: row.verdict || null,
    variance_cad: numOrNull(row.variance_cad),
    result,
    file: row.file_name ? {
      name: row.file_name, mime: row.file_mime || null,
      size_bytes: row.file_size != null ? Number(row.file_size) : null,
      download_url: `/api/audits/${row.id}/file`,
    } : null,
    submitted_by: row.submitter_email || undefined,
    created_at: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Upload — same pattern as quote attachments: files on disk under
// backend/uploads/audits/<user_id>/, metadata on the audit row, never
// served from a public path (download goes through the scoped API).
// ---------------------------------------------------------------------------
const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads', 'audits');
try { fs.mkdirSync(UPLOAD_ROOT, { recursive: true }); } catch { /* ignore */ }

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_ROOT, String(req.user.id).replace(/[^A-Za-z0-9_-]/g, ''));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = String(file.originalname || 'invoice').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 200) || 'invoice';
    cb(null, Date.now().toString(36) + '_' + safe);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = /^(application\/pdf|image\/(png|jpeg|jpg|webp|heic|heif))$/i.test(file.mimetype || '');
    cb(ok ? null : new Error('Only PDF or photo uploads are accepted.'), ok);
  },
});

// ---------------------------------------------------------------------------
// Input cleaning (accepts JSON bodies and multipart form fields alike).
// ---------------------------------------------------------------------------
function parseMaybeJson(v, dflt) {
  if (v == null || v === '') return dflt;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return dflt; }
}

function cleanSubmission(body) {
  const b = body || {};
  const str = (v, max) => String(v == null ? '' : v).slice(0, max).trim();
  const money = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? round2(n) : 0;
  };
  const piecesRaw = parseMaybeJson(b.pieces_detail || b.pieces, []);
  const pieces = (Array.isArray(piecesRaw) ? piecesRaw : []).slice(0, 50).map((p) => ({
    qty: Math.max(1, Math.floor(Number(p.qty) || 1)),
    package_type: str(p.package_type, 40) || 'Pallet',
    weight_lb: Math.max(0, Number(p.weight_lb) || 0),
    length: p.length != null && p.length !== '' ? Number(p.length) || null : null,
    width: p.width != null && p.width !== '' ? Number(p.width) || null : null,
    height: p.height != null && p.height !== '' ? Number(p.height) || null : null,
    stackable: !!p.stackable,
  })).filter((p) => p.weight_lb > 0);
  const totalWeight = Number(b.total_weight_lb ?? b.total_weight_lbs);
  const weight = Number.isFinite(totalWeight) && totalWeight > 0
    ? round2(totalWeight)
    : round2(pieces.reduce((s, p) => s + p.weight_lb, 0));
  const chargesRaw = parseMaybeJson(b.charges, {}) || {};
  const accRaw = Array.isArray(chargesRaw.accessorials) ? chargesRaw.accessorials : [];
  const accessorials = accRaw.slice(0, 30).map((a) => ({
    name: str(a && a.name, 120) || 'Accessorial',
    amount_cad: money(a && (a.amount_cad ?? a.amount)),
  })).filter((a) => a.amount_cad > 0 || a.name);
  const base = money(chargesRaw.base_cad ?? chargesRaw.base);
  const fsc = money(chargesRaw.fsc_cad ?? chargesRaw.fsc);
  const accTotal = round2(accessorials.reduce((s, a) => s + a.amount_cad, 0));
  let total = money(chargesRaw.total_cad ?? chargesRaw.total);
  if (!total && (base || fsc || accTotal)) total = round2(base + fsc + accTotal);
  const totalPieces = Math.max(0, Math.floor(Number(b.total_pieces) || 0))
    || pieces.reduce((s, p) => s + p.qty, 0);
  return {
    carrier_name: str(b.carrier_name || b.carrier, 160),
    invoice_no: str(b.invoice_no, 120),
    invoice_date: /^\d{4}-\d{2}-\d{2}$/.test(str(b.invoice_date, 10)) ? str(b.invoice_date, 10) : null,
    origin_city: str(b.origin_city, 80),
    origin_province: str(b.origin_province || b.origin_state, 40),
    dest_city: str(b.dest_city, 80),
    dest_province: str(b.dest_province || b.dest_state, 40),
    total_weight_lb: weight,
    total_pieces: totalPieces,
    pieces,
    charges: { base_cad: base, fsc_cad: fsc, accessorials, total_cad: total },
  };
}

function validateSubmission(sub) {
  if (!sub.carrier_name) return 'carrier_name is required — the carrier that issued the invoice.';
  if (!sub.invoice_no) return 'invoice_no is required.';
  if (!sub.origin_city || !sub.dest_city) return 'Origin and destination cities are required.';
  if (!sub.total_weight_lb || sub.total_weight_lb <= 0) return 'A total shipment weight (lb) is required to re-rate the invoice.';
  if (!sub.charges.total_cad || sub.charges.total_cad <= 0) return 'The invoice total is required.';
  return null;
}

// ---------------------------------------------------------------------------
// Routes.
// ---------------------------------------------------------------------------

// GET /api/audits/carriers — carriers we hold rate data for (form picker).
router.get('/carriers', (req, res) => {
  let carriers = [];
  try { carriers = matrix.listCarriers() || []; } catch { carriers = []; }
  return res.json({
    carriers: carriers.map((c) => ({ id: c.carrier_id, label: c.carrier_label })),
  });
});

// GET /api/audits/usage — this month's audit count for the caller's
// account + their tier's shape. Counts only: no prices, and in free-tool
// mode the UI presents it as informational (quotas never block).
router.get('/usage', async (req, res) => {
  try {
    const month = new Date().toISOString().slice(0, 7);
    const cnt = await db.query(
      `SELECT COUNT(*)::int AS n FROM invoice_audits
        WHERE user_id = $1 AND to_char(created_at, 'YYYY-MM') = $2`,
      [req.user.id, month]
    );
    const trow = await db.query('SELECT audit_tier FROM users WHERE id = $1 LIMIT 1', [req.user.id]);
    const summary = auditBillingFor(trow.rows.length ? trow.rows[0].audit_tier : 'starter', cnt.rows[0].n);
    return res.json({
      month,
      audits_used: summary.used,
      tier: summary.tier,
      tier_name: summary.tier_name,
      invoice_limit: summary.invoice_limit,
      over_by: summary.over_by,
      free_tool_mode: config.freeToolMode,
    });
  } catch (err) {
    return res.status(502).json({ error: 'Could not load audit usage: ' + err.message });
  }
});

// POST /api/audits — submit an invoice for audit (JSON or multipart with
// an optional invoice_file). Runs the re-rate immediately and stores the
// full comparison. NEVER blocked by quota (testing phase).
router.post('/',
  (req, res, next) => upload.single('invoice_file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: 'Upload failed: ' + err.message });
    return next();
  }),
  async (req, res) => {
    const sub = cleanSubmission(req.body);
    const invalid = validateSubmission(sub);
    if (invalid) {
      if (req.file) { try { fs.unlinkSync(req.file.path); } catch { /* ignore */ } }
      return res.status(400).json({ error: invalid });
    }
    try {
      await ensureAuditSchema(); // no-op after first success; covers a raced boot
    } catch { /* insert below will surface any real problem */ }
    const result = rerate(sub);
    try {
      const r = await db.query(
        `INSERT INTO invoice_audits
           (user_id, company_id, carrier_name, carrier_id, invoice_no, invoice_date,
            origin_city, origin_province, dest_city, dest_province,
            total_weight_lb, total_pieces, pieces_json, charges_json, result_json,
            status, verdict, variance_cad, file_name, file_path, file_mime, file_size)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         RETURNING *`,
        [req.user.id, req.user.company_id || null, sub.carrier_name, result.carrier_id || null,
         sub.invoice_no, sub.invoice_date, sub.origin_city, sub.origin_province || null,
         sub.dest_city, sub.dest_province || null, sub.total_weight_lb, sub.total_pieces,
         JSON.stringify(sub.pieces), JSON.stringify(sub.charges), JSON.stringify(result),
         result.status, result.verdict || null, result.variance_cad,
         req.file ? req.file.originalname : null, req.file ? req.file.path : null,
         req.file ? req.file.mimetype : null, req.file ? req.file.size : null]
      );
      return res.status(201).json({ audit: auditShape(r.rows[0]) });
    } catch (err) {
      if (req.file) { try { fs.unlinkSync(req.file.path); } catch { /* ignore */ } }
      return res.status(502).json({ error: 'Could not save the audit: ' + err.message });
    }
  }
);

// GET /api/audits — the caller's audits (company scope for company admins,
// all for site admins), newest first.
router.get('/', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
  try {
    const scope = scopeClause(req, 1);
    const r = await db.query(
      `SELECT a.*, u.email AS submitter_email FROM invoice_audits a
         JOIN users u ON u.id = a.user_id
        WHERE ${scope.clause}
        ORDER BY a.created_at DESC LIMIT $${scope.params.length + 1}`,
      [...scope.params, limit]
    );
    return res.json({ audits: r.rows.map(auditShape) });
  } catch (err) {
    return res.status(502).json({ error: 'Could not list audits: ' + err.message });
  }
});

// GET /api/audits/:id — one audit with the full line-by-line comparison.
router.get('/:id', async (req, res) => {
  try {
    const scope = scopeClause(req, 2);
    const r = await db.query(
      `SELECT a.*, u.email AS submitter_email FROM invoice_audits a
         JOIN users u ON u.id = a.user_id
        WHERE a.id = $1 AND ${scope.clause} LIMIT 1`,
      [req.params.id, ...scope.params]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Audit not found.' });
    return res.json({ audit: auditShape(r.rows[0]) });
  } catch (err) {
    return res.status(502).json({ error: 'Could not load the audit: ' + err.message });
  }
});

// GET /api/audits/:id/file — download the uploaded invoice file (scoped).
router.get('/:id/file', async (req, res) => {
  try {
    const scope = scopeClause(req, 2);
    const r = await db.query(
      `SELECT a.file_name, a.file_path FROM invoice_audits a
        WHERE a.id = $1 AND ${scope.clause} LIMIT 1`,
      [req.params.id, ...scope.params]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Audit not found.' });
    const row = r.rows[0];
    if (!row.file_path || !fs.existsSync(row.file_path)) {
      return res.status(410).json({ error: 'No file is stored for this audit.' });
    }
    return res.download(row.file_path, row.file_name || 'invoice');
  } catch (err) {
    return res.status(502).json({ error: 'Could not download the file: ' + err.message });
  }
});

// DELETE /api/audits/:id — remove an audit in scope (+ its stored file).
router.delete('/:id', async (req, res) => {
  try {
    const scope = scopeClause(req, 2);
    const r = await db.query(
      `DELETE FROM invoice_audits WHERE id = $1 AND ${scope.clause} RETURNING file_path`,
      [req.params.id, ...scope.params]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Audit not found.' });
    if (r.rows[0].file_path) { try { fs.unlinkSync(r.rows[0].file_path); } catch { /* already gone */ } }
    return res.json({ deleted: true });
  } catch (err) {
    return res.status(502).json({ error: 'Could not delete the audit: ' + err.message });
  }
});

module.exports = router;
module.exports.AUDIT_TIERS = AUDIT_TIERS;
module.exports.auditBillingFor = auditBillingFor;
module.exports.ensureAuditSchema = ensureAuditSchema;
