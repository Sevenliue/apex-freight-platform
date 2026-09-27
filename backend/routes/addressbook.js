// routes/addressbook.js — saved shipper/consignee address book.
//   GET    /api/address-book        — list (newest first)
//   POST   /api/address-book        — create {label*, company, contact_name,
//                                     street, city*, province, postal,
//                                     country, phone, email}
//   PUT    /api/address-book/:id    — update
//   DELETE /api/address-book/:id    — delete
// With no database, records live in memory for the server's lifetime.
'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

// Address-book records contain customer PII — every route requires sign-in.
// (ownerId below is therefore always the signed-in account's id.)
router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  next();
});

// In-memory fallback: id -> record.
const mem = new Map();

function memId() {
  return db.newId('ab');
}

function str(v, max) {
  return String(v == null ? '' : v).slice(0, max);
}

function clean(body) {
  const b = body || {};
  return {
    label: str(b.label, 120).trim(),
    company: str(b.company, 160).trim(),
    contact_name: str(b.contact_name, 120).trim(),
    street: str(b.street, 160).trim(),
    city: str(b.city, 80).trim(),
    province: str(b.province, 40).trim(),
    postal: str(b.postal, 20).trim(),
    country: str(b.country, 40).trim() || 'CA',
    phone: str(b.phone, 40).trim(),
    email: str(b.email, 160).trim(),
  };
}

function rowToAddr(row) {
  return {
    id: row.id,
    user_id: row.user_id || null,
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

// GET /api/address-book/search?q=<text> — type-ahead over the signed-in
// user's own address book. Used by the quote form: address-book matches are
// shown FIRST, Google Places suggestions come after. Never touches Google,
// so it also saves Places API calls.
router.get('/search', async (req, res) => {
  const ownerId = (req.user && req.user.id) || null;
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q.length < 2) return res.json({ suggestions: [] });
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const match = (a) =>
    [a.label, a.company, a.contact_name, a.street, a.city, a.postal]
      .some((v) => String(v || '').toLowerCase().includes(q));
  try {
    let rows;
    if (db.isEnabled()) {
      const r = await db.query(
        `SELECT id, label, company, contact_name, street, city, province,
                postal, country, phone, email
           FROM address_book
          WHERE user_id IS NOT DISTINCT FROM $1
            AND (lower(label) LIKE $2 OR lower(company) LIKE $2
                 OR lower(contact_name) LIKE $2 OR lower(street) LIKE $2
                 OR lower(city) LIKE $2 OR lower(postal) LIKE $2)
          ORDER BY created_at DESC LIMIT 8`,
        [ownerId, like]
      );
      rows = r.rows;
    } else {
      rows = [...mem.values()]
        .filter((a) => (a.user_id || null) === (ownerId || null) && match(a))
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
        .slice(0, 8);
    }
    return res.json({
      suggestions: rows.map((a) => ({
        source: 'address_book',
        id: a.id,
        main_text: [a.label || a.company || a.contact_name, a.street].filter(Boolean).join(' — ') || a.city,
        secondary_text: [a.city, a.province, a.postal].filter(Boolean).join(', ') + ' · ★ My address book',
        address: {
          name: a.contact_name || a.company || '',
          street: a.street || '',
          city: a.city || '',
          province: a.province || '',
          postal: a.postal || '',
          country: a.country || 'CA',
          phone: a.phone || '',
          email: a.email || '',
        },
      })),
    });
  } catch (err) {
    return res.status(502).json({ error: 'Address search failed: ' + err.message });
  }
});

router.get('/primary', async (req, res) => {
  const ownerId = (req.user && req.user.id) || null;
  try {
    if (db.isEnabled()) {
      const r = await db.query(
        `SELECT * FROM address_book
          WHERE user_id IS NOT DISTINCT FROM $1 AND is_primary = true
          ORDER BY created_at DESC LIMIT 1`,
        [ownerId]
      );
      return res.json({ address: r.rows.length ? rowToAddr(r.rows[0]) : null });
    }
    const rec = [...mem.values()]
      .filter((a) => (a.user_id || null) === (ownerId || null) && a.is_primary)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0];
    return res.json({ address: rec || null });
  } catch (err) {
    return res.status(502).json({ error: 'Could not load primary address: ' + err.message });
  }
});

