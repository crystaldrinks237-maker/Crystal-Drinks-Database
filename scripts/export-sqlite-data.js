// Run this ON YOUR LAPTOP (where your old data/crystal-drinks.db file lives),
// BEFORE switching to the hosted PostgreSQL version, to save your existing data.
//
//   node scripts/export-sqlite-data.js
//
// It writes sqlite-export.json in the project folder. Copy that file along
// when you set up the hosted version, then run scripts/import-to-postgres.js
// there (pointed at your new database) to bring your data across.

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const TABLES = [
  'users', 'bottle_types', 'bottle_qualities', 'bottle_variants',
  'attendance', 'production', 'empty_bottle_purchases',
  'deliveries', 'delivery_items', 'expenses', 'settings'
];

const dbPath = path.join(__dirname, '..', 'data', 'crystal-drinks.db');

if (!fs.existsSync(dbPath)) {
  console.log('No data/crystal-drinks.db found here - nothing to export.');
  console.log('(If you never ran the local version, that\'s expected - just skip this step.)');
  process.exit(0);
}

const db = new DatabaseSync(dbPath);
const dump = { exportedAt: new Date().toISOString(), tables: {} };

for (const table of TABLES) {
  try {
    dump.tables[table] = db.prepare(`SELECT * FROM ${table}`).all();
  } catch (e) {
    console.warn(`Skipping ${table} (${e.message})`);
    dump.tables[table] = [];
  }
}

const outPath = path.join(__dirname, '..', 'sqlite-export.json');
fs.writeFileSync(outPath, JSON.stringify(dump, null, 2));

console.log('Exported your existing data to:', outPath);
console.log('Row counts:', Object.fromEntries(Object.entries(dump.tables).map(([k, v]) => [k, v.length])));
console.log('\nNext: bring this file with you and run scripts/import-to-mysql.js against your new hosted database.');
