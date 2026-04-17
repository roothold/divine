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
       SET credit_balance  = credit_balance  - $2,
           lifetime_spent  = lifetime_spent  + $2,
           updated_at      = NOW()
       WHERE user_id = $1 AND credit_balance >= $2
       RETURNING *`,
      [userId, amount]
    );
    if (!rows.length) throw new Error('INSUFFICIENT_FUNDS');
    const wallet = rows[0];
    await client.query(
      `INSERT INTO wallet_transactions
         (wallet_id, line_item_type, amount, direction, balance_after, label)
       VALUES ($1, 'perspective_spend', $2, 'debit', $3, $4)`,
      [wallet.id, amount, wallet.credit_balance, label]
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
      `INSERT INTO wallets (user_id, credit_balance, lifetime_earned)
       VALUES ($1, $2, $2)
       ON CONFLICT (user_id) DO UPDATE
         SET credit_balance  = wallets.credit_balance  + $2,
             lifetime_earned = wallets.lifetime_earned + $2,
             updated_at      = NOW()
       RETURNING *`,
      [userId, amount]
    );
    const wallet = rows[0];
    await client.query(
      `INSERT INTO wallet_transactions
         (wallet_id, line_item_type, amount, direction, balance_after, label)
       VALUES ($1, 'topup', $2, 'credit', $3, $4)`,
      [wallet.id, amount, wallet.credit_balance, label]
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
