// routes/quotes.js — saved quotes for the Smart Shipping-style flow.
//   GET  /api/quotes/accessorials      — pick-up/delivery service catalog
//   POST /api/quotes/:id/save          — save a quote for later retrieval
//   GET  /api/quotes/saved?user_id=    — list saved quotes
//   GET  /api/quotes/:id               — full quote (params + rates) for reload
//
// :id accepts either the in-memory shipment_id (q_...) or the DB uuid.
// With no database, saved quotes live in memory for the server's lifetime.
'use strict';

const express = require('express');
const db = require('../db');
const { store } = require('../lib/store');
const acc = require('../lib/accessorials');

const router = express.Router();

function bad(res, code, error) {
  return res.status(code).json({ error });
}

router.get('/accessorials', (req, res) => {
  res.json({ accessorials: acc.list() });
});

// POST /api/quotes/full-load-request — custom pricing request for a full truckload.
// Stores the request (DB when configured, memory otherwise) and notifies the admin.
const fullLoadMem = [];
router.post('/full-load-request', async (req, res) => {
  if (!req.user) return bad(res, 401, 'Sign in to request full-load pricing.');
  const b = req.body || {};
  const origin_city = String((b.origin && b.origin.city) || '').trim();
  const dest_city = String((b.destination && b.destination.city) || '').trim();
  if (!origin_city || !dest_city) return bad(res, 400, 'Origin and destination cities are required.');
  const equipment = ['dry_van', 'reefer', 'flatbed', 'other'].includes(b.equipment) ? b.equipment : 'dry_van';
  const rec = {
    id: 'fl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    user_id: req.user.id,
    user_email: req.user.email,
    origin_city,
    origin_province: String((b.origin && (b.origin.state || b.origin.province)) || '').trim(),
    dest_city,
    dest_province: String((b.destination && (b.destination.state || b.destination.province)) || '').trim(),
    equipment,
    weight_lb: Math.max(0, parseFloat(b.weight_lb) || 0),
    pieces: Math.max(0, parseInt(b.pieces, 10) || 0),
    pickup_date: b.pickup_date || null,
    commodity: String(b.commodity || '').slice(0, 120),
    notes: String(b.notes || '').slice(0, 2000),
    status: 'new',
    created_at: new Date().toISOString(),
  };
  try {
    if (db.isEnabled()) {
      const r = await db.query(
        `INSERT INTO full_load_requests
           (user_id, user_email, origin_city, origin_province, dest_city, dest_province,
            equipment, weight_lb, pieces, pickup_date, commodity, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id, created_at`,
        [rec.user_id, rec.user_email, rec.origin_city, rec.origin_province, rec.dest_city,
         rec.dest_province, rec.equipment, rec.weight_lb, rec.pieces,
         rec.pickup_date || null, rec.commodity, rec.notes]
      );
      rec.id = r.rows[0].id;
      rec.created_at = r.rows[0].created_at;
    } else {
      fullLoadMem.unshift(rec);
    }
  } catch (err) {
    console.error('[quotes] full-load-request store failed (memory fallback):', err.message);
    fullLoadMem.unshift(rec);
  }
  try {
    const notifyLib = require('../lib/notify');
    // Suggested FTL pricing basis for the admin: 20,000 lb minimum at the
    // lane's 20,000-lb break with the carrier's FTL fuel surcharge.
    let ftlHint = '';
    try {
      const matrix = require('../lib/matrix');
      if (typeof matrix.quoteFtl === 'function') {
        const qs = matrix.quoteFtl({
          originCity: origin_city, originProv: rec.origin_province,
          destCity: dest_city, destProv: rec.dest_province,
          weightLbs: rec.weight_lb, packages: [],
        });
        if (qs.length) {
          const b = qs[0];
          const cad = (n) => '$' + Number(n || 0).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          ftlHint = `Suggested FTL basis: ${b.carrier_label} — 20,000 lb × $${b.rate_cwt_used}/CWT = ${cad(b.base_cad)} base + ${b.fsc_percent}% FTL fuel surcharge (${cad(b.fsc_cad)}) ≈ ${cad(b.total_cad)} total.`;
        }
      }
    } catch (err) { console.error('[quotes] FTL hint failed (non-fatal):', err.message); }
    notifyLib.notify('full_load_request', null, { request: rec, ftl_hint: ftlHint });
  } catch (err) { console.error('[notify] hook failed (non-fatal):', err.message); }
  res.json({ ok: true });
});

