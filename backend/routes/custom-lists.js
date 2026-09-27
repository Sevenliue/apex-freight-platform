// routes/custom-lists.js — per-account custom dropdown lists.
//
//   GET    /api/custom-lists/:kind       — list own labels (newest first)
//   POST   /api/custom-lists/:kind       — add {label}
//   DELETE /api/custom-lists/:kind/:id   — delete own label
//
// kind is 'package_type' or 'product_name'. Auth required.
// With no database, records live in memory for the server's lifetime.
'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

const KINDS = new Set(['package_type', 'product_name']);

// In-memory fallback: `${userId}:${kind}:${id}` -> record.
const mem = new Map();

function memId() {
  return db.newId('cl');
}

function bad(res, code, error) {
  return res.status(code).json({ error });
}

function checkKind(req, res) {
  const kind = req.params.kind;
  if (!KINDS.has(kind)) {
    bad(res, 400, "Unknown list: kind must be 'package_type' or 'product_name'.");
    return null;
  }
  return kind;
}

function needAuth(req, res) {
  if (!req.user) {
    bad(res, 401, 'Sign in to manage your custom lists.');
    return false;
  }
  return true;
}

function cleanLabel(v) {
  return String(v == null ? '' : v).trim().slice(0, 80);
}

function memList(userId, kind) {
  return [...mem.values()]
    .filter((r) => r.user_id === userId && r.kind === kind)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

// GET /api/custom-lists/:kind — own labels, newest first.
router.get('/:kind', async (req, res) => {
  if (!needAuth(req, res)) return;
  const kind = checkKind(req, res);
  if (!kind) return;
  const userId = req.user.id;
  if (db.isEnabled()) {
    try {
      const r = await db.query(
        `SELECT id, kind, label, created_at FROM custom_list_items
          WHERE user_id = $1 AND kind = $2 ORDER BY created_at DESC LIMIT 200`,
        [userId, kind]
      );
      return res.json({ items: r.rows });
    } catch (err) {
      return bad(res, 502, 'Could not list custom items: ' + err.message);
    }
  }
  return res.json({ items: memList(userId, kind) });
});

// POST /api/custom-lists/:kind — add {label}.
router.post('/:kind', async (req, res) => {
  if (!needAuth(req, res)) return;
  const kind = checkKind(req, res);
  if (!kind) return;
  const label = cleanLabel((req.body || {}).label);
  if (!label) return bad(res, 400, 'Label is required.');
  const userId = req.user.id;
  if (db.isEnabled()) {
    try {
      const r = await db.query(
        `INSERT INTO custom_list_items (user_id, kind, label)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, kind, label) DO UPDATE SET label = EXCLUDED.label
         RETURNING id, kind, label, created_at`,
        [userId, kind, label]
      );
      return res.status(201).json({ item: r.rows[0] });
    } catch (err) {
      return bad(res, 502, 'Could not save custom item: ' + err.message);
    }
  }
  const now = new Date().toISOString();
  const existing = memList(userId, kind).find((r) => r.label.toLowerCase() === label.toLowerCase());
  if (existing) return res.status(201).json({ item: existing });
  const rec = { id: memId(), user_id: userId, kind, label, created_at: now };
  mem.set(`${userId}:${kind}:${rec.id}`, rec);
  return res.status(201).json({ item: rec });
});

// DELETE /api/custom-lists/:kind/:id — delete own label.
router.delete('/:kind/:id', async (req, res) => {
  if (!needAuth(req, res)) return;
  const kind = checkKind(req, res);
  if (!kind) return;
  const userId = req.user.id;
  const id = req.params.id;
  if (db.isEnabled()) {
    try {
      const r = await db.query(
        'DELETE FROM custom_list_items WHERE id = $1 AND user_id = $2 AND kind = $3',
        [id, userId, kind]
      );
      if (!r.rowCount) return bad(res, 404, 'Custom item not found.');
      return res.json({ deleted: true });
    } catch (err) {
      return bad(res, 502, 'Could not delete custom item: ' + err.message);
    }
  }
  const key = `${userId}:${kind}:${id}`;
  if (!mem.has(key)) return bad(res, 404, 'Custom item not found.');
  mem.delete(key);
  return res.json({ deleted: true });
});

module.exports = router;
