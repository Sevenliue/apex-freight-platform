// lib/holidays.js — Canadian statutory holidays, federal + provincial.
//
// Used for:
//   - pickup-date validation (carriers don't run on statutory holidays)
//   - transit-day math (delivery estimates skip weekends + holidays)
//
// Coverage: general statutory holidays for all 13 provinces/territories.
// Rules encoded:
//   - Good Friday: all provinces except QC (QC observes Easter Monday instead)
//   - Victoria Day (Mon on/before May 24): AB BC MB NT NU ON SK YT;
//     QC observes National Patriots' Day the same date
//   - 1st Mon Aug: AB Heritage Day, BC BC Day, SK Saskatchewan Day,
//     ON Civic Holiday, NB New Brunswick Day
//   - 3rd Mon Feb: AB/BC/SK/ON/NB Family Day, MB Louis Riel Day, PE Islander Day
//   - Sep 30 Truth and Reconciliation: BC (statute); Thanksgiving: all except
//     NB NS NL PE; Remembrance Day: all except ON QC; Boxing Day: ON
//   - NL extras: St. Patrick's Day (Mar 17), Discovery Day (Jun 24)
//   - NT/YT: National Indigenous Peoples Day (Jun 21)
// Observed rule: a holiday falling on Sat/Sun is observed the following
// Monday; if two observances collide, the later one moves to Tuesday.
// (Quebec's Good-Friday-vs-Easter-Monday employer choice is resolved as
// Easter Monday, the most common payroll treatment.)
//
// All date math is in UTC day numbers — no local-timezone pitfalls.
'use strict';

const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];
const PROVINCE_NAMES = {
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', NT: 'Northwest Territories',
  NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec',
  SK: 'Saskatchewan', YT: 'Yukon',
};
const ALL = [...PROVINCES];
const normProv = (p) => String(p || '').trim().toUpperCase();
function provinceName(prov) {
  return PROVINCE_NAMES[normProv(prov)] || null;
}

// --- calendar math -----------------------------------------------------------
const DAY = 86400000;
const dayNum = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / DAY);
const fromDayNum = (n) => new Date(n * DAY).toISOString().slice(0, 10);
const parseISO = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null;
};
const isoDayNum = (iso) => {
  const p = parseISO(iso);
  return p ? dayNum(p.y, p.mo, p.d) : null;
};
const weekday = (n) => new Date(n * DAY).getUTCDay(); // 0=Sun..6=Sat

function nthWeekdayOfMonth(y, m, wd, n) {
  const first = dayNum(y, m, 1);
  const off = (wd - weekday(first) + 7) % 7;
  return first + off + (n - 1) * 7;
}
function mondayOnOrBefore(y, m, d) {
  let n = dayNum(y, m, d);
  while (weekday(n) !== 1) n -= 1;
  return n;
}
function easterSunday(y) {
  // Anonymous Gregorian computus.
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m2 = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m2 + 114) / 31);
  const day = ((h + l - 7 * m2 + 114) % 31) + 1;
  return dayNum(y, month, day);
}

// --- holiday definitions ------------------------------------------------------
function rawHolidays(year) {
  const H = [];
  const add = (n, name, provs) => H.push({ n, name, provs });
  const notQC = ALL.filter((p) => p !== 'QC');

  add(dayNum(year, 1, 1), "New Year's Day", ALL);

  const fam = nthWeekdayOfMonth(year, 2, 1, 3); // 3rd Monday of February
  add(fam, 'Family Day', ['AB', 'BC', 'SK', 'ON', 'NB']);
  add(fam, 'Louis Riel Day', ['MB']);
  add(fam, 'Islander Day', ['PE']);

  add(dayNum(year, 3, 17), "St. Patrick's Day", ['NL']);

  const easter = easterSunday(year);
  add(easter - 2, 'Good Friday', notQC);
  add(easter + 1, 'Easter Monday', ['QC']);

  const vic = mondayOnOrBefore(year, 5, 24);
  add(vic, 'Victoria Day', ['AB', 'BC', 'MB', 'NT', 'NU', 'ON', 'SK', 'YT']);
  add(vic, "National Patriots' Day", ['QC']);

  add(dayNum(year, 6, 21), 'National Indigenous Peoples Day', ['NT', 'YT']);
  add(dayNum(year, 6, 24), 'Discovery Day', ['NL']);
  add(dayNum(year, 6, 24), 'Saint-Jean-Baptiste Day', ['QC']);

  add(dayNum(year, 7, 1), 'Canada Day', ALL);

  const civic = nthWeekdayOfMonth(year, 8, 1, 1); // 1st Monday of August
  add(civic, 'Heritage Day', ['AB']);
  add(civic, 'BC Day', ['BC']);
  add(civic, 'Saskatchewan Day', ['SK']);
  add(civic, 'Civic Holiday', ['ON']);
  add(civic, 'New Brunswick Day', ['NB']);

  add(nthWeekdayOfMonth(year, 9, 1, 1), 'Labour Day', ALL);
  add(dayNum(year, 9, 30), 'National Day for Truth and Reconciliation', ['BC']);

  add(nthWeekdayOfMonth(year, 10, 1, 2), 'Thanksgiving',
    ['AB', 'BC', 'MB', 'NT', 'NU', 'ON', 'QC', 'SK', 'YT']);
  add(dayNum(year, 11, 11), 'Remembrance Day',
    ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'PE', 'SK', 'YT']);

  add(dayNum(year, 12, 25), 'Christmas Day', ALL);
  add(dayNum(year, 12, 26), 'Boxing Day', ['ON']);
  return H;
}

