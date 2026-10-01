// routes/holidays.js — public Canadian statutory-holiday reference.
//   GET /api/holidays?year=2026&prov=AB -> {year, prov, holidays: [{date, name}]}
// Used by the quote/pickup date pickers and as an inspectable reference for
// the holiday logic applied to transit estimates.
'use strict';

const express = require('express');
const holidays = require('../lib/holidays');

const router = express.Router();

router.get('/', (req, res) => {
  const year = Number(req.query.year) || new Date().getUTCFullYear();
  const prov = String(req.query.prov || '').trim().toUpperCase() || null;
  if (!Number.isFinite(year) || year < 2000 || year > 2100) {
    return res.status(400).json({ error: 'year must be between 2000 and 2100' });
  }
  if (prov && !holidays.PROVINCES.includes(prov)) {
    return res.status(400).json({ error: `unknown province '${prov}'` });
  }
  res.json({
    year,
    prov,
    province_name: prov ? holidays.provinceName(prov) : null,
    holidays: holidays.listHolidays(year, prov),
  });
});

module.exports = router;
