// routes/shipper-rates.js — Shipper "My Rates" uploads (Oct 2026).
//
// Shipper-side accounts upload THEIR OWN carrier rate sheets (their
// account rates with carriers they already hold accounts with) so Seven
// can review them and load rates manually, the same way carrier intakes
// are handled today. This feature is STORAGE + REVIEW WORKFLOW ONLY:
// files are stored privately per account, listed for the owner (and
// their company admin), and marked up by the site admin with a review
// status (uploaded / reviewed / loaded / rejected) + a note.
//
// PRIVACY (hard rules):
//   - An upload is visible ONLY to its owner, their company's admins,
//     and site admins. Every read/download/delete is scope-checked; an
//     out-of-scope id answers 404, never the data.
//   - Uploaded rate data NEVER enters the shared rating panel, the
//     matrix, or any other customer's quotes/audits. Nothing in this
//     module writes to any rates table.
//   - Files live on disk under backend/uploads/shipper-rates/<user_id>/
//     and are only served through the scoped download route — there is
//     no public/static path to them.
//
// ACCESS: approved shipper accounts, company_admin and site admins.
// Carrier-role accounts get 403 (carriers have their own rate-upload
// flow in routes/carrier-uploads.js — untouched). The feature ships in
// the full + platform2 profiles and is gated OFF under
// SITE_PROFILE=employer (not part of the employer handover bundle);
// server.js also wraps the mount in employerBlocked.
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const config = require('../config');
const db = require('../db');
const billing = require('../lib/billing');
const { notify } = require('../lib/notify');

const router = express.Router();

const STATUSES = ['uploaded', 'reviewed', 'loaded', 'rejected'];

