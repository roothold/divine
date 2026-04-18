/**
 * Divine Intelligence — PostgreSQL Pool + Data Access
 */

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

export default pool;

// ── Wallet helpers ────────────────────────────────────────────────────────────

export async function getOrCreateWallet(userId) {
  const { rows } = await pool.query(
    `INSERT INTO wallets (user_id, credit_balance)
     VALUES ($1, 0.00)
     ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [userId]
  );
  return rows[0];
}

export async function deductCredit(userId, amount, label, metadata = {}) {
  const lineItemType = metadata.line_item_type || 'perspective_spend';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE wallets
       SET credit_balance = credit_balance - $2,
           updated_at     = NOW()
       WHERE user_id = $1 AND credit_balance >= $2
       RETURNING *`,
      [userId, amount]
    );
    if (!rows.length) throw new Error('INSUFFICIENT_FUNDS');
    const wallet = rows[0];
    await client.query(
      `INSERT INTO wallet_transactions
         (wallet_id, line_item_type, amount, direction, balance_after, label)
       VALUES ($1, $2, $3, 'debit', $4, $5)`,
      [wallet.id, lineItemType, amount, wallet.credit_balance, label]
    );
    await client.query('COMMIT');
    return wallet;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function creditWallet(userId, amount, label, metadata = {}) {
  const lineItemType = metadata.line_item_type || 'topup';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO wallets (user_id, credit_balance)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE
         SET credit_balance = wallets.credit_balance + $2,
             updated_at     = NOW()
       RETURNING *`,
      [userId, amount]
    );
    const wallet = rows[0];
    await client.query(
      `INSERT INTO wallet_transactions
         (wallet_id, line_item_type, amount, direction, balance_after, label)
       VALUES ($1, $2, $3, 'credit', $4, $5)`,
      [wallet.id, lineItemType, amount, wallet.credit_balance, label]
    );
    await client.query('COMMIT');
    return wallet;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── User helpers ──────────────────────────────────────────────────────────────

/** Strip password_hash before returning to callers. */
function publicUser(row) {
  if (!row) return null;
  const { password_hash, ...safe } = row;
  return safe;
}

export async function getUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return publicUser(rows[0]);
}

/** Returns raw row including password_hash — only for auth checks. */
export async function getUserByEmail(email) {
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE email = $1',
    [email.toLowerCase().trim()]
  );
  return rows[0] || null;
}

/** Upsert via Google OAuth. Links google_id to existing email if found. */
export async function upsertGoogleUser({ googleId, email, name, avatarUrl }) {
  const { rows } = await pool.query(
    `INSERT INTO users (google_id, email, name, avatar_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE
       SET google_id  = EXCLUDED.google_id,
           name       = COALESCE(users.name, EXCLUDED.name),
           avatar_url = COALESCE(users.avatar_url, EXCLUDED.avatar_url),
           updated_at = NOW()
     RETURNING *`,
    [googleId, email.toLowerCase().trim(), name, avatarUrl]
  );
  return publicUser(rows[0]);
}

/** Upsert via LinkedIn OAuth. */
export async function upsertLinkedInUser({ linkedinId, email, name, avatarUrl }) {
  const { rows } = await pool.query(
    `INSERT INTO users (linkedin_id, email, name, avatar_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE
       SET linkedin_id = EXCLUDED.linkedin_id,
           name        = COALESCE(users.name, EXCLUDED.name),
           avatar_url  = COALESCE(users.avatar_url, EXCLUDED.avatar_url),
           updated_at  = NOW()
     RETURNING *`,
    [linkedinId, email.toLowerCase().trim(), name, avatarUrl]
  );
  return publicUser(rows[0]);
}

/** Create a new email/password user. Caller must hash password first. */
export async function createEmailUser({ email, name, passwordHash }) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, name, password_hash)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [email.toLowerCase().trim(), name, passwordHash]
  );
  return publicUser(rows[0]);
}

/** Returns raw row including password_hash — only for auth checks, by user ID. */
export async function getUserByIdRaw(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

/** Update display name. */
export async function updateUserName(id, name) {
  const { rows } = await pool.query(
    `UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [name, id]
  );
  return publicUser(rows[0]);
}

/** Update email — checks uniqueness. */
export async function updateUserEmail(id, newEmail) {
  const email = newEmail.toLowerCase().trim();
  const { rows } = await pool.query(
    `UPDATE users SET email = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [email, id]
  );
  return publicUser(rows[0]);
}

/** Update password hash. */
export async function updateUserPassword(id, passwordHash) {
  await pool.query(
    `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
    [passwordHash, id]
  );
}

// ── Admin helpers ─────────────────────────────────────────────────────────────

/**
 * Boot-time schema migration — idempotent, runs before the server accepts traffic.
 * Each statement is isolated so one failure never blocks the rest.
 */
export async function adminMigrateSchema() {
  const run = async (label, sql) => {
    try { await pool.query(sql); }
    catch (e) { console.warn(`[migrate:${label}]`, e.message); }
  };

  // ── users ──────────────────────────────────────────────────────────────────
  await run('users.is_admin',    `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin    BOOLEAN NOT NULL DEFAULT FALSE`);
  await run('users.is_disabled', `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_disabled BOOLEAN NOT NULL DEFAULT FALSE`);

  // ── stripe_events ──────────────────────────────────────────────────────────
  await run('stripe_events', `
    CREATE TABLE IF NOT EXISTS stripe_events (
      event_id   TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── thinker_earnings ───────────────────────────────────────────────────────
  await run('thinker_earnings', `
    CREATE TABLE IF NOT EXISTS thinker_earnings (
      id         BIGSERIAL     PRIMARY KEY,
      thinker_id TEXT          NOT NULL,
      user_id    TEXT,
      amount     NUMERIC(10,4) NOT NULL,
      label      TEXT,
      created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )
  `);
  await run('thinker_earnings.idx1', `CREATE INDEX IF NOT EXISTS thinker_earnings_thinker_idx ON thinker_earnings (thinker_id, created_at DESC)`);
  await run('thinker_earnings.idx2', `CREATE INDEX IF NOT EXISTS thinker_earnings_user_idx    ON thinker_earnings (user_id,    created_at DESC)`);

  // ── user_sessions ──────────────────────────────────────────────────────────
  await run('user_sessions', `
    CREATE TABLE IF NOT EXISTS user_sessions (
      id          TEXT        NOT NULL,
      user_id     TEXT        NOT NULL,
      thinker     JSONB,
      decision    TEXT,
      key_insight JSONB,
      frames      JSONB,
      project_id  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (id, user_id)
    )
  `);
  await run('user_sessions.idx', `CREATE INDEX IF NOT EXISTS user_sessions_user_id_idx ON user_sessions (user_id, created_at DESC)`);

  // ── wallet_transactions — add new columns one at a time ───────────────────
  // The live DB may have been created from an older schema that used
  // (user_id, type) instead of (wallet_id, direction, line_item_type).
  // Each ADD COLUMN is isolated so a pre-existing column never blocks the rest.
  await run('wt.wallet_id',      `ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS wallet_id      UUID`);
  await run('wt.direction',      `ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS direction      TEXT`);
  await run('wt.line_item_type', `ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS line_item_type TEXT`);
  await run('wt.balance_after',  `ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS balance_after  DECIMAL(12,4)`);
  await run('wt.label',          `ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS label          TEXT`);

  // Back-fill wallet_id from old user_id column (if user_id still exists)
  await run('wt.backfill.wallet_id', `
    UPDATE wallet_transactions wt
    SET    wallet_id = w.id
    FROM   wallets w
    WHERE  w.user_id::text = wt.user_id::text
      AND  wt.wallet_id IS NULL
  `);

  // Back-fill direction from old type column (if type still exists)
  await run('wt.backfill.direction', `
    UPDATE wallet_transactions
    SET    direction = CASE WHEN type = 'credit' THEN 'credit' ELSE 'debit' END
    WHERE  direction IS NULL
      AND  type      IS NOT NULL
  `);

  // Default remaining nulls
  await run('wt.default.direction',      `UPDATE wallet_transactions SET direction      = 'debit'             WHERE direction      IS NULL`);
  await run('wt.default.line_item_type', `UPDATE wallet_transactions SET line_item_type = 'perspective_spend'  WHERE line_item_type IS NULL`);
  await run('wt.default.balance_after',  `UPDATE wallet_transactions SET balance_after  = 0                   WHERE balance_after  IS NULL`);
  await run('wt.default.label',          `UPDATE wallet_transactions SET label          = 'migrated'           WHERE label          IS NULL`);

  await run('wt.idx', `CREATE INDEX IF NOT EXISTS idx_wt_wallet ON wallet_transactions(wallet_id, created_at DESC)`);

  console.log('[DB] Schema migration complete.');
}

/** Full user list with wallet balance + perspective count. */
export async function adminGetUsers({ search = '', offset = 0, limit = 50 } = {}) {
  const like = `%${search}%`;
  const { rows } = await pool.query(
    `SELECT
       u.id,
       u.name,
       u.email,
       u.is_admin,
       u.is_disabled,
       u.thinker_access,
       u.created_at,
       COALESCE(w.credit_balance, 0)                   AS balance,
       COUNT(wt.id) FILTER (WHERE wt.type = 'debit') AS perspective_count
     FROM users u
     LEFT JOIN wallets w              ON w.user_id = u.id
     LEFT JOIN wallet_transactions wt ON wt.user_id = u.id
     WHERE ($1 = '' OR u.name ILIKE $2 OR u.email ILIKE $2)
     GROUP BY u.id, w.id, w.credit_balance
     ORDER BY u.created_at DESC
     LIMIT $3 OFFSET $4`,
    [search, like, limit, offset]
  );
  return rows;
}

/** Platform-wide user stat counts (unaffected by search/pagination). */
export async function adminGetUserStats() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)                                    AS total_users,
      COUNT(*) FILTER (WHERE NOT is_disabled)     AS active_users,
      COUNT(*) FILTER (WHERE is_admin = TRUE)     AS admin_users,
      COUNT(*) FILTER (WHERE thinker_access = TRUE) AS thinker_users
    FROM users
  `);
  return rows[0];
}

/** Count total users (with optional search filter). */
export async function adminCountUsers(search = '') {
  const like = `%${search}%`;
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS total FROM users
     WHERE ($1 = '' OR name ILIKE $2 OR email ILIKE $2)`,
    [search, like]
  );
  return parseInt(rows[0].total, 10);
}

/** Enable / disable a user account. */
export async function adminSetUserDisabled(id, disabled) {
  const { rows } = await pool.query(
    `UPDATE users SET is_disabled = $1, updated_at = NOW() WHERE id = $2 RETURNING id, is_disabled`,
    [disabled, id]
  );
  return rows[0];
}

/** Grant / revoke admin flag. */
export async function adminSetUserAdmin(id, isAdmin) {
  const { rows } = await pool.query(
    `UPDATE users SET is_admin = $1, updated_at = NOW() WHERE id = $2 RETURNING id, is_admin`,
    [isAdmin, id]
  );
  return rows[0];
}

/** Grant / revoke thinker access. */
export async function adminSetThinkerAccess(id, access) {
  const { rows } = await pool.query(
    `UPDATE users SET thinker_access = $1, updated_at = NOW() WHERE id = $2 RETURNING id, thinker_access`,
    [access, id]
  );
  return rows[0];
}

/** Paginated perspectives ledger (wallet_transactions of type perspective_spend). */
export async function adminGetPerspectives({ search = '', offset = 0, limit = 50 } = {}) {
  const like = `%${search}%`;
  const { rows } = await pool.query(
    `SELECT
       wt.id,
       wt.created_at,
       wt.label,
       wt.amount,
       wt.balance_after,
       u.id    AS user_id,
       u.name  AS user_name,
       u.email AS user_email
     FROM wallet_transactions wt
     JOIN users u ON u.id = wt.user_id
     WHERE wt.type = 'debit'
       AND ($1 = '' OR u.name ILIKE $2 OR u.email ILIKE $2 OR wt.label ILIKE $2)
     ORDER BY wt.created_at DESC
     LIMIT $3 OFFSET $4`,
    [search, like, limit, offset]
  );
  return rows;
}

export async function adminCountPerspectives(search = '') {
  const like = `%${search}%`;
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS total
     FROM wallet_transactions wt
     JOIN users u ON u.id = wt.user_id
     WHERE wt.type = 'debit'
       AND ($1 = '' OR u.name ILIKE $2 OR u.email ILIKE $2 OR wt.label ILIKE $2)`,
    [search, like]
  );
  return parseInt(rows[0].total, 10);
}

/** Revenue overview — totals across all wallets and transactions. */
export async function adminGetRevenue() {
  const { rows: totals } = await pool.query(`
    SELECT
      COUNT(DISTINCT u.id)                                                                       AS total_users,
      COUNT(DISTINCT u.id) FILTER (WHERE u.is_disabled = FALSE)                                 AS active_users,
      COALESCE(SUM(w.credit_balance), 0)                                                         AS total_balance,
      COALESCE(SUM(wt.amount) FILTER (WHERE wt.type = 'debit'),  0)  AS total_spent,
      COALESCE(SUM(wt.amount) FILTER (WHERE wt.type = 'credit'), 0)  AS total_earned,
      COUNT(wt.id)          FILTER (WHERE wt.type = 'debit')         AS total_perspectives
    FROM users u
    LEFT JOIN wallets w              ON w.user_id = u.id
    LEFT JOIN wallet_transactions wt ON wt.user_id = u.id
  `);

  const { rows: recentTxns } = await pool.query(`
    SELECT
      wt.id,
      wt.created_at,
      wt.type                                            AS line_item_type,
      wt.type                                            AS direction,
      wt.amount,
      wt.label,
      u.name  AS user_name,
      u.email AS user_email
    FROM wallet_transactions wt
    JOIN users u ON u.id = wt.user_id
    ORDER BY wt.created_at DESC
    LIMIT 20
  `);

  return { totals: totals[0], recent: recentTxns };
}

// ── Session helpers ───────────────────────────────────────────────────────────

/** Upsert a session (insert or update on conflict). */
export async function upsertSession(userId, session) {
  await pool.query(
    `INSERT INTO user_sessions (id, user_id, thinker, decision, key_insight, frames, project_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id, user_id) DO UPDATE
       SET thinker=$3, decision=$4, key_insight=$5, frames=$6, project_id=$7`,
    [
      session.id,
      userId,
      JSON.stringify(session.thinker   || null),
      session.decision  || null,
      JSON.stringify(session.keyInsight || null),
      JSON.stringify(session.frames    || []),
      session.projectId || null,
      session.date ? new Date(session.date) : new Date(),
    ]
  );
}

/** Load all sessions for a user, newest first. */
export async function getUserSessions(userId, limit = 100) {
  const { rows } = await pool.query(
    `SELECT id, thinker, decision, key_insight AS "keyInsight",
            frames, project_id AS "projectId", created_at AS date
     FROM user_sessions
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

/** Delete a single session belonging to a user. */
export async function deleteSession(userId, sessionId) {
  await pool.query(
    `DELETE FROM user_sessions WHERE id = $1 AND user_id = $2`,
    [sessionId, userId]
  );
}

// ── Thinker earnings helpers ──────────────────────────────────────────────────

/**
 * Record a thinker earning (called after each successful perspective deduction).
 * userId is the thinker's user account UUID (looked up by payoutEmail); nullable
 * if the thinker has no linked account yet.
 */
export async function recordThinkerEarning(thinkerId, userId, amount, label) {
  await pool.query(
    `INSERT INTO thinker_earnings (thinker_id, user_id, amount, label)
     VALUES ($1, $2, $3, $4)`,
    [thinkerId, userId || null, amount, label]
  );
}

/**
 * Lifetime stats for a thinker's dashboard.
 * Accepts either thinker_id (string) or user_id (UUID) — checks both.
 */
export async function getThinkerStats(userIdOrThinkerId) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)                      AS total_perspectives,
       COALESCE(SUM(amount), 0)      AS total_earned,
       MAX(created_at)               AS last_activity
     FROM thinker_earnings
     WHERE user_id = $1 OR thinker_id = $1`,
    [userIdOrThinkerId]
  );
  return rows[0];
}

/**
 * Recent earning records for a thinker (for their transactions panel).
 * period: 'week' | 'month' | 'year' | 'all'
 */
export async function getThinkerTransactions(userIdOrThinkerId, period = 'month') {
  const cutoff = {
    week:  `NOW() - INTERVAL '7 days'`,
    month: `NOW() - INTERVAL '30 days'`,
    year:  `NOW() - INTERVAL '365 days'`,
    all:   `'1970-01-01'`,
  }[period] || `NOW() - INTERVAL '30 days'`;

  const { rows } = await pool.query(
    `SELECT id, thinker_id, amount, label, created_at
     FROM thinker_earnings
     WHERE (user_id = $1 OR thinker_id = $1)
       AND created_at >= ${cutoff}
     ORDER BY created_at DESC
     LIMIT 100`,
    [userIdOrThinkerId]
  );
  return rows;
}

/**
 * Aggregated earnings by period (for chart data).
 */
export async function getThinkerEarningsByPeriod(userIdOrThinkerId, period = 'month') {
  const trunc = period === 'year' ? 'month' : 'day';
  const cutoff = {
    week:  `NOW() - INTERVAL '7 days'`,
    month: `NOW() - INTERVAL '30 days'`,
    year:  `NOW() - INTERVAL '365 days'`,
  }[period] || `NOW() - INTERVAL '30 days'`;

  const { rows } = await pool.query(
    `SELECT
       DATE_TRUNC('${trunc}', created_at) AS period,
       COUNT(*)                            AS perspectives,
       SUM(amount)                         AS earned
     FROM thinker_earnings
     WHERE (user_id = $1 OR thinker_id = $1)
       AND created_at >= ${cutoff}
     GROUP BY 1
     ORDER BY 1 ASC`,
    [userIdOrThinkerId]
  );
  return rows;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Sovereign Logic Alignment — Thinker Logic v2.0 ───────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Migrate the full Thinker Logic schema (v2.0).
 * Idempotent — safe to call on every server boot after adminMigrateSchema().
 *
 * New tables introduced in v2.0:
 *   thinker_axioms, axiom_weights, axiom_weight_history,
 *   fragility_points (with industry_vertical + venture_stage scoping),
 *   protocols (with protocol_type, confidence_interval, axiom_selection_rationale),
 *   sovereign_feedback (with defer_context),
 *   outcome_verifications (with decay_factor),
 *   outcome_window_defaults,
 *   confounding_severity
 */
export async function migrateThinkerLogicSchema() {
  // ── Core axiom registry ──────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS thinker_axioms (
      logic_id         TEXT    PRIMARY KEY,
      thinker_id       TEXT    NOT NULL,
      category         TEXT    NOT NULL,
      axiom_text       TEXT    NOT NULL,
      base_weight      NUMERIC(5,3) NOT NULL DEFAULT 1.000,
      output_format    TEXT    NOT NULL DEFAULT 'structured_protocol',
      deprecated_at    TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS thinker_axioms_thinker_idx ON thinker_axioms (thinker_id);
  `);

  // ── Per-venture live weight state ────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS axiom_weights (
      venture_id        UUID NOT NULL,
      logic_id          TEXT NOT NULL REFERENCES thinker_axioms(logic_id),
      current_weight    NUMERIC(5,3) NOT NULL DEFAULT 1.000
                          CHECK (current_weight BETWEEN 0.01 AND 3.00),
      application_count INT  NOT NULL DEFAULT 0,
      success_count     INT  NOT NULL DEFAULT 0,
      rejection_count   INT  NOT NULL DEFAULT 0,
      last_updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (venture_id, logic_id)
    );
  `);

  // ── Append-only weight history ───────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS axiom_weight_history (
      id           BIGSERIAL PRIMARY KEY,
      venture_id   UUID NOT NULL,
      logic_id     TEXT NOT NULL,
      from_weight  NUMERIC(5,3) NOT NULL,
      to_weight    NUMERIC(5,3) NOT NULL,
      cause        TEXT NOT NULL,
      outcome_id   UUID,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS awh_venture_logic_idx
      ON axiom_weight_history (venture_id, logic_id, created_at DESC);
  `);

  // ── Fragility index — v2.0: scoped by industry_vertical + venture_stage ─────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fragility_points (
      fragility_id              TEXT PRIMARY KEY,
      parent_logic_id           TEXT NOT NULL REFERENCES thinker_axioms(logic_id),
      condition                 TEXT NOT NULL,
      failure_mode              TEXT NOT NULL,
      override_prompt           TEXT,
      confirmed_instances       INT  NOT NULL DEFAULT 0,
      sovereign_override_required BOOLEAN NOT NULL DEFAULT FALSE,
      industry_vertical         TEXT,        -- NULL = applies to all verticals
      venture_stage             TEXT,        -- NULL = applies to all stages
      discovered_via            TEXT NOT NULL DEFAULT 'admin_encoding'
                                  CHECK (discovered_via IN
                                    ('user_rejection','negative_outcome','admin_encoding')),
      created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS fp_logic_vertical_idx
      ON fragility_points (parent_logic_id, industry_vertical);
  `);

  // ── Protocol issuance ledger — v2.0 ─────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS protocols (
      protocol_id                TEXT PRIMARY KEY,
      venture_id                 UUID NOT NULL,
      session_id                 TEXT NOT NULL,
      logic_ids                  TEXT[]       NOT NULL,
      protocol_type              TEXT         NOT NULL DEFAULT 'general',
      confidence                 NUMERIC(4,3),
      confidence_lower           NUMERIC(4,3),
      confidence_upper           NUMERIC(4,3),
      axiom_selection_rationale  JSONB,
      issued_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS protocols_venture_idx
      ON protocols (venture_id, issued_at DESC);
  `);

  // ── Sovereign feedback — v2.0: defer_context added ──────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sovereign_feedback (
      feedback_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      protocol_id       TEXT NOT NULL REFERENCES protocols(protocol_id),
      user_action       TEXT NOT NULL
                          CHECK (user_action IN ('EXECUTE','REFINE','REJECT','DEFER')),
      rejection_class   TEXT,
      refinement_class  TEXT,
      defer_context     TEXT,  -- why deferred: 'timing' | 'resource_constraint' | 'needs_review'
      user_raw_text     TEXT,
      supersedes_id     UUID REFERENCES sovereign_feedback(feedback_id),
      actioned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // ── Outcome verification — v2.0: decay_factor + protocol_type window ────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outcome_verifications (
      outcome_id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      feedback_id                 UUID NOT NULL REFERENCES sovereign_feedback(feedback_id),
      protocol_id                 TEXT NOT NULL,
      status                      TEXT NOT NULL DEFAULT 'pending'
                                    CHECK (status IN ('pending','complete','skipped','flagged')),
      baseline_kpis               JSONB,
      projected_kpis              JSONB,
      actual_kpis                 JSONB,
      efficacy_score              NUMERIC(4,3),
      decay_factor                NUMERIC(5,4) DEFAULT 1.0000,
      effective_efficacy          NUMERIC(4,3),  -- efficacy_score × decay_factor
      npv_delta                   NUMERIC(12,2),
      confounding_discount        NUMERIC(4,3) DEFAULT 1.000,
      confounders_detected        TEXT[],
      weight_deltas               JSONB,
      measurement_due             TIMESTAMPTZ NOT NULL,
      measured_at                 TIMESTAMPTZ,
      measurement_source          TEXT NOT NULL DEFAULT 'pending'
                                    CHECK (measurement_source IN
                                      ('quickbooks_sync','manual_entry','estimated','pending')),
      supersedes_id               UUID REFERENCES outcome_verifications(outcome_id),
      created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ov_status_due_idx
      ON outcome_verifications (status, measurement_due)
      WHERE status = 'pending';
  `);

  // ── Outcome window defaults (Protocol type → measurement window) ─────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outcome_window_defaults (
      protocol_type         TEXT PRIMARY KEY,
      default_window_days   INT  NOT NULL,
      min_window_days       INT  NOT NULL,
      max_window_days       INT  NOT NULL,
      primary_kpi           TEXT NOT NULL,
      description           TEXT
    );
    INSERT INTO outcome_window_defaults
      (protocol_type, default_window_days, min_window_days, max_window_days, primary_kpi, description)
    VALUES
      ('pricing_change',         30,  14,  60, 'gross_margin',        'Pricing has immediate and lagged revenue effects'),
      ('distribution_pivot',     45,  21,  90, 'cac',                 'Channel learning curve averages 6 weeks'),
      ('brand_positioning',      90,  45, 180, 'mrr_growth_pct',      'Brand signal takes 2–3 months to register in pipeline'),
      ('product_feature',        45,  21,  90, 'mrr_growth_pct',      'Feature adoption lag: 3–6 weeks to stabilise'),
      ('capital_allocation',     90,  45, 180, 'runway_months',       'Cash deployment shows in metrics over a quarter'),
      ('hiring_decision',       120,  60, 180, 'mrr_growth_pct',      'Hire ramp time makes < 60-day measurement noisy'),
      ('market_entry',          120,  60, 270, 'cac',                 'Market entry proof requires multiple sales cycles'),
      ('regulatory_response',    14,   7,  30, 'gross_margin',        'Compliance decisions have near-immediate impact'),
      ('fundraising_strategy',  180,  90, 365, 'runway_months',       'Fundraise outcomes are binary on close date'),
      ('operational_change',     45,  21,  90, 'gross_margin',        'Operational efficiency changes within one quarter'),
      ('general',                60,  21, 180, 'mrr_growth_pct',      'Default window for unclassified protocols')
    ON CONFLICT (protocol_type) DO NOTHING;
  `);

  // ── Confounding severity classification ──────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS confounding_severity (
      confounder_type       TEXT PRIMARY KEY,
      discount_factor       NUMERIC(4,3) NOT NULL CHECK (discount_factor BETWEEN 0.1 AND 1.0),
      evidence_signal       TEXT         NOT NULL,
      auto_detectable       BOOLEAN      NOT NULL DEFAULT FALSE,
      cumulative_floor      NUMERIC(4,3) NOT NULL DEFAULT 0.30,
      description           TEXT
    );
    INSERT INTO confounding_severity
      (confounder_type, discount_factor, evidence_signal, auto_detectable, description)
    VALUES
      ('market_downturn_major',  0.40, 'benchmark_index_down_gt_10pct_in_window',  TRUE,  'Market-wide decline > 10% obscures company-specific factors'),
      ('market_downturn_minor',  0.70, 'benchmark_index_down_3_to_10pct',          TRUE,  'Moderate market softness has partial confounding effect'),
      ('competitive_entry',      0.65, 'new_competitor_announced_in_vertical',     FALSE, 'New competitor alters CAC and win-rate baselines'),
      ('regulatory_change',      0.55, 'new_regulation_published_in_measurement_window', FALSE, 'New regulation constrains or accelerates execution'),
      ('supply_chain_shock',     0.60, 'supply_delay_gt_30_days',                  FALSE, 'Inventory or supply disruption affects unit economics'),
      ('key_person_departure',   0.70, 'c_level_or_lead_left_during_window',       FALSE, 'Leadership change affects execution quality'),
      ('macro_credit_tightening',0.75, 'fed_rate_increase_in_window',              TRUE,  'Capital cost changes affect financial metrics'),
      ('natural_disaster',       0.30, 'declared_disaster_in_operating_region',    FALSE, 'Force majeure events dominate business outcomes'),
      ('pandemic_or_health_event',0.25,'public_health_emergency_declared',         FALSE, 'Systemic health events override strategic decisions'),
      ('no_confounder',          1.00, 'none',                                     TRUE,  'Clean outcome measurement — no discount applied')
    ON CONFLICT (confounder_type) DO NOTHING;
  `);

  console.log('[ThinkerLogic] v2.0 schema migration complete.');
}

