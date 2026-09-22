// Run this AFTER your hosted PostgreSQL database (e.g. on Neon) is set up and
// your .env (or Render's environment variables) point at it via DATABASE_URL:
//
//   node scripts/import-to-postgres.js
//
// It reads sqlite-export.json (created by scripts/export-sqlite-data.js on
// your laptop) and loads that data into the new database, replacing the
// freshly auto-seeded defaults (default admin account, placeholder bottle
// types, etc.) with your real data.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const { runMigrations } = require('../lib/migrate');

// Parents before children - required both for inserting (FK targets must
// exist first) and, in reverse, for deleting (children must go before parents).
const TABLES_IN_ORDER = [
  'users', 'bottle_types', 'bottle_qualities', 'bottle_variants',
  'attendance', 'production', 'empty_bottle_purchases',
  'deliveries', 'delivery_items', 'expenses', 'settings'
];

async function main() {
  const inPath = path.join(__dirname, '..', 'sqlite-export.json');
  if (!fs.existsSync(inPath)) {
    console.error('sqlite-export.json not found in the project folder.');
    console.error('Run scripts/export-sqlite-data.js on your laptop first, then copy that file here.');
    process.exit(1);
  }
  const dump = JSON.parse(fs.readFileSync(inPath, 'utf8'));

  console.log('Making sure tables exist on the new database...');
  await runMigrations(pool);

  console.log('Clearing auto-seeded defaults...');
  for (const table of [...TABLES_IN_ORDER].reverse()) {
    await pool.query(`DELETE FROM "${table}"`);
  }

  for (const table of TABLES_IN_ORDER) {
    const rows = dump.tables[table] || [];
    if (rows.length === 0) continue;

    console.log(`Importing ${rows.length} row(s) into ${table}...`);
    for (const row of rows) {
      const columns = Object.keys(row);
      const colList = columns.map(c => `"${c}"`).join(', ');
      const placeholders = columns.map(() => '?').join(', ');
      const values = columns.map(c => row[c]);
      await pool.query(`INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`, values);
    }

    // Explicit id values don't advance PostgreSQL's auto-increment sequence
    // on their own - fix that up so the next normal insert doesn't collide.
    if (rows[0] && Object.prototype.hasOwnProperty.call(rows[0], 'id')) {
      await pool.query(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 1))`
      );
    }
  }

  console.log('\nImport complete! Your existing data is now in the hosted database.');
  process.exit(0);
}

main().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
