-- UAT seed script for ShipRate (Oct 30, 2026) — Northline test data, PART 2 (database).
--
-- RUN WHERE: a one-off script/shell on Render with DATABASE_URL pointing at
-- the SHIPRATE prod database (apex-freight-db). DB seeds apply to ONE site
-- only: run UAT for company/inventory steps on shiprate.ca, not Northline.
-- File-based rates (matrix-data.json) already deploy to both sites.
--
-- SAFETY: touches only the sevencnca@gmail.com user row (company link, only
-- when currently NULL) and inserts test rows. It never changes any role,
-- never touches other users, and is idempotent (re-runnable).
--
-- Part A: 30 inventory items for Seven's warehouse inventory.
-- NOTE: inventory_items has NO commodity/size/dimension/weight columns
-- (sku, name, qty only). Sizes and weights live in the checklist's package
-- lines, not in inventory rows. Names below carry the commodity + size.

WITH me AS (SELECT id FROM users WHERE email = 'sevencnca@gmail.com')
INSERT INTO inventory_items (id, user_id, sku, name, qty)
SELECT gen_random_uuid(), me.id, v.sku, v.name, v.qty
FROM me, (VALUES
  ('TIRE-11R225', 'Truck tire 11R22.5', 40),
  ('TIRE-LT265', 'Light truck tire LT265/70R17', 60),
  ('TIRE-31580', 'Wide-base tire 315/80R22.5', 24),
  ('TIRE-ATV25', 'ATV tire 25x10-12', 32),
  ('TIRE-OTR', 'OTR tire 20.5R25 (oversize)', 6),
  ('BOX-241818', 'Cardboard box 24x18x18 in', 200),
  ('BOX-484036', 'Cardboard box 48x40x36 in', 80),
  ('BOX-121212', 'Cardboard box 12x12x12 in', 500),
  ('PALLET-4840', 'Wood pallet 48x40 in', 120),
  ('PALLET-PLAS', 'Plastic pallet 48x40 in', 60),
  ('BARREL-55S', 'Steel barrel 55 gal', 48),
  ('BARREL-30P', 'Plastic barrel 30 gal', 72),
  ('CRATE-4848', 'Wood crate 48x48x48 in', 20),
  ('CRATE-GLASS', 'Glass crate 96x48x12 in (oversize, fragile)', 4),
  ('TOTE-2717', 'Plastic tote 27x17x12 in', 150),
  ('ROLL-CARPET', 'Carpet roll 60 in wide x 50 ft (oversize)', 10),
  ('PIPE-BUNDLE', 'Steel pipe bundle 20 ft (oversize)', 8),
  ('ENGINE-BLK', 'Engine block, crated', 5),
  ('BATT-PALLET', 'Battery pallet, lead-acid (DG)', 12),
  ('MATTRESS-Q', 'Queen mattress, bagged', 25),
  ('SOFA-3', '3-seat sofa, wrapped', 8),
  ('FRIDGE-FS', 'Full-size refrigerator', 10),
  ('WASHER', 'Washing machine', 14),
  ('DRYER', 'Dryer', 14),
  ('ATV-500', 'ATV 500cc, crated', 6),
  ('SNOWMOBILE', 'Snowmobile, crated', 4),
  ('TRACTOR-LAWN', 'Lawn tractor', 7),
  ('GEN-10KW', 'Generator 10 kW, skid-mounted', 9),
  ('COMP-80GAL', 'Air compressor 80 gal tank', 11),
  ('BEAM-20FT', 'Steel beam 20 ft (oversize)', 15)
) AS v(sku, name, qty)
ON CONFLICT (user_id, sku) DO UPDATE SET qty = EXCLUDED.qty, name = EXCLUDED.name;

-- Part B: Northline 3PL company + portal own-rate rows (for the shipper-portal
-- test: "Company rate" badge + carrier-direct booking).
-- Creates the company if missing (by name), links Seven's account only when
-- his company_id is currently NULL, enables the portal, and seeds 'engine'
-- own-rate rows for both Northline carriers (in-place engine rates, no payload).
DO $$
DECLARE
  uid UUID;
  cid UUID;
BEGIN
  SELECT id INTO uid FROM users WHERE email = 'sevencnca@gmail.com';
  IF uid IS NULL THEN
    RAISE NOTICE 'sevencnca@gmail.com user not found — Part B skipped';
    RETURN;
  END IF;
  SELECT id INTO cid FROM companies WHERE name = 'Northline 3PL';
  IF cid IS NULL THEN
    cid := gen_random_uuid();
    INSERT INTO companies (id, name, join_code, created_by)
    VALUES (cid, 'Northline 3PL', 'NORTHLINE-3PL', uid);
  END IF;
  UPDATE users SET company_id = cid WHERE id = uid AND company_id IS NULL;
  UPDATE companies SET portal_enabled = TRUE WHERE id = cid;
  INSERT INTO company_rates (company_id, carrier_id, shape, payload)
  VALUES (cid, 'northline_transport', 'engine', NULL),
         (cid, 'northline_express', 'engine', NULL)
  ON CONFLICT (company_id, carrier_id) DO NOTHING;
  RAISE NOTICE 'Northline 3PL company % ready, portal enabled', cid;
END $$;

-- Verify (run after): counts + portal rows.
-- SELECT sku, name, qty FROM inventory_items WHERE user_id =
--   (SELECT id FROM users WHERE email = 'sevencnca@gmail.com') ORDER BY sku;
-- SELECT c.name, c.portal_enabled, r.carrier_id, r.shape FROM companies c
--   LEFT JOIN company_rates r ON r.company_id = c.id WHERE c.name = 'Northline 3PL';