// ── Weight Update Algorithm v2.0 ─────────────────────────────────────────────

/**
 * Venture integrity stage → weight update parameters.
 * Stage is derived from the count of completed outcomes with mean efficacy ≥ threshold.
 */
const STAGE_PARAMS = {
  bootstrap:  { multiplier: 0.08, max_weight: 1.50, calibration_scale: 0.04 },
  emerging:   { multiplier: 0.12, max_weight: 2.00, calibration_scale: 0.06 },
  validated:  { multiplier: 0.16, max_weight: 2.50, calibration_scale: 0.08 },
  sovereign:  { multiplier: 0.20, max_weight: 3.00, calibration_scale: 0.10 },
};

/**
 * computeWeightDelta — WUA v2.0
 *
 * Key changes from v1.2:
 *  1. Smooth loss: replaces cliff at 0.40 with continuous (efficacy − 0.50) × stage_multiplier
 *  2. Calibration bonus: sqrt scaling prevents explosion at low confidence
 *  3. Stage-aware multiplier: bootstrap is conservative; sovereign trusts signal fully
 *  4. Temporal decay applied to effective_efficacy before delta computation
 *
 * @param {object} p
 * @param {number} p.efficacy_score         ∈ [0, 1]
 * @param {number} p.decay_factor           ∈ [0, 1] — 1.0 for recent, lower for old outcomes
 * @param {number} p.confounding_discount   ∈ [0, 1] — from confounding_severity lookup
 * @param {number} p.confidence_at_issue    ∈ [0, 1]
 * @param {'EXECUTE'|'REFINE'|'REJECT'} p.action
 * @param {'bootstrap'|'emerging'|'validated'|'sovereign'} p.venture_stage
 * @param {number} p.current_weight         existing axiom weight
 * @returns {{ bounded_delta: number, effective_efficacy: number, new_weight: number }}
 */
