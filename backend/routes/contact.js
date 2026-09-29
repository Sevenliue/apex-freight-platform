// routes/contact.js — public "Contact us" form.
//
//   POST /api/contact  {name, email, message}
//
// Rate-limited. Delivers to the admin inbox through the notify layer
// (resend/webhook when configured). When no email provider is configured the
// endpoint answers 503 with a clear message instead of silently dropping
// the message — the frontend then shows a fallback contact address.
'use strict';

const express = require('express');
const { rateLimit } = require('../lib/rate-limit');

const router = express.Router();
const contactLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: 'contact' });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emailConfigured() {
  const p = String(process.env.NOTIFY_PROVIDER || 'log').toLowerCase();
  if (p === 'resend') return !!(process.env.RESEND_API_KEY && process.env.NOTIFY_FROM);
  if (p === 'webhook') return !!process.env.NOTIFY_WEBHOOK_URL;
  return false;
}

router.post('/', contactLimit, async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 255);
  const email = String(b.email || '').trim().toLowerCase().slice(0, 254);
  const message = String(b.message || '').trim().slice(0, 5000);

  if (!name) return res.status(400).json({ error: 'Your name is required.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email address is required.' });
  if (message.length < 10) {
    return res.status(400).json({ error: 'Please write a short message (at least 10 characters).' });
  }

  const { sendEmail, adminEmail } = require('../lib/notify');
  const to = adminEmail();
  if (!to || !emailConfigured()) {
    return res.status(503).json({
      error: 'The contact form is not connected yet — please email us directly instead.',
    });
  }
  const result = await sendEmail({
    to,
    subject: `Website contact — ${name}`,
    text: `Name: ${name}\nEmail: ${email}\n\n${message}`,
    event: 'contact_form',
  });
  if (result && result.failed) {
    return res.status(502).json({ error: 'Could not send your message — please try again later.' });
  }
  return res.json({ ok: true, message: 'Thanks — your message is on its way. We reply within one business day.' });
});

module.exports = router;
