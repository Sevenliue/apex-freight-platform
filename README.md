# Apex Freight & Shipping Canada — Platform

A freight brokerage marketplace for shipping across Canada: shippers get instant rate quotes computed from built-in carrier tariff matrices (with a configurable markup), post loads to a load board, and carriers place bids; payments are handled through Stripe and live parcel rates through EasyPost. One Node.js backend hosts both the API and the static frontend, so it runs on a single web service (Render) or locally on your own machine.

## Project tree

```
platform/
├── backend/            # Express API (server.js entry) + package.json
│   └── server.js       # reads ../.env; serves API and ../frontend on one origin
├── frontend/           # static UI; calls the API on the same origin by default
├── db/
│   └── schema.sql      # Postgres schema for loads/bids (apply once after deploy)
├── .env.example        # commented placeholder config — copy to .env and fill in
├── .gitignore
├── Dockerfile          # container image: node:20-slim, node backend/server.js
├── render.yaml         # Render blueprint: web service + Postgres database
└── vercel.json         # alternative FRONTEND-ONLY static deploy
```

## Prerequisites

- Node 20+ (Docker optional, for container builds)
- A Postgres database is **optional**: without `DATABASE_URL` the backend runs
  with an in-memory demo store (data resets on restart)

## Local run

```bash
cp .env.example .env      # then edit .env with your real values
cd backend && npm install && node server.js
```

Open http://localhost:5000

## What works with zero keys

- **Instant matrix quotes** — quotes computed from the built-in carrier tariff
  sheets (LTL lanes, weight breaks, fuel surcharges) with your `MARKUP_PERCENT`
- **Load board + bidding demo** — post loads and place bids using the
  in-memory store (no Postgres needed)

## What needs keys

- `DATABASE_URL` → persistent loads, bids, and users (Postgres on Render or Supabase)
- `EASYPOST_API_KEY` → live parcel/small-parcel carrier rates
- `STRIPE_SECRET_KEY` + `STRIPE_PUBLISHABLE_KEY` → accept customer payments

## Deploy (Render)

1. Push `platform/` to a Git repo, then in Render: **New → Blueprint** → select the repo (reads `render.yaml`).
2. Set `EASYPOST_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, and
   `FRONTEND_ORIGIN` in the service's environment settings (they are `sync: false`
   placeholders in the blueprint on purpose).
3. Apply the schema to the new `apex-freight-db` database **once**:
   ```bash
   psql $DATABASE_URL -f db/schema.sql
   ```
   (`$DATABASE_URL` is available on the Render service; from your own machine,
   copy the connection string from the Render Postgres dashboard.)

## Alternative: frontend-only on Vercel

`vercel.json` deploys just the static UI from `frontend/` (no API). If you use
it, edit `frontend/api.js` so `API_BASE_URL` points at your Render backend URL
(e.g. `https://apex-freight-platform.onrender.com`) instead of the same-origin default.

## Accounts & keys Seven must create himself

These require your personal identity, legal entity, or billing — they cannot be
set up by an assistant:

- **EasyPost account + API key** — sign up at easypost.com, grab a test key first,
  switch to a production key when you're ready to quote real rates.
- **Stripe account + secret and publishable keys** — sign up at stripe.com;
  **identity verification is required by Stripe before you can receive payouts**.
- **Postgres database** — free tier on Render or Supabase, whichever you prefer.
- **Custom domain** — register at the registrar of your choice and point it at
  your Render service.

A plain note: **carrier contracts, cargo insurance, and Stripe identity
verification are business/legal steps no AI can do for you.** Rates only mean
something once carriers agree to them, insurance only exists once a policy is
issued in your company's name, and Stripe will only pay out to a verified
account. Plan for those in your launch checklist.
