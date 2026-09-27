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
    created_at: row.created_at,
  };
}

router.get('/', async (req, res) => {
  if (db.isEnabled()) {
    try {
      const r = await db.query('SELECT * FROM address_book ORDER BY created_at DESC LIMIT 200');
      return res.json({ addresses: r.rows.map(rowToAddr) });
    } catch (err) {
      return res.status(502).json({ error: 'Could not list addresses: ' + err.message });
    }
  }
  const all = [...mem.values()].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  res.json({ addresses: all });
});

router.post('/', async (req, res) => {
  const a = clean(req.body);
  if (!a.label || !a.city) {
    return res.status(400).json({ error: 'label and city are required' });
  }
  if (db.isEnabled()) {
    try {
      const r = await db.query(
        `INSERT INTO address_book (label, company, contact_name, street, city, province, postal, country, phone, email)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [a.label, a.company || null, a.contact_name || null, a.street || null, a.city,
         a.province || null, a.postal || null, a.country, a.phone || null, a.email || null]
      );
      return res.status(201).json({ address: rowToAddr(r.rows[0]) });
    } catch (err) {
      return res.status(502).json({ error: 'Could not save address: ' + err.message });
    }
  }
  const rec = { id: memId(), ...a, created_at: new Date().toISOString() };
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
      const r = await db.query(
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
  const updated = { ...rec, ...a };
  mem.set(rec.id, updated);
  res.json({ address: updated });
});

router.delete('/:id', async (req, res) => {
  if (db.isEnabled()) {
    try {
      const r = await db.query('DELETE FROM address_book WHERE id = $1 RETURNING id', [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'Unknown address id' });
      return res.json({ deleted: true });
    } catch (err) {
      return res.status(502).json({ error: 'Could not delete address: ' + err.message });
    }
  }
  if (!mem.delete(req.params.id)) return res.status(404).json({ error: 'Unknown address id' });
  res.json({ deleted: true });
});

module.exports = router;