router.get('/', async (req, res) => {
  const ownerId = (req.user && req.user.id) || null;
  if (db.isEnabled()) {
    try {
      const r = ownerId
        ? await db.query('SELECT * FROM address_book WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200', [ownerId])
        : await db.query('SELECT * FROM address_book ORDER BY created_at DESC LIMIT 200');
      return res.json({ addresses: r.rows.map(rowToAddr) });
    } catch (err) {
      return res.status(502).json({ error: 'Could not list addresses: ' + err.message });
    }
  }
  const all = [...mem.values()]
    .filter((a) => !ownerId || a.user_id === ownerId)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  res.json({ addresses: all });
});

router.post('/', async (req, res) => {
  const a = clean(req.body);
  if (!a.label || !a.city) {
    return res.status(400).json({ error: 'label and city are required' });
  }
  const ownerId = (req.user && req.user.id) || null;
  // Dedupe on street+city+postal per account (e.g. double-clicking the
  // "Save to address book" button): return the existing record instead of
  // creating a duplicate.
  const dupWhere = 'user_id IS NOT DISTINCT FROM $1 AND lower(street) = lower($2) AND lower(city) = lower($3) AND lower(coalesce(postal,\'\')) = lower($4)';
  if (db.isEnabled()) {
    try {
      const dup = await db.query(`SELECT * FROM address_book WHERE ${dupWhere} LIMIT 1`, [ownerId, a.street, a.city, a.postal]);
      if (dup.rows.length) return res.json({ address: rowToAddr(dup.rows[0]), duplicate: true });
      const r = await db.query(
        `INSERT INTO address_book (user_id, label, company, contact_name, street, city, province, postal, country, phone, email)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [ownerId, a.label, a.company || null, a.contact_name || null, a.street || null, a.city,
         a.province || null, a.postal || null, a.country, a.phone || null, a.email || null]
      );
      return res.status(201).json({ address: rowToAddr(r.rows[0]) });
    } catch (err) {
      return res.status(502).json({ error: 'Could not save address: ' + err.message });
    }
  }
  const existing = [...mem.values()].find(
    (r) =>
      (r.user_id || null) === (ownerId || null) &&
      String(r.street || '').toLowerCase() === a.street.toLowerCase() &&
      String(r.city || '').toLowerCase() === a.city.toLowerCase() &&
      String(r.postal || '').toLowerCase() === a.postal.toLowerCase()
  );
  if (existing) return res.json({ address: existing, duplicate: true });
  const rec = { id: memId(), user_id: (req.user && req.user.id) || null, ...a, is_primary: false, created_at: new Date().toISOString() };
  mem.set(rec.id, rec);
  res.status(201).json({ address: rec });
});

router.put('/:id', async (req, res) => {
  const a = clean(req.body);
  if (!a.label || !a.city) {
    return res.status(400).json({ error: 'label and city are required' });
  }
  if (db.isEnabled()) {
    try {
      const ownerId = (req.user && req.user.id) || null;
      const r = ownerId
        ? await db.query(
            `UPDATE address_book
             SET label=$3, company=$4, contact_name=$5, street=$6, city=$7,
                 province=$8, postal=$9, country=$10, phone=$11, email=$12
             WHERE id=$1 AND user_id=$2 RETURNING *`,
            [req.params.id, ownerId, a.label, a.company || null, a.contact_name || null, a.street || null, a.city,
             a.province || null, a.postal || null, a.country, a.phone || null, a.email || null]
          )
        : await db.query(
            `UPDATE address_book
             SET label=$2, company=$3, contact_name=$4, street=$5, city=$6,
                 province=$7, postal=$8, country=$9, phone=$10, email=$11
             WHERE id=$1 RETURNING *`,
            [req.params.id, a.label, a.company || null, a.contact_name || null, a.street || null, a.city,
             a.province || null, a.postal || null, a.country, a.phone || null, a.email || null]
          );
      if (!r.rows.length) return res.status(404).json({ error: 'Unknown address id' });
      return res.json({ address: rowToAddr(r.rows[0]) });
    } catch (err) {
      return res.status(502).json({ error: 'Could not update address: ' + err.message });
    }
  }
  const rec = mem.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Unknown address id' });
  const ownerId = (req.user && req.user.id) || null;
  if (ownerId && rec.user_id !== ownerId) return res.status(404).json({ error: 'Unknown address id' });
  const updated = { ...rec, ...a };
  mem.set(rec.id, updated);
  res.json({ address: updated });
});

router.post('/:id/primary', async (req, res) => {
  const ownerId = (req.user && req.user.id) || null;
  if (db.isEnabled()) {
    try {
      const chk = ownerId
        ? await db.query('SELECT id FROM address_book WHERE id = $1 AND user_id = $2', [req.params.id, ownerId])
        : await db.query('SELECT id FROM address_book WHERE id = $1', [req.params.id]);
      if (!chk.rows.length) return res.status(404).json({ error: 'Unknown address id' });
      await db.query(
        'UPDATE address_book SET is_primary = false WHERE user_id IS NOT DISTINCT FROM $1',
        [ownerId]
      );
      const r = await db.query('UPDATE address_book SET is_primary = true WHERE id = $1 RETURNING *', [
        req.params.id,
      ]);
      return res.json({ address: rowToAddr(r.rows[0]) });
    } catch (err) {
      return res.status(502).json({ error: 'Could not set primary address: ' + err.message });
    }
  }
  const rec = mem.get(req.params.id);
  if (!rec || (ownerId && rec.user_id !== ownerId)) {
    return res.status(404).json({ error: 'Unknown address id' });
  }
  for (const r of mem.values()) {
    if ((r.user_id || null) === (ownerId || null)) r.is_primary = false;
  }
  rec.is_primary = true;
  res.json({ address: rec });
});

router.delete('/:id', async (req, res) => {
  if (db.isEnabled()) {
    try {
      const ownerId = (req.user && req.user.id) || null;
      const r = ownerId
        ? await db.query('DELETE FROM address_book WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, ownerId])
        : await db.query('DELETE FROM address_book WHERE id = $1 RETURNING id', [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'Unknown address id' });
      return res.json({ deleted: true });
    } catch (err) {
      return res.status(502).json({ error: 'Could not delete address: ' + err.message });
    }
  }
  {
    const rec = mem.get(req.params.id);
    const ownerId = (req.user && req.user.id) || null;
    if (!rec || (ownerId && rec.user_id !== ownerId)) {
      return res.status(404).json({ error: 'Unknown address id' });
    }
    mem.delete(req.params.id);
  }
  res.json({ deleted: true });
});

module.exports = router;

// savePartyAddresses(userId, shipper, consignee): auto-save the addresses a
// customer typed on the quote/shipment form into their own address book, so
// each address stays attached to their customer account. Called best-effort
// from order creation; never throws.
// Party shape: {name, street1|street, city, state|province, zip|postal,
//               country, phone, email}
async function savePartyAddresses(userId, shipper, consignee) {
  const norm = (p, kind) => {
    const q = p || {};
    const street = String(q.street1 || q.street || '').trim();
    const city = String(q.city || '').trim();
    if (!street || !city) return null;
    const name = String(q.name || q.company || '').trim().slice(0, 120);
    return {
      label: (kind + ' — ' + (name || 'address')).slice(0, 120),
      company: name,
      contact_name: name,
      street: street.slice(0, 160),
      city: city.slice(0, 80),
      province: String(q.state || q.province || '').trim().slice(0, 40),
      postal: String(q.zip || q.postal || '').trim().slice(0, 20),
      country: String(q.country || '').trim().slice(0, 40) || 'CA',
      phone: String(q.phone || '').trim().slice(0, 40),
      email: String(q.email || '').trim().slice(0, 160),
    };
  };
  const parties = [
    norm(shipper, 'Shipper'),
    norm(consignee, 'Consignee'),
  ].filter(Boolean);
  if (!parties.length) return;

  if (db.isEnabled()) {
    for (const a of parties) {
      const dup = await db.query(
        `SELECT id FROM address_book
         WHERE user_id IS NOT DISTINCT FROM $1
           AND lower(street) = lower($2) AND lower(city) = lower($3)
           AND lower(coalesce(postal,'')) = lower($4) LIMIT 1`,
        [userId || null, a.street, a.city, a.postal]
      );
      if (dup.rows.length) continue;
      await db.query(
        `INSERT INTO address_book (user_id, label, company, contact_name, street, city, province, postal, country, phone, email)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [userId || null, a.label, a.company || null, a.contact_name || null, a.street, a.city,
         a.province || null, a.postal || null, a.country, a.phone || null, a.email || null]
      );
    }
    return;
  }
  for (const a of parties) {
    const dup = [...mem.values()].some(
      (r) =>
        (r.user_id || null) === (userId || null) &&
        String(r.street || '').toLowerCase() === a.street.toLowerCase() &&
        String(r.city || '').toLowerCase() === a.city.toLowerCase() &&
        String(r.postal || '').toLowerCase() === a.postal.toLowerCase()
    );
    if (dup) continue;
    const rec = { id: memId(), user_id: userId || null, ...a, created_at: new Date().toISOString() };
    mem.set(rec.id, rec);
  }
}

module.exports.savePartyAddresses = savePartyAddresses;