function rowToQuote(row) {
  const j = (v) => {
    if (v == null) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return null; }
  };
  return {
    id: row.id,
    shipment_id: row.id,
    quote_name: row.quote_name,
    user_id: row.user_id,
    origin: {
      street1: row.origin_street1, city: row.origin_city, state: row.origin_state,
      zip: row.origin_zip, country: row.origin_country,
    },
    destination: {
      street1: row.dest_street1, city: row.dest_city, state: row.dest_state,
      zip: row.dest_zip, country: row.dest_country,
    },
    shipper: j(row.shipper_json) || {},
    consignee: j(row.consignee_json) || {},
    packages: j(row.packages_json) || [],
    accessorials: j(row.accessorials_json) || [],
    rates: j(row.rates_json) || [],
    region: row.region || 'canada_usa',
    direction: row.direction || 'outbound',
    freight_charges: row.freight_charges || 'prepaid',
    bill_to: j(row.bill_to_json) || {},
    depot_dropoff: !!row.depot_dropoff,
    depot_pickup: !!row.depot_pickup,
    delivery_note_1: row.delivery_note_1 || '',
    delivery_note_2: row.delivery_note_2 || '',
    private_notes: row.private_notes || '',
    add_insurance: !!row.add_insurance,
    insurance_declared: row.insurance_declared != null ? Number(row.insurance_declared) : null,
    total_weight_lbs: row.parcel_weight != null ? Number(row.parcel_weight) : null,
    created_at: row.created_at,
    is_saved: !!row.is_saved,
  };
}

function memToQuote(q) {
  return {
    id: q.db_quote_id || q.shipment_id,
    shipment_id: q.shipment_id,
    quote_name: q.quote_name || null,
    user_id: q.user_id || null,
    origin: q.origin,
    destination: q.destination,
    shipper: q.shipper || {},
    consignee: q.consignee || {},
    packages: q.packages || [],
    accessorials: q.accessorials || [],
    rates: q.rates || [],
    region: q.region || 'canada_usa',
    direction: q.direction || 'outbound',
    freight_charges: q.freight_charges || 'prepaid',
    bill_to: q.bill_to || {},
    depot_dropoff: !!q.depot_dropoff,
    depot_pickup: !!q.depot_pickup,
    delivery_note_1: q.delivery_note_1 || '',
    delivery_note_2: q.delivery_note_2 || '',
    private_notes: q.private_notes || '',
    add_insurance: !!q.add_insurance,
    insurance_declared: q.declared_value != null ? Number(q.declared_value) : null,
    total_weight_lbs: q.total_weight_lbs ?? null,
    created_at: q.created_at,
    is_saved: true,
  };
}

// POST /api/quotes/:id/save — { name?, delivery_note_1?, delivery_note_2?, private_notes? }
router.post('/:id/save', async (req, res) => {
  if (!req.user) return bad(res, 401, 'Sign in required.');
  const { id } = req.params;
  const body = req.body || {};
  const name = String(body.name || '').slice(0, 255) || null;
  const notes = {
    delivery_note_1: String(body.delivery_note_1 || '').slice(0, 60),
    delivery_note_2: String(body.delivery_note_2 || '').slice(0, 60),
    private_notes: String(body.private_notes || '').slice(0, 4000),
  };

  // In-memory record first (fast path; also the only path without a DB).
  const mem = store.quotes.get(id);
  if (mem) {
    if (ownerMismatch(req, mem.user_id)) return bad(res, 403, 'Not your quote');
    mem.quote_name = name;
    mem.is_saved = true;
    Object.assign(mem, notes);
    store.savedQuotes.set(mem.shipment_id, mem);
    if (db.isEnabled() && mem.db_quote_id) {
      try {
        await db.query(
          `UPDATE quotes SET is_saved = true, quote_name = $2, delivery_note_1 = $3, delivery_note_2 = $4,
                             private_notes = $5, add_insurance = $6, insurance_declared = $7 WHERE id = $1`,
          [mem.db_quote_id, name, notes.delivery_note_1, notes.delivery_note_2, notes.private_notes,
           !!mem.add_insurance, mem.declared_value != null ? mem.declared_value : null]
        );
      } catch (err) {
        return bad(res, 502, 'Could not mark quote saved: ' + err.message);
      }
    }
    return res.json({ saved: true, quote: memToQuote(mem) });
  }

  // Fall back to a DB row by uuid (e.g. after a server restart).
  if (db.isEnabled()) {
    try {
      const chk = await db.query('SELECT user_id FROM quotes WHERE id = $1', [id]);
      if (!chk.rows.length) return bad(res, 404, 'Unknown quote id — request a fresh quote first');
      if (ownerMismatch(req, chk.rows[0].user_id)) return bad(res, 403, 'Not your quote');
      const r = await db.query(
        `UPDATE quotes SET is_saved = true, quote_name = COALESCE($2, quote_name),
                           delivery_note_1 = $3, delivery_note_2 = $4, private_notes = $5
         WHERE id = $1 RETURNING *`,
        [id, name, notes.delivery_note_1, notes.delivery_note_2, notes.private_notes]
      );
      if (!r.rows.length) return bad(res, 404, 'Unknown quote id — request a fresh quote first');
      return res.json({ saved: true, quote: rowToQuote(r.rows[0]) });
    } catch (err) {
      return bad(res, 502, 'Could not save quote: ' + err.message);
    }
  }

  return bad(res, 404, 'Unknown quote id — request a fresh quote first');
});

