const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

/** Splits schema.sql into individual statements (safe here: no semicolons inside string literals in this file). */
function splitStatements(sql) {
  return sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));
}

async function columnExists(pool, table, column) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return rows[0].n > 0;
}

/** Creates every bottle_type x bottle_quality combination that doesn't already exist as a variant. */
async function ensureAllVariantsExist(pool) {
  const [types] = await pool.query('SELECT id FROM bottle_types');
  const [qualities] = await pool.query('SELECT id FROM bottle_qualities');
  for (const t of types) {
    for (const q of qualities) {
      await pool.query(
        'INSERT INTO bottle_variants (type_id, quality_id) VALUES (?, ?) ON CONFLICT (type_id, quality_id) DO NOTHING',
        [t.id, q.id]
      );
    }
  }
}

/**
 * Runs once at startup, every time the app boots. Safe to run repeatedly:
 * - Creates any tables that don't exist yet.
 * - (Room for future ALTER TABLE-style upgrades, guarded by columnExists.)
 * - Seeds default settings, a default admin account, and default bottle
 *   types/qualities the very first time the database is empty.
 */
async function runMigrations(pool) {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  const statements = splitStatements(schema);
  for (const stmt of statements) {
    await pool.query(stmt);
  }

  // Example of the pattern for a future column addition:
  // if (!(await columnExists(pool, 'attendance', 'some_new_column'))) {
  //   await pool.query('ALTER TABLE attendance ADD COLUMN some_new_column VARCHAR(50)');
  // }

  const [typeCountRows] = await pool.query('SELECT COUNT(*) AS n FROM bottle_types');
  if (typeCountRows[0].n === 0) {
    for (const name of ['Type A', 'Type B', 'Type C']) {
      await pool.query('INSERT INTO bottle_types (name) VALUES (?)', [name]);
    }
  }
  const [qualityCountRows] = await pool.query('SELECT COUNT(*) AS n FROM bottle_qualities');
  if (qualityCountRows[0].n === 0) {
    for (const name of ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4']) {
      await pool.query('INSERT INTO bottle_qualities (name) VALUES (?)', [name]);
    }
  }
  await ensureAllVariantsExist(pool);

  const defaultSettings = {
    company_name: 'Crystal Drinks',
    company_address: '',
    company_phone: '',
    wage_mode: 'per_day',
    per_bottle_rate: '0',
    invoice_counter: '1000',
    low_stock_threshold_empty: '200',
    low_stock_threshold_filled: '100'
  };
  for (const [key, value] of Object.entries(defaultSettings)) {
    await pool.query('INSERT INTO settings ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO NOTHING', [key, value]);
  }

  const [existingAdmins] = await pool.query("SELECT id FROM users WHERE username = 'admin'");
  if (existingAdmins.length === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await pool.query(
      `INSERT INTO users (name, username, password_hash, role, daily_wage, active)
       VALUES ('Owner', 'admin', ?, 'admin', 0, 1)`,
      [hash]
    );
    console.log('[setup] Created default admin account -> username: admin | password: admin123');
    console.log('[setup] IMPORTANT: log in and change this password immediately (Settings > Change Password).');
  }
}

module.exports = { runMigrations, ensureAllVariantsExist, columnExists };
