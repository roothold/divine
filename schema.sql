-- Divine Intelligence — Database Schema
-- Run once against your Railway Postgres instance:
--   psql $DATABASE_URL -f schema.sql

-- ── Extensions ──────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Wallets ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallets (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT        UNIQUE NOT NULL,          -- device UUID (localStorage)
  credit_balance  DECIMAL(10,4) NOT NULL DEFAULT 0.00,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Transactions ledger ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id   UUID        NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  type        TEXT        NOT NULL CHECK (type IN ('credit','debit','refund')),
  amount      DECIMAL(10,4) NOT NULL,                  -- always positive
  description TEXT,
  metadata    JSONB       DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_transactions_wallet ON transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at DESC);

-- ── Conversation contexts (for context management / summarisation) ───────────
CREATE TABLE IF NOT EXISTS conversation_contexts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT        NOT NULL,
  thinker_id  TEXT        NOT NULL,
  messages    JSONB       NOT NULL DEFAULT '[]',
  summary     TEXT,                                    -- compressed history
  token_est   INTEGER     NOT NULL DEFAULT 0,          -- rough token count
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, thinker_id)
);
CREATE INDEX IF NOT EXISTS idx_ctx_user_thinker ON conversation_contexts(user_id, thinker_id);

-- ── Auto-update updated_at ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS wallets_updated_at     ON wallets;
DROP TRIGGER IF EXISTS ctx_updated_at         ON conversation_contexts;

CREATE TRIGGER wallets_updated_at
  BEFORE UPDATE ON wallets
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER ctx_updated_at
  BEFORE UPDATE ON conversation_contexts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
