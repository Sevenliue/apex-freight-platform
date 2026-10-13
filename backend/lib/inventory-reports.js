// lib/inventory-reports.js — daily inventory report snapshots + email.
//
// Once per day (America/Edmonton), each account that holds inventory gets a
// snapshot report saved to inventory_reports and emailed to the account
// owner, unless they opted out (users.inventory_report_email).
//
// Reports are idempotent per (user_id, report_date): an existing row is never
// overwritten, and email is best-effort — a failed send never deletes the
// saved row. Nothing in this file throws; failures are logged with the
// [inventory-reports] prefix.
'use strict';

const db = require('../db');
const { sendEmail } = require('./notify');

const TZ = 'America/Edmonton';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

async function ensureInventoryReportTables() {
  if (!db.isEnabled()) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_reports (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id),
      report_date DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      item_count INT NOT NULL DEFAULT 0,
      total_units INT NOT NULL DEFAULT 0,
      damaged_units INT NOT NULL DEFAULT 0,
      today_in INT NOT NULL DEFAULT 0,
      today_out INT NOT NULL DEFAULT 0,
      low_stock_count INT NOT NULL DEFAULT 0,
      expiring_count INT NOT NULL DEFAULT 0,
      csv TEXT,
      emailed_to TEXT,
      email_status TEXT,
      UNIQUE (user_id, report_date)
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS inventory_reports_user_idx ON inventory_reports (user_id, report_date DESC)`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS inventory_report_email BOOLEAN NOT NULL DEFAULT true`);
}

function edmontonParts() {
  const p = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date()).forEach((part) => { p[part.type] = part.value; });
  if (p.hour === '24') p.hour = '00';
  return p;
}

// YYYY-MM-DD for America/Edmonton. No new dependencies.
function edmontonToday() {
  const p = edmontonParts();
  return `${p.year}-${p.month}-${p.day}`;
}

// HH:MM (24h) for America/Edmonton.
function edmontonClock() {
  const p = edmontonParts();
  return `${p.hour}:${p.minute}`;
}

