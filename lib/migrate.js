const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

/** Splits schema.sql into individual statements (safe here: no semicolons inside string literals in this file). */
function splitStatements(sql) {
  return sql
    .split(';')
    .map(chunk => chunk
      .split('\n')
      .filter(line => !line.trim().startsWith('--')) // drop comment lines, keep the real SQL in that chunk
      .join('\n')
      .trim()
    )
    .filter(s => s.length > 0);
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
 * Runs once at startup, every time the app boots. Safe to run repeatedly,
 * and wrapped in a single transaction so a failure partway through (e.g. a
 * bad statement) rolls everything back instead of leaving some tables
 * created and others missing - a half-migrated database would otherwise
 * fail forever on every subsequent restart.
 * - Creates any tables that don't exist yet.
 * - (Room for future ALTER TABLE-style upgrades, guarded by columnExists.)
 * - Seeds default settings, a default admin account, and default bottle
 *   types/qualities the very first time the database is empty.
 */
async function runMigrations(pool) {
  await pool.transaction(async (query) => {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
    const statements = splitStatements(schema);
    for (const stmt of statements) {
      await query(stmt);
    }

    // Example of the pattern for a future column addition:
    // if (!(await columnExists({ query }, 'attendance', 'some_new_column'))) {
    //   await query('ALTER TABLE attendance ADD COLUMN some_new_column VARCHAR(50)');
    // }

    // ---- Customers & payments upgrade (existing databases) ----
    // Brand-new databases already get these columns from schema.sql. Databases
    // created before customer tracking existed need them added here.
    if (!(await columnExists({ query }, 'deliveries', 'customer_id'))) {
      await query('ALTER TABLE deliveries ADD COLUMN customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL');
    }
    if (!(await columnExists({ query }, 'deliveries', 'previous_balance'))) {
      await query('ALTER TABLE deliveries ADD COLUMN previous_balance DECIMAL(12,2) NOT NULL DEFAULT 0');
    }
    if (!(await columnExists({ query }, 'deliveries', 'amount_paid'))) {
      await query('ALTER TABLE deliveries ADD COLUMN amount_paid DECIMAL(12,2) NOT NULL DEFAULT 0');
      // Before this upgrade the app never recorded payments, so every existing
      // delivery is treated as paid in full. Without this, every past delivery
      // would suddenly look completely unpaid. This runs exactly once, at the
      // moment the column is first added.
      await query('UPDATE deliveries SET amount_paid = total_amount');
      console.log('[setup] Customer tracking added. Existing deliveries were marked as paid in full.');
    }
    await query('CREATE INDEX IF NOT EXISTS idx_deliveries_customer ON deliveries (customer_id)');
    await query('CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments (customer_id)');

    // ---- Crates ("pets" of 6 or 12 bottles) upgrade ----
    if (!(await columnExists({ query }, 'delivery_items', 'crates'))) {
      await query('ALTER TABLE delivery_items ADD COLUMN crates INTEGER');
    }
    if (!(await columnExists({ query }, 'delivery_items', 'price_per_crate'))) {
      await query('ALTER TABLE delivery_items ADD COLUMN price_per_crate DECIMAL(12,2)');
    }

    // ---- Bottles per pet, per bottle type ----
    // Most types are 6 bottles to a pet; the 500ml types are 12. Added once, with
    // 500ml types set to 12 at that moment; after that it's editable on the Products page.
    if (!(await columnExists({ query }, 'bottle_types', 'bottles_per_pet'))) {
      await query('ALTER TABLE bottle_types ADD COLUMN bottles_per_pet INTEGER NOT NULL DEFAULT 6');
      await query("UPDATE bottle_types SET bottles_per_pet = 12 WHERE name ~* '(^|[^0-9])500 *ml'");
      console.log('[setup] Bottles-per-pet added. 500ml types set to 12, all others 6.');
    }

    // ---- Raw materials (PET sheets, labels, caps) upgrade ----
    // New tables come from schema.sql above. Databases created earlier have an expenses
    // category check that doesn't know about 'materials_purchase', so swap it for the new one.
    const [catCheck] = await query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'expenses'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%bottles_purchase%'`
    );
    if (catCheck.length > 0 && !catCheck[0].def.includes('materials_purchase')) {
      const [named] = await query(
        `SELECT conname FROM pg_constraint
         WHERE conrelid = 'expenses'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%bottles_purchase%'`
      );
      await query(`ALTER TABLE expenses DROP CONSTRAINT "${named[0].conname}"`);
      await query(
        `ALTER TABLE expenses ADD CONSTRAINT expenses_category_check
         CHECK (category IN ('bottles_purchase','materials_purchase','petrol','maintenance','electricity','other'))`
      );
      console.log('[setup] Expenses now accept the materials_purchase category.');
    }
    await query('CREATE INDEX IF NOT EXISTS idx_stock_adjustments_variant ON stock_adjustments (variant_id)');
    await query('CREATE INDEX IF NOT EXISTS idx_material_purchases_material ON material_purchases (material_id)');
    await query('CREATE INDEX IF NOT EXISTS idx_material_adjustments_material ON material_adjustments (material_id)');

    // Seed the three starting materials exactly once. A settings flag (rather than "table is
    // empty") means that if you later delete or rename them, they don't come back on restart.
    const [seededRows] = await query('SELECT value FROM settings WHERE "key" = ?', ['materials_seeded']);
    if (seededRows.length === 0) {
      for (const [name, unit] of [['PET Sheets', 'kg'], ['Labels', 'kg'], ['Bottle Caps', 'pcs']]) {
        await query('INSERT INTO materials (name, unit) VALUES (?, ?) ON CONFLICT (name) DO NOTHING', [name, unit]);
      }
      await query('INSERT INTO settings ("key", value) VALUES (?, ?)', ['materials_seeded', '1']);
      console.log('[setup] Added raw materials: PET Sheets (kg), Labels (kg), Bottle Caps (pcs).');
    }

    const [typeCountRows] = await query('SELECT COUNT(*) AS n FROM bottle_types');
    if (typeCountRows[0].n === 0) {
      for (const name of ['Type A', 'Type B', 'Type C']) {
        await query('INSERT INTO bottle_types (name) VALUES (?)', [name]);
      }
    }
    const [qualityCountRows] = await query('SELECT COUNT(*) AS n FROM bottle_qualities');
    if (qualityCountRows[0].n === 0) {
      for (const name of ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4']) {
        await query('INSERT INTO bottle_qualities (name) VALUES (?)', [name]);
      }
    }
    await ensureAllVariantsExist({ query });

    const defaultSettings = {
      company_name: 'Crystal Drinks',
      company_address: '',
      company_phone: '',
      wage_mode: 'per_day',
      per_bottle_rate: '0',
      invoice_counter: '1000',
      low_stock_threshold_empty: '200',
      low_stock_threshold_filled: '100',
      whatsapp_country_code: '92'
    };
    for (const [key, value] of Object.entries(defaultSettings)) {
      await query('INSERT INTO settings ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO NOTHING', [key, value]);
    }

    const [existingAdmins] = await query("SELECT id FROM users WHERE username = 'admin'");
    if (existingAdmins.length === 0) {
      const hash = bcrypt.hashSync('admin123', 10);
      await query(
        `INSERT INTO users (name, username, password_hash, role, daily_wage, active)
         VALUES ('Owner', 'admin', ?, 'admin', 0, 1)`,
        [hash]
      );
      console.log('[setup] Created default admin account -> username: admin | password: admin123');
      console.log('[setup] IMPORTANT: log in and change this password immediately (Settings > Change Password).');
    }
  });
}

module.exports = { runMigrations, ensureAllVariantsExist, columnExists };
