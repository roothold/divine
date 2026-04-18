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

export async function deductCredit(userId, amount, label, _metadata = {}) {
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
         (user_id, type, amount, balance_after, label)
       VALUES ($1, 'debit', $2, $3, $4)`,
      [userId, amount, wallet.credit_balance, label]
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

export async function creditWallet(userId, amount, label, _metadata = {}) {
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
         (user_id, type, amount, balance_after, label)
       VALUES ($1, 'credit', $2, $3, $4)`,
      [userId, amount, wallet.credit_balance, label]
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
 * Ensure is_admin and is_disabled columns exist.
 * Safe to call on every boot — uses IF NOT EXISTS.
 */
export async function adminMigrateSchema() {
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin    BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_disabled BOOLEAN NOT NULL DEFAULT FALSE;
  `);
  // Idempotency table for Stripe webhook events — prevents double-crediting on retries
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stripe_events (
      event_id   TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
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
       COALESCE(w.credit_balance, 0) AS balance,
       COUNT(wt.id) FILTER (WHERE wt.type = 'debit') AS perspective_count
     FROM users u
     LEFT JOIN wallets w              ON w.user_id = u.id
     LEFT JOIN wallet_transactions wt ON wt.user_id = u.id
     WHERE ($1 = '' OR u.name ILIKE $2 OR u.email ILIKE $2)
     GROUP BY u.id, w.credit_balance
     ORDER BY u.created_at DESC
     LIMIT $3 OFFSET $4`,
    [search, like, limit, offset]
  );
  return rows;
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
      COUNT(DISTINCT u.id)                                              AS total_users,
      COUNT(DISTINCT u.id) FILTER (WHERE u.is_disabled = FALSE)         AS active_users,
      COALESCE(SUM(w.credit_balance), 0)                                AS total_balance,
      COALESCE(SUM(wt.amount) FILTER (WHERE wt.type = 'debit'), 0) AS total_spent,
      COALESCE(SUM(wt.amount) FILTER (WHERE wt.type = 'credit'), 0) AS total_earned,
      COUNT(wt.id) FILTER (WHERE wt.type = 'debit')         AS total_perspectives
    FROM users u
    LEFT JOIN wallets w              ON w.user_id = u.id
    LEFT JOIN wallet_transactions wt ON wt.user_id = u.id
  `);

  const { rows: recentTxns } = await pool.query(`
    SELECT
      wt.id,
      wt.created_at,
      wt.type,
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
