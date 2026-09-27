// routes/tracking.js — GET /api/tracking/:tracking_code?carrier=
// Creates (or refreshes) an EasyPost Tracker for the code and returns a
// normalized tracking summary. 501 when EASYPOST_API_KEY is not set.
'use strict';

const express = require('express');
const easypost = require('../lib/easypost');

const router = express.Router();

router.get('/:tracking_code', async (req, res) => {
  const { tracking_code } = req.params;
  const carrier = req.query.carrier;

  if (!easypost.isEnabled()) {
    return res.status(501).json({ error: 'Live tracking is not connected yet — the site owner needs to add a carrier tracking key.' });
  }
  if (!carrier) {
    return res.status(400).json({ error: 'carrier query parameter is required' });
  }

  try {
    // Create (or refresh) the tracker via the fetch wrapper, then read
    // back the freshest status.
    const tracker = await easypost.getTracking(tracking_code, carrier);

    const tracking_details = (tracker.tracking_details || []).map((d) => {
      const loc = d.tracking_location || {};
      const location = [loc.city, loc.state, loc.country].filter(Boolean).join(', ') || null;
      return { status: d.status, message: d.message, datetime: d.datetime, location };
    });

    return res.json({
      tracking_code,
      carrier: tracker.carrier,
      status: tracker.status,
      est_delivery_date: tracker.est_delivery_date || null,
      tracking_details,
    });
  } catch (err) {
    return res.status(502).json({ error: 'EasyPost tracking lookup failed', detail: err.message });
  }
});

module.exports = router;
