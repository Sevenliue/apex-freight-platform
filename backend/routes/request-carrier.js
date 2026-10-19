// routes/request-carrier.js — public "Request a carrier" form.
//
//   POST /api/request-carrier  {carrier_name, origin_city, dest_city, name, email, notes}
//
// Public (no auth — a shipper without an account can ask for a lane).
// Rate-limited. Delivers to the admin inbox through the notify layer.
// Mirrors routes/contact.js: when no email provider is configured the
// endpoint answers 503 with a clear message instead of silently dropping
// the request.
'use strict';

const express = require('express');
const { rateLimit } = require('../lib/rate-limit');

const router = express.Router();
const requestLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: 'request-carrier' });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emailConfigured() {
  const p = String(process.env.NOTIFY_PROVIDER || 'log').toLowerCase();
  if (p === 'resend') return !!(process.env.RESEND_API_KEY && process.env.NOTIFY_FROM);
  if (p === 'webhook') return !!process.env.NOTIFY_WEBHOOK_URL;
  return false;
}

router.post('/', requestLimit, async (req, res) => {
  const b = req.body || {};
  const carrierName = String(b.carrier_name || '').trim().slice(0, 255);
  const originCity = String(b.origin_city || '').trim().slice(0, 120);
  const destCity = String(b.dest_city || '').trim().slice(0, 120);
  const name = String(b.name || '').trim().slice(0, 255);
  const email = String(b.email || '').trim().toLowerCase().slice(0, 254);
  const notes = String(b.notes || '').trim().slice(0, 2000);

  if (!carrierName) return res.status(400).json({ error: 'Tell us which carrier or lane you need.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email address is required.' });

  const { notify, adminEmail } = require('../lib/notify');
  const to = adminEmail();
  if (!to || !emailConfigured()) {
    return res.status(503).json({
      error: 'The request form is not connected yet — please email us directly instead.',
    });
  }
  try {
    await notify('carrier_requested', null, {
      request: {
        carrier_name: carrierName,
        origin_city: originCity || '—',
        dest_city: destCity || '—',
        name: name || '—',
        email,
        notes: notes || '—',
      },
    });
  } catch (err) {
    console.error('[request-carrier] notify failed:', err.message);
    return res.status(502).json({ error: 'Could not send your request — please try again later.' });
  }
  return res.json({ ok: true, message: 'Thanks — we got your carrier request and will follow up.' });
});

module.exports = router;
