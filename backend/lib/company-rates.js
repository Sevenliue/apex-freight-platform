// lib/company-rates.js — company own-rate store for the company portal.
//
// Tables are created on boot (same CREATE TABLE IF NOT EXISTS pattern as
// routes/company.js). Shapes:
//   live_link — own-rate row = the carrier's current matrix row with markup
//     removed (no rate payload stored; the engine book is the source).
//   engine    — own-rate row from preserved engine data (TEAMS teamsQuotes).
//   per_tire  — own-rate row from a stored per-tire table payload
//     (Bee Express Acheson corridor, transcribed from Total Tire's PDFs).
//
// V1 pilot seed (Seven, 2026-10-29): Total Tire Distributors only, anchored
// on its assigned company admin's email (the company row is found through
// the admin's users.company_id, so the seed does not depend on the exact
// company name spelling). The seed runs ONLY when this deployment's brand
// is ShipRate, so the pilot stays on shiprate.ca and never auto-enables on
// Northline Freight. Idempotent: markers use ON CONFLICT DO NOTHING and the
// portal flag is set unconditionally for the pilot company.
'use strict';

const db = require('../db');
const beeRates = require('./bee-express-rates');

const TOTAL_TIRE_ADMIN_EMAIL = 'hongbo_liu@kaltire.com';

const LIVE_LINK_CARRIERS = [
  'jays', 'armour', 'willys', 'hifab', 'bandstra', 'jrhall', 'guilbault',
  'minimax', 'morneau', 'number8', 'minimax_ltl',
];
const ENGINE_CARRIERS = ['teams'];
const PER_TIRE_CARRIERS = ['beeexpress'];

function brandName() {
  try {
    const c = require('../config');
    return c.brandName || (c.default && c.default.brandName) || 'ShipRate';
  } catch {
    return 'ShipRate';
  }
}

// Pure check for carrier-direct booking (server-side verification in
// POST /api/shipments/book-direct): the stored row must be an own-rate row
// AND the caller's company must hold a marker for that carrier AND retail
// must equal cost (no markup on own rows, by construction).
function isBookableOwnRate(rate, markers) {
  if (!rate || !markers) return false;
  return rate.billing === 'carrier_direct'
    && rate.rate_kind === 'own'
    && markers.has(rate.carrier_id)
    && rate.retail_cad != null
    && rate.retail_cad === rate.cost_cad;
}
// before the cheapest-first sort). Pure over its inputs except for the
// TEAMS in-place conversion (those row objects are shared with the stored
// quote record, which must also carry the own-rate rows for booking).
//   rates: priced broker rows (mutated: TEAMS rows converted in place)
//   markers: Map(carrier_id -> { shape, payload }) for the caller's company
//   bee: sanitized { flat, mt, semi, farmWeights } or null
// Returns the merged array. Rules: an own-rate row ALWAYS shows when the
// company has a rate for that carrier; a broker row for the same carrier
// shows ONLY when its total is strictly cheaper. Own rows carry
// rate_kind 'own' + billing 'carrier_direct'; broker rows carry neither.
// Own rows exclude the platform add-on insurance (a carrier-direct booking
// bills freight only). Callers must NOT pass another company's markers.
function mergePortalRows({ rates, markers, bee, originCity, destCity, totalWeightLbs, transit, estDeliveryDate, transitDaysUpper }) {
  // TEAMS: kept in the pricing set only for marker members; convert in
  // place (no broker copy ever exists for TEAMS — private rates).
  for (const r of rates) {
    if (r.carrier_id === 'teams' && markers.get('teams')) {
      r.rate_id = r.rate_id.replace(/^matrix_/, 'own_');
      r.retail_cad = r.cost_cad;
      r.rate_kind = 'own';
      r.billing = 'carrier_direct';
      r.source = 'own_rate';
      delete r.insurance_cad;
      delete r.insurance_declared_value;
    }
  }
  // Live-link carriers: clone each priced broker row as an own row (same
  // charges, markup removed), then drop each broker row that is not
  // strictly cheaper than its own clone (paired per row object, so
  // duplicate carrier+service rows compare exactly).
  const ownRows = [];
  const brokerToOwn = new Map();
  for (const r of rates) {
    const m = markers.get(r.carrier_id);
    if (m && m.shape === 'live_link' && r.retail_cad != null && !r.rate_on_request && !r.rate_kind) {
      const own = { ...r, rate_id: r.rate_id.replace(/^matrix_/, 'own_'), retail_cad: r.cost_cad, rate_kind: 'own', billing: 'carrier_direct', source: 'own_rate' };
      delete own.insurance_cad;
      delete own.insurance_declared_value;
      ownRows.push(own);
      brokerToOwn.set(r, own.retail_cad);
    }
  }
  let merged = rates.filter((r) => {
    if (r.rate_kind === 'own') return true;
    if (brokerToOwn.has(r)) return r.retail_cad < brokerToOwn.get(r);
    return true;
  });
  merged.push(...ownRows);
  // Bee Express per-tire own row (Total Tire's Acheson corridor tables).
  if (markers.get('beeexpress') && bee) {
    const q = beeRates.beeExpressQuote({
      originCity, destCity,
      flat: bee.flat, mt: bee.mt, semi: bee.semi, farmWeights: bee.farmWeights,
    });
    if (!q.rate_on_request) {
      const brokerBee = merged.find((r) => r.carrier_id === 'beeexpress' && r.retail_cad != null && !r.rate_on_request);
      merged.push({
        rate_id: 'own_beeexpress',
        carrier_id: 'beeexpress',
        carrier: (brokerBee && brokerBee.carrier) || 'Bee Express',
        service: (brokerBee && brokerBee.service) || 'Standard',
        cost_cad: q.total,
        retail_cad: q.total,
        currency: 'CAD',
        fsc_percent: 33,
        delivery_days: transit,
        transit_estimate: true,
        est_delivery_date: estDeliveryDate(transitDaysUpper(transit)),
        source: 'own_rate',
        weight_lbs: totalWeightLbs,
        billable_weight_lbs: totalWeightLbs,
        rate_basis: 'per_tire',
        rate_kind: 'own',
        billing: 'carrier_direct',
        notes: ['Your company rate (Bee Express Acheson corridor per-tire tables)'],
      });
      merged = merged.filter((r) => !(r.carrier_id === 'beeexpress' && r.rate_kind !== 'own' && r.retail_cad != null && !(r.retail_cad < q.total)));
    }
  }
  return merged;
}

