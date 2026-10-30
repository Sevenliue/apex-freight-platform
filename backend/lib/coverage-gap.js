// lib/coverage-gap.js — staff notification for portal coverage gaps.
//
// When a paying (portal) shipper quotes a lane none of their carriers
// covers, Seven + ShipRate staff get one email per company + lane per day,
// so staff can follow up with a value-add discussion to help the shipper
// select a new carrier. The email lists the cheapest broker rows on the
// quote as discussion candidates.
//
// Delivery is best-effort and never blocks or fails the quote: dedup is a
// single atomic INSERT (ON CONFLICT DO NOTHING), and every failure is
// logged, not thrown. When no email provider is configured the gap is
// still recorded in coverage_gap_notices (the audit trail) and logged.
'use strict';

const db = require('../db');
const { sendEmail } = require('./notify');
const config = require('../config');

async function ensureTable() {
  await db.query(`CREATE TABLE IF NOT EXISTS coverage_gap_notices (
    company_id TEXT NOT NULL,
    origin_city TEXT NOT NULL,
    dest_city TEXT NOT NULL,
    notice_date DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (company_id, origin_city, dest_city, notice_date)
  )`);
}

function edmontonDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' });
}

function money(n) {
  return '$' + Number(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Returns true when this call recorded a NEW notice (caller: send the
// email). Returns false when already notified today, or when DB/email
// is unavailable. Never throws.
async function maybeNotifyCoverageGap({
  companyId, companyName, userEmail,
  originCity, originProv, destCity, destProv, weightLbs, candidates,
}) {
  if (!db.isEnabled() || !companyId) return false;
  try {
    await ensureTable();
    const r = await db.query(
      `INSERT INTO coverage_gap_notices (company_id, origin_city, dest_city, notice_date)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [String(companyId), String(originCity || ''), String(destCity || ''), edmontonDate()]
    );
    if (r.rowCount !== 1) return false; // already notified today
    const to = (config.adminEmails && config.adminEmails.length) ? config.adminEmails : null;
    const lane = `${originCity || '?'}${originProv ? ', ' + originProv : ''} → ${destCity || '?'}${destProv ? ', ' + destProv : ''}`;
    const candLines = (candidates || []).map((c, i) =>
      `${i + 1}. ${c.carrier || c.carrier_id} — ${money(c.retail_cad)} CAD`).join('\n');
    const text = `A paying shipper just quoted a lane none of their carriers covers.\n` +
      `Company: ${companyName || companyId}\n` +
      `Quoted by: ${userEmail || '—'}\n` +
      `Lane: ${lane}\n` +
      `Weight: ${weightLbs != null ? Number(weightLbs).toLocaleString('en-CA') + ' lb' : '—'}\n` +
      `Cheapest ShipRate broker options on the quote:\n${candLines || '—'}\n\n` +
      `Follow up with a value-add discussion to help them select a new carrier for this lane.`;
    const res = await sendEmail({
      to, event: 'coverage_gap',
      subject: `Coverage gap: ${companyName || companyId} quoted ${lane} with no company carrier`,
      text,
    });
    if (res && (res.skipped || res.failed)) {
      console.log(`[coverage-gap] notice recorded for ${companyId} ${lane} (email ${res.skipped || res.failed})`);
    }
    return true;
  } catch (err) {
    console.error('[coverage-gap] notify failed (non-fatal):', err.message);
    return false;
  }
}

module.exports = { maybeNotifyCoverageGap };
