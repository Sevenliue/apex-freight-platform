# Rate Matrix — Data Engine

Pure-Node (zero dependencies) LTL rating engine for ShipRate.
All money in **CAD**. UI and comments in English.

| File | Purpose |
|---|---|
| `matrix-data.json` | Normalized seed data (generated; do not hand-edit — regenerate with `build-matrix.js`) |
| `matrix-engine.js` | Rating engine (CommonJS): `loadMatrix`, `quoteMatrix`, `listCarriers`, `getAccessorials`, `upsertCarrierRows` |
| `build-matrix.js` | One-off generator: parses the source CSVs into `matrix-data.json` |

## Data sources

Source rate sheets (read-only, in `~/workspace/shiprate-freight/rate_tables/`). Account numbers,
contact names, emails, and customer company names were stripped during normalization —
carrier names and sheet numbers are the only identifiers kept.

| Carrier | Source file | Lanes | Break columns |
|---|---|---|---|
| HiFab Transport | `hifab_2026_ltl.csv` | 32 | L5C(<500), 5C, 1M, 2M, 5M, 10M, 20M (open) |
| Guilbault Transport | `guilbault_2026_ltl.csv` | 10 | LTL(<500), 500, 1000, 2000, 5000, 10000, 20000 (open) |
| Rosenau Transport | `rosenau_2026_ltl.csv` | 5,510 | 1–499, 500–999, 1000–1999, 2000–4999, 5000–9999, 10000–19999, 20000–29999, 30000–39999, 40000–49999, 50000+ (open) |
| Guilbault accessorials | `guilbault_2026_accessorials.csv` | 42 items | — |

Normalization notes:
- City/province uppercased and trimmed. The HiFab rows with origin `"ACHESON AB"` and an
  empty province field are split to `ACHESON` / `AB`.
- Each CSV's weight-break columns become `breaks: [{max_lb, rate_cwt}]`, ascending; the top
  break is open-ended (`max_lb: 999999`).
- Lanes with missing or non-positive rates are skipped (none were skipped in the 2026 seed).
- Sheet `notes` columns are **not** copied into the seed data (privacy).

## Rating method

`quoteMatrix({originCity, originProv, destCity, destProv, weightLbs})`:

1. Match lanes case-insensitively on `(city, prov)`; falls back to city-only matching when the
   province is empty on either side (data or query).
2. Pick the first break with `weightLbs <= max_lb`.
3. `base = max(min_charge_cad, weightLbs / 100 * rate_cwt)`.
4. `fsc = base * fsc_percent / 100` (Rosenau: 105.44% at 10,000+ lb — see below).
5. `total = base + fsc`; money rounded to 2 decimals.
6. Results sorted cheapest-first; `[]` when nothing matches.

Each quote row: `{carrier_id, carrier_label, service:'LTL', weight_lbs, rate_cwt_used,
base_cad, fsc_percent, fsc_cad, total_cad, min_charge_applied, currency:'CAD', source:'matrix'}`.

## Fuel surcharge refresh cadence

| Carrier | FSC | As of | Refresh cadence |
|---|---|---|---|
| HiFab Transport | 39% | 2026-09 | **Monthly** — update `fsc_percent` in `matrix-data.json` each month |
| Guilbault Transport | 41% (FCA LTL) | 2026-09-25 | On sheet renewal (sheet 17172 effective 2026-04-01 → 2027-03-31) |
| Rosenau Transport | 65.74% LTL / **105.44% at 10,000+ lb** | 2026-09-25 | Check published FSC periodically; the 10,000-lb override is hard-coded in `matrix-engine.js` (`ROSENAU_TL_FSC`) |

To refresh: edit the carrier's `fsc_percent`/`fsc_as_of` in `matrix-data.json` (or call
`loadMatrix()` and mutate the in-memory carrier entry), then restart/reload the backend —
`loadMatrix()` caches on first call.

## Adding a new carrier's lanes

1. Add the carrier's CSV to `~/workspace/shiprate-freight/rate_tables/` using the same column
   layout as the other LTL files (`origin_city, origin_prov, dest_city, dest_prov,
   min_charge_cad, rate_*_cwt ...`).
2. In `build-matrix.js`, add the carrier id to `SOURCE_FILES` and its break columns (in
   ascending order) to `BREAK_MAPS`, plus its entry to the `carriers` array (FSC value,
   `fsc_as_of`, and refresh note).
3. Run `node build-matrix.js` and re-run the sanity quote to confirm the new lanes rate.
4. For runtime uploads (no rebuild), use `upsertCarrierRows(carrierId, rows)` with canonical
   lane rows — **in-memory only**; the upload endpoint must persist them (e.g. rewrite
   `matrix-data.json` or append to the carrier's source CSV and rebuild).