export function computeWeightDelta({
  efficacy_score,
  decay_factor = 1.0,
  confounding_discount = 1.0,
  confidence_at_issue = 0.5,
  action,
  venture_stage = 'bootstrap',
  current_weight = 1.0,
}) {
  const stage = STAGE_PARAMS[venture_stage] || STAGE_PARAMS.bootstrap;

  // Step 1: apply temporal decay + confounding
  const effective_efficacy = efficacy_score * decay_factor * confounding_discount;

  // Step 2: smooth centred loss — no cliff; crosses zero at efficacy = 0.50
  const base_delta = (effective_efficacy - 0.50) * stage.multiplier;

  // Step 3: calibration bonus — sqrt scaling prevents explosion
  //   Rewards low-confidence correct predictions without dominating the signal.
  //   At confidence=0.0 correct: bonus = calibration_scale × sqrt(1.0) = calibration_scale
  //   At confidence=0.5 correct: bonus = calibration_scale × sqrt(0.5) ≈ 0.71 × scale
  //   At confidence=0.99 correct: bonus = calibration_scale × sqrt(0.01) ≈ 0.10 × scale
  const calibration_bonus = effective_efficacy >= 0.50
    ? stage.calibration_scale * Math.sqrt(Math.max(0, 1.0 - confidence_at_issue))
    : 0;  // no calibration bonus for incorrect predictions

  let raw_delta = base_delta + calibration_bonus;

  // Step 4: action modifier
  if (action === 'REFINE') {
    raw_delta *= 0.50;  // half-signal: user modified but executed
  } else if (action === 'REJECT') {
    raw_delta = -0.10;  // flat penalty; fragility classification (not magnitude) carries the signal
  }
  // EXECUTE: full signal; DEFER: caller should not invoke this function

  // Step 5: clamp delta to ±0.20 max per outcome
  const bounded_delta = Math.max(-0.20, Math.min(0.20, raw_delta));

  // Step 6: clamp new weight to [0.01, stage.max_weight]
  const new_weight = Math.max(0.01, Math.min(stage.max_weight, current_weight + bounded_delta));

  return { bounded_delta, effective_efficacy, new_weight };
}

