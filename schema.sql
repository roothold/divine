-- ═══════════════════════════════════════════════════════════════════════════
-- DIVINE INTELLIGENCE — Cognitive Equity Schema  v3
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Entity map:
--   users ──────────────────────────────────────────┐
--     │                                              │
--     ├─► wallets ──► wallet_transactions            │
--     │               (Cognitive Equity Ledger)      │
--     │                                              │
--     └─► chat_sessions ──► chat_messages            │
--              │            session_domain_tags       │
--              │            thinker_routing_log       │
--              │                                     │
--   thinker_profiles ◄────────────────────────────────┘
--        │
--        ├─► thinker_domain_verifications ──► cognitive_domains
--        └─► thinker_earnings
--
-- credit_packages ──► credit_orders ──► wallet_transactions
--
-- Run:  psql $DATABASE_URL -f schema.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- fuzzy domain search


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. USERS
--    Platform consumers + authenticated thinkers
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS users (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT          UNIQUE NOT NULL,
  name            TEXT,
  avatar_url      TEXT,
  google_id       TEXT          UNIQUE,
  linkedin_id     TEXT          UNIQUE,
  password_hash   TEXT,                                    -- email/password auth
  role            TEXT          NOT NULL DEFAULT 'user'
                                CHECK (role IN ('user','admin','thinker')),
  thinker_access  BOOLEAN       NOT NULL DEFAULT FALSE,
  thinker_slug    TEXT,                                    -- FK to thinker_profiles.slug
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_email        ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_google_id    ON users(google_id);
CREATE INDEX IF NOT EXISTS idx_users_linkedin_id  ON users(linkedin_id);
CREATE INDEX IF NOT EXISTS idx_users_thinker_slug ON users(thinker_slug);


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. COGNITIVE DOMAINS
--    The tagging taxonomy — every query and every thinker lives in domains.
--    This table is the backbone of the routing/verification system.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS cognitive_domains (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT          UNIQUE NOT NULL, -- 'startup-strategy', 'stoic-philosophy'
  name        TEXT          NOT NULL,        -- 'Startup Strategy'
  description TEXT,
  parent_id   UUID          REFERENCES cognitive_domains(id) ON DELETE SET NULL,
  color       TEXT          NOT NULL DEFAULT '#9E9E9E',  -- hex for UI badges
  icon        TEXT,                                       -- emoji or SVG key
  sort_order  SMALLINT      NOT NULL DEFAULT 0,
  is_active   BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_domains_slug   ON cognitive_domains(slug);
CREATE INDEX IF NOT EXISTS idx_domains_parent ON cognitive_domains(parent_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. THINKER PROFILES
--    The public "Human Mind" card — decoupled from auth accounts.
--    A thinker_profile can exist before its owner creates a login.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS thinker_profiles (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT          UNIQUE NOT NULL,  -- 'michael-akindele'
  user_id         UUID          REFERENCES users(id) ON DELETE SET NULL,
  display_name    TEXT          NOT NULL,
  title           TEXT,                            -- 'Founder · Cognitive Strategist'
  bio             TEXT,
  avatar_initials TEXT          NOT NULL DEFAULT 'TK',
  avatar_color    TEXT          NOT NULL DEFAULT '#2C3E50',
  lens            TEXT,         -- signature one-liner ("Clarity through paradox")
  status          TEXT          NOT NULL DEFAULT 'active'
                                CHECK (status IN ('draft','active','suspended')),
  public_profile  BOOLEAN       NOT NULL DEFAULT TRUE,
  royalty_pct     DECIMAL(5,2)  NOT NULL DEFAULT 20.00  -- % of perspective cost they earn
                                CHECK (royalty_pct BETWEEN 0 AND 100),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_thinkers_slug    ON thinker_profiles(slug);
CREATE INDEX IF NOT EXISTS idx_thinkers_user    ON thinker_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_thinkers_status  ON thinker_profiles(status);


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. THINKER DOMAIN VERIFICATIONS
--    The gating table. Controls which domains each thinker may audit.
--    Michael Akindele ONLY appears in sessions tagged with his verified domains.
--    Unauthorized domain → thinker is excluded from routing pool.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS thinker_domain_verifications (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  thinker_id      UUID          NOT NULL REFERENCES thinker_profiles(id) ON DELETE CASCADE,
  domain_id       UUID          NOT NULL REFERENCES cognitive_domains(id) ON DELETE CASCADE,

  -- Verification level drives routing priority
  level           TEXT          NOT NULL DEFAULT 'verified'
                                CHECK (level IN ('provisional','verified','expert')),

  -- Audit trail
  verified_by     UUID          REFERENCES users(id) ON DELETE SET NULL,
  verified_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ,             -- NULL = never expires
  confidence_pct  SMALLINT      NOT NULL DEFAULT 85
                                CHECK (confidence_pct BETWEEN 0 AND 100),
  notes           TEXT,

  -- Soft disable without deleting history
  is_active       BOOLEAN       NOT NULL DEFAULT TRUE,
  revoked_at      TIMESTAMPTZ,
  revoked_reason  TEXT,

  UNIQUE (thinker_id, domain_id)
);
CREATE INDEX IF NOT EXISTS idx_tdv_thinker     ON thinker_domain_verifications(thinker_id);
CREATE INDEX IF NOT EXISTS idx_tdv_domain      ON thinker_domain_verifications(domain_id);
CREATE INDEX IF NOT EXISTS idx_tdv_active      ON thinker_domain_verifications(thinker_id, domain_id)
  WHERE is_active = TRUE;


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. WALLETS
--    One wallet per user. balance is the live source of truth.
--    Never mutate balance directly — always go through wallet_transactions.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS wallets (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID          UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credit_balance  DECIMAL(12,4) NOT NULL DEFAULT 0.0000
                                CHECK (credit_balance >= 0),
  lifetime_spent  DECIMAL(12,4) NOT NULL DEFAULT 0.0000,  -- total credits ever debited
  lifetime_earned DECIMAL(12,4) NOT NULL DEFAULT 0.0000,  -- total credits ever credited
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. WALLET TRANSACTIONS — The Cognitive Equity Ledger
--    Every interaction is a named, typed, immutable line item.
--    The balance_after column makes any point-in-time balance instantly auditable.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id       UUID          NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,

  -- ── Line-item classification ──────────────────────────────────────────
  line_item_type  TEXT          NOT NULL CHECK (line_item_type IN (
    'topup',               -- User purchased credits
    'perspective_spend',   -- Credits spent on a chat/perspective
    'thinker_royalty',     -- Share earned by thinker for their verified audit
    'refund',              -- Credits returned to user
    'bonus',               -- Free credits (promo / admin grant)
    'admin_adjustment',    -- Manual balance correction
    'expiry'               -- Credits expired
  )),

  -- ── Amounts (always positive; direction is explicit) ──────────────────
  amount          DECIMAL(12,4) NOT NULL CHECK (amount > 0),
  direction       TEXT          NOT NULL CHECK (direction IN ('credit','debit')),
  balance_after   DECIMAL(12,4) NOT NULL,  -- immutable snapshot post-transaction

  -- ── Human-readable label (shown in UI ledger) ─────────────────────────
  label           TEXT          NOT NULL,  -- "Perspective: First-Principles Logic"
  description     TEXT,                    -- longer detail / receipt line

  -- ── What triggered this transaction ──────────────────────────────────
  ref_type        TEXT          CHECK (ref_type IN (
    'chat_session', 'credit_order', 'thinker_audit', 'admin', 'system'
  )),
  ref_id          UUID,                    -- polymorphic FK to the triggering row

  -- ── Cognitive equity attribution ─────────────────────────────────────
  domain_id       UUID          REFERENCES cognitive_domains(id) ON DELETE SET NULL,
  thinker_id      UUID          REFERENCES thinker_profiles(id) ON DELETE SET NULL,

  -- Immutable — transactions are never updated
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wt_wallet       ON wallet_transactions(wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wt_ref          ON wallet_transactions(ref_type, ref_id);
CREATE INDEX IF NOT EXISTS idx_wt_type         ON wallet_transactions(line_item_type);
CREATE INDEX IF NOT EXISTS idx_wt_thinker      ON wallet_transactions(thinker_id);
CREATE INDEX IF NOT EXISTS idx_wt_domain       ON wallet_transactions(domain_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. CREDIT PACKAGES
--    The top-up tiers surfaced in the UI modal
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS credit_packages (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  credits         INTEGER       NOT NULL CHECK (credits > 0),
  price_usd_cents INTEGER       NOT NULL CHECK (price_usd_cents > 0),
  label           TEXT,                           -- 'Popular', 'Best Value'
  description     TEXT,
  is_active       BOOLEAN       NOT NULL DEFAULT TRUE,
  sort_order      SMALLINT      NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);


-- ═══════════════════════════════════════════════════════════════════════════
-- 8. CREDIT ORDERS
--    A purchase event — one row per Stripe checkout
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS credit_orders (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  package_id            UUID          REFERENCES credit_packages(id) ON DELETE SET NULL,
  credits               INTEGER       NOT NULL CHECK (credits > 0),
  amount_usd_cents      INTEGER       NOT NULL CHECK (amount_usd_cents >= 0),
  stripe_payment_intent TEXT,
  stripe_session_id     TEXT,
  status                TEXT          NOT NULL DEFAULT 'pending'
                                      CHECK (status IN ('pending','paid','failed','refunded')),
  wallet_transaction_id UUID          REFERENCES wallet_transactions(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  paid_at               TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_orders_user   ON credit_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON credit_orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_stripe ON credit_orders(stripe_payment_intent);


-- ═══════════════════════════════════════════════════════════════════════════
-- 9. CHAT SESSIONS
--    A conversation between a user and a thinker.
--    The thinker on a session MUST be verified for the session's primary domain.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS chat_sessions (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thinker_id        UUID          REFERENCES thinker_profiles(id) ON DELETE SET NULL,
  title             TEXT,
  status            TEXT          NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active','archived','deleted')),

  -- ── Routing context ────────────────────────────────────────────────────
  primary_domain_id UUID          REFERENCES cognitive_domains(id) ON DELETE SET NULL,
  routing_reason    TEXT,          -- "Matched: First-Principles Logic (Expert, 94%)"
  model_used        TEXT          DEFAULT 'claude-opus-4-5',

  -- ── Cost accounting ────────────────────────────────────────────────────
  credits_spent     DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  message_count     INTEGER       NOT NULL DEFAULT 0,
  total_tokens      INTEGER       NOT NULL DEFAULT 0,

  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  last_message_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sessions_user      ON chat_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_thinker   ON chat_sessions(thinker_id);
CREATE INDEX IF NOT EXISTS idx_sessions_domain    ON chat_sessions(primary_domain_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status    ON chat_sessions(status);


-- ═══════════════════════════════════════════════════════════════════════════
-- 10. SESSION DOMAIN TAGS
--     A session can span multiple domains with confidence scores.
--     The primary tag is what drives thinker routing.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS session_domain_tags (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID          NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  domain_id       UUID          NOT NULL REFERENCES cognitive_domains(id) ON DELETE CASCADE,
  confidence_pct  SMALLINT      NOT NULL DEFAULT 70
                                CHECK (confidence_pct BETWEEN 0 AND 100),
  is_primary      BOOLEAN       NOT NULL DEFAULT FALSE,
  tagged_by       TEXT          NOT NULL DEFAULT 'system'
                                CHECK (tagged_by IN ('system','admin','thinker','user')),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, domain_id)
);
CREATE INDEX IF NOT EXISTS idx_sdt_session ON session_domain_tags(session_id);
CREATE INDEX IF NOT EXISTS idx_sdt_domain  ON session_domain_tags(domain_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- 11. CHAT MESSAGES
--     Individual turns in a session
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS chat_messages (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID          NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role            TEXT          NOT NULL CHECK (role IN ('user','assistant','system')),
  content         TEXT          NOT NULL,
  token_count     INTEGER       NOT NULL DEFAULT 0,
  credits_cost    DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  model_used      TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON chat_messages(session_id, created_at ASC);


-- ═══════════════════════════════════════════════════════════════════════════
-- 12. THINKER ROUTING LOG
--     Immutable audit of every thinker selection decision.
--     Answers: "Why did Michael appear for this query?"
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS thinker_routing_log (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID          NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  thinker_id      UUID          NOT NULL REFERENCES thinker_profiles(id),
  selected_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- ── Domain matching detail ─────────────────────────────────────────────
  matched_domains JSONB         NOT NULL DEFAULT '[]',
  -- [{domain_slug, domain_name, thinker_level, thinker_confidence_pct}]
  routing_score   DECIMAL(5,4),  -- composite 0.0–1.0 match score

  -- ── Gating result ─────────────────────────────────────────────────────
  domain_verified BOOLEAN       NOT NULL DEFAULT FALSE,
  gate_details    JSONB         NOT NULL DEFAULT '{}',
  -- {passed: true, checked_domains: [...], verification_levels: [...]}

  selection_method TEXT         NOT NULL DEFAULT 'domain_match'
                                CHECK (selection_method IN (
                                  'domain_match',   -- auto-routed via domain tags
                                  'user_selected',  -- user explicitly chose thinker
                                  'admin_override'  -- admin forced assignment
                                ))
);
CREATE INDEX IF NOT EXISTS idx_routing_session ON thinker_routing_log(session_id);
CREATE INDEX IF NOT EXISTS idx_routing_thinker ON thinker_routing_log(thinker_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- 13. THINKER EARNINGS
--     Royalties accrued per thinker per session — the thinker-side ledger
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS thinker_earnings (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  thinker_id        UUID          NOT NULL REFERENCES thinker_profiles(id) ON DELETE CASCADE,
  session_id        UUID          REFERENCES chat_sessions(id) ON DELETE SET NULL,
  wallet_tx_id      UUID          REFERENCES wallet_transactions(id) ON DELETE SET NULL,
  domain_id         UUID          REFERENCES cognitive_domains(id) ON DELETE SET NULL,
  credits_earned    DECIMAL(12,4) NOT NULL CHECK (credits_earned > 0),
  royalty_pct       DECIMAL(5,2)  NOT NULL,  -- snapshot at time of earning
  status            TEXT          NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending','paid','held','voided')),
  earned_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  paid_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_earnings_thinker ON thinker_earnings(thinker_id, earned_at DESC);
CREATE INDEX IF NOT EXISTS idx_earnings_domain  ON thinker_earnings(domain_id);
CREATE INDEX IF NOT EXISTS idx_earnings_status  ON thinker_earnings(status);


-- ═══════════════════════════════════════════════════════════════════════════
-- 14. GUEST RATE LIMITS
--     Tracks API usage for unauthenticated (guest) users by their ephemeral
--     localStorage ID.  Allows a rolling 72-hour window check server-side
--     so guests cannot bypass the limit by clearing localStorage.
--     IP hash is stored as a secondary signal (SHA-256, first 16 hex chars).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS guest_rate_limits (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id   TEXT        NOT NULL,   -- the u_<hex> id from localStorage
  ip_hash    TEXT,                   -- truncated SHA-256 of client IP
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_grl_guest ON guest_rate_limits(guest_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_grl_ip    ON guest_rate_limits(ip_hash,  created_at DESC);

-- Auto-purge rows older than 72 hours to keep the table small.
-- Run nightly via pg_cron or a cron job:
--   DELETE FROM guest_rate_limits WHERE created_at < NOW() - INTERVAL '72 hours';


-- ═══════════════════════════════════════════════════════════════════════════
-- 15. LEGACY — conversation_contexts (v2 compat; migrate to chat_sessions)
-- ═══════════════════════════════════════════════════════════════════════════

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


-- ═══════════════════════════════════════════════════════════════════════════
-- TRIGGERS — auto-update updated_at
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_updated_at        ON users;
DROP TRIGGER IF EXISTS wallets_updated_at      ON wallets;
DROP TRIGGER IF EXISTS thinkers_updated_at     ON thinker_profiles;
DROP TRIGGER IF EXISTS sessions_updated_at     ON chat_sessions;
DROP TRIGGER IF EXISTS ctx_updated_at          ON conversation_contexts;

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER wallets_updated_at
  BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER thinkers_updated_at
  BEFORE UPDATE ON thinker_profiles FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER sessions_updated_at
  BEFORE UPDATE ON chat_sessions FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER ctx_updated_at
  BEFORE UPDATE ON conversation_contexts FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ═══════════════════════════════════════════════════════════════════════════
-- FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════

-- ── fn: wallet_credit ────────────────────────────────────────────────────
-- Safely credits a wallet and writes a ledger line item atomically.
-- Returns the new wallet_transactions row id.
CREATE OR REPLACE FUNCTION wallet_credit(
  p_wallet_id     UUID,
  p_amount        DECIMAL,
  p_type          TEXT,     -- line_item_type
  p_label         TEXT,
  p_description   TEXT      DEFAULT NULL,
  p_ref_type      TEXT      DEFAULT NULL,
  p_ref_id        UUID      DEFAULT NULL,
  p_domain_id     UUID      DEFAULT NULL,
  p_thinker_id    UUID      DEFAULT NULL
)
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE
  v_new_balance DECIMAL;
  v_tx_id       UUID;
BEGIN
  -- Lock the wallet row to prevent concurrent balance corruption
  UPDATE wallets
    SET credit_balance  = credit_balance + p_amount,
        lifetime_earned = lifetime_earned + p_amount
  WHERE id = p_wallet_id
  RETURNING credit_balance INTO v_new_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet % not found', p_wallet_id;
  END IF;

  INSERT INTO wallet_transactions (
    wallet_id, line_item_type, amount, direction, balance_after,
    label, description, ref_type, ref_id, domain_id, thinker_id
  ) VALUES (
    p_wallet_id, p_type, p_amount, 'credit', v_new_balance,
    p_label, p_description, p_ref_type, p_ref_id, p_domain_id, p_thinker_id
  ) RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$$;


-- ── fn: wallet_debit ─────────────────────────────────────────────────────
-- Safely debits a wallet. Raises if insufficient balance.
-- Returns the new wallet_transactions row id.
CREATE OR REPLACE FUNCTION wallet_debit(
  p_wallet_id     UUID,
  p_amount        DECIMAL,
  p_type          TEXT,
  p_label         TEXT,
  p_description   TEXT      DEFAULT NULL,
  p_ref_type      TEXT      DEFAULT NULL,
  p_ref_id        UUID      DEFAULT NULL,
  p_domain_id     UUID      DEFAULT NULL,
  p_thinker_id    UUID      DEFAULT NULL
)
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE
  v_new_balance DECIMAL;
  v_tx_id       UUID;
BEGIN
  UPDATE wallets
    SET credit_balance = credit_balance - p_amount,
        lifetime_spent = lifetime_spent + p_amount
  WHERE id = p_wallet_id
    AND credit_balance >= p_amount   -- atomic balance guard
  RETURNING credit_balance INTO v_new_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient balance or wallet not found: %', p_wallet_id;
  END IF;

  INSERT INTO wallet_transactions (
    wallet_id, line_item_type, amount, direction, balance_after,
    label, description, ref_type, ref_id, domain_id, thinker_id
  ) VALUES (
    p_wallet_id, p_type, p_amount, 'debit', v_new_balance,
    p_label, p_description, p_ref_type, p_ref_id, p_domain_id, p_thinker_id
  ) RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$$;


-- ── fn: get_verified_thinkers_for_domain ─────────────────────────────────
-- Returns all thinker_profiles that are verified (or expert) for a given
-- domain slug. This is the query the routing engine calls.
-- Michael Akindele only appears here if he has a row in
-- thinker_domain_verifications for that domain with is_active = TRUE.
CREATE OR REPLACE FUNCTION get_verified_thinkers_for_domain(p_domain_slug TEXT)
RETURNS TABLE (
  thinker_id    UUID,
  slug          TEXT,
  display_name  TEXT,
  level         TEXT,
  confidence    SMALLINT,
  routing_score DECIMAL
) LANGUAGE sql STABLE AS $$
  SELECT
    tp.id,
    tp.slug,
    tp.display_name,
    tdv.level,
    tdv.confidence_pct,
    -- Score: expert=1.0, verified=0.8, provisional=0.5, weighted by confidence
    ROUND(
      CASE tdv.level
        WHEN 'expert'       THEN 1.00
        WHEN 'verified'     THEN 0.80
        WHEN 'provisional'  THEN 0.50
      END * (tdv.confidence_pct / 100.0),
    4) AS routing_score
  FROM thinker_profiles tp
  JOIN thinker_domain_verifications tdv ON tdv.thinker_id = tp.id
  JOIN cognitive_domains cd             ON cd.id = tdv.domain_id
  WHERE cd.slug     = p_domain_slug
    AND tdv.is_active = TRUE
    AND (tdv.expires_at IS NULL OR tdv.expires_at > NOW())
    AND tp.status   = 'active'
  ORDER BY routing_score DESC, tp.display_name;
$$;


-- ── fn: thinker_is_verified_for_domain ───────────────────────────────────
-- Boolean gate: can this thinker appear in this domain?
-- Used server-side before routing any session.
CREATE OR REPLACE FUNCTION thinker_is_verified_for_domain(
  p_thinker_slug  TEXT,
  p_domain_slug   TEXT
)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM thinker_domain_verifications tdv
    JOIN thinker_profiles tp ON tp.id = tdv.thinker_id
    JOIN cognitive_domains cd ON cd.id = tdv.domain_id
    WHERE tp.slug   = p_thinker_slug
      AND cd.slug   = p_domain_slug
      AND tdv.is_active = TRUE
      AND tdv.level IN ('verified','expert')
      AND (tdv.expires_at IS NULL OR tdv.expires_at > NOW())
  );
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- VIEWS
-- ═══════════════════════════════════════════════════════════════════════════

-- ── v_wallet_ledger ───────────────────────────────────────────────────────
-- Full human-readable ledger per user (joins user name + domain/thinker labels)
CREATE OR REPLACE VIEW v_wallet_ledger AS
  SELECT
    wt.id,
    u.email                     AS user_email,
    u.name                      AS user_name,
    wt.line_item_type,
    wt.direction,
    wt.amount,
    wt.balance_after,
    wt.label,
    wt.description,
    cd.name                     AS domain_name,
    tp.display_name             AS thinker_name,
    wt.ref_type,
    wt.ref_id,
    wt.created_at
  FROM wallet_transactions wt
  JOIN wallets w              ON w.id = wt.wallet_id
  JOIN users u                ON u.id = w.user_id
  LEFT JOIN cognitive_domains cd ON cd.id = wt.domain_id
  LEFT JOIN thinker_profiles tp  ON tp.id = wt.thinker_id
  ORDER BY wt.created_at DESC;


-- ── v_thinker_roster ─────────────────────────────────────────────────────
-- Active thinkers with their verified domain list (for admin + routing UI)
CREATE OR REPLACE VIEW v_thinker_roster AS
  SELECT
    tp.id,
    tp.slug,
    tp.display_name,
    tp.title,
    tp.status,
    tp.royalty_pct,
    COUNT(tdv.id) FILTER (WHERE tdv.is_active)  AS active_domain_count,
    JSON_AGG(
      JSON_BUILD_OBJECT(
        'domain_slug',  cd.slug,
        'domain_name',  cd.name,
        'level',        tdv.level,
        'confidence',   tdv.confidence_pct,
        'verified_at',  tdv.verified_at
      )
    ) FILTER (WHERE tdv.is_active)               AS verified_domains,
    SUM(te.credits_earned)                        AS lifetime_earnings,
    tp.created_at
  FROM thinker_profiles tp
  LEFT JOIN thinker_domain_verifications tdv ON tdv.thinker_id = tp.id
  LEFT JOIN cognitive_domains cd             ON cd.id = tdv.domain_id
  LEFT JOIN thinker_earnings te             ON te.thinker_id = tp.id
  GROUP BY tp.id, tp.slug, tp.display_name, tp.title, tp.status, tp.royalty_pct, tp.created_at
  ORDER BY tp.display_name;


-- ── v_domain_thinker_coverage ─────────────────────────────────────────────
-- Which domains have verified thinkers, and how many
CREATE OR REPLACE VIEW v_domain_thinker_coverage AS
  SELECT
    cd.id,
    cd.slug,
    cd.name,
    cd.color,
    COUNT(tdv.id) FILTER (WHERE tdv.is_active AND tdv.level = 'expert')    AS expert_count,
    COUNT(tdv.id) FILTER (WHERE tdv.is_active AND tdv.level = 'verified')  AS verified_count,
    COUNT(tdv.id) FILTER (WHERE tdv.is_active AND tdv.level = 'provisional') AS provisional_count,
    COUNT(tdv.id) FILTER (WHERE tdv.is_active)                             AS total_thinkers,
    BOOL_OR(tdv.is_active AND tdv.level IN ('verified','expert'))          AS has_verified_thinker
  FROM cognitive_domains cd
  LEFT JOIN thinker_domain_verifications tdv ON tdv.domain_id = cd.id
  WHERE cd.is_active = TRUE
  GROUP BY cd.id, cd.slug, cd.name, cd.color
  ORDER BY total_thinkers DESC, cd.name;


-- ═══════════════════════════════════════════════════════════════════════════
-- 16. STRIPE EVENT LOG — idempotency guard for webhook replays
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS stripe_events (
  event_id    TEXT        PRIMARY KEY,   -- Stripe evt_xxx id — globally unique
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Auto-purge rows older than 90 days:
--   DELETE FROM stripe_events WHERE created_at < NOW() - INTERVAL '90 days';
