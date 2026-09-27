// routes/webhooks.js — POST /api/webhooks/easypost
// Receives EasyPost event webhooks. The HMAC-SHA256 signature in the
// X-Hmac-Signature header is verified against EASYPOST_WEBHOOK_SECRET before
// anything is trusted; bad signatures are rejected with 401 (EasyPost retries
// non-2XX, so a 401 keeps retrying until the secret is configured).
// When a database is configured and the event is a tracker update, the
// matching order's status is updated and a row is appended to tracking_logs.
//
// NOTE: server.js mounts this handler with express.raw() so req.body is the
// raw Buffer — signature verification needs the exact bytes EasyPost sent.
'use strict';

const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const config = require('../config');

const router = express.Router();

// verifyEasypostSignature(rawBody, headers): EasyPost signs each webhook with
// HMAC-SHA256 over the raw request body; the hex digest arrives as
// `X-Hmac-Signature: hmac-sha256-hex=<hex>`. The secret is NFKD-normalized
// (matching EasyPost's official clients), and integral weights get the
// documented `.0` fixup before hashing because EasyPost's servers serialize
// them as floats.
function verifyEasypostSignature(rawBody, headers) {
  const secret = config.easypostWebhookSecret;
  if (!secret) return false;
  const received = String((headers && headers['x-hmac-signature']) || '');
  const hex = received.startsWith('hmac-sha256-hex=')
    ? received.slice('hmac-sha256-hex='.length)
    : received;
  if (!hex) return false;
  const corrected = Buffer.from(rawBody)
    .toString('utf8')
    .replace(/("weight":\s*)(\d+)(\s*)(?=,|\})/g, '$1$2.0');
  const digest = crypto
    .createHmac('sha256', Buffer.from(secret.normalize('NFKD'), 'utf8'))
    .update(corrected, 'utf8')
    .digest('hex');
  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(hex.trim().toLowerCase(), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function easypostWebhook(req, res) {
  if (!verifyEasypostSignature(req.body, req.headers)) {
    console.warn('[webhook/easypost] rejected: bad or missing signature (set EASYPOST_WEBHOOK_SECRET)');
    return res.status(401).send('Bad signature');
  }
  let event;
  try {
    event = JSON.parse(Buffer.from(req.body).toString('utf8'));
  } catch {
    return res.status(400).send('Bad JSON');
  }
  try {
    const description = event.description || '';
    const result = event.result || {};
    const isTrackerUpdate = description === 'tracker.updated' || result.object === 'Tracker';

    if (db.isEnabled() && isTrackerUpdate && result.tracking_code) {
      await db.query('UPDATE orders SET status = $1 WHERE tracking_code = $2', [
        result.status || 'in_transit',
        result.tracking_code,
      ]);
      await db.query(
        'INSERT INTO tracking_logs (tracking_code, status, detail) VALUES ($1, $2, $3)',
        [result.tracking_code, result.status || null, JSON.stringify(result)]
      );
    }
  } catch (err) {
    // Never fail the webhook acknowledgement because of a DB problem.
    console.error('[webhook/easypost] DB update failed (non-fatal):', err.message);
  }
  return res.status(200).send('Webhook Received');
}

// Exported for server.js, which mounts it with express.raw() ahead of the
// JSON parser. Kept off the router so the raw bytes survive.
module.exports = router;
module.exports.easypostWebhook = easypostWebhook;