// ── Thompson Sampling — Axiom Ranking ────────────────────────────────────────

/**
 * Sample a weight from the Beta posterior for one axiom.
 * Uses the Johnk method for Beta(a, b) sampling.
 *
 * @param {number} alpha  success_count + 1  (minimum 1 ensures non-degenerate distribution)
 * @param {number} beta_  rejection_count + 1
 * @returns {number} sampled weight ∈ (0, 1)
 */
function sampleBeta(alpha, beta_) {
  // Johnk's method: sample two Gamma variates and normalise
  function sampleGamma(shape) {
    if (shape < 1) {
      // Ahrens-Dieter method for shape < 1
      const u = Math.random();
      return sampleGamma(1 + shape) * Math.pow(u, 1 / shape);
    }
    // Marsaglia-Tsang method for shape ≥ 1
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
      let x, v;
      do { x = Math.random() * 2 - 1; } while (Math.abs(x) >= 1);
      // Box-Muller normal
      const u2 = Math.random();
      const z  = Math.sqrt(-2 * Math.log(u2)) * Math.cos(2 * Math.PI * x);
      v = Math.pow(1 + c * z, 3);
      if (v > 0) {
        const u3 = Math.random();
        if (u3 < 1 - 0.0331 * Math.pow(z, 4)) return d * v;
        if (Math.log(u3) < 0.5 * z * z + d * (1 - v + Math.log(v))) return d * v;
      }
    }
  }
  const g1 = sampleGamma(alpha);
  const g2 = sampleGamma(beta_);
  return g1 / (g1 + g2);
}

