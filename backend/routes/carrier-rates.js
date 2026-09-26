// routes/carrier-rates.js — carrier tariff management.
//   POST /api/carrier-rates/upload
//     {carrier_id, carrier_label?, fsc_percent?, lanes:[{origin_city, origin_prov,
//      dest_city, dest_prov, min_charge_cad, breaks:[{max_lb, rate_cwt}]}]}
//     Merges lanes into the in-memory matrix via the engine's upsertCarrierRows
//     and, when DATABASE_URL is set, upserts them into carrier_matrix_rates.
//   GET /api/carrier-rates/accessorials/:carrier_id
'use strict';

const express = require('express');
const db = require('../db');
const matrix = require('../lib/matrix');

const router = express.Router();

router.post('/upload', async (req, res) => {
  const { carrier_id, carrier_label, fsc_percent, lanes } = req.body || {};
  if (!carrier_id || typeof carrier_id !== 'string') {
    return res.status(400).json({ error: 'carrier_id is required' });
  }
  if (!Array.isArray(lanes) || lanes.length === 0) {
    return res.status(400).json({ error: 'lanes must be a non-empty array' });
  }

  let upserted;
  try {
    upserted = matrix.upsertCarrierRows(carrier_id, lanes);
  } catch (err) {
    return res.status(502).json({ error: 'Rate matrix upsert failed', detail: err.message });
  }

  const warnings = [];
  if (db.isEnabled()) {
    try {
      for (const lane of lanes) {
        await db.query(
          `INSERT INTO carrier_matrix_rates
             (carrier_id, carrier_label, fsc_percent, origin_city, origin_prov,
              dest_city, dest_prov, min_charge_cad, breaks, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
           ON CONFLICT (carrier_id, origin_city, origin_prov, dest_city, dest_prov)
           DO UPDATE SET carrier_label = COALESCE(EXCLUDED.carrier_label, carrier_matrix_rates.carrier_label),
                         fsc_percent = COALESCE(EXCLUDED.fsc_percent, carrier_matrix_rates.fsc_percent),
                         min_charge_cad = EXCLUDED.min_charge_cad,
                         breaks = EXCLUDED.breaks,
                         updated_at = now()`,
          [carrier_id, carrier_label || null, fsc_percent != null ? Number(fsc_percent) : null,
           String(lane.origin_city || '').trim(), String(lane.origin_prov || '').trim(),
           String(lane.dest_city || '').trim(), String(lane.dest_prov || '').trim(),
           Number(lane.min_charge_cad) || 0, JSON.stringify(lane.breaks || [])]
        );
      }
    } catch (err) {
      warnings.push(`db_upsert_failed: ${err.message}`);
    }
  }

  const body = { carrier_id, upserted };
  if (warnings.length) body.warnings = warnings;
  return res.json(body);
});

router.get('/accessorials/:carrier_id', (req, res) => {
  try {
    const accessorials = matrix.getAccessorials(req.params.carrier_id) || [];
    return res.json({ carrier_id: req.params.carrier_id, accessorials });
  } catch (err) {
    return res.status(502).json({ error: 'Accessorial lookup failed', detail: err.message });
  }
});

module.exports = router;
