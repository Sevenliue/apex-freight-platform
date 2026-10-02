# ShipRate — Disaster Recovery & Restore Guide

If the site goes down, or if you ever need to rebuild it without Muse's help,
everything you need is listed here. Keep this file with the repo.

## Where everything lives

| Piece | Location | Notes |
|---|---|---|
| All site code (backend + frontend) | GitHub: `Sevenliue/apex-freight-platform` | Full history; clone or download ZIP any time, no Muse needed |
| Built rate data | `backend/rates/matrix-data.json` (in the repo) | Generated from `rate_tables/` by `backend/rates/build-matrix.js` |
| Source rate sheets (CSVs) | `rate_tables/` (in the repo) | The raw carrier tables the matrix is built from |
| Database schema | `db/schema.sql` (in the repo) | Applied automatically at every server boot — a fresh DB rebuilds itself |
| Live database (users, quotes, shipments, FSC overrides) | Render Postgres `apex-freight-db` | **Not in git.** Only copy lives on Render |
| Secrets / API keys | Render dashboard → Environment | **Never in git.** You must re-enter these on a rebuild (see checklist) |
| Domain + DNS | Cloudflare (`shiprate.ca`) | CNAME @ and www → `apex-freight-platform.onrender.com`, proxied |
| Infra-as-code | `render.yaml` (in the repo) | One-click Blueprint rebuild of service + database |

## If the site is down — in order

### 1. Bad deploy (most common)
Render Dashboard → `apex-freight-platform` service → **Events** → find the last
working deploy → **Rollback**. Or push a fix to GitHub; Render auto-deploys.

### 2. Service deleted or broken beyond rollback
Render Dashboard → **New → Blueprint** → select `Sevenliue/apex-freight-platform`
→ Render recreates the web service from `render.yaml`. Then:
1. Re-add the custom domains (`shiprate.ca`, `www.shiprate.ca`) under Settings → Custom Domains.
2. Re-enter every secret env var from the checklist below (Render does not restore values you typed in by hand).
3. The database schema applies itself on first boot from `db/schema.sql`.

### 3. Database lost or corrupted
- Render Postgres keeps **automatic daily backups** (7-day retention on paid plans).
  Dashboard → `apex-freight-db` → **Backups** → restore to a new database, then
  point `DATABASE_URL` at it.
- With no backup: create a fresh Postgres, attach it — the schema rebuilds on
  boot, but **all data (users, quotes, shipments, FSC overrides) is gone**.
  You will need to re-enter each carrier's FSC in Admin → Fuel surcharges.

### 4. No Muse, no VM — starting from zero on your own machine
1. Go to `github.com/Sevenliue/apex-freight-platform` → **Code → Download ZIP** (or `git clone`).
2. You have the entire site. To run it: `cd backend && npm install && node server.js`
   (needs a Postgres `DATABASE_URL`, or it runs in limited in-memory mode).
3. To relaunch publicly: create a Render account → **New → Blueprint** → point at
   the repo → add domains + env vars from the checklist.

## Secret env var checklist (values live only in Render — keep your own copy)

- `DATABASE_URL` — auto-wired from the Render Postgres (via `render.yaml`)
- `PUBLIC_URL` — `https://shiprate.ca`
- `FRONTEND_ORIGIN` — `https://shiprate.ca`
- `ADMIN_EMAILS` — your admin login email(s)
- `NOTIFY_PROVIDER` = `resend`, `RESEND_API_KEY`, `NOTIFY_FROM` = `noreply@shiprate.ca`, `NOTIFY_ADMIN_EMAIL`
- `GOOGLE_PLACES_API_KEY` — address autocomplete
- `EASYPOST_API_KEY` — parcel rates (when you activate it)
- `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` — payments
- `MARKUP_PERCENT` = `15`
- `REQUIRE_EMAIL_VERIFICATION` = `true`

⚠️ **Heads-up:** the Render Postgres free tier expires **2026-10-26**. If it lapses,
the database (all users, quotes, shipments, FSC settings) can be deleted.
Upgrade to the paid DB plan before that date to keep automatic backups and your data.