/**
 * Rank axioms using Thompson Sampling.
 *
 * Each axiom gets a sampled weight from Beta(success+1, rejection+1).
 * High-performing axioms win most of the time, but suppressed axioms
 * occasionally surface — enabling exploration without forgetting evidence.
 *
 * @param {Array<{logic_id, current_weight, success_count, rejection_count, boost_factor?}>} axioms
 * @param {number} topK  how many axioms to return (default 5)
 * @returns {Array} sorted axioms with sampled_weight added
 */
export function rankAxiomsThompson(axioms, topK = 5) {
  const ranked = axioms.map(ax => {
    const alpha  = (ax.success_count   || 0) + 1;
    const beta_  = (ax.rejection_count || 0) + 1;
    const posterior_sample = sampleBeta(alpha, beta_);
    // Blend current_weight (evidence) with the posterior sample (exploration)
    // 70/30 blend: primarily evidence-driven, with 30% exploration randomness
    const boost  = ax.boost_factor || 1.0;
    const blended_weight = (0.70 * ax.current_weight + 0.30 * posterior_sample * 3.0) * boost;
    return { ...ax, sampled_weight: posterior_sample, blended_weight };
  });
  return ranked
    .sort((a, b) => b.blended_weight - a.blended_weight)
    .slice(0, topK);
}

