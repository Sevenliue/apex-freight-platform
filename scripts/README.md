# ShipRate downtime prevention scripts

## Pre-deploy: `node scripts/smoke-test.js`
Starts the backend locally on port 5999, then:
- Verifies `/api/health` returns 200
- Quotes one lane per carrier (all 11) via the matrix engine
- Tests minimax skid rates (5–8 skids)
- Tests city-only addresses, heavy (15000 lb), light (200 lb)
- Verifies Bandstra absent on reverse lanes (one-way)
- Runs the **skidCount regression check** (2026-10-02 outage)

Exits non-zero on any failure. **Run before every deploy.**

## Post-deploy: `node scripts/verify-deploy.js [url]`
Default url: https://shiprate.ca
- Checks `/api/health` → 200
- Checks `/api/diesel-prices` → 200 with data
- Runs PG→VAN 1000 lb quote, verifies Bandstra present
- Verifies response times < 10s

Exits non-zero on failure. **Run after every deploy.**

## The skidCount regression (2026-10-02)
`skidCount` was declared with `let` inside the `if (!worldwide)` block in
`backend/routes/rates.js` but referenced outside it → ReferenceError → the
async handler never responded → frontend timed out after ~60s. Site was
effectively down all day.

The smoke test catches this two ways:
1. **Static scope check**: verifies `let skidCount` is declared before (not
   inside) the `if (!worldwide)` block, at handler-body indentation.
2. **Engine test**: `quoteMatrix` with `skidCount: 6` must not throw.
