// One-off UAT seed at boot (Oct 31, 2026). Render Shell is blocked on the
// free plan (closing the upgrade popup removes the terminal), so the seed
// runs at boot instead of from the Shell. Same SQL file and same
// idempotent statements as backend/scripts/run-uat-seed.js (the Shell
// variant); this module only changes HOW it is invoked.
//
// Gating (all in server.js, mirrored here for tests):
//   - runs only when UAT_SEED_AT_BOOT=1 is set on the service;
//   - shiprate brand only — skipped when the brand is Northline Freight;
//   - skipped when no database is configured.
// A failure throws to the caller, which logs it and continues booting.
// Nothing here logs credentials — only counts, names, and shapes.
'use strict';

const fs = require('fs');
const path = require('path');

const SQL_FILE = path.join(__dirname, '..', 'scripts', 'uat-inventory-portal-seed.sql');
const USER_EMAIL = 'sevencnca@gmail.com';
const COMPANY_NAME = 'Northline 3PL';

async function runUatBootSeed(deps) {
  const db = deps.db;
  const brandName = deps.brandName;
  if (!db.isEnabled()) return { skipped: 'database not configured' };
  if (brandName === 'Northline Freight') return { skipped: 'Northline brand — seeds are shiprate-only' };

  const sql = fs.readFileSync(SQL_FILE, 'utf8');
  const marker = '\n-- Part B:';
  const cut = sql.indexOf(marker);
  const partA = cut === -1 ? sql : sql.slice(0, cut);
  const partB = cut === -1 ? null : sql.slice(cut);

  await db.query(partA);
  if (partB) await db.query(partB);

  const items = await db.query(
    'SELECT COUNT(*)::int AS n FROM inventory_items WHERE user_id = (SELECT id FROM users WHERE email = $1)',
    [USER_EMAIL]
  );
  const company = await db.query(
    `SELECT c.name, c.portal_enabled, r.carrier_id, r.shape
       FROM companies c LEFT JOIN company_rates r ON r.company_id = c.id
      WHERE c.name = $1 ORDER BY r.carrier_id`,
    [COMPANY_NAME]
  );
  const link = await db.query(
    `SELECT c.name AS company_name FROM users u LEFT JOIN companies c ON c.id = u.company_id
      WHERE u.email = $1`,
    [USER_EMAIL]
  );
  return {
    inventoryItems: items.rows[0] ? items.rows[0].n : null,
    companyRows: company.rows,
    linkedCompany: link.rows[0] ? link.rows[0].company_name : null,
  };
}

module.exports = { runUatBootSeed };