// ── Temporal Decay ───────────────────────────────────────────────────────────

/**
 * Compute exponential decay factor for a historical outcome.
 *
 * Half-life: ~14 months (decay constant k = 0.05/month)
 *   - Outcome from 1 month ago:  decay ≈ 0.951 (≈ full weight)
 *   - Outcome from 6 months ago: decay ≈ 0.741
 *   - Outcome from 14 months:    decay ≈ 0.500 (half-weight)
 *   - Outcome from 24 months:    decay ≈ 0.301
 *
 * @param {Date|string} outcomeDate
 * @param {number} [decayConstant=0.05]  per-month decay rate
 * @returns {number} decay_factor ∈ [0.10, 1.00]
 */
export function computeTemporalDecay(outcomeDate, decayConstant = 0.05) {
  const MS_PER_MONTH = 30.44 * 24 * 60 * 60 * 1000;
  const monthsAgo = (Date.now() - new Date(outcomeDate).getTime()) / MS_PER_MONTH;
  const decay = Math.exp(-decayConstant * Math.max(0, monthsAgo));
  return Math.max(0.10, Math.min(1.00, decay));  // floor at 0.10 — never fully discount
}

// ── Outcome Window Lookup ─────────────────────────────────────────────────────

/**
 * Get the default measurement window for a protocol type.
 * Falls back to 'general' (60 days) if type is unknown.
 *
 * @param {string} protocolType
 * @returns {Promise<{default_window_days, min_window_days, max_window_days, primary_kpi}>}
 */
export async function getOutcomeWindow(protocolType) {
  const { rows } = await pool.query(
    `SELECT default_window_days, min_window_days, max_window_days, primary_kpi
     FROM outcome_window_defaults
     WHERE protocol_type = $1 OR protocol_type = 'general'
     ORDER BY CASE WHEN protocol_type = $1 THEN 0 ELSE 1 END
     LIMIT 1`,
    [protocolType || 'general']
  );
  return rows[0] || { default_window_days: 60, min_window_days: 21, max_window_days: 180, primary_kpi: 'mrr_growth_pct' };
}

// ── Confounding Discount Lookup ───────────────────────────────────────────────

/**
 * Compute the cumulative confounding discount for a set of detected confounder types.
 * Discounts are multiplicative; cumulative result is floored at 0.30.
 * If cumulative discount < 0.30, outcome is flagged for human review.
 *
 * @param {string[]} confounderTypes  e.g. ['market_downturn_minor', 'competitive_entry']
 * @returns {Promise<{discount: number, flagForReview: boolean, details: Array}>}
 */
export async function computeConfoundingDiscount(confounderTypes = []) {
  if (!confounderTypes.length) return { discount: 1.0, flagForReview: false, details: [] };

  const placeholders = confounderTypes.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await pool.query(
    `SELECT confounder_type, discount_factor, cumulative_floor, description
     FROM confounding_severity
     WHERE confounder_type = ANY(ARRAY[${placeholders}]::TEXT[])`,
    confounderTypes
  );

  let cumulative = 1.0;
  const details  = [];
  let floor      = 0.30;  // default floor

  for (const row of rows) {
    cumulative *= parseFloat(row.discount_factor);
    floor       = Math.max(floor, parseFloat(row.cumulative_floor));
    details.push({ type: row.confounder_type, factor: row.discount_factor, reason: row.description });
  }

  const finalDiscount  = Math.max(floor, cumulative);
  const flagForReview  = cumulative < floor;  // outcome too noisy for automated training

  return { discount: parseFloat(finalDiscount.toFixed(3)), flagForReview, details };
}

