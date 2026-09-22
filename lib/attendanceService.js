const pool = require('../db');

async function getSetting(key) {
  const [rows] = await pool.query('SELECT value FROM settings WHERE "key" = ?', [key]);
  return rows.length ? rows[0].value : null;
}

/** Active variants, for building "log production" forms. */
async function activeVariants() {
  const [rows] = await pool.query(`
    SELECT v.id, t.name AS type_name, q.name AS quality_name
    FROM bottle_variants v
    JOIN bottle_types t ON t.id = v.type_id
    JOIN bottle_qualities q ON q.id = v.quality_id
    WHERE v.active = 1 AND t.active = 1 AND q.active = 1
    ORDER BY t.name, q.name
  `);
  return rows;
}

/** All variants including inactive ones, so old entries referencing a since-retired variant still display correctly. */
async function allVariantsIncludingInactive() {
  const [rows] = await pool.query(`
    SELECT v.id, t.name AS type_name, q.name AS quality_name, v.active
    FROM bottle_variants v
    JOIN bottle_types t ON t.id = v.type_id
    JOIN bottle_qualities q ON q.id = v.quality_id
    ORDER BY t.name, q.name
  `);
  return rows;
}

/** variant_id -> quantity map of what was logged for a given attendance row. */
async function getProductionMap(attendanceId) {
  const [rows] = await pool.query('SELECT variant_id, quantity FROM production WHERE attendance_id = ?', [attendanceId]);
  const map = {};
  rows.forEach(r => { map[r.variant_id] = r.quantity; });
  return map;
}

/**
 * Creates or updates one worker's attendance for one date, including the per-variant
 * production breakdown. Used by both the worker's own dashboard and the admin's
 * "add/edit attendance" screen.
 *
 * variantQuantities: array of { variantId, quantity }
 * source: 'worker' or 'admin' (who entered this)
 */
async function saveAttendance({ userId, date, present, notes, variantQuantities, source }) {
  const wageMode = (await getSetting('wage_mode')) || 'per_day';
  const perBottleRate = parseFloat((await getSetting('per_bottle_rate')) || '0');

  const [workerRows] = await pool.query('SELECT daily_wage FROM users WHERE id = ?', [userId]);
  if (workerRows.length === 0) throw new Error('Worker not found');
  const worker = workerRows[0];

  const isPresent = present ? 1 : 0;
  const cleanItems = (variantQuantities || [])
    .map(v => ({ variantId: parseInt(v.variantId, 10), quantity: parseInt(v.quantity, 10) || 0 }))
    .filter(v => v.variantId && v.quantity > 0);
  const totalBottles = cleanItems.reduce((sum, v) => sum + v.quantity, 0);

  let wageAmount = 0;
  if (isPresent) {
    wageAmount = wageMode === 'per_bottle' ? totalBottles * perBottleRate : Number(worker.daily_wage);
  }
  const wageRate = wageMode === 'per_bottle' ? perBottleRate : Number(worker.daily_wage);
  const createdBy = source || 'worker';

  const [rows] = await pool.query(`
    INSERT INTO attendance (user_id, date, present, bottles_filled, wage_mode, wage_rate, wage_amount, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, date) DO UPDATE SET
      present = EXCLUDED.present,
      bottles_filled = EXCLUDED.bottles_filled,
      wage_mode = EXCLUDED.wage_mode,
      wage_rate = EXCLUDED.wage_rate,
      wage_amount = EXCLUDED.wage_amount,
      notes = EXCLUDED.notes,
      created_by = EXCLUDED.created_by
    RETURNING id
  `, [userId, date, isPresent, totalBottles, wageMode, wageRate, wageAmount, notes || null, createdBy]);

  const attendanceId = rows[0].id;

  await pool.query('DELETE FROM production WHERE attendance_id = ?', [attendanceId]);
  for (const v of cleanItems) {
    await pool.query('INSERT INTO production (attendance_id, variant_id, quantity) VALUES (?, ?, ?)', [attendanceId, v.variantId, v.quantity]);
  }

  return attendanceId;
}

module.exports = { getSetting, activeVariants, allVariantsIncludingInactive, getProductionMap, saveAttendance };
