// routes/webhooks.js — POST /api/webhooks/easypost
// Receives EasyPost event webhooks. ALWAYS answers 200 'Webhook Received'
// (EasyPost retries otherwise). When a database is configured and the event
// is a tracker update, the matching order's status is updated and a row is
// appended to tracking_logs.
'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

router.post('/easypost', async (req, res) => {
  const event = req.body || {};
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
});

module.exports = router;