// ---------------------------------------------------------------------------
// Schema (idempotent; also in db/schema.sql for fresh databases).
// ---------------------------------------------------------------------------
async function ensureShipperRatesSchema() {
  if (!db.isEnabled()) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS shipper_rate_uploads (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      company_id     uuid REFERENCES companies(id) ON DELETE SET NULL,
      carrier_name   varchar(160) NOT NULL,
      service_note   varchar(255),
      fsc_note       varchar(255),
      effective_date date,
      expiry_date    date,
      file_name      varchar(255) NOT NULL,
      file_path      text NOT NULL,
      file_mime      varchar(120),
      file_size      integer,
      status         varchar(20) NOT NULL DEFAULT 'uploaded',
      admin_note     text,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now()
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_shipper_rate_uploads_user ON shipper_rate_uploads (user_id, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_shipper_rate_uploads_company ON shipper_rate_uploads (company_id, created_at DESC)`);
}
ensureShipperRatesSchema().catch((e) => console.error('[shipper-rates] schema setup failed:', e.message));

// ---------------------------------------------------------------------------
// Access gate: signed in, not employer profile, not a carrier-role
// account. requireApprovedAccount (server.js) has already rejected
// pending accounts.
// ---------------------------------------------------------------------------
function isSiteAdmin(req) {
  return !!req.everestAdmin || billing.isAdminEmail(req.user && req.user.email);
}

function requireShipperRatesAccess(req, res, next) {
  if (config.siteProfile === 'employer') {
    return res.status(404).json({ error: 'Not found' });
  }
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  if (!db.isEnabled()) {
    return res.status(503).json({ error: 'My Rates is unavailable right now.' });
  }
  if (req.user.role === 'carrier' && !isSiteAdmin(req)) {
    return res.status(403).json({ error: 'My Rates is for shipper accounts.' });
  }
  req.ratesScope = { isSiteAdmin: isSiteAdmin(req) };
  return next();
}
router.use(requireShipperRatesAccess);

// Visibility scope: site admins see all uploads; a company admin sees
// their company's; everyone else sees only their own. Returns
// {clause, params} with the scope value bound at position firstParam.
// col is the (possibly aliased) user_id column to test.
function scopeClause(req, firstParam, col) {
  const c = col || 'user_id';
  if (req.ratesScope.isSiteAdmin) return { clause: 'TRUE', params: [] };
  if (req.user.role === 'company_admin' && req.user.company_id) {
    return { clause: `${c} IN (SELECT id FROM users WHERE company_id = $${firstParam})`, params: [req.user.company_id] };
  }
  return { clause: `${c} = $${firstParam}`, params: [req.user.id] };
}

// ---------------------------------------------------------------------------
// Upload — files on disk under backend/uploads/shipper-rates/<user_id>/,
// metadata on the row, never served from a public path (download goes
// through the scoped API route below).
//
// Accepted: PDF, Excel (.xls/.xlsx), CSV, and photos (jpg/png/webp).
// The extension is the primary gate; the mimetype must also be one of
// the known types for that family (some browsers send octet-stream for
// spreadsheets/CSV, which is accepted only with a matching extension).
// ---------------------------------------------------------------------------
const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads', 'shipper-rates');
try { fs.mkdirSync(UPLOAD_ROOT, { recursive: true }); } catch { /* ignore */ }

const EXT_MIMES = {
  '.pdf': ['application/pdf'],
  '.xls': ['application/vnd.ms-excel'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'],
  '.csv': ['text/csv', 'application/vnd.ms-excel', 'text/plain'],
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.png': ['image/png'],
  '.webp': ['image/webp'],
};

function fileTypeOk(file) {
  const ext = path.extname(String(file.originalname || '')).toLowerCase();
  const okMimes = EXT_MIMES[ext];
  if (!okMimes) return false;
  const mime = String(file.mimetype || '').toLowerCase();
  return okMimes.includes(mime) || mime === 'application/octet-stream' || mime === '';
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_ROOT, String(req.user.id).replace(/[^A-Za-z0-9_-]/g, ''));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = String(file.originalname || 'rate-sheet').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 200) || 'rate-sheet';
    cb(null, Date.now().toString(36) + '_' + safe);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = fileTypeOk(file);
    cb(ok ? null : new Error('Only PDF, Excel (.xls/.xlsx), CSV, or photo (jpg/png) rate sheets are accepted.'), ok);
  },
});

// ---------------------------------------------------------------------------
// Payload shaping — field-by-field; only the upload's own metadata.
// ---------------------------------------------------------------------------
function dateStr(v) {
  if (!v) return null;
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  return String(v).slice(0, 10);
}

function uploadShape(row) {
  return {
    id: row.id,
    carrier_name: row.carrier_name,
    service_note: row.service_note || null,
    fsc_note: row.fsc_note || null,
    effective_date: dateStr(row.effective_date),
    expiry_date: dateStr(row.expiry_date),
    file: {
      name: row.file_name,
      mime: row.file_mime || null,
      size_bytes: row.file_size != null ? Number(row.file_size) : null,
      download_url: `/api/shipper-rates/${row.id}/file`,
    },
    status: row.status,
    admin_note: row.admin_note || null,
    uploaded_by: row.uploader_email || undefined,
    uploader_name: row.uploader_name || undefined,
    company: row.company_label || undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const SELECT_WITH_UPLOADER = `
  SELECT s.*, u.email AS uploader_email, u.full_name AS uploader_name,
         COALESCE(c.name, u.company_name) AS company_label
    FROM shipper_rate_uploads s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN companies c ON c.id = u.company_id`;

// ---------------------------------------------------------------------------
// Routes.
// ---------------------------------------------------------------------------

// POST /api/shipper-rates — upload one of the shipper's own carrier rate
// sheets (multipart: the file + metadata fields). The file is REQUIRED —
// this feature exists to collect the sheet itself.
router.post('/',
  (req, res, next) => upload.single('rate_file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: 'Upload failed: ' + err.message });
    return next();
  }),
  async (req, res) => {
    const str = (v, max) => String(v == null ? '' : v).slice(0, max).trim();
    const dateOrNull = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(str(v, 10)) ? str(v, 10) : null);
    const carrierName = str(req.body && req.body.carrier_name, 160);
    if (!carrierName) {
      if (req.file) { try { fs.unlinkSync(req.file.path); } catch { /* ignore */ } }
      return res.status(400).json({ error: 'carrier_name is required — the carrier this rate sheet belongs to.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'A rate sheet file is required (PDF, Excel, CSV, or a photo of the sheet).' });
    }
    try {
      await ensureShipperRatesSchema(); // no-op after first success; covers a raced boot
    } catch { /* insert below will surface any real problem */ }
    try {
      const r = await db.query(
        `INSERT INTO shipper_rate_uploads
           (user_id, company_id, carrier_name, service_note, fsc_note,
            effective_date, expiry_date, file_name, file_path, file_mime, file_size)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id`,
        [req.user.id, req.user.company_id || null, carrierName,
         str(req.body.service_note, 255) || null, str(req.body.fsc_note, 255) || null,
         dateOrNull(req.body.effective_date), dateOrNull(req.body.expiry_date),
         req.file.originalname, req.file.path, req.file.mimetype || null, req.file.size]
      );
      const row = await db.query(`${SELECT_WITH_UPLOADER} WHERE s.id = $1`, [r.rows[0].id]);
      // Notify Seven (best-effort — notify() never throws, and a failed
      // notification must never fail the upload).
      notify('shipper_rate_uploaded', null, {
        upload: {
          id: r.rows[0].id,
          carrier_name: carrierName,
          file_name: req.file.originalname,
          user_name: req.user.name || req.user.full_name || null,
          user_email: req.user.email || null,
          company: (row.rows[0] && row.rows[0].company_label) || req.user.company || null,
        },
      }).catch(() => { /* non-fatal */ });
      return res.status(201).json({ upload: uploadShape(row.rows[0]) });
    } catch (err) {
      if (req.file) { try { fs.unlinkSync(req.file.path); } catch { /* ignore */ } }
      return res.status(502).json({ error: 'Could not save the upload: ' + err.message });
    }
  }
);

// GET /api/shipper-rates — uploads in the caller's scope (own; company
// for company admins; all for site admins), newest first.
router.get('/', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
  try {
    const scope = scopeClause(req, 1, 's.user_id');
    const r = await db.query(
      `${SELECT_WITH_UPLOADER}
        WHERE ${scope.clause}
        ORDER BY s.created_at DESC LIMIT $${scope.params.length + 1}`,
      [...scope.params, limit]
    );
    return res.json({ uploads: r.rows.map(uploadShape) });
  } catch (err) {
    return res.status(502).json({ error: 'Could not list uploads: ' + err.message });
  }
});

// GET /api/shipper-rates/:id/file — download the stored sheet (scoped).
router.get('/:id/file', async (req, res) => {
  try {
    const scope = scopeClause(req, 2, 's.user_id');
    const r = await db.query(
      `SELECT s.file_name, s.file_path FROM shipper_rate_uploads s
        WHERE s.id = $1 AND ${scope.clause} LIMIT 1`,
      [req.params.id, ...scope.params]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Upload not found.' });
    const row = r.rows[0];
    if (!row.file_path || !fs.existsSync(row.file_path)) {
      return res.status(410).json({ error: 'No file is stored for this upload.' });
    }
    return res.download(row.file_path, row.file_name || 'rate-sheet');
  } catch (err) {
    return res.status(502).json({ error: 'Could not download the file: ' + err.message });
  }
});

// PATCH /api/shipper-rates/:id/status — SITE ADMIN ONLY: the review
// workflow (uploaded → reviewed → loaded / rejected) + an admin note.
router.patch('/:id/status', async (req, res) => {
  if (!req.ratesScope.isSiteAdmin) {
    return res.status(403).json({ error: 'Only the site admin can change an upload\'s review status.' });
  }
  const status = String((req.body && req.body.status) || '').trim().toLowerCase();
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}.` });
  }
  const noteProvided = req.body && Object.prototype.hasOwnProperty.call(req.body, 'admin_note');
  const adminNote = noteProvided ? String(req.body.admin_note == null ? '' : req.body.admin_note).slice(0, 2000).trim() || null : undefined;
  try {
    const r = await db.query(
      `UPDATE shipper_rate_uploads
          SET status = $2,
              admin_note = CASE WHEN $3::boolean THEN $4 ELSE admin_note END,
              updated_at = now()
        WHERE id = $1
        RETURNING id`,
      [req.params.id, status, noteProvided, adminNote || null]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Upload not found.' });
    const row = await db.query(`${SELECT_WITH_UPLOADER} WHERE s.id = $1`, [req.params.id]);
    return res.json({ upload: uploadShape(row.rows[0]) });
  } catch (err) {
    return res.status(502).json({ error: 'Could not update the upload: ' + err.message });
  }
});

// DELETE /api/shipper-rates/:id — remove an upload in scope (+ its file).
router.delete('/:id', async (req, res) => {
  try {
    const scope = scopeClause(req, 2);
    const r = await db.query(
      `DELETE FROM shipper_rate_uploads WHERE id = $1 AND ${scope.clause} RETURNING file_path`,
      [req.params.id, ...scope.params]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Upload not found.' });
    if (r.rows[0].file_path) { try { fs.unlinkSync(r.rows[0].file_path); } catch { /* already gone */ } }
    return res.json({ deleted: true });
  } catch (err) {
    return res.status(502).json({ error: 'Could not delete the upload: ' + err.message });
  }
});

module.exports = router;
module.exports.ensureShipperRatesSchema = ensureShipperRatesSchema;
module.exports.STATUSES = STATUSES;