// GET /api/quotes/saved — the signed-in account's saved quotes only.
router.get('/saved', async (req, res) => {
  if (!req.user) return bad(res, 401, 'Sign in required.');
  const userId = req.user.id;
  if (db.isEnabled()) {
    try {
      const r = await db.query(
        'SELECT * FROM quotes WHERE is_saved = true AND user_id = $1 ORDER BY created_at DESC LIMIT 50',
        [userId]
      );
      return res.json({ quotes: r.rows.map(rowToQuote) });
    } catch (err) {
      return bad(res, 502, 'Could not list saved quotes: ' + err.message);
    }
  }
  const all = [...store.savedQuotes.values()]
    .filter((q) => q.user_id === userId)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, 50);
  return res.json({ quotes: all.map(memToQuote) });
});

// GET /api/quotes/:id
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const mem = store.quotes.get(id) || store.savedQuotes.get(id);
  if (mem) return res.json({ quote: memToQuote(mem) });
  if (db.isEnabled()) {
    try {
      const r = await db.query('SELECT * FROM quotes WHERE id = $1', [id]);
      if (!r.rows.length) return bad(res, 404, 'Unknown quote id');
      return res.json({ quote: rowToQuote(r.rows[0]) });
    } catch (err) {
      return bad(res, 502, 'Could not load quote: ' + err.message);
    }
  }
  return bad(res, 404, 'Unknown quote id');
});

// ---------------------------------------------------------------------------
// Attachments — files land on disk under backend/uploads/<shipment_key>/ and
// metadata goes to quote_attachments (or the in-memory quote record when no
// DB is configured).
// ---------------------------------------------------------------------------
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');
try { fs.mkdirSync(UPLOAD_ROOT, { recursive: true }); } catch { /* ignore */ }

function safeKey(id) {
  return String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'quote';
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_ROOT, safeKey(req.params.id));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = String(file.originalname || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 200) || 'file';
    cb(null, Date.now().toString(36) + '_' + safe);
  },
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024, files: 10 } });

async function resolveQuote(id) {
  const mem = store.quotes.get(id) || store.savedQuotes.get(id);
  if (mem) {
    return { mem, dbId: mem.db_quote_id || null, shipmentKey: mem.shipment_id, userId: mem.user_id || null };
  }
  if (db.isEnabled()) {
    const r = await db.query('SELECT * FROM quotes WHERE id = $1', [id]);
    if (r.rows.length) {
      const row = r.rows[0];
      return { mem: null, dbId: row.id, shipmentKey: String(row.id), userId: row.user_id || null };
    }
  }
  return null;
}

function ownerMismatch(req, userId) {
  // Anonymous callers may only touch ownerless (guest) quotes; anyone else
  // must match the quote owner's account.
  if (!req.user) return !!userId;
  return !!(userId && String(req.user.id) !== String(userId));
}

function attPublic(a) {
  return {
    id: a.id, filename: a.filename, mime: a.mime,
    size_bytes: a.size_bytes != null ? Number(a.size_bytes) : null,
    created_at: a.created_at,
    download_url: `/api/quotes/attachments/${encodeURIComponent(a.id)}/download`,
  };
}

