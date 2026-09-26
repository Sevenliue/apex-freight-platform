# Apex Freight backend

Express backend for the **Apex Freight & Shipping Canada** freight brokerage
marketplace. Currency **CAD**, English UI/comments.

## Zero-setup run

```bash
cd platform/backend
npm install
npm start            # listens on PORT (default 5000)
```

With no env vars set the server runs in **demo mode**: matrix LTL quoting and
the full load-board → bid → award flow work from in-memory stores. Routes that
need EasyPost, Stripe, or Postgres answer `501` with a clear message naming the
missing credential.

Copy `../.env.example` to `../.env` and fill in values to enable integrations.

## Environment

| Var | Default | Enables |
|---|---|---|
| `PORT` | `5000` | — |
| `MARKUP_PERCENT` | `15` | markup on matrix quotes and awarded bids |
| `EASYPOST_API_KEY` | _(empty)_ | parcel rates, label purchase, tracking |
| `STRIPE_SECRET_KEY` | _(empty)_ | charging shippers on bid accept |
| `DATABASE_URL` | _(empty)_ | Postgres persistence + reports + admin |
| `FRONTEND_ORIGIN` | _(empty)_ | public frontend URL (Stripe callbacks) |
| `AUTH_TOKEN` | _(empty)_ | bearer-token auth stub (see below) |

`parcel.weight` on `/api/rates` is treated as **pounds (lbs)**; it is converted
to ounces for EasyPost.

## Endpoints

| Method & path | Notes |
|---|---|
| `GET /api/health` | `{status:'online', timestamp}` |
| `POST /api/rates` | matrix quotes always; EasyPost parcel rates appended when keyed |
| `POST /api/shipments/buy` | `501` without EasyPost key |
| `GET /api/tracking/:tracking_code?carrier=` | `501` without EasyPost key |
| `POST /api/webhooks/easypost` | always `200 'Webhook Received'` |
| `POST /api/loads/create` | `201 {load}` |
| `GET /api/loads/open` | `{loads:[{...load, total_bids, lowest_bid}]}` |
| `POST /api/bids/submit` | upsert on posting+carrier |
| `POST /api/bids/accept` | `{charged_to_shipper, carrier_payout, your_platform_profit, payment_status}` |
| `POST /api/loads/:id/probill` | attach carrier PRO#/BOL# |
| `POST /api/carrier-rates/upload` | `{carrier_id, lanes:[...]}` → engine upsert + DB upsert |
| `GET /api/carrier-rates/accessorials/:carrier_id` | from matrix engine |
| `GET /api/reports/shipper/:shipper_id` | `501` without DB |
| `GET /api/reports/carrier/:carrier_id` | `501` without DB |
| `GET /api/admin/overview` | `501` without DB |
| `GET /` | sibling frontend `index.html` (static) |

## Auth stub

`middleware/auth.js` is **disabled by default**. Set `AUTH_TOKEN` and every
`/api` request (except `/api/health` and `/api/webhooks/easypost`) must send
`Authorization: Bearer <AUTH_TOKEN>` or it gets `401`. EasyPost webhooks are
exempt because EasyPost cannot send our bearer token — verify those with an
EasyPost webhook secret instead.

## Sibling contracts

- **Rate matrix** (`./rates/matrix-engine.js`, sibling-built): loaded by
  `lib/matrix.js`, which validates the four exports
  (`quoteMatrix`, `listCarriers`, `getAccessorials`, `upsertCarrierRows`).
  Falls back to `../rates/matrix-engine.js`, then to the clearly-marked
  **sample** engine in `lib/matrix-fallback.js` (invented demo data only).
- **Database** (`../db/` + DB sibling): when `DATABASE_URL` is set, routes
  additionally write to `quotes`, `orders`, `shipment_postings`, `bids`,
  `marketplace_transactions`, `carrier_matrix_rates`, `tracking_logs`, and
  read `financial_reports_view` (view columns are the DB sibling's; reports
  adapt to common column candidates). DB write failures are non-fatal and
  surfaced as `warnings`.
- **Frontend** (`../frontend/`): served statically; `frontend/api.js`
  already matches these routes.

## Money math

`retail = round2(cost × (1 + MARKUP_PERCENT/100))`. On bid accept:
`shipperPrice = round2(bid × (1+markup/100))`,
`platformProfit = round2(shipperPrice − bid)`. Stripe charges are in cents
with `currency: 'cad'`.

## Notes / stubbed

- EasyPost label buy and tracking are implemented against `@easypost/api`
  v8 (`client.Shipment.create/buy`, `client.Tracker.create`) but untested
  live — no API key exists yet.
- Stripe `paymentIntents.create` is implemented but untested live.
- Report column mapping is defensive (first-present candidate wins); confirm
  against the sibling's `financial_reports_view` definition when it lands.
- No API keys, account IDs, or private identifiers are invented anywhere.
