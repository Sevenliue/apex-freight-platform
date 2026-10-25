'use strict';
// One-off rate-table sync (Northline lift, Oct 2026).
//
// Copies ONLY the four carrier-rate tables from a source database into this
// service's database, so Northline Freight quotes match shiprate.ca:
//   carrier_fsc, carrier_density_floor, carrier_dim_weight,
//   carrier_matrix_rates (matched on the lane unique key, NOT on id —
//   target rows get fresh uuids, so re-runs are idempotent).
//
// NEVER copied: users, companies, quotes, shipments, address_book,
// shipper_rate_uploads, carrier_rate_uploads, audits, sessions, billing,
// marketplace, inventory — anything account- or order-related stays put.
//
// Safety:
// - Runs ONLY when RUN_RATE_SYNC=1 AND SOURCE_DATABASE_URL are set.
// - Source connection issues SELECTs only; target writes are confined to
//   the four tables above, one transaction per table.
// - Refuses when source and target resolve to the same database.
// - Never logs connection strings or credentials — the report carries
//   counts, carrier ids, and FSC percents only.
// - Returns the report; the caller logs it and boots normally regardless.
//   A success email goes to the admin address via lib/notify.
const { Pool } = require('pg');

const TABLES = [
  {
    name: 'carrier_fsc',
    keyCols: ['carrier_id'],
    cols: ['carrier_id', 'fsc_ltl_percent', 'fsc_tl_percent', 'updated_at', 'updated_by'],
  },
  {
    name: 'carrier_density_floor',
    keyCols: ['carrier_id'],
    cols: ['carrier_id', 'floor_lb_per_cuft', 'updated_at', 'updated_by'],
  },
  {
    name: 'carrier_dim_weight',
    keyCols: ['carrier_id'],
    cols: ['carrier_id', 'enabled', 'updated_at', 'updated_by'],
  },
  {
    name: 'carrier_matrix_rates',
    keyCols: ['carrier_id', 'origin_city', 'origin_prov', 'dest_city', 'dest_prov'],
    cols: ['carrier_id', 'carrier_label', 'origin_city', 'origin_prov', 'dest_city',
      'dest_prov', 'min_charge_cad', 'breaks_json', 'fsc_percent',
      'effective_date', 'expiry_date'],
    updateCols: ['carrier_label', 'min_charge_cad', 'breaks_json', 'fsc_percent',
      'effective_date', 'expiry_date'],
  },
];

function sameDb(a, b) {
  try {
    const ua = new URL(a), ub = new URL(b);
    return ua.host === ub.host && ua.pathname === ub.pathname && ua.username === ub.username;
  } catch { return a === b; }
}

function keyOf(row, keyCols) {
  return keyCols.map((c) => String(row[c] ?? '')).join('|');
}

async function runRateSync() {
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const targetUrl = process.env.DATABASE_URL;
  if (process.env.RUN_RATE_SYNC !== '1') throw new Error('RUN_RATE_SYNC is not 1 — refusing to run');
  if (!sourceUrl) throw new Error('SOURCE_DATABASE_URL is not set');
  if (!targetUrl) throw new Error('DATABASE_URL is not set');
  if (sameDb(sourceUrl, targetUrl)) throw new Error('source and target are the same database — refusing to run');

  const src = new Pool({ connectionString: sourceUrl, connectionTimeoutMillis: 8000, statement_timeout: 60000, max: 2 });
  const dst = new Pool({ connectionString: targetUrl, connectionTimeoutMillis: 8000, statement_timeout: 60000, max: 2 });
  const report = { tables: {}, started_at: new Date().toISOString() };
  try {
    for (const t of TABLES) {
      const colList = t.cols.join(', ');
      const srcRows = (await src.query(`SELECT ${colList} FROM ${t.name}`)).rows;
      const dstKeys = new Set(
        (await dst.query(`SELECT ${t.keyCols.join(', ')} FROM ${t.name}`)).rows
          .map((r) => keyOf(r, t.keyCols)));
      const updateCols = t.updateCols || t.cols.filter((c) => !t.keyCols.includes(c));
      const placeholders = t.cols.map((_, i) => `$${i + 1}`).join(', ');
      const updates = updateCols.map((c) => `${c} = EXCLUDED.${c}`).join(', ');
      const conflict = t.keyCols.join(', ');
      let upserted = 0;
      const client = await dst.connect();
      try {
        await client.query('BEGIN');
        for (const row of srcRows) {
          const vals = t.cols.map((c) => {
            const v = row[c];
            if (c === 'breaks_json') return v == null ? null : JSON.stringify(v);
            return v;
          });
          await client.query(
            `INSERT INTO ${t.name} (${colList}) VALUES (${placeholders}) ` +
            `ON CONFLICT (${conflict}) DO UPDATE SET ${updates}`,
            vals);
          upserted++;
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`${t.name}: ${e.message}`);
      } finally {
        client.release();
      }
      const targetOnly = [...dstKeys].filter((k) => !srcRows.some((r) => keyOf(r, t.keyCols) === k));
      report.tables[t.name] = { source_rows: srcRows.length, upserted, target_only_keys: targetOnly };
      if (t.name === 'carrier_fsc') {
        report.tables[t.name].rows = srcRows.map((r) => ({
          carrier_id: r.carrier_id, ltl: r.fsc_ltl_percent, tl: r.fsc_tl_percent,
        }));
      }
    }
  } finally {
    await src.end().catch(() => {});
    await dst.end().catch(() => {});
  }
  report.finished_at = new Date().toISOString();

  // Success email to the admin address (best-effort; report is also logged).
  try {
    const { sendEmail, adminEmail } = require('../lib/notify');
    const lines = Object.entries(report.tables).map(([name, r]) =>
      `${name}: source ${r.source_rows}, upserted ${r.upserted}, target-only ${r.target_only_keys.length}`);
    await sendEmail({
      to: adminEmail(),
      subject: 'Northline rate sync complete',
      text: ['Northline rate-table sync finished.', '', ...lines,
        '',
        'FSC rows copied:',
        ...(report.tables.carrier_fsc.rows || []).map((r) => `  ${r.carrier_id}: LTL ${r.ltl}% / TL ${r.tl == null ? '—' : r.tl + '%'}`),
        '',
        'Target-only keys (left untouched, not deleted):',
        ...Object.entries(report.tables).flatMap(([name, r]) =>
          r.target_only_keys.map((k) => `  ${name}: ${k}`)),
      ].join('\n'),
    });
  } catch (e) {
    console.error('[rate-sync] report email failed:', e.message);
  }
  return report;
}

module.exports = { runRateSync };