function addDays(yyyyMmDd, n) {
  const d = new Date(yyyyMmDd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function fmtDate(yyyyMmDd) {
  const parts = String(yyyyMmDd || '').split('-');
  if (parts.length !== 3) return String(yyyyMmDd || '');
  const [y, m, d] = parts.map(Number);
  if (!y || !m || !d) return String(yyyyMmDd || '');
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// buildReport(userId, reportDate) -> {summary, csv}.
// reportDate is YYYY-MM-DD in Edmonton terms; movements are counted for that
// same Edmonton calendar day.
async function buildReport(userId, reportDate) {
  const itemsR = await db.query(
    `SELECT sku, name, qty, damaged_qty, expiry_date::text AS expiry_date, low_stock_at
     FROM inventory_items WHERE user_id = $1 ORDER BY name ASC`,
    [userId]
  );
  const flowR = await db.query(
    `SELECT direction, COALESCE(SUM(qty), 0)::int AS units
     FROM inventory_movements
     WHERE user_id = $1 AND (created_at AT TIME ZONE '${TZ}')::date = $2::date
     GROUP BY direction`,
    [userId, reportDate]
  );
  const today = { in: 0, out: 0 };
  flowR.rows.forEach((r) => { today[r.direction] = r.units; });

  const expiryCutoff = addDays(reportDate, 30);
  let totalUnits = 0, damagedUnits = 0, lowCount = 0, expCount = 0, dmgCount = 0;
  const items = itemsR.rows.map((i) => {
    const qty = Number(i.qty) || 0;
    const dmg = Number(i.damaged_qty) || 0;
    totalUnits += qty;
    damagedUnits += dmg;
    const exp = i.expiry_date ? String(i.expiry_date).slice(0, 10) : '';
    if (Number(i.low_stock_at) > 0 && qty <= Number(i.low_stock_at)) lowCount++;
    if (exp && exp <= expiryCutoff && qty > 0) expCount++;
    if (dmg > 0) dmgCount++;
    return { sku: i.sku, name: i.name, qty, damaged_qty: dmg, expiry_date: exp, low_stock_at: Number(i.low_stock_at) || 0 };
  });

  const summary = {
    report_date: reportDate,
    item_count: items.length,
    total_units: totalUnits,
    damaged_units: damagedUnits,
    today_in: today.in,
    today_out: today.out,
    low_stock_count: lowCount,
    expiring_count: expCount,
    damaged_count: dmgCount,
  };
  const csv =
    'sku,name,qty_on_hand,damaged_qty,expiry_date,low_stock_at\n' +
    items.map((i) => [i.sku, i.name, i.qty, i.damaged_qty, i.expiry_date, i.low_stock_at].map(csvCell).join(',')).join('\n');
  return { summary, csv };
}

function buildEmailBody(user, summary) {
  const name = (user && user.full_name) || 'there';
  return (
    `Hi ${name},\n\n` +
    `Your daily inventory report for ${fmtDate(summary.report_date)}:\n\n` +
    `- SKUs on file: ${summary.item_count}\n` +
    `- Units on hand: ${summary.total_units}\n` +
    `- Damaged units (segregated): ${summary.damaged_units}\n` +
    `- Scanned in today: ${summary.today_in}\n` +
    `- Scanned out today: ${summary.today_out}\n` +
    `- Low-stock alerts: ${summary.low_stock_count}\n` +
    `- Expiring within 30 days: ${summary.expiring_count}\n` +
    `- Items with damaged stock: ${summary.damaged_count}\n\n` +
    `Full item list attached (CSV).`
  );
}

// saveAndEmailReport(userId, reportDate, {email}) — idempotent; never throws.
// Returns {report, summary?, emailStatus?, existing?, failed?}.
async function saveAndEmailReport(userId, reportDate, opts = {}) {
  try {
    if (!db.isEnabled()) return { skipped: 'db disabled' };
    const email = opts.email !== false;
    const existing = await db.query(
      `SELECT * FROM inventory_reports WHERE user_id = $1 AND report_date = $2`,
      [userId, reportDate]
    );
    if (existing.rows.length) return { report: existing.rows[0], existing: true };

    const { summary, csv } = await buildReport(userId, reportDate);
    const ins = await db.query(
      `INSERT INTO inventory_reports
         (id, user_id, report_date, item_count, total_units, damaged_units,
          today_in, today_out, low_stock_count, expiring_count, csv)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (user_id, report_date) DO NOTHING
       RETURNING *`,
      [db.newId('invr'), userId, reportDate, summary.item_count, summary.total_units,
       summary.damaged_units, summary.today_in, summary.today_out,
       summary.low_stock_count, summary.expiring_count, csv]
    );
    let report = ins.rows[0];
    if (!report) {
      const r = await db.query(
        `SELECT * FROM inventory_reports WHERE user_id = $1 AND report_date = $2`,
        [userId, reportDate]
      );
      return { report: r.rows[0], existing: true };
    }

    let emailStatus = 'skipped: email not requested';
    let emailedTo = null;
    if (email) {
      const u = await db.query(
        `SELECT email, full_name, inventory_report_email FROM users WHERE id = $1`,
        [userId]
      );
      const user = u.rows[0] || {};
      const optedIn = user.inventory_report_email !== false;
      emailedTo = user.email || null;
      if (emailedTo && optedIn) {
        const result = await sendEmail({
          to: emailedTo,
          subject: `Daily inventory report — ${fmtDate(reportDate)}`,
          text: buildEmailBody(user, summary),
          event: 'inventory_report',
          attachments: [{
            filename: `inventory-report-${reportDate}.csv`,
            content: Buffer.from(csv, 'utf8').toString('base64'),
          }],
        });
        if (result && result.sent) emailStatus = 'sent';
        else if (result && result.skipped) emailStatus = `skipped: ${result.skipped}`;
        else if (result && result.logged) emailStatus = 'logged (no email provider)';
        else if (result && result.failed) emailStatus = `failed: ${result.failed}`;
        else emailStatus = 'unknown';
      } else if (!emailedTo) {
        emailStatus = 'skipped: no email on account';
      } else {
        emailStatus = 'skipped: opted out';
      }
    }
    await db.query(
      `UPDATE inventory_reports SET emailed_to = $2, email_status = $3 WHERE id = $1`,
      [report.id, emailedTo, emailStatus]
    );
    const fresh = await db.query(`SELECT * FROM inventory_reports WHERE id = $1`, [report.id]);
    return { report: fresh.rows[0], summary, emailStatus };
  } catch (e) {
    console.error('[inventory-reports] saveAndEmailReport failed:', e.message);
    return { failed: e.message };
  }
}

// runDailyInventoryReports({email, reportDate}) — one run for every account
// holding inventory. Never throws.
async function runDailyInventoryReports(opts = {}) {
  const out = { date: opts.reportDate || edmontonToday(), users: 0, saved: 0, existing: 0, emailed: 0, failed: 0 };
  try {
    if (!db.isEnabled()) { console.log('[inventory-reports] skipped: db disabled'); return out; }
    const users = await db.query(`SELECT DISTINCT i.user_id FROM inventory_items i JOIN users u ON u.id = i.user_id`);
    out.users = users.rows.length;
    for (const row of users.rows) {
      const res = await saveAndEmailReport(row.user_id, out.date, { email: opts.email !== false });
      if (res.existing) out.existing++;
      else if (res.failed) out.failed++;
      else { out.saved++; if (String(res.emailStatus || '').indexOf('sent') === 0) out.emailed++; }
    }
    console.log(`[inventory-reports] ${out.date}: ${out.users} account(s), saved ${out.saved}, existing ${out.existing}, emailed ${out.emailed}, failed ${out.failed}`);
  } catch (e) {
    console.error('[inventory-reports] runDailyInventoryReports failed:', e.message);
    out.failed++;
  }
  return out;
}

// catchUpInventoryReports() — backfill missed days (max 3 back) after a
// downtime. Email is sent only for the most recent missed day. Never throws.
async function catchUpInventoryReports() {
  const out = { users: 0, saved: 0, failed: 0 };
  try {
    if (!db.isEnabled()) return out;
    const today = edmontonToday();
    const yesterday = addDays(today, -1);
    const floor = addDays(today, -3);
    const users = await db.query(`SELECT DISTINCT user_id FROM inventory_items`);
    for (const { user_id } of users.rows) {
      out.users++;
      let start = floor;
      try {
        const m = await db.query(`SELECT MAX(report_date)::text AS maxd FROM inventory_reports WHERE user_id = $1`, [user_id]);
        if (m.rows[0].maxd) start = addDays(m.rows[0].maxd, 1);
      } catch (e) { /* fall through to floor */ }
      if (start < floor) start = floor;
      const days = [];
      for (let d = start; d <= yesterday; d = addDays(d, 1)) days.push(d);
      for (let i = 0; i < days.length; i++) {
        const res = await saveAndEmailReport(user_id, days[i], { email: i === days.length - 1 });
        if (res.existing) continue;
        if (res.failed) out.failed++;
        else out.saved++;
      }
    }
    console.log(`[inventory-reports] catch-up: ${out.users} account(s), saved ${out.saved}, failed ${out.failed}`);
  } catch (e) {
    console.error('[inventory-reports] catch-up failed:', e.message);
    out.failed++;
  }
  return out;
}

module.exports = {
  ensureInventoryReportTables,
  edmontonToday,
  edmontonClock,
  addDays,
  buildReport,
  saveAndEmailReport,
  runDailyInventoryReports,
  catchUpInventoryReports,
};
