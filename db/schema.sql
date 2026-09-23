-- Belgian Budget App — PostgreSQL schema
-- Run with: psql $DATABASE_URL -f schema.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per GoCardless "requisition" (a consented link to a bank)
CREATE TABLE bank_connections (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    institution_id      TEXT NOT NULL,          -- e.g. "KBC_KREDBEBB"
    requisition_id      TEXT NOT NULL,          -- GoCardless requisition id
    status              TEXT NOT NULL DEFAULT 'pending', -- pending|linked|expired|revoked
    access_token_enc    TEXT,                   -- AES-256-GCM encrypted
    refresh_token_enc   TEXT,
    consent_expires_at  TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bank_connection_id  UUID NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
    gocardless_account_id TEXT NOT NULL,
    iban                TEXT,
    account_name        TEXT,
    currency            TEXT NOT NULL DEFAULT 'EUR',
    current_balance     NUMERIC(12,2),
    balance_updated_at  TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (gocardless_account_id)
);

CREATE TABLE categories (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(id) ON DELETE CASCADE, -- NULL = system default category
    parent_id       UUID REFERENCES categories(id),
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL DEFAULT 'expense', -- expense|income
    icon            TEXT,
    UNIQUE (user_id, name)
);

CREATE TABLE transactions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id          UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    gocardless_tx_id     TEXT NOT NULL,          -- external id, for idempotent sync
    booking_date        DATE NOT NULL,
    amount               NUMERIC(12,2) NOT NULL, -- negative = expense, positive = income
    currency             TEXT NOT NULL DEFAULT 'EUR',
    counterparty_name    TEXT,
    remittance_info       TEXT,                  -- raw description from the bank
    category_id           UUID REFERENCES categories(id),
    category_source        TEXT NOT NULL DEFAULT 'auto', -- auto|manual
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, gocardless_tx_id)
);

CREATE INDEX idx_transactions_account_date ON transactions (account_id, booking_date);
CREATE INDEX idx_transactions_category ON transactions (category_id);

CREATE TABLE budgets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id     UUID NOT NULL REFERENCES categories(id),
    month           DATE NOT NULL,               -- stored as first-of-month, e.g. 2026-09-01
    amount          NUMERIC(12,2) NOT NULL,
    UNIQUE (user_id, category_id, month)
);

CREATE TABLE recommendations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id     UUID REFERENCES categories(id),
    month           DATE NOT NULL,
    message         TEXT NOT NULL,
    severity        TEXT NOT NULL DEFAULT 'info', -- info|warning
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    dismissed       BOOLEAN NOT NULL DEFAULT false
);

-- Seed a reasonable default category taxonomy
INSERT INTO categories (name, kind) VALUES
    ('Wages', 'income'),
    ('Other income', 'income'),
    ('Home costs', 'expense'),
    ('Transportation', 'expense'),
    ('Health', 'expense'),
    ('Daily living', 'expense'),
    ('Entertainment', 'expense'),
    ('Savings', 'expense'),
    ('Obligations', 'expense'),
    ('Uncategorized', 'expense');