async function ensureCompanyRateTables() {
  if (!db.isEnabled()) return;
  // Boot-order proof: route require order is not guaranteed, and
  // company.js creates the companies table asynchronously on its own load.
  // If this module's CREATE ran first, the REFERENCES companies(id) below
  // would fail and the portal tables would never exist (the failure is
  // caught and only logged). So create companies here first too — the
  // statement is idempotent and identical to routes/company.js.
  await db.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      join_code TEXT NOT NULL UNIQUE,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS company_rates (
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      carrier_id TEXT NOT NULL,
      shape TEXT NOT NULL,
      payload JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (company_id, carrier_id)
    )`);
  await db.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS portal_enabled BOOLEAN NOT NULL DEFAULT FALSE`);
}

async function findPilotCompanyId() {
  const r = await db.query(
    'SELECT company_id FROM users WHERE email = $1 AND company_id IS NOT NULL LIMIT 1',
    [TOTAL_TIRE_ADMIN_EMAIL]);
  return r.rows.length ? r.rows[0].company_id : null;
}

async function seedTotalTireRates() {
  if (!db.isEnabled()) return false;
  if (brandName() !== 'ShipRate') return false;
  const companyId = await findPilotCompanyId();
  if (!companyId) {
    console.error('[company-rates] pilot company not found via admin email; seed skipped');
    return false;
  }
  for (const carrierId of LIVE_LINK_CARRIERS) {
    await db.query(
      `INSERT INTO company_rates (company_id, carrier_id, shape, payload)
       VALUES ($1, $2, 'live_link', NULL)
       ON CONFLICT (company_id, carrier_id) DO NOTHING`,
      [companyId, carrierId]);
  }
  for (const carrierId of ENGINE_CARRIERS) {
    await db.query(
      `INSERT INTO company_rates (company_id, carrier_id, shape, payload)
       VALUES ($1, $2, 'engine', NULL)
       ON CONFLICT (company_id, carrier_id) DO NOTHING`,
      [companyId, carrierId]);
  }
  const beePayload = {
    flats: beeRates.FLATS,
    farm_bands: beeRates.FARM_BANDS,
    south_towns: beeRates.SOUTH_TOWNS,
    north_towns: beeRates.NORTH_TOWNS,
    source: 'Total_Tire_Acheson__Rate.pdf + Total_Tire_Farm_Tire.pdf (Jan-25)',
  };
  await db.query(
    `INSERT INTO company_rates (company_id, carrier_id, shape, payload)
     VALUES ($1, 'beeexpress', 'per_tire', $2::jsonb)
     ON CONFLICT (company_id, carrier_id) DO NOTHING`,
    [companyId, JSON.stringify(beePayload)]);
  await db.query('UPDATE companies SET portal_enabled = TRUE WHERE id = $1', [companyId]);
  return true;
}

// Returns null when the company has no portal (unknown id, flag off, or no
// rows); otherwise { carriers: Map(carrier_id -> { shape, payload }) }.
async function getCompanyOwnRates(companyId) {
  if (!db.isEnabled() || !companyId) return null;
  const flag = await db.query('SELECT portal_enabled FROM companies WHERE id = $1', [companyId]);
  if (!flag.rows.length || !flag.rows[0].portal_enabled) return null;
  const r = await db.query(
    'SELECT carrier_id, shape, payload FROM company_rates WHERE company_id = $1',
    [companyId]);
  if (!r.rows.length) return null;
  const carriers = new Map();
  for (const row of r.rows) carriers.set(row.carrier_id, { shape: row.shape, payload: row.payload });
  return { carriers };
}

ensureCompanyRateTables()
  .then(() => seedTotalTireRates())
  .catch((e) => console.error('[company-rates] setup failed:', e.message));

module.exports = {
  LIVE_LINK_CARRIERS,
  ENGINE_CARRIERS,
  PER_TIRE_CARRIERS,
  BEE_CORRIDOR: { south: beeRates.SOUTH_TOWNS, north: beeRates.NORTH_TOWNS },
  mergePortalRows,
  isBookableOwnRate,
  ensureCompanyRateTables,
  seedTotalTireRates,
  getCompanyOwnRates,
};
