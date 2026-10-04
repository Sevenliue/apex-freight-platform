// routes/carrier-uploads.js — carrier self-serve rate-sheet uploads.
//
// Public: carriers download the ShipRate CSV template and upload their tariff.
// Uploads are validated and stored as pending; nothing goes live until Seven
// approves it in Admin. Approved lanes are written to carrier_matrix_lanes
// (durable in Postgres) and merged into the running rate engine immediately.
'use strict';

const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const matrix = require('../lib/matrix');
const notify = require('../lib/notify');
const { rateLimit } = require('../lib/rate-limit');
const { generateTemplate, slugify, validateUpload } = require('../lib/rate-upload');
const { requireAdmin } = require('./admin');

const router = express.Router();

const newId = () => 'upl_' + crypto.randomBytes(9).toString('hex');

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

// Download the CSV template carriers fill in.
router.get('/template', (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="shiprate-rate-template.csv"');
  res.send(generateTemplate());
});

// Submit a rate sheet. Body (JSON): {carrier_name, contact_name,
// contact_email, contact_phone, fsc_percent, file_name, csv_text}.
// The frontend reads the file as text — no multipart handling needed.
router.post(
  '/',
  rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: 'Too many uploads — please try again later.' }),
  async (req, res) => {
    if (!db.isEnabled()) return res.status(501).json({ error: 'Uploads are unavailable right now.' });
    const b = req.body || {};
    const carrierName = String(b.carrier_name || '').trim().slice(0, 160);
    const contactEmail = String(b.contact_email || '').trim().slice(0, 160);
    if (!carrierName) return res.status(400).json({ error: 'Carrier name is required.' });
    if (!contactEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)) {
      return res.status(400).json({ error: 'A valid contact email is required.' });
    }
    const fsc = b.fsc_percent === '' || b.fsc_percent == null ? null : Number(b.fsc_percent);
    if (fsc != null && (!Number.isFinite(fsc) || fsc < 0 || fsc > 500)) {
      return res.status(400).json({ error: 'Fuel surcharge must be between 0 and 500%.' });
    }
    const v = validateUpload(String(b.csv_text || ''));
    if (!v.ok) return res.status(400).json({ error: 'Rate sheet failed validation.', errors: v.errors });

    const id = newId();
    try {
      await db.query(
        `INSERT INTO carrier_rate_uploads
           (id, carrier_name, contact_name, contact_email, contact_phone, fsc_percent, file_name, raw_csv, lane_count, warnings, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')`,
        [id, carrierName, String(b.contact_name || '').trim().slice(0, 160) || null,
         contactEmail, String(b.contact_phone || '').trim().slice(0, 40) || null,
         fsc, String(b.file_name || '').trim().slice(0, 255) || null,
         String(b.csv_text), v.lanes.length, JSON.stringify(v.warnings.slice(0, 50))]
      );
    } catch (err) {
      return res.status(502).json({ error: 'Could not save the upload: ' + err.message });
    }

    // Tell Seven — non-fatal if it fails.
    try {
      await notify.notify('carrier_upload_received', null, {
        upload: { id, carrier_name: carrierName, contact_email: contactEmail, lane_count: v.lanes.length },
      });
    } catch { /* logged inside notify */ }

    return res.status(201).json({
      id,
      lane_count: v.lanes.length,
      warnings: v.warnings,
      message: 'Received — we review every rate sheet before it goes live, usually within 2 business days.',
    });
  }
);

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

router.get('/admin/list', async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  if (!db.isEnabled()) return res.status(501).json({ error: 'Admin requires a database.' });
  const status = String(req.query.status || 'pending');
  try {
    const r = await db.query(
      `SELECT id, carrier_name, contact_name, contact_email, contact_phone, fsc_percent,
              file_name, lane_count, warnings, status, review_note, created_at, reviewed_at, reviewed_by
       FROM carrier_rate_uploads
       WHERE ($1 = 'all' OR status = $1)
       ORDER BY created_at DESC LIMIT 100`,
      [status]
    );
    return res.json({ uploads: r.rows });
  } catch (err) {
    return res.status(502).json({ error: 'Could not list uploads: ' + err.message });
  }
});

