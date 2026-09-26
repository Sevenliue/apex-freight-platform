-- ============================================================================
-- Apex Freight & Shipping Canada — PostgreSQL schema
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
