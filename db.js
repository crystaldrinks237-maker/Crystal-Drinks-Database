const { Pool, types } = require('pg');
require('dotenv').config();

// pg returns these types as JS Date objects or precision-safe strings by
// default. Override so they behave the way the rest of this app expects
// (plain date strings, and numbers you can call .toFixed() on).
types.setTypeParser(1082, val => val);                                   // date -> 'YYYY-MM-DD' string
types.setTypeParser(1114, val => val);                                   // timestamp (no tz) -> string
types.setTypeParser(1700, val => (val === null ? null : parseFloat(val))); // numeric/decimal -> number
types.setTypeParser(20, val => parseInt(val, 10));                       // bigint (e.g. COUNT(*)) -> number

// Neon (and most hosted Postgres) give you one connection string. Render lets
// you set this as an environment variable in its dashboard. Falls back to
// discrete DB_* variables for local development against a plain local Postgres.
const connectionString = process.env.DATABASE_URL;

const pgPool = connectionString
  ? new Pool({ connectionString, ssl: { rejectUnauthorized: false } })
  : new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'crystal_drinks'
    });

/** Converts '?' placeholders (in source order) to Postgres's '$1, $2, ...' style. */
function toPositional(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/**
 * Compatibility wrapper: lets the rest of the app keep using '?' placeholders
 * and `const [rows] = await pool.query(...)` destructuring (as if this were
 * mysql2) while actually running on PostgreSQL underneath. Exposed as
 * `.query` on the exported object so existing `pool.query(...)` call sites
 * throughout the app work unchanged.
 */
async function query(sql, params = []) {
  const result = await pgPool.query(toPositional(sql), params || []);
  return [result.rows, result];
}

/**
 * Runs `fn` with a single dedicated connection wrapped in BEGIN/COMMIT, so a
 * batch of statements either all succeed or all roll back together. This is
 * what keeps a failed migration from leaving the database in a half-created
 * state (some tables existing, others missing) that then fails forever on
 * every retry - `fn` receives a query function with the same '?'-placeholder,
 * `[rows]`-destructuring shape as the normal `query` export above.
 */
async function transaction(fn) {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const txQuery = async (sql, params = []) => {
      const result = await client.query(toPositional(sql), params || []);
      return [result.rows, result];
    };
    const value = await fn(txQuery);
    await client.query('COMMIT');
    return value;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { query, transaction, raw: pgPool };