router.get('/admin/:id', async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  if (!db.isEnabled()) return res.status(501).json({ error: 'Admin requires a database.' });
  try {
    const r = await db.query('SELECT * FROM carrier_rate_uploads WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Upload not found.' });
    const u = r.rows[0];
    const v = validateUpload(u.raw_csv);
    return res.json({
      upload: { ...u, raw_csv: undefined },
      preview_lanes: v.lanes.slice(0, 25),
      preview_total: v.lanes.length,
      validation: { ok: v.ok, errors: v.errors, warnings: v.warnings },
    });
  } catch (err) {
    return res.status(502).json({ error: 'Could not load upload: ' + err.message });
  }
});

// Approve: register the carrier, write lanes to the DB, merge into the live
// engine, mark approved. Re-uploads for the same carrier replace its lanes.
router.post('/admin/:id/approve', async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  if (!db.isEnabled()) return res.status(501).json({ error: 'Admin requires a database.' });
  try {
    const r = await db.query('SELECT * FROM carrier_rate_uploads WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Upload not found.' });
    const u = r.rows[0];
    if (u.status === 'approved') return res.status(409).json({ error: 'Already approved.' });
    const v = validateUpload(u.raw_csv);
    if (!v.ok) return res.status(400).json({ error: 'Sheet no longer validates.', errors: v.errors });

    let carrierId = slugify(u.carrier_name);

    const email = (req.user && req.user.email) || null;
    // Re-upload for the same carrier replaces its lanes (clean replace).
    await db.query('DELETE FROM carrier_matrix_rates WHERE carrier_id = $1', [carrierId]);
    const fscNum = u.fsc_percent == null ? null : Number(u.fsc_percent);
    for (const lane of v.lanes) {
      await db.query(
        `INSERT INTO carrier_matrix_rates
           (carrier_id, carrier_label, fsc_percent, origin_city, origin_prov,
            dest_city, dest_prov, min_charge_cad, breaks_json, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,
        [carrierId, u.carrier_name, fscNum, lane.origin_city, lane.origin_prov,
         lane.dest_city, lane.dest_prov, lane.min_charge_cad, JSON.stringify(lane.breaks)]
      );
    }
    if (typeof matrix.upsertCarrier === 'function') {
      matrix.upsertCarrier({
        carrier_id: carrierId,
        carrier_label: u.carrier_name,
        fsc_percent: u.fsc_percent == null ? 0 : Number(u.fsc_percent),
        fsc_as_of: new Date().toISOString().slice(0, 10),
        fsc_note: 'self-serve upload',
      });
    }
    if (typeof matrix.upsertCarrierRows === 'function') {
      matrix.upsertCarrierRows(carrierId, v.lanes);
    }
    await db.query(
      `UPDATE carrier_rate_uploads SET status='approved', review_note=$2, reviewed_at=now(), reviewed_by=$3 WHERE id=$1`,
      [u.id, String((req.body || {}).review_note || '').slice(0, 1000) || null, email]
    );
    return res.json({ carrier_id: carrierId, carrier_name: u.carrier_name, lanes: v.lanes.length });
  } catch (err) {
    return res.status(502).json({ error: 'Could not approve upload: ' + err.message });
  }
});

router.post('/admin/:id/reject', async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  if (!db.isEnabled()) return res.status(501).json({ error: 'Admin requires a database.' });
  try {
    const email = (req.user && req.user.email) || null;
    await db.query(
      `UPDATE carrier_rate_uploads SET status='rejected', review_note=$2, reviewed_at=now(), reviewed_by=$3 WHERE id=$1`,
      [req.params.id, String((req.body || {}).review_note || '').slice(0, 1000) || null, email]
    );
    return res.json({ ok: true });
  } catch (err) {
    return res.status(502).json({ error: 'Could not reject upload: ' + err.message });
  }
});

module.exports = router;
