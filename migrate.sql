-- ═══════════════════════════════════════════════════════════════════════════
-- Divine Intelligence — Database Migration
-- Run once against the live DB:  psql $DATABASE_URL -f migrate.sql
--
-- What this fixes:
--   The live wallet_transactions table was created with user_id / type /
--   direction columns (old schema). The app now expects:
--     wallet_id       UUID  FK → wallets(id)
--     line_item_type  TEXT  CHECK (...)
--     direction       TEXT  CHECK ('credit' | 'debit')
--
--   This migration adds the missing columns, back-fills them, and creates
--   the indexes the app relies on.  All steps are idempotent (safe to re-run).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Add wallet_id if missing ───────────────────────────────────────────────
ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS wallet_id UUID REFERENCES wallets(id) ON DELETE CASCADE;

-- Back-fill from wallets (old rows used user_id directly on the tx table)
UPDATE wallet_transactions wt
SET    wallet_id = w.id
FROM   wallets w
WHERE  w.user_id = wt.user_id   -- old column; may not exist — see step below
  AND  wt.wallet_id IS NULL;

-- After back-fill, require the column (skip if already NOT NULL)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE  table_name = 'wallet_transactions'
      AND  column_name = 'wallet_id'
      AND  is_nullable = 'YES'
  ) THEN
    -- Only set NOT NULL if every row is now populated
    IF NOT EXISTS (SELECT 1 FROM wallet_transactions WHERE wallet_id IS NULL) THEN
      ALTER TABLE wallet_transactions ALTER COLUMN wallet_id SET NOT NULL;
    END IF;
  END IF;
END $$;

-- ── 2. Add line_item_type if missing (old schema used "type") ─────────────────
ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS line_item_type TEXT;

-- Back-fill: map old "type" values → new line_item_type values
UPDATE wallet_transactions
SET    line_item_type = CASE
         WHEN type = 'credit' THEN 'topup'
         WHEN type = 'debit'  THEN 'perspective_spend'
         ELSE type
       END
WHERE  line_item_type IS NULL
  AND  type IS NOT NULL;

-- Default any remaining nulls
UPDATE wallet_transactions
SET    line_item_type = 'perspective_spend'
WHERE  line_item_type IS NULL;

-- Add CHECK constraint if not already present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE  conname = 'wallet_transactions_line_item_type_check'
      AND  conrelid = 'wallet_transactions'::regclass
  ) THEN
    ALTER TABLE wallet_transactions
      ADD CONSTRAINT wallet_transactions_line_item_type_check
      CHECK (line_item_type IN (
        'topup','perspective_spend','thinker_royalty',
        'refund','bonus','admin_adjustment','expiry'
      ));
  END IF;
END $$;

-- ── 3. Add direction if missing (old schema stored 'credit'/'debit' in type) ──
ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS direction TEXT;

-- Back-fill from old type column if it exists
UPDATE wallet_transactions
SET    direction = CASE
         WHEN type = 'credit' THEN 'credit'
         ELSE 'debit'
       END
WHERE  direction IS NULL
  AND  type IS NOT NULL;

-- Default any remaining nulls to debit
UPDATE wallet_transactions
SET    direction = 'debit'
WHERE  direction IS NULL;

-- Add CHECK constraint if not already present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE  conname = 'wallet_transactions_direction_check'
      AND  conrelid = 'wallet_transactions'::regclass
  ) THEN
    ALTER TABLE wallet_transactions
      ADD CONSTRAINT wallet_transactions_direction_check
      CHECK (direction IN ('credit', 'debit'));
  END IF;
END $$;

-- Make direction NOT NULL once all rows are populated
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE  table_name = 'wallet_transactions'
      AND  column_name = 'direction'
      AND  is_nullable = 'YES'
  ) THEN
    IF NOT EXISTS (SELECT 1 FROM wallet_transactions WHERE direction IS NULL) THEN
      ALTER TABLE wallet_transactions ALTER COLUMN direction SET NOT NULL;
    END IF;
  END IF;
END $$;

-- ── 4. Ensure balance_after column exists ─────────────────────────────────────
ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS balance_after DECIMAL(12,4);

UPDATE wallet_transactions
SET    balance_after = 0
WHERE  balance_after IS NULL;

-- ── 5. Ensure label column exists ────────────────────────────────────────────
ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS label TEXT;

UPDATE wallet_transactions
SET    label = 'Migrated transaction'
WHERE  label IS NULL;

-- ── 6. Indexes ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_wt_wallet
  ON wallet_transactions(wallet_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wt_type
  ON wallet_transactions(line_item_type);

COMMIT;

-- Done. Verify with:
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'wallet_transactions'
--   ORDER BY ordinal_position;
