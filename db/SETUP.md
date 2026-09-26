# Apex Freight & Shipping Canada — Database Setup

PostgreSQL schema for the freight brokerage marketplace. All amounts in **CAD**.
Files live in this folder: `platform/db/schema.sql`.

> No real credentials appear anywhere in this repo. Use the placeholders below
> and keep actual connection strings in environment variables only.

---

## A. Supabase (managed Postgres)

1. Go to [supabase.com](https://supabase.com) and sign in (or create an account).
2. **Create a project**: New project → pick an organization → name it
   (e.g. `apex-freight`), choose a region close to you (e.g. `Canada — Montreal`
   or `US — Oregon`), and set a strong database password. Save that password
   somewhere safe (a password manager, not this repo).
3. Open the project dashboard → **SQL Editor** (left sidebar) → **New query**.
4. Paste the full contents of `schema.sql` into the editor and press **Run**
   (or Cmd/Ctrl + Enter). The script is idempotent — running it twice is safe.
5. Get the connection string: **Project Settings → Database → Connection string
   → URI**. It looks like:
   ```
   postgresql://postgres:[YOUR-PASSWORD]@db.<project-ref>.supabase.co:5432/postgres
   ```
   Copy it into your app's environment as `DATABASE_URL`, replacing
   `[YOUR-PASSWORD]` with the password from step 2. Never commit it to git.

## B. Render (managed Postgres)

1. Sign in at [render.com](https://render.com) → **New → PostgreSQL**.
2. Name it (e.g. `apex-freight-db`), choose a region and plan, then **Create Database**.
3. On the database page, copy the **External Database URL** (starts with
   `postgresql://...`). It looks like:
   ```
   postgresql://apex_freight_user:[YOUR-PASSWORD]@<host>.render.com:5432/apex_freight
   ```
4. Run `schema.sql` against it once — options:
   - **psql locally**: `psql "$DATABASE_URL" -f platform/db/schema.sql`
   - **Render shell**: open a Shell on any connected service, paste/upload the
     file, and run the same `psql` command.
5. Set `DATABASE_URL` to the External Database URL in your app's environment
   variables (Render dashboard → service → Environment). Never commit it to git.

## C. Verify the tables exist

Run any of these against the live database:

```sql
-- List all application tables
SELECT tablename
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

-- Confirm the view and the generated-fee columns
SELECT viewname FROM pg_views WHERE schemaname = 'public';
SELECT column_name, is_generated
FROM information_schema.columns
WHERE table_name IN ('orders', 'marketplace_transactions')
  AND column_name = 'platform_fee';
```

Expected tables: `users`, `quotes`, `orders`, `tracking_logs`,
`shipment_postings`, `carrier_bids`, `marketplace_transactions`,
`carrier_matrix_rates`, and the view `financial_reports_view`.

Smoke test (insert then roll back — safe to run on an empty DB):

```sql
BEGIN;
INSERT INTO users (email, full_name, role)
VALUES ('test-shipper@example.com', 'Test Shipper', 'shipper')
RETURNING id, role, is_verified, carrier_status;
ROLLBACK;
```

If the insert returns one row with `role = 'shipper'`, `is_verified = false`,
and `carrier_status = 'pending'`, the defaults are working.