// Build the per-year lookup: ISO date -> [{name, provs}]. Both the statutory
// day itself and (when it falls on a weekend) the observed weekday are
// registered; observed-day collisions push forward.
const _yearCache = new Map();
function getYear(year) {
  if (_yearCache.has(year)) return _yearCache.get(year);
  const byDate = new Map();
  const taken = new Set();
  const reg = (n, name, provs) => {
    const iso = fromDayNum(n);
    taken.add(n);
    if (!byDate.has(iso)) byDate.set(iso, []);
    byDate.get(iso).push({ name, provs });
  };
  const raw = rawHolidays(year).sort((a, b) => a.n - b.n);
  for (const h of raw) {
    reg(h.n, h.name, h.provs);
    const wd = weekday(h.n);
    if (wd === 0 || wd === 6) {
      let n = h.n + (wd === 0 ? 1 : 2);
      while (taken.has(n)) n += 1;
      reg(n, `${h.name} (observed)`, h.provs);
    }
  }
  _yearCache.set(year, byDate);
  return byDate;
}

// --- public API ---------------------------------------------------------------

// holidayOn('2026-12-25', 'AB') -> 'Christmas Day' | null.
// Unknown/empty province matches only holidays observed in all provinces.
function holidayOn(iso, prov) {
  const p = parseISO(iso);
  if (!p) return null;
  const hits = getYear(p.y).get(iso) || [];
  const pr = normProv(prov);
  const hit = hits.find((h) =>
    pr ? h.provs.includes(pr) : h.provs.length === PROVINCES.length);
  return hit ? hit.name : null;
}

function isBusinessDay(iso, provs) {
  const n = isoDayNum(iso);
  if (n == null) return false;
  const wd = weekday(n);
  if (wd === 0 || wd === 6) return false;
  const list = Array.isArray(provs) ? provs : [provs];
  return !list.some((pr) => holidayOn(iso, pr));
}

// addBusinessDays('2026-10-01', 2, ['AB','BC']) -> '2026-10-05'.
// The start day is not counted; weekends and holidays in ANY listed
// province are skipped.
function addBusinessDays(iso, n, provs) {
  let d = isoDayNum(iso);
  if (d == null || !(n >= 0)) return null;
  let left = Math.floor(n);
  while (left > 0) {
    d += 1;
    if (isBusinessDay(fromDayNum(d), provs)) left -= 1;
  }
  return fromDayNum(d);
}

function nextBusinessDay(iso, provs) {
  return addBusinessDays(iso, 1, provs);
}

// listHolidays(2026, 'AB') -> [{date, name}] sorted.
function listHolidays(year, prov) {
  const y = Number(year);
  if (!Number.isFinite(y)) return [];
  const pr = normProv(prov);
  const out = [];
  for (const [date, hits] of getYear(y)) {
    const names = [];
    for (const h of hits) {
      if (!pr || h.provs.includes(pr)) names.push(h.name);
    }
    const uniq = [...new Set(names)];
    if (uniq.length) out.push({ date, name: uniq.join(' / ') });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

module.exports = {
  PROVINCES,
  PROVINCE_NAMES,
  provinceName,
  holidayOn,
  isBusinessDay,
  addBusinessDays,
  nextBusinessDay,
  listHolidays,
};