// POST /api/quotes/:id/attachments — multipart files[] (max 10, 25MB each)
router.post('/:id/attachments',
  async (req, res, next) => {
    try {
      const q = await resolveQuote(req.params.id);
      if (!q) return bad(res, 404, 'Unknown quote id — request a fresh quote first');
      if (ownerMismatch(req, q.userId)) return bad(res, 403, 'Not your quote');
      req._quote = q;
      next();
    } catch (err) { next(err); }
  },
  (req, res, next) => upload.array('files', 10)(req, res, (err) => {
    if (err) return bad(res, 400, 'Upload failed: ' + err.message);
    next();
  }),
  async (req, res, next) => {
    try {
      const q = req._quote;
      const out = [];
      for (const f of req.files || []) {
        const rec = {
          id: 'att_' + Math.random().toString(36).slice(2, 10),
          filename: f.originalname, stored_path: f.path, mime: f.mimetype,
          size_bytes: f.size, created_at: new Date().toISOString(),
          shipment_key: q.shipmentKey,
        };
        if (db.isEnabled()) {
          const r = await db.query(
            `INSERT INTO quote_attachments (quote_id, shipment_key, user_id, filename, stored_path, mime, size_bytes)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
            [q.dbId, q.shipmentKey, q.userId, f.originalname, f.path, f.mimetype, f.size]
          );
          rec.id = r.rows[0].id;
          rec.created_at = r.rows[0].created_at;
        } else if (q.mem) {
          q.mem.attachments = q.mem.attachments || [];
          q.mem.attachments.push(rec);
        }
        out.push(attPublic(rec));
      }
      return res.json({ uploaded: out });
    } catch (err) { next(err); }
  }
);

// GET /api/quotes/:id/attachments
router.get('/:id/attachments', async (req, res, next) => {
  try {
    const q = await resolveQuote(req.params.id);
    if (!q) return bad(res, 404, 'Unknown quote id');
    if (ownerMismatch(req, q.userId)) return bad(res, 403, 'Not your quote');
    let list = [];
    if (db.isEnabled()) {
      const r = await db.query(
        `SELECT id, filename, mime, size_bytes, created_at FROM quote_attachments
         WHERE shipment_key = $1 ${q.dbId ? 'OR quote_id = $2' : ''} ORDER BY created_at`,
        q.dbId ? [q.shipmentKey, q.dbId] : [q.shipmentKey]
      );
      list = r.rows.map(attPublic);
    } else if (q.mem) {
      list = (q.mem.attachments || []).map(attPublic);
    }
    return res.json({ attachments: list });
  } catch (err) { next(err); }
});

async function findAttachment(attId) {
  if (db.isEnabled()) {
    const r = await db.query('SELECT * FROM quote_attachments WHERE id = $1', [attId]);
    if (r.rows.length) {
      const a = r.rows[0];
      return { rec: a, userId: a.user_id || null, shipmentKey: a.shipment_key, fromDb: true };
    }
  }
  for (const q of [...store.quotes.values(), ...store.savedQuotes.values()]) {
    const hit = (q.attachments || []).find((a) => String(a.id) === String(attId));
    if (hit) return { rec: hit, mem: q, userId: q.user_id || null, shipmentKey: q.shipment_id, fromDb: false };
  }
  return null;
}

// DELETE /api/quotes/:id/attachments/:attId
router.delete('/:id/attachments/:attId', async (req, res, next) => {
  try {
    const q = await resolveQuote(req.params.id);
    if (!q) return bad(res, 404, 'Unknown quote id');
    if (ownerMismatch(req, q.userId)) return bad(res, 403, 'Not your quote');
    const found = await findAttachment(req.params.attId);
    if (!found || String(found.shipmentKey) !== String(q.shipmentKey)) {
      return bad(res, 404, 'Attachment not found on this quote');
    }
    try { fs.unlinkSync(found.rec.stored_path); } catch { /* already gone */ }
    if (found.fromDb) {
      await db.query('DELETE FROM quote_attachments WHERE id = $1', [req.params.attId]);
    } else if (found.mem) {
      found.mem.attachments = (found.mem.attachments || []).filter((a) => String(a.id) !== String(req.params.attId));
    }
    return res.json({ deleted: true });
  } catch (err) { next(err); }
});

// GET /api/quotes/attachments/:attId/download — streams the file.
router.get('/attachments/:attId/download', async (req, res, next) => {
  try {
    const found = await findAttachment(req.params.attId);
    if (!found) return bad(res, 404, 'Attachment not found');
    if (ownerMismatch(req, found.userId)) return bad(res, 403, 'Not your file');
    if (!found.rec.stored_path || !fs.existsSync(found.rec.stored_path)) {
      return bad(res, 410, 'File no longer stored on this server');
    }
    return res.download(found.rec.stored_path, found.rec.filename || 'file');
  } catch (err) { next(err); }
});

module.exports = router;
