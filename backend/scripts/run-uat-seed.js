// One-off UAT seed runner (Oct 30, 2026). Runs ONLY from a Render Shell
// on the SHIPRATE service — never on Northline (seeds are shiprate-only).
//
//   UAT_SEED=1 node backend/scripts/run-uat-seed.js
//
// What it does (see uat-inventory-portal-seed.sql next to it):
//   Part A: 30 fictional inventory items for sevencnca@gmail.com
//           (idempotent: ON CONFLICT (user_id, sku) DO UPDATE).
//   Part B: Northline 3PL company (created if missing), portal enabled,
//           'engine' own-rate rows for northline_transport + express.
//           Seven's account is linked ONLY when his company_id is NULL —
//           if he is already in another company the link is skipped by
//           design, and the report says so (leave that company first,
//           then re-run; the script is idempotent).
// Safety: refuses without UAT_SEED=1; never logs connection strings —
// only the database NAME (no host, user, or password) is printed.
// It is NOT required by server.js and never runs at boot.
'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const SQL_FILE = path.join(__dirname, 'uat-inventory-portal-seed.sql');
const USER_EMAIL = 'sevencnca@gmail.com';

function dbNameOnly(url) {
  try {
    return new URL(url).pathname.replace(/^\//, '') || '(unknown db)';
  } catch (_) {
    return '(unknown db)';
  }
}

async function main() {
  if (process.env.UAT_SEED !== '1') {
    console.error('Refused: set UAT_SEED=1 to run the UAT seed (Render Shell, SHIPRATE service only).');
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set — run this from the Render Shell of the shiprate service.');
    process.exit(1);
  }
  console.log(`UAT seed -> database: ${dbNameOnly(url)} (shiprate only — do not run on Northline)`);

  const sql = fs.readFileSync(SQL_FILE, 'utf8');
  const marker = '\n-- Part B:';
  const cut = sql.indexOf(marker);
  const partA = cut === -1 ? sql : sql.slice(0, cut);
  const partB = cut === -1 ? null : sql.slice(cut);

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(partA);
    console.log('Part A done: inventory upserted');
    if (partB) {
      await client.query(partB);
      console.log('Part B done: Northline 3PL company + portal rows upserted');
    }
    const items = await client.query(
      'SELECT COUNT(*)::int AS n FROM inventory_items WHERE user_id = (SELECT id FROM users WHERE email = $1)',
      [USER_EMAIL]
    );
    const company = await client.query(
      `SELECT c.name, c.portal_enabled, r.carrier_id, r.shape
         FROM companies c LEFT JOIN company_rates r ON r.company_id = c.id
        WHERE c.name = 'Northline 3PL' ORDER BY r.carrier_id`
    );
    const link = await client.query(
      `SELECT u.company_id, c.name AS company_name FROM users u
         LEFT JOIN companies c ON c.id = u.company_id WHERE u.email = $1`,
      [USER_EMAIL]
    );
    console.log(`Verify: inventory items for ${USER_EMAIL}: ${items.rows[0].n} (expect 30)`);
    if (!company.rows.length) {
      console.log('Verify: Northline 3PL company NOT FOUND — Part B did not run');
    } else {
      for (const r of company.rows) {
        console.log(`Verify: company ${r.name} portal_enabled=${r.portal_enabled} carrier=${r.carrier_id} shape=${r.shape}`);
      }
    }
    const l = link.rows[0] || {};
    if (l.company_name === 'Northline 3PL') {
      console.log('Verify: your account is linked to Northline 3PL — portal tests (Phase 4.2) are ready');
    } else if (l.company_name) {
      console.log(`Verify: your account is linked to '${l.company_name}', NOT Northline 3PL — Part B skipped the link by design. Leave that company first, then re-run this script.`);
    } else {
      console.log('Verify: your account has no company link — check the user row (Part B should have linked it)');
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(`UAT seed FAILED: ${e.message}`);
  process.exit(1);
});