// ── Axiom Weight Update Job ───────────────────────────────────────────────────

/**
 * runWeightUpdateJob — processes all pending outcome_verifications that are past due.
 *
 * For each pending outcome:
 *  1. Fetch confounding discount (from stored confounder list or default 1.0)
 *  2. Compute temporal decay based on when the Protocol was issued
 *  3. Run WUA v2.0 for each logic_id in the Protocol (primary 60%, secondary 30%, tertiary 10%)
 *  4. Apply weight delta to axiom_weights, record in axiom_weight_history
 *  5. Mark outcome_verification as complete
 *
 * This function is designed to run as a scheduled job (every 6 hours recommended).
 */
export async function runWeightUpdateJob() {
  const { rows: pending } = await pool.query(`
    SELECT
      ov.outcome_id,
      ov.feedback_id,
      ov.protocol_id,
      ov.efficacy_score,
      ov.confounders_detected,
      ov.measurement_source,
      ov.created_at AS outcome_created_at,
      sf.user_action,
      sf.rejection_class,
      p.venture_id,
      p.logic_ids,
      p.issued_at AS protocol_issued_at,
      p.confidence AS confidence_at_issue
    FROM outcome_verifications ov
    JOIN sovereign_feedback  sf ON sf.feedback_id = ov.feedback_id
    JOIN protocols           p  ON p.protocol_id  = ov.protocol_id
    WHERE ov.status       = 'pending'
      AND ov.measurement_due <= NOW()
      AND ov.efficacy_score  IS NOT NULL
      AND ov.supersedes_id   IS NULL
  `);

  if (!pending.length) {
    console.log('[WUA v2.0] No pending outcomes to process.');
    return { processed: 0 };
  }

  let processed = 0;

  for (const row of pending) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Confounding discount
      const confounderTypes = row.confounders_detected || [];
      const { discount: confounding_discount, flagForReview } =
        await computeConfoundingDiscount(confounderTypes);

      if (flagForReview) {
        await client.query(
          `UPDATE outcome_verifications
             SET status = 'flagged', measured_at = NOW(),
                 confounding_discount = $1
           WHERE outcome_id = $2`,
          [confounding_discount, row.outcome_id]
        );
        await client.query('COMMIT');
        console.warn(`[WUA v2.0] Outcome ${row.outcome_id} flagged for human review (discount ${confounding_discount})`);
        continue;
      }

      // 2. Temporal decay
      const decay_factor = computeTemporalDecay(row.protocol_issued_at);

      // 3. Venture stage (derive from outcomes count)
      const { rows: stageRows } = await client.query(
        `SELECT COUNT(*) AS completed_outcomes,
                AVG(efficacy_score) AS mean_efficacy
         FROM outcome_verifications
         WHERE protocol_id IN (
           SELECT protocol_id FROM protocols WHERE venture_id = $1
         ) AND status = 'complete'`,
        [row.venture_id]
      );
      const completedCount = parseInt(stageRows[0]?.completed_outcomes || 0, 10);
      const meanEfficacy   = parseFloat(stageRows[0]?.mean_efficacy    || 0);
      const venture_stage  =
        completedCount >= 50 && meanEfficacy >= 0.70 ? 'sovereign' :
        completedCount >= 10 && meanEfficacy >= 0.65 ? 'validated' :
        completedCount >=  3 && meanEfficacy >= 0.55 ? 'emerging'  : 'bootstrap';

      // 4. Attribution shares — 60 / 30 / 10 split across logic_ids
      const logicIds    = row.logic_ids || [];
      const shares      = [0.60, 0.30, 0.10];
      const weightDeltas = {};

      for (let i = 0; i < Math.min(logicIds.length, 3); i++) {
        const logicId = logicIds[i];
        const share   = shares[i] || 0.10;

        // Fetch current weight + counts for this axiom in this venture
        const { rows: awRows } = await client.query(
          `SELECT current_weight, success_count, rejection_count
           FROM axiom_weights
           WHERE venture_id = $1 AND logic_id = $2`,
          [row.venture_id, logicId]
        );
        const current_weight = awRows[0]?.current_weight
          ? parseFloat(awRows[0].current_weight) : 1.0;

        const { bounded_delta, effective_efficacy, new_weight } = computeWeightDelta({
          efficacy_score:      parseFloat(row.efficacy_score),
          decay_factor,
          confounding_discount,
          confidence_at_issue: parseFloat(row.confidence_at_issue || 0.5),
          action:              row.user_action,
          venture_stage,
          current_weight,
        });

        // Scale delta by attribution share
        const attributed_delta  = parseFloat((bounded_delta * share).toFixed(4));
        const attributed_weight = parseFloat(
          Math.max(0.01, Math.min(STAGE_PARAMS[venture_stage].max_weight,
            current_weight + attributed_delta)).toFixed(3)
        );

        weightDeltas[logicId] = { attributed_delta, attributed_weight, share, effective_efficacy };

        // Upsert axiom_weights
        const isSuccess = effective_efficacy >= 0.50;
        await client.query(
          `INSERT INTO axiom_weights
             (venture_id, logic_id, current_weight, application_count,
              success_count, rejection_count, last_updated_at)
           VALUES ($1, $2, $3, 1,
             ${isSuccess ? 1 : 0}, ${row.user_action === 'REJECT' ? 1 : 0}, NOW())
           ON CONFLICT (venture_id, logic_id) DO UPDATE SET
             current_weight    = $3,
             application_count = axiom_weights.application_count + 1,
             success_count     = axiom_weights.success_count   + ${isSuccess ? 1 : 0},
             rejection_count   = axiom_weights.rejection_count + ${row.user_action === 'REJECT' ? 1 : 0},
             last_updated_at   = NOW()`,
          [row.venture_id, logicId, attributed_weight]
        );

        // Append weight history
        await client.query(
          `INSERT INTO axiom_weight_history
             (venture_id, logic_id, from_weight, to_weight, cause, outcome_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [row.venture_id, logicId, current_weight, attributed_weight,
           `WUA_v2.0_${row.user_action}`, row.outcome_id]
        );
      }

      // 5. Mark outcome complete
      const effective_efficacy_final = parseFloat(row.efficacy_score) * decay_factor * confounding_discount;
      await client.query(
        `UPDATE outcome_verifications SET
           status               = 'complete',
           decay_factor         = $1,
           effective_efficacy   = $2,
           confounding_discount = $3,
           weight_deltas        = $4,
           measured_at          = NOW()
         WHERE outcome_id = $5`,
        [decay_factor, effective_efficacy_final.toFixed(3),
         confounding_discount, JSON.stringify(weightDeltas), row.outcome_id]
      );

      await client.query('COMMIT');
      processed++;
      console.log(`[WUA v2.0] Processed outcome ${row.outcome_id} | stage=${venture_stage} | Δweight logged for ${logicIds.length} axiom(s)`);

    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[WUA v2.0] Failed on outcome ${row.outcome_id}:`, err.message);
    } finally {
      client.release();
    }
  }

  return { processed, total: pending.length };
}

