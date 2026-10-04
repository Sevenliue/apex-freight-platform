-- ============================================================================
-- ShipRate — PostgreSQL schema
-- Currency: CAD. Owner city: Edmonton, AB.
-- Idempotent: safe to run more than once.
-- ============================================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enum types (guarded so re-runs don't fail)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('shipper', 'carrier', 'admin');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE carrier_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE load_status AS ENUM ('draft', 'open_for_bids', 'awarded', 'in_transit', 'delivered', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE bid_status AS ENUM ('submitted', 'accepted', 'rejected', 'withdrawn');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- users: shippers, carriers, and platform admins
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id                uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
    email             varchar(255)    UNIQUE NOT NULL,
    full_name         varchar(255),
    company_name      varchar(255),
    phone             varchar(50),
    role              user_role       NOT NULL DEFAULT 'shipper',
    is_verified       boolean         NOT NULL DEFAULT false,
    carrier_mc_number varchar(100),
    carrier_status    carrier_status  NOT NULL DEFAULT 'pending',
    created_at        timestamptz     NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Shipper account auth (added 2026-09-27): password login + session tokens.
-- Idempotent: ALTER ... IF NOT EXISTS / CREATE TABLE IF NOT EXISTS.
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash varchar(255);

CREATE TABLE IF NOT EXISTS sessions (
    token      text         PRIMARY KEY,
    user_id    uuid         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz  NOT NULL DEFAULT now(),
    expires_at timestamptz  NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- Address book ownership (added 2026-09-27): addresses belong to the
-- logged-in account when one is present; guest-created rows stay unowned.
ALTER TABLE address_book ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_address_book_user_id ON address_book(user_id);
-- Prime shipping location (added 2026-09-27): one address per account auto-fills
-- the shipper block on outbound quotes and the consignee block on inbound.
ALTER TABLE address_book ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false;

-- Depot service flags on quotes (added 2026-09-27): shipper drops off at the
-- origin depot (no pickup dispatch); consignee collects at the destination
-- depot (no carrier delivery).
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS depot_dropoff boolean NOT NULL DEFAULT false;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS depot_pickup boolean NOT NULL DEFAULT false;

-- Delivery notes (print on the BOL) + private notes (internal only), added 2026-09-27.
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS delivery_note_1 varchar(60) NOT NULL DEFAULT '';
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS delivery_note_2 varchar(60) NOT NULL DEFAULT '';
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS private_notes text NOT NULL DEFAULT '';

-- Additional cargo insurance, added 2026-09-27.
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS add_insurance boolean NOT NULL DEFAULT false;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS insurance_declared numeric;

-- Quote attachments (commercial invoices, photos, etc.).
CREATE TABLE IF NOT EXISTS quote_attachments (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    quote_id    uuid        REFERENCES quotes(id) ON DELETE CASCADE,
    shipment_key varchar(64) NOT NULL,
    user_id     uuid        REFERENCES users(id) ON DELETE SET NULL,
    filename    varchar(255) NOT NULL,
    stored_path text        NOT NULL,
    mime        varchar(128),
    size_bytes  integer,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attachments_shipment ON quote_attachments(shipment_key);
CREATE INDEX IF NOT EXISTS idx_attachments_quote ON quote_attachments(quote_id);

-- Custom per-account dropdown lists (added 2026-09-27): shippers can add
-- their own package types and product names; kind is 'package_type' or
-- 'product_name'.
CREATE TABLE IF NOT EXISTS custom_list_items (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       varchar(20) NOT NULL,
  label      varchar(80) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_custom_list_kind CHECK (kind IN ('package_type', 'product_name')),
  CONSTRAINT uq_custom_list UNIQUE (user_id, kind, label)
);
CREATE INDEX IF NOT EXISTS idx_custom_list_user_kind ON custom_list_items(user_id, kind);

-- ---------------------------------------------------------------------------
-- quotes: instant-quote requests and their rate results
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quotes (
    id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid          REFERENCES users(id) ON DELETE SET NULL,
    easypost_shipment_id varchar(255),
    origin_street1      varchar(255),
    origin_city         varchar(255),
    origin_state        varchar(100),
    origin_zip          varchar(50),
    origin_country      varchar(100),
    dest_street1        varchar(255),
    dest_city           varchar(255),
    dest_state          varchar(100),
    dest_zip            varchar(50),
    dest_country        varchar(100),
    parcel_length       numeric,
    parcel_width        numeric,
    parcel_height       numeric,
    parcel_weight       numeric,
    created_at          timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quotes_user_id ON quotes(user_id);

-- ---------------------------------------------------------------------------
-- orders: purchased parcel shipments (label bought via rate provider)
-- + scheduled LTL loads (paid at scheduling via Stripe Checkout).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tendered boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS carrier_pro varchar(255);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_checkout_session_id varchar(255);
-- Shipper's order # + receiver's PO #: required on every shipment, for reporting.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipper_order_no varchar(255);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS receiver_po_no varchar(255);
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
    id                     uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
    quote_id               uuid            REFERENCES quotes(id) ON DELETE SET NULL,
    user_id                uuid            REFERENCES users(id) ON DELETE SET NULL,
    easypost_shipment_id   varchar(255),
    easypost_rate_id       varchar(255),
    tracking_code          varchar(255)    UNIQUE,
    tracker_id             varchar(255),
    carrier                varchar(100),
    service_level          varchar(100),
    cost_amount            numeric(10,2),
    charged_amount         numeric(10,2),
    platform_fee           numeric(10,2)   GENERATED ALWAYS AS (charged_amount - cost_amount) STORED,
    currency               varchar(3)      NOT NULL DEFAULT 'CAD',
    label_url              text,
    status                 varchar(50)     NOT NULL DEFAULT 'purchased',
    payment_status         varchar(50)     NOT NULL DEFAULT 'paid',
    stripe_payment_intent_id varchar(255),
    created_at             timestamptz     NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_quote_id ON orders(quote_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- ---------------------------------------------------------------------------
-- tracking_logs: event history per order
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tracking_logs (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        uuid          NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    tracking_code   varchar(255),
    status          varchar(100),
    message         text,
    location        varchar(255),
    event_timestamp timestamptz,
    created_at      timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tracking_logs_order_id ON tracking_logs(order_id);
CREATE INDEX IF NOT EXISTS idx_tracking_logs_tracking_code ON tracking_logs(tracking_code);

-- ---------------------------------------------------------------------------
-- shipment_postings: LTL/FTL freight loads posted to the marketplace
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shipment_postings (
    id                    uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
    shipper_id            uuid            NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shipper_order_number  varchar(100),
    carrier_probill_number varchar(100),
    origin_city           varchar(255),
    origin_state          varchar(100),
    origin_zip            varchar(50),
    pickup_date           timestamptz,
    dest_city             varchar(255),
    dest_state            varchar(100),
    dest_zip              varchar(50),
    delivery_date         timestamptz,
    weight_lbs            numeric,
    freight_type          varchar(20)     NOT NULL DEFAULT 'LTL',
    equipment_needed      varchar(255),
    description           text,
    max_budget            numeric(10,2),
    status                load_status     NOT NULL DEFAULT 'open_for_bids',
    created_at            timestamptz     NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shipment_postings_shipper_id ON shipment_postings(shipper_id);
CREATE INDEX IF NOT EXISTS idx_shipment_postings_status ON shipment_postings(status);
CREATE INDEX IF NOT EXISTS idx_shipment_postings_shipper_order_number ON shipment_postings(shipper_order_number);
CREATE INDEX IF NOT EXISTS idx_shipment_postings_carrier_probill_number ON shipment_postings(carrier_probill_number);

-- ---------------------------------------------------------------------------
-- carrier_bids: one bid per carrier per posting
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS carrier_bids (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_posting_id uuid        NOT NULL REFERENCES shipment_postings(id) ON DELETE CASCADE,
    carrier_id          uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bid_amount          numeric(10,2) NOT NULL,
    estimated_transit_days int,
    notes               text,
    status              bid_status  NOT NULL DEFAULT 'submitted',
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_carrier_bids_posting_carrier UNIQUE (shipment_posting_id, carrier_id)
);
CREATE INDEX IF NOT EXISTS idx_carrier_bids_shipment_posting_id ON carrier_bids(shipment_posting_id);
CREATE INDEX IF NOT EXISTS idx_carrier_bids_carrier_id ON carrier_bids(carrier_id);
CREATE INDEX IF NOT EXISTS idx_carrier_bids_status ON carrier_bids(status);

-- ---------------------------------------------------------------------------
-- marketplace_transactions: awarded bids held in escrow / settled
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marketplace_transactions (
    id                uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id       uuid            REFERENCES shipment_postings(id) ON DELETE SET NULL,
    bid_id            uuid            REFERENCES carrier_bids(id) ON DELETE SET NULL,
    shipper_id        uuid            REFERENCES users(id) ON DELETE SET NULL,
    carrier_id        uuid            REFERENCES users(id) ON DELETE SET NULL,
    gross_shipper_paid numeric(12,2)  NOT NULL,
    carrier_payout    numeric(12,2)   NOT NULL,
    platform_fee      numeric(12,2)   GENERATED ALWAYS AS (gross_shipper_paid - carrier_payout) STORED,
    stripe_charge_id  varchar(255),
    stripe_transfer_id varchar(255),
    status            varchar(50)     NOT NULL DEFAULT 'escrowed',
    created_at        timestamptz     NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketplace_transactions_shipment_id ON marketplace_transactions(shipment_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_transactions_bid_id ON marketplace_transactions(bid_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_transactions_shipper_id ON marketplace_transactions(shipper_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_transactions_carrier_id ON marketplace_transactions(carrier_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_transactions_status ON marketplace_transactions(status);

-- ---------------------------------------------------------------------------
-- carrier_matrix_rates: published carrier lane rate tables (CWT breaks + FSC)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS carrier_matrix_rates (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    carrier_id      varchar(50),
    carrier_label   varchar(100),
    origin_city     varchar(255),
    origin_prov     varchar(100),
    dest_city       varchar(255),
    dest_prov       varchar(100),
    min_charge_cad  numeric(10,2),
    breaks_json     jsonb,
    fsc_percent     numeric(5,2),
    effective_date  date,
    expiry_date     date,
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT uq_carrier_matrix_rates_lane UNIQUE (carrier_id, origin_city, origin_prov, dest_city, dest_prov)
);
CREATE INDEX IF NOT EXISTS idx_carrier_matrix_rates_carrier_id ON carrier_matrix_rates(carrier_id);
CREATE INDEX IF NOT EXISTS idx_carrier_matrix_rates_origin ON carrier_matrix_rates(origin_city, origin_prov);
CREATE INDEX IF NOT EXISTS idx_carrier_matrix_rates_dest ON carrier_matrix_rates(dest_city, dest_prov);

-- ---------------------------------------------------------------------------
-- View: financial_reports_view
-- One row per marketplace transaction with shipment, bid, and party context.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW financial_reports_view AS
SELECT
    t.id                    AS transaction_id,
    t.shipment_id           AS shipment_id,
    sp.shipper_order_number AS shipper_order_number,
    sp.carrier_probill_number AS carrier_probill_number,
    t.shipper_id            AS shipper_id,
    t.carrier_id            AS carrier_id,
    sp.origin_city          AS origin_city,
    sp.origin_state         AS origin_prov,
    sp.dest_city            AS dest_city,
    sp.dest_state           AS dest_prov,
    sp.pickup_date          AS shipment_date,
    t.gross_shipper_paid    AS shipper_total_spent,
    t.carrier_payout        AS carrier_gross_earned,
    t.platform_fee          AS platform_profit,
    t.status                AS payment_status
FROM marketplace_transactions t
LEFT JOIN shipment_postings sp ON sp.id = t.shipment_id
LEFT JOIN carrier_bids b       ON b.id = t.bid_id;

-- ---------------------------------------------------------------------------
-- Smart-shipping quote flow: saved quotes, full quote payloads, BOL data.
-- Idempotent: safe to re-run on existing databases.
-- ---------------------------------------------------------------------------
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS is_saved        boolean      NOT NULL DEFAULT false;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS quote_name      varchar(255);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS shipper_json    jsonb;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS consignee_json  jsonb;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS packages_json   jsonb;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS accessorials_json jsonb;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS rates_json       jsonb;
CREATE INDEX IF NOT EXISTS idx_quotes_is_saved ON quotes(is_saved);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS bol_json jsonb;

-- Shipment type + freight charges (Smart Shipping-style top options).
-- Idempotent: safe to re-run on existing databases.
-- ---------------------------------------------------------------------------
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS region          varchar(20) NOT NULL DEFAULT 'canada_usa';
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS direction       varchar(20) NOT NULL DEFAULT 'outbound';
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS freight_charges varchar(20) NOT NULL DEFAULT 'prepaid';
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS bill_to_json    jsonb;

-- ---------------------------------------------------------------------------
-- Address Book: saved shipper/consignee addresses with one-tap quote fill.
-- Carriers: carrier directory + exclusion list (excluded carriers are hidden
-- from the matrix-ranked quote board). Idempotent: safe to re-run.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS address_book (
  id                uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
  label             varchar(120)    NOT NULL,
  company           varchar(160),
  contact_name      varchar(120),
  street            varchar(160),
  city              varchar(80)     NOT NULL,
  province          varchar(40),
  postal            varchar(20),
  country           varchar(40)     NOT NULL DEFAULT 'CA',
  phone             varchar(40),
  email             varchar(160),
  created_at        timestamptz     NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_address_book_label ON address_book(label);

CREATE TABLE IF NOT EXISTS carriers (
  id                uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
  name              varchar(160)    NOT NULL UNIQUE,
  city              varchar(80),
  province          varchar(40),
  phone             varchar(40),
  email             varchar(160),
  created_at        timestamptz     NOT NULL DEFAULT now()
);

-- Admin-set fuel-surcharge overrides per rate-matrix carrier. When a row
-- exists, its percents win over the rate-sheet values baked into
-- backend/rates/matrix-data.json. fsc_tl_percent applies at 10,000+ lb
-- (Rosenau's TL tier); NULL means no TL tier. Deleting the row restores the
-- rate-sheet value.
CREATE TABLE IF NOT EXISTS carrier_fsc (
  carrier_id      varchar(80)     PRIMARY KEY,
  fsc_ltl_percent numeric         NOT NULL,
  fsc_tl_percent  numeric,
  updated_at      timestamptz     NOT NULL DEFAULT now(),
  updated_by      varchar(160)
);

-- Admin-set per-carrier dimensional-weight density floors (lb per cubic
-- foot). When a row exists, its floor wins over the global
-- DENSITY_FLOOR_LB_PER_CUFT default (10) for that carrier's cube-rule
-- calculation. Deleting the row restores the default.
CREATE TABLE IF NOT EXISTS carrier_density_floor (
  carrier_id        varchar(80)   PRIMARY KEY,
  floor_lb_per_cuft numeric       NOT NULL,
  updated_at        timestamptz   NOT NULL DEFAULT now(),
  updated_by        varchar(160)
);

-- Seed the carriers the rate matrix already quotes (names must match the
-- carrier_label strings in backend/rates/build-matrix.js).
INSERT INTO carriers (name) VALUES
  ('Rosenau Transport'),
  ('Guilbault Transport'),
  ('HiFab Transport')
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS carrier_exclusions (
  carrier_name      varchar(160)    PRIMARY KEY,
  created_at        timestamptz     NOT NULL DEFAULT now()
);

-- 2026-09-27: carrier exclusions become per-account. They were a single
-- global list (one row per carrier_name shared by every account), so one
-- user's exclusion hid the carrier for everyone. Migrate to (user_id,
-- carrier_name) rows. Idempotent — safe to run on every boot.
ALTER TABLE carrier_exclusions ADD COLUMN IF NOT EXISTS user_id uuid;
DO $$
DECLARE
  pkdef  text;
  pkname text;
BEGIN
  SELECT pg_get_constraintdef(oid), conname INTO pkdef, pkname
  FROM pg_constraint
  WHERE conrelid = 'carrier_exclusions'::regclass AND contype = 'p';
  IF pkdef IS NULL OR position('(user_id, carrier_name)' in pkdef) = 0 THEN
    -- Legacy global rows cannot be attributed to an account; drop them so
    -- the composite primary key (which forbids NULL user_id) applies cleanly.
    DELETE FROM carrier_exclusions WHERE user_id IS NULL;
    IF pkname IS NOT NULL THEN
      EXECUTE 'ALTER TABLE carrier_exclusions DROP CONSTRAINT ' || quote_ident(pkname);
    END IF;
    ALTER TABLE carrier_exclusions ADD PRIMARY KEY (user_id, carrier_name);
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Subscription billing (added 2026-09-27): Stripe subscriptions + monthly
-- quote quotas. Idempotent: ALTER ... IF NOT EXISTS.
-- Tiers: free (5 quotes/mo), starter (50 quotes/mo), pro (unlimited).
-- subscription_status: none | active | trialing | past_due | canceled ...
-- Only active/trialing count as a paid subscription; anything else is
-- treated as the free tier by the quota logic.
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_tier text NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status text NOT NULL DEFAULT 'none';
ALTER TABLE users ADD COLUMN IF NOT EXISTS current_period_end timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS quotes_used integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS quota_period text;
-- Per-account unlimited-quote grant (admin toggle). Bypasses the monthly
-- quote cap without granting any admin rights.
ALTER TABLE users ADD COLUMN IF NOT EXISTS unlimited_quotes boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer_id ON users(stripe_customer_id);

-- ---------------------------------------------------------------------------
-- Shipping approval (added 2026-09-27): new accounts start quote-only.
-- An admin must approve the account (Admin → Account approvals) before the
-- customer can schedule/pay for shipments. Admins (ADMIN_EMAILS) bypass.
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS shipping_approved boolean NOT NULL DEFAULT false;

-- Per-customer freight markup override (percent). NULL = use the global
-- MARKUP_PERCENT default. Admin-managed via POST /api/admin/users/:id/markup.
ALTER TABLE users ADD COLUMN IF NOT EXISTS markup_percent numeric;

-- ---------------------------------------------------------------------------
-- Full-load pricing requests (added 2026-09-27): a customer can ask for custom
-- pricing on a full truckload instead of instant LTL rates. An admin is
-- notified and follows up with a price.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS full_load_requests (
  id              uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid,
  user_email      text,
  origin_city     text,
  origin_province text,
  dest_city       text,
  dest_province   text,
  equipment       text,
  weight_lb       numeric,
  pieces          integer,
  pickup_date     date,
  commodity       text,
  notes           text,
  status          text NOT NULL DEFAULT 'new',
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- pickup_requests: customer-booked carrier pickups. A request is tied to one
-- of the customer's orders (shipments); the admin confirms it with the
-- carrier and updates the status. Customers can cancel their own requests
-- while still in 'requested' status.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pickup_requests (
  id              uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid            REFERENCES users(id) ON DELETE SET NULL,
  order_id        uuid            REFERENCES orders(id) ON DELETE SET NULL,
  pickup_date     date            NOT NULL,
  time_window     varchar(40)     NOT NULL DEFAULT 'morning',
  contact_name    varchar(120),
  contact_phone   varchar(40),
  notes           text,
  status          varchar(40)     NOT NULL DEFAULT 'requested',
  created_at      timestamptz     NOT NULL DEFAULT now(),
  decided_at      timestamptz
);
CREATE INDEX IF NOT EXISTS idx_pickup_requests_user_id ON pickup_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_pickup_requests_status ON pickup_requests(status);

-- ---------------------------------------------------------------------------
-- Single-use auth tokens: password resets + email verification (added 2026-09-29).
-- Only the SHA-256 hash of the raw token is stored; the raw value is emailed
-- to the account holder and never persisted or returned by any endpoint.
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_tokens (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose     varchar(32) NOT NULL CHECK (purpose IN ('password_reset', 'email_verify')),
    token_hash  varchar(64) NOT NULL UNIQUE,
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user_purpose ON auth_tokens(user_id, purpose);
