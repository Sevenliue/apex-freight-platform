// lib/sheet-dates.js — per-carrier rate-sheet effective/expiry dates + staleness.
//
// The live matrix (matrix-data.json) carries FSC percents and FSC as-of
// dates, but NOT sheet effective/expiry dates — those live only in the
// carriers' sheet notes. This static map records the sheet dates verified
// from those notes, so quote rows can show "Rate checked on [date]" (sheet
// effective + FSC-as-of) and warn on expired sheets / stale FSCs.
//
// Carriers NOT listed here have no verified sheet dates on file — their
// rows show the FSC-as-of date only. Never guess a date: a missing entry
// means "unknown", and the UI must say so (or omit the line).
'use strict';

// carrier_id -> { effective: 'YYYY-MM-DD' | null, expiry: 'YYYY-MM-DD' | null }
// Dates verified from the sheet notes in backend/rates/build-matrix.js
// (guilbault/bandstra/morneau/minimax_ottawa/armour/willys/minimax) and the
// rate-review record (rosenau expiry 2026-12-31).
const SHEET_DATES = {
  guilbault: { effective: '2026-04-01', expiry: '2027-03-31' },
  bandstra: { effective: '2025-10-08', expiry: '2026-10-07' },
  morneau: { effective: null, expiry: '2027-09-30' },
  minimax_ottawa: { effective: null, expiry: '2025-05-31' },
  armour: { effective: '2025-08-28', expiry: '2026-12-31' },
  willys: { effective: '2025-04-01', expiry: '2027-09-30' },
  minimax: { effective: null, expiry: '2026-12-31' },
  rosenau: { effective: null, expiry: '2026-12-31' },
  number8: { effective: '2024-03-01', expiry: null }, // 6-zone CWT tariff eff. Mar 2024; Seven confirmed still current 2026-10-19; no expiry on sheet
  donedeal: { effective: '2026-10-19', expiry: null }, // ASSUMPTION: no date on the sheet (photo); recorded as the date Seven provided it 2026-10-19
  teams: { effective: '2024-06-05', expiry: '2024-08-31' }, // printed dates on the Total Tire quote sheets; loaded per Seven 2026-10-20 (stated still up to date) — rows will flag the sheet as expired, which is the honest state of the paper
};

// Staleness for the CUSTOMER-FACING quote board. Deliberately stricter than
// the Admin > Fuel surcharges table (which flags a missing as-of date as
// stale — an admin attention signal): on a quote we warn only on POSITIVE
// evidence of staleness — an as-of date present and past its cadence
// window. A missing/unparseable date shows no date and no warning (some
// carriers, e.g. Prime Time with a hard-zero FSC, carry no FSC date at
// all — warning there would cry wolf).
function fscStale(asOf, cadence) {
  if (cadence === 'per_sheet') return false;
  const days = cadence === 'weekly' ? 7 : 31;
  if (!asOf) return false;
  const m = String(asOf).trim().match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +(m[3] || 1)));
  if (Number.isNaN(d.getTime())) return false;
  return Date.now() - d.getTime() > days * 864e5;
}

function sheetDatesFor(carrierId) {
  return SHEET_DATES[carrierId] || { effective: null, expiry: null };
}

// rateCheckedFor(carrierId, meta): freshness block attached to each matrix
// quote row. meta = listCarriers() entry {fsc_as_of, fsc_cadence} | null.
// Dates are 'YYYY-MM-DD' (or 'YYYY-MM' for some FSC as-of values) or null.
// sheet_expired compares YYYY-MM-DD strings lexicographically (safe: fixed width).
function rateCheckedFor(carrierId, meta) {
  const sheet = sheetDatesFor(carrierId);
  const fscAsOf = (meta && meta.fsc_as_of) || null;
  const fscCadence = (meta && meta.fsc_cadence) || null;
  const today = new Date().toISOString().slice(0, 10);
  return {
    fsc_as_of: fscAsOf,
    fsc_cadence: fscCadence,
    sheet_effective: sheet.effective,
    sheet_expiry: sheet.expiry,
    sheet_expired: !!(sheet.expiry && sheet.expiry < today),
    fsc_stale: fscStale(fscAsOf, fscCadence),
  };
}

module.exports = { SHEET_DATES, fscStale, sheetDatesFor, rateCheckedFor };