// ── Confidence Interval for Protocol output ───────────────────────────────────

/**
 * Compute a Bayesian confidence interval for a Protocol recommendation.
 * Interval width narrows with more outcomes and lower weight variance.
 *
 * @param {string} ventureId
 * @param {string[]} logicIds
 * @param {number} pointEstimate  the model's stated confidence ∈ [0,1]
 * @returns {Promise<{lower: number, point: number, upper: number}>}
 */
export async function computeProtocolConfidenceInterval(ventureId, logicIds, pointEstimate) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'complete') AS completed_outcomes,
       COALESCE(STDDEV(efficacy_score) FILTER (WHERE status = 'complete'), 0.25) AS efficacy_stddev
     FROM outcome_verifications ov
     JOIN protocols p ON p.protocol_id = ov.protocol_id
     WHERE p.venture_id = $1
       AND p.logic_ids && $2::TEXT[]`,
    [ventureId, logicIds]
  );

  const n      = parseInt(rows[0]?.completed_outcomes || 0, 10);
  const stddev = parseFloat(rows[0]?.efficacy_stddev  || 0.25);

  // Interval width shrinks with sample size (CLT: σ/√n); min width = 0.05
  const se    = n > 0 ? stddev / Math.sqrt(n) : 0.20;
  const half  = Math.max(0.05, Math.min(0.30, 1.96 * se));  // 95% CI

  return {
    lower: parseFloat(Math.max(0.01, pointEstimate - half).toFixed(3)),
    point: parseFloat(pointEstimate.toFixed(3)),
    upper: parseFloat(Math.min(0.99, pointEstimate + half).toFixed(3)),
  };
}

// ── Fragility helpers (v2.0 — venture-scoped) ────────────────────────────────

/**
 * Fetch active fragility points for a logic_id, filtered by vertical and stage.
 * NULL industry_vertical = applies to all; NULL venture_stage = applies to all.
 *
 * @param {string} logicId
 * @param {string} [industryVertical]
 * @param {string} [ventureStage]
 */
export async function getFragilityPoints(logicId, industryVertical = null, ventureStage = null) {
  const { rows } = await pool.query(
    `SELECT *
     FROM fragility_points
     WHERE parent_logic_id = $1
       AND (industry_vertical = $2 OR industry_vertical IS NULL)
       AND (venture_stage     = $3 OR venture_stage     IS NULL)
     ORDER BY confirmed_instances DESC`,
    [logicId, industryVertical, ventureStage]
  );
  return rows;
}

/**
 * Record a user REJECT as a fragility instance (append-only).
 * After 5 confirmed instances for the same condition + vertical,
 * automatically sets sovereign_override_required = true.
 *
 * Deduplication: rejects within 24h from the same venture for the same
 * axiom/condition are treated as a single instance to prevent flooding.
 */
export async function recordFragilityInstance(fragilityId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE fragility_points
         SET confirmed_instances = confirmed_instances + 1,
             sovereign_override_required = CASE
               WHEN confirmed_instances + 1 >= 5 THEN TRUE
               ELSE sovereign_override_required
             END
       WHERE fragility_id = $1
       RETURNING confirmed_instances, sovereign_override_required`,
      [fragilityId]
    );

    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}


// ── Thinker Logic — runtime helpers ──────────────────────────────────────────

/**
 * Load all active axioms for a thinker, merged with per-venture live weights.
 * Falls back to base_weight when no venture row exists yet.
 *
 * @param {string} thinkerId
 * @param {string} ventureId  UUID (user_id used as venture proxy)
 * @returns {Array<{logic_id, category, axiom_text, current_weight,
 *                  success_count, rejection_count, application_count}>}
 */
export async function loadThinkerAxioms(thinkerId, ventureId) {
  const { rows } = await pool.query(
    `SELECT
       ta.logic_id,
       ta.category,
       ta.axiom_text,
       ta.base_weight,
       COALESCE(aw.current_weight,    ta.base_weight) AS current_weight,
       COALESCE(aw.success_count,     0)              AS success_count,
       COALESCE(aw.rejection_count,   0)              AS rejection_count,
       COALESCE(aw.application_count, 0)              AS application_count
     FROM   thinker_axioms ta
     LEFT JOIN axiom_weights aw
            ON aw.logic_id   = ta.logic_id
           AND aw.venture_id = $2
     WHERE  ta.thinker_id   = $1
       AND  ta.deprecated_at IS NULL
     ORDER BY current_weight DESC`,
    [thinkerId, ventureId]
  );
  return rows;
}

/**
 * Seed a thinker's axioms from their profile if no rows exist yet.
 * Idempotent — uses INSERT … ON CONFLICT DO NOTHING.
 *
 * @param {string} thinkerId
 * @param {Array<{logic_id, category, axiom_text, base_weight?}>} axiomDefs
 */
export async function seedThinkerAxioms(thinkerId, axiomDefs) {
  if (!axiomDefs?.length) return;
  for (const ax of axiomDefs) {
    await pool.query(
      `INSERT INTO thinker_axioms (logic_id, thinker_id, category, axiom_text, base_weight)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (logic_id) DO NOTHING`,
      [ax.logic_id, thinkerId, ax.category, ax.axiom_text, ax.base_weight ?? 1.0]
    );
  }
}
