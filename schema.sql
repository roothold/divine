-- Divine Intelligence — Database Schema v2
-- Run once against your Railway Postgres instance:
--   psql $DATABASE_URL -f schema.sql

-- ── Extensions ──────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Users ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT        UNIQUE NOT NULL,
  name            TEXT,
  avatar_url      TEXT,
  google_id       TEXT        UNIQUE,
  linkedin_id     TEXT        UNIQUE,
  password_hash   TEXT,                                 -- email/password auth
  role            TEXT        NOT NULL DEFAULT 'user'
                              CHECK (role IN ('user','admin','thinker')),
  thinker_access  BOOLEAN     NOT NULL DEFAULT FALSE,
  thinker_id      TEXT,                                 -- links to THINKERS[].id
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_email       ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_google_id   ON users(google_id);
CREATE INDEX IF NOT EXISTS idx_users_linkedin_id ON users(linkedin_id);

-- ── Wallets ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallets (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT        UNIQUE NOT NULL,          -- auth user UUID or device UUID
  credit_balance  DECIMAL(10,4) NOT NULL DEFAULT 0.00,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Transactions ledger ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id   UUID        NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  type        TEXT        NOT NULL CHECK (type IN ('credit','debit','refund')),
  amount      DECIMAL(10,4) NOT NULL,
  description TEXT,
  metadata    JSONB       DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_transactions_wallet  ON transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at DESC);

-- ── Conversation contexts ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversation_contexts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT        NOT NULL,
  thinker_id  TEXT        NOT NULL,
  messages    JSONB       NOT NULL DEFAULT '[]',
  summary     TEXT,
  token_est   INTEGER     NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, thinker_id)
);
CREATE INDEX IF NOT EXISTS idx_ctx_user_thinker ON conversation_contexts(user_id, thinker_id);

-- ── Auto-update updated_at ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS wallets_updated_at ON wallets;
DROP TRIGGER IF EXISTS users_updated_at   ON users;
DROP TRIGGER IF EXISTS ctx_updated_at     ON conversation_contexts;

CREATE TRIGGER wallets_updated_at
  BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER ctx_updated_at
  BEFORE UPDATE ON conversation_contexts FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
