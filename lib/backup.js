const pool = require('../db');

// Tables listed in an order safe for re-import (parents before children,
// matching the foreign keys in schema.sql).
const TABLES = [
  'users',
  'bottle_types',
  'bottle_qualities',
  'bottle_variants',
  'attendance',
  'production',
  'empty_bottle_purchases',
  'deliveries',
  'delivery_items',
  'expenses',
  'settings'
];

/**
 * Exports every table to a plain JSON object. Used for the "Download backup"
 * button - hosted platforms typically don't give you a reliable local disk
 * to write scheduled backup files to, so backups here are an on-demand
 * download instead of an automatic local file like the laptop version had.
 * Your hosting provider's managed Postgres database (e.g. Neon) usually has
 * its own automated backups/snapshots too - this is a supplementary safety
 * net you control yourself (e.g. to keep a copy in your own cloud storage).
 */
async function exportAllTablesAsJSON() {
  const dump = { exportedAt: new Date().toISOString(), tables: {} };
  for (const table of TABLES) {
    const [rows] = await pool.query(`SELECT * FROM "${table}"`);
    dump.tables[table] = rows;
  }
  return dump;
}

module.exports = { exportAllTablesAsJSON, TABLES };
