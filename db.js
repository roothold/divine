/**
 * Divine Intelligence — PostgreSQL Pool
 * Single shared pool for the entire app.
 */

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }   // Railway Postgres requires SSL
    : false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

export default pool;

/**
 * Convenience: get-or-create a wallet row for a user.
 * Returns the wallet row.
 */
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

/**
 * Deduct an amount from a wallet atomically.
 * Returns updated wallet or throws if insufficient funds.
 */
export async function deductCredit(userId, amount, description, metadata = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE wallets
       SET credit_balance = credit_balance - $2, updated_at = NOW()
       WHERE user_id = $1 AND credit_balance >= $2
       RETURNING *`,
      [userId, amount]
    );

    if (!rows.length) throw new Error('INSUFFICIENT_FUNDS');

    await client.query(
      `INSERT INTO transactions (wallet_id, type, amount, description, metadata)
       VALUES ($1, 'debit', $2, $3, $4)`,
      [rows[0].id, amount, description, metadata]
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

/**
 * Credit an amount to a wallet atomically.
 * Creates wallet if it doesn't exist.
 */
export async function creditWallet(userId, amount, description, metadata = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Upsert wallet
    const { rows } = await client.query(
      `INSERT INTO wallets (user_id, credit_balance)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE
         SET credit_balance = wallets.credit_balance + $2,
             updated_at = NOW()
       RETURNING *`,
      [userId, amount]
    );

    await client.query(
      `INSERT INTO transactions (wallet_id, type, amount, description, metadata)
       VALUES ($1, 'credit', $2, $3, $4)`,
      [rows[0].id, amount, description, metadata]
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
