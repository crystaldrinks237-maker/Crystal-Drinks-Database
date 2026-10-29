const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const pool = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { generateInvoicePDF } = require('../lib/invoice');
const { generateMonthlyReportPDF } = require('../lib/report');
const { toCSV } = require('../lib/csv');
const { exportAllTablesAsJSON } = require('../lib/backup');
const { activeVariants, allVariantsIncludingInactive, getProductionMap, saveAttendance, getSetting } = require('../lib/attendanceService');
const { ensureAllVariantsExist } = require('../lib/migrate');
const { round2, listCustomersWithBalances, getBalance, findCustomerByName } = require('../lib/customerService');
const { round3, getBottleTotals, getVariantStockMap, getVariantStock, getMaterialsWithStock } = require('../lib/stockService');

// A "pet" is a crate; how many bottles it holds depends on the type (bottle_types.bottles_per_pet).

router.use(requireAdmin);
router.use('/customers', require('./customers'));

async function setSetting(key, value) {
  await pool.query(
    'INSERT INTO settings ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value',
    [key, value]
  );
}
async function getCompany() {
  return {
    company_name: await getSetting('company_name'),
    company_address: await getSetting('company_address'),
    company_phone: await getSetting('company_phone')
  };
}
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function lastDayOfMonth(year, month) {
  // day 0 of the next month = last day of this month; avoids invalid dates like "Feb 31"
  return new Date(Date.UTC(parseInt(year, 10), parseInt(month, 10), 0)).getUTCDate();
}

// ---------- DASHBOARD ----------
router.get('/', async (req, res, next) => {
  try {
    const { emptyStock, filledStock } = await getBottleTotals();
    const materials = (await getMaterialsWithStock()).filter(m => m.active);
    const lowMaterials = materials.filter(m => m.low);

    const [[{ n: totalRevenue }]] = await pool.query('SELECT COALESCE(SUM(total_amount),0) AS n FROM deliveries');
    const [[{ n: totalWages }]] = await pool.query('SELECT COALESCE(SUM(wage_amount),0) AS n FROM attendance');
    // Every bottle and material purchase already logs its own expense row (see the purchase
    // routes below), so this one total covers them. Adding the purchase tables' costs on top
    // would count those purchases twice.
    const [[{ n: totalExpenses }]] = await pool.query('SELECT COALESCE(SUM(amount),0) AS n FROM expenses');

    const today = todayStr();
    const [todaysAttendance] = await pool.query(
      'SELECT a.*, u.name FROM attendance a JOIN users u ON u.id = a.user_id WHERE a.date = ?', [today]
    );
    const [recentDeliveries] = await pool.query('SELECT * FROM deliveries ORDER BY date DESC, id DESC LIMIT 5');

    // Who owes us money (credits / prepayments don't offset other people's debts here)
    const owing = (await listCustomersWithBalances()).filter(c => c.balance > 0).sort((a, b) => b.balance - a.balance);
    const totalOwed = round2(owing.reduce((s, c) => s + c.balance, 0));

    const lowStockEmptyThreshold = parseInt((await getSetting('low_stock_threshold_empty')) || '200', 10);
    const lowStockFilledThreshold = parseInt((await getSetting('low_stock_threshold_filled')) || '100', 10);

    res.render('admin/dashboard', {
      user: req.session.user,
      emptyStock, filledStock,
      lowStockEmptyThreshold, lowStockFilledThreshold,
      lowEmpty: emptyStock < lowStockEmptyThreshold,
      lowFilled: filledStock < lowStockFilledThreshold,
      materials, lowMaterials,
      totalRevenue, totalWages, totalExpenses,
      netEstimate: totalRevenue - totalWages - totalExpenses,
      todaysAttendance, recentDeliveries, today,
      totalOwed, owingCount: owing.length, topOwing: owing.slice(0, 5)
    });
  } catch (err) { next(err); }
});

// ---------- WORKERS ----------
router.get('/workers', async (req, res, next) => {
  try {
    const [workers] = await pool.query("SELECT * FROM users WHERE role = 'worker' ORDER BY active DESC, name");
    res.render('admin/workers', { user: req.session.user, workers });
  } catch (err) { next(err); }
});

router.get('/workers/new', (req, res) => {
  res.render('admin/worker-form', { user: req.session.user, worker: null, error: null });
});

router.post('/workers', async (req, res, next) => {
  try {
    const { name, username, password, daily_wage } = req.body;
    const hash = bcrypt.hashSync(password, 10);
    await pool.query(
      `INSERT INTO users (name, username, password_hash, role, daily_wage, active)
       VALUES (?, ?, ?, 'worker', ?, 1)`,
      [name, username, hash, parseFloat(daily_wage) || 0]
    );
    res.redirect('/admin/workers');
  } catch (e) {
    if (e.code === '23505') {
      return res.render('admin/worker-form', { user: req.session.user, worker: null, error: 'Username already exists.' });
    }
    next(e);
  }
});

router.get('/workers/:id/edit', async (req, res, next) => {
  try {
    const [rows] = await pool.query("SELECT * FROM users WHERE id = ? AND role = 'worker'", [req.params.id]);
    if (!rows[0]) return res.redirect('/admin/workers');
    res.render('admin/worker-form', { user: req.session.user, worker: rows[0], error: null });
  } catch (err) { next(err); }
});

router.post('/workers/:id', async (req, res, next) => {
  try {
    const { name, daily_wage, active, new_password } = req.body;
    await pool.query('UPDATE users SET name = ?, daily_wage = ?, active = ? WHERE id = ?',
      [name, parseFloat(daily_wage) || 0, active ? 1 : 0, req.params.id]);
    if (new_password && new_password.trim()) {
      const hash = bcrypt.hashSync(new_password.trim(), 10);
      await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.params.id]);
    }
    res.redirect('/admin/workers');
  } catch (err) { next(err); }
});

// ---------- ATTENDANCE / PRODUCTION ----------
router.get('/attendance', async (req, res, next) => {
  try {
    const date = req.query.date || todayStr();
    const [rows] = await pool.query(`
      SELECT a.*, u.name,
        (SELECT STRING_AGG(CONCAT(t.name, ' ', q.name, ': ', p.quantity), ', ')
         FROM production p
         JOIN bottle_variants v ON v.id = p.variant_id
         JOIN bottle_types t ON t.id = v.type_id
         JOIN bottle_qualities q ON q.id = v.quality_id
         WHERE p.attendance_id = a.id) AS breakdown
      FROM attendance a JOIN users u ON u.id = a.user_id
      WHERE a.date = ? ORDER BY u.name
    `, [date]);
    const [workers] = await pool.query("SELECT * FROM users WHERE role='worker' AND active=1 ORDER BY name");
    res.render('admin/attendance', { user: req.session.user, date, rows, workers });
  } catch (err) { next(err); }
});

// Add or edit one worker's attendance for one date, as the admin.
router.get('/attendance/entry', async (req, res, next) => {
  try {
    const date = req.query.date || todayStr();
    const userId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
    const [workers] = await pool.query("SELECT * FROM users WHERE role='worker' AND active=1 ORDER BY name");

    let existing = null;
    let productionMap = {};
    if (userId) {
      const [rows] = await pool.query('SELECT * FROM attendance WHERE user_id = ? AND date = ?', [userId, date]);
      existing = rows[0] || null;
      if (existing) productionMap = await getProductionMap(existing.id);
    }

    const variants = userId ? await allVariantsIncludingInactive() : await activeVariants();

    res.render('admin/attendance-form', {
      user: req.session.user,
      date, userId, workers, existing, productionMap, variants
    });
  } catch (err) { next(err); }
});

router.post('/attendance/entry', async (req, res, next) => {
  try {
    const { user_id, date, present, notes } = req.body;
    const variants = await allVariantsIncludingInactive();
    const variantQuantities = variants.map(v => ({
      variantId: v.id,
      quantity: req.body['variant_' + v.id]
    }));

    await saveAttendance({
      userId: parseInt(user_id, 10), date, present, notes, variantQuantities, source: 'admin'
    });

    res.redirect('/admin/attendance?date=' + encodeURIComponent(date));
  } catch (err) { next(err); }
});

router.get('/attendance/export.csv', async (req, res, next) => {
  try {
    const [rows] = await pool.query(`
      SELECT a.date, u.name, a.present, a.bottles_filled, a.wage_mode, a.wage_amount, a.created_by, a.notes
      FROM attendance a JOIN users u ON u.id = a.user_id ORDER BY a.date DESC
    `);
    const csv = toCSV(rows, [
      { key: 'date', label: 'Date' },
      { key: 'name', label: 'Worker' },
      { key: 'present', label: 'Present' },
      { key: 'bottles_filled', label: 'Bottles Filled' },
      { key: 'wage_mode', label: 'Wage Mode' },
      { key: 'wage_amount', label: 'Wage Amount' },
      { key: 'created_by', label: 'Logged By' },
      { key: 'notes', label: 'Notes' }
    ]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="attendance.csv"');
    res.send(csv);
  } catch (err) { next(err); }
});

// Delete a whole day's attendance entry for one worker (also removes its per-variant production rows via cascade).
router.delete('/attendance/:id', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT date FROM attendance WHERE id = ?', [req.params.id]);
    await pool.query('DELETE FROM attendance WHERE id = ?', [req.params.id]);
    const redirectDate = rows[0] ? rows[0].date : todayStr();
    res.redirect('/admin/attendance?date=' + encodeURIComponent(redirectDate));
  } catch (err) { next(err); }
});

// ---------- INVENTORY (empty bottles) ----------
router.get('/inventory', async (req, res, next) => {
  try {
    const [purchases] = await pool.query(`
      SELECT p.*, t.name AS type_name, q.name AS quality_name
      FROM empty_bottle_purchases p
      LEFT JOIN bottle_variants v ON v.id = p.variant_id
      LEFT JOIN bottle_types t ON t.id = v.type_id
      LEFT JOIN bottle_qualities q ON q.id = v.quality_id
      ORDER BY p.date DESC, p.id DESC
    `);

    const { emptyStock, filledStock } = await getBottleTotals();

    const allVariants = await allVariantsIncludingInactive();
    const stockMap = await getVariantStockMap();
    const byVariant = allVariants.map(v => {
      const s = stockMap[v.id] || { emptyStock: 0, filledStock: 0 };
      return { ...v, emptyStock: s.emptyStock, filledStock: s.filledStock };
    });

    const [adjustments] = await pool.query(`
      SELECT a.*, t.name AS type_name, q.name AS quality_name
      FROM stock_adjustments a
      JOIN bottle_variants v ON v.id = a.variant_id
      JOIN bottle_types t ON t.id = v.type_id
      JOIN bottle_qualities q ON q.id = v.quality_id
      ORDER BY a.date DESC, a.id DESC
    `);

    const materials = await getMaterialsWithStock();
    const [materialPurchases] = await pool.query(`
      SELECT p.*, m.name AS material_name, m.unit
      FROM material_purchases p JOIN materials m ON m.id = p.material_id
      ORDER BY p.date DESC, p.id DESC
    `);
    const [materialAdjustments] = await pool.query(`
      SELECT a.*, m.name AS material_name, m.unit
      FROM material_adjustments a JOIN materials m ON m.id = a.material_id
      ORDER BY a.date DESC, a.id DESC
    `);

    res.render('admin/inventory', {
      user: req.session.user,
      purchases,
      emptyStock, filledStock,
      byVariant,
      variantsForPurchase: await activeVariants(),
      allVariants, adjustments,
      materials, materialPurchases, materialAdjustments,
      error: req.query.error || null
    });
  } catch (err) { next(err); }
});

// ---------- INVENTORY: opening stock / stock-count corrections (bottles) ----------
// Two ways to use the form:
//   mode "add"    - add (or, with a minus sign, remove) a quantity. Used for the stock you
//                   already had before the system was started, or to fix a small mistake.
//   mode "set_to" - you type what is physically on the shelf now and the system works out the
//                   difference itself and saves that as the adjustment. This is the one to use
//                   to clear a negative number.
// Either way the result is an adjustment row: it moves the stock number only, never money.
router.post('/inventory/adjust', async (req, res, next) => {
  try {
    const { date, variant_id, kind, mode, quantity, notes } = req.body;
    const variantId = parseInt(variant_id, 10);
    const bottleKind = kind === 'filled' ? 'filled' : 'empty';
    const entered = parseInt(quantity, 10);
    if (!variantId || Number.isNaN(entered)) {
      return res.redirect('/admin/inventory?error=' + encodeURIComponent('Pick a type/quality and enter a quantity.'));
    }

    let delta = entered;
    let note = (notes || '').trim();
    if (mode === 'set_to') {
      if (entered < 0) {
        return res.redirect('/admin/inventory?error=' + encodeURIComponent('The actual count cannot be negative.'));
      }
      const current = await getVariantStock(variantId);
      const now = bottleKind === 'filled' ? current.filledStock : current.emptyStock;
      delta = entered - now;
      if (delta === 0) return res.redirect('/admin/inventory');
      note = `Stock count: set to ${entered} (system showed ${now})` + (note ? ' - ' + note : '');
    }

    await pool.query(
      'INSERT INTO stock_adjustments (date, variant_id, kind, quantity, notes) VALUES (?, ?, ?, ?, ?)',
      [date || todayStr(), variantId, bottleKind, delta, note || null]
    );
    res.redirect('/admin/inventory');
  } catch (err) { next(err); }
});

router.delete('/inventory/adjust/:id', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM stock_adjustments WHERE id = ?', [req.params.id]);
    res.redirect('/admin/inventory');
  } catch (err) { next(err); }
});

// ---------- INVENTORY: raw materials (PET sheets, labels, bottle caps) ----------
router.post('/inventory/materials', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const unit = req.body.unit === 'pcs' ? 'pcs' : 'kg';
    if (!name) return res.redirect('/admin/inventory?error=' + encodeURIComponent('Enter a name for the material.'));
    await pool.query(
      'INSERT INTO materials (name, unit, low_stock_threshold) VALUES (?, ?, ?)',
      [name, unit, Math.max(0, round3(parseFloat(req.body.low_stock_threshold) || 0))]
    );
    res.redirect('/admin/inventory');
  } catch (e) {
    if (e.code === '23505') return res.redirect('/admin/inventory?error=' + encodeURIComponent('A material with that name already exists.'));
    next(e);
  }
});

router.post('/inventory/materials/:id/update', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.redirect('/admin/inventory?error=' + encodeURIComponent('A material needs a name.'));
    await pool.query(
      'UPDATE materials SET name = ?, low_stock_threshold = ?, active = ? WHERE id = ?',
      [name, Math.max(0, round3(parseFloat(req.body.low_stock_threshold) || 0)), req.body.active ? 1 : 0, req.params.id]
    );
    res.redirect('/admin/inventory');
  } catch (e) {
    if (e.code === '23505') return res.redirect('/admin/inventory?error=' + encodeURIComponent('A material with that name already exists.'));
    next(e);
  }
});

// Buying material: adds to stock and logs the cost as an expense (category materials_purchase),
// the same way empty-bottle purchases do. Both rows are saved together or not at all.
router.post('/inventory/materials/purchase', async (req, res, next) => {
  try {
    const { date, material_id, quantity, cost_total, supplier, notes } = req.body;
    const qty = round3(parseFloat(quantity));
    const cost = round2(parseFloat(cost_total) || 0);
    if (!parseInt(material_id, 10) || !(qty > 0)) {
      return res.redirect('/admin/inventory?error=' + encodeURIComponent('Pick a material and enter a quantity above zero.'));
    }
    await pool.transaction(async (q) => {
      const [found] = await q('SELECT name, unit FROM materials WHERE id = ?', [parseInt(material_id, 10)]);
      if (!found[0]) throw new Error('Material not found');
      const m = found[0];
      const [exp] = await q(
        `INSERT INTO expenses (date, category, amount, description) VALUES (?, 'materials_purchase', ?, ?) RETURNING id`,
        [date, cost, `Purchased ${qty} ${m.unit} ${m.name}${supplier ? ' from ' + supplier : ''}`]
      );
      await q(
        `INSERT INTO material_purchases (material_id, date, quantity, cost_total, supplier, notes, expense_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [parseInt(material_id, 10), date, qty, cost, supplier || null, notes || null, exp[0].id]
      );
    });
    res.redirect('/admin/inventory');
  } catch (err) { next(err); }
});

// Deleting a purchase also removes the expense it logged (they are linked), so the cost
// does not stay behind in Expenses after the stock is gone.
router.delete('/inventory/materials/purchase/:id', async (req, res, next) => {
  try {
    await pool.transaction(async (q) => {
      const [rows] = await q('SELECT expense_id FROM material_purchases WHERE id = ?', [req.params.id]);
      await q('DELETE FROM material_purchases WHERE id = ?', [req.params.id]);
      if (rows[0] && rows[0].expense_id) await q('DELETE FROM expenses WHERE id = ?', [rows[0].expense_id]);
    });
    res.redirect('/admin/inventory');
  } catch (err) { next(err); }
});

// Opening stock, used in production, wasted, or a correction. The person picks the reason and
// types a plain positive number; the sign is worked out here, so "used 25" can't be saved as +25
// by mistake. Only "correction" takes a sign from what was typed.
router.post('/inventory/materials/adjust', async (req, res, next) => {
  try {
    const { date, material_id, reason, quantity, notes } = req.body;
    const typed = round3(parseFloat(quantity));
    const why = ['opening', 'used', 'wasted', 'correction'].includes(reason) ? reason : 'used';
    if (!parseInt(material_id, 10) || Number.isNaN(typed) || typed === 0) {
      return res.redirect('/admin/inventory?error=' + encodeURIComponent('Pick a material and enter a quantity.'));
    }
    let signed = typed;
    if (why === 'opening') signed = Math.abs(typed);
    else if (why === 'used' || why === 'wasted') signed = -Math.abs(typed);
    await pool.query(
      'INSERT INTO material_adjustments (material_id, date, reason, quantity, notes) VALUES (?, ?, ?, ?, ?)',
      [parseInt(material_id, 10), date || todayStr(), why, signed, (notes || '').trim() || null]
    );
    res.redirect('/admin/inventory');
  } catch (err) { next(err); }
});

router.delete('/inventory/materials/adjust/:id', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM material_adjustments WHERE id = ?', [req.params.id]);
    res.redirect('/admin/inventory');
  } catch (err) { next(err); }
});

router.get('/inventory/materials/export.csv', async (req, res, next) => {
  try {
    const [rows] = await pool.query(`
      SELECT p.date, m.name AS material, m.unit, p.quantity, p.cost_total, p.supplier, p.notes
      FROM material_purchases p JOIN materials m ON m.id = p.material_id
      ORDER BY p.date DESC, p.id DESC
    `);
    const csv = toCSV(rows, [
      { key: 'date', label: 'Date' },
      { key: 'material', label: 'Material' },
      { key: 'unit', label: 'Unit' },
      { key: 'quantity', label: 'Quantity' },
      { key: 'cost_total', label: 'Cost Total' },
      { key: 'supplier', label: 'Supplier' },
      { key: 'notes', label: 'Notes' }
    ]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="material-purchases.csv"');
    res.send(csv);
  } catch (err) { next(err); }
});

router.post('/inventory/purchase', async (req, res, next) => {
  try {
    const { date, variant_id, quantity, cost_total, supplier, notes } = req.body;
    const [variantRows] = await pool.query(`
      SELECT t.name AS type_name, q.name AS quality_name
      FROM bottle_variants v JOIN bottle_types t ON t.id=v.type_id JOIN bottle_qualities q ON q.id=v.quality_id
      WHERE v.id = ?
    `, [variant_id]);
    const variant = variantRows[0];

    await pool.query(
      `INSERT INTO empty_bottle_purchases (variant_id, date, quantity, cost_total, supplier, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [parseInt(variant_id, 10) || null, date, parseInt(quantity, 10) || 0, parseFloat(cost_total) || 0, supplier || null, notes || null]
    );

    const variantDesc = variant ? `${variant.type_name} / ${variant.quality_name}` : 'bottles';
    await pool.query(
      `INSERT INTO expenses (date, category, amount, description) VALUES (?, 'bottles_purchase', ?, ?)`,
      [date, parseFloat(cost_total) || 0, `Purchased ${quantity} ${variantDesc} empty bottles${supplier ? ' from ' + supplier : ''}`]
    );

    res.redirect('/admin/inventory');
  } catch (err) { next(err); }
});

router.get('/inventory/export.csv', async (req, res, next) => {
  try {
    const [rows] = await pool.query(`
      SELECT p.date, t.name AS type_name, q.name AS quality_name, p.quantity, p.cost_total, p.supplier, p.notes
      FROM empty_bottle_purchases p
      LEFT JOIN bottle_variants v ON v.id = p.variant_id
      LEFT JOIN bottle_types t ON t.id = v.type_id
      LEFT JOIN bottle_qualities q ON q.id = v.quality_id
      ORDER BY p.date DESC
    `);
    const csv = toCSV(rows, [
      { key: 'date', label: 'Date' },
      { key: 'type_name', label: 'Type' },
      { key: 'quality_name', label: 'Quality' },
      { key: 'quantity', label: 'Quantity' },
      { key: 'cost_total', label: 'Cost Total' },
      { key: 'supplier', label: 'Supplier' },
      { key: 'notes', label: 'Notes' }
    ]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="empty-bottle-purchases.csv"');
    res.send(csv);
  } catch (err) { next(err); }
});

// Delete a purchase record. Note: this does NOT remove the matching auto-logged
// expense (there's no link between them) - delete that separately on the
// Expenses page if needed.
router.delete('/inventory/purchase/:id', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM empty_bottle_purchases WHERE id = ?', [req.params.id]);
    res.redirect('/admin/inventory');
  } catch (err) { next(err); }
});

// ---------- PRODUCTS (bottle types, qualities, variants) ----------
router.get('/products', async (req, res, next) => {
  try {
    const [types] = await pool.query('SELECT * FROM bottle_types ORDER BY name');
    const [qualities] = await pool.query('SELECT * FROM bottle_qualities ORDER BY name');
    const variants = await allVariantsIncludingInactive();
    res.render('admin/products', { user: req.session.user, types, qualities, variants });
  } catch (err) { next(err); }
});

router.post('/products/types', async (req, res, next) => {
  try {
    const { name } = req.body;
    const perPet = Math.max(1, parseInt(req.body.bottles_per_pet, 10) || 6);
    if (name && name.trim()) {
      try {
        await pool.query('INSERT INTO bottle_types (name, bottles_per_pet) VALUES (?, ?)', [name.trim(), perPet]);
        await ensureAllVariantsExist(pool);
      } catch (e) {
        if (e.code !== '23505') throw e; // duplicate name, ignore
      }
    }
    res.redirect('/admin/products');
  } catch (err) { next(err); }
});

router.post('/products/types/:id', async (req, res, next) => {
  try {
    const { name, active } = req.body;
    const perPet = Math.max(1, parseInt(req.body.bottles_per_pet, 10) || 6);
    await pool.query('UPDATE bottle_types SET name = ?, active = ?, bottles_per_pet = ? WHERE id = ?', [name, active ? 1 : 0, perPet, req.params.id]);
    res.redirect('/admin/products');
  } catch (err) { next(err); }
});

router.post('/products/qualities', async (req, res, next) => {
  try {
    const { name } = req.body;
    if (name && name.trim()) {
      try {
        await pool.query('INSERT INTO bottle_qualities (name) VALUES (?)', [name.trim()]);
        await ensureAllVariantsExist(pool);
      } catch (e) {
        if (e.code !== '23505') throw e;
      }
    }
    res.redirect('/admin/products');
  } catch (err) { next(err); }
});

router.post('/products/qualities/:id', async (req, res, next) => {
  try {
    const { name, active } = req.body;
    await pool.query('UPDATE bottle_qualities SET name = ?, active = ? WHERE id = ?', [name, active ? 1 : 0, req.params.id]);
    res.redirect('/admin/products');
  } catch (err) { next(err); }
});

router.post('/products/variants/:id', async (req, res, next) => {
  try {
    const { active } = req.body;
    await pool.query('UPDATE bottle_variants SET active = ? WHERE id = ?', [active ? 1 : 0, req.params.id]);
    res.redirect('/admin/products');
  } catch (err) { next(err); }
});

// ---------- DELIVERIES + INVOICES ----------
router.get('/deliveries', async (req, res, next) => {
  try {
    const [deliveries] = await pool.query(`
      SELECT d.*,
        (SELECT STRING_AGG(CONCAT(t.name, ' ', q.name, ' x', di.quantity), ', ')
         FROM delivery_items di
         JOIN bottle_variants v ON v.id = di.variant_id
         JOIN bottle_types t ON t.id = v.type_id
         JOIN bottle_qualities q ON q.id = v.quality_id
         WHERE di.delivery_id = d.id) AS breakdown
      FROM deliveries d ORDER BY d.date DESC, d.id DESC
    `);
    res.render('admin/deliveries', { user: req.session.user, deliveries });
  } catch (err) { next(err); }
});

// Everything the delivery form needs: bottle rows, the regular-customer picker
// (with balances), and each customer's last price per bottle type so it can be pre-filled.
async function deliveryFormData(req, extra = {}) {
  const variants = extra.variants || await activeVariants();
  const customers = (await listCustomersWithBalances()).filter(c => c.active);

  const [priceRows] = await pool.query(`
    SELECT d.customer_id, di.variant_id, di.price_per_bottle, di.crates, di.price_per_crate
    FROM delivery_items di
    JOIN deliveries d ON d.id = di.delivery_id
    WHERE di.id IN (
      SELECT MAX(di2.id)
      FROM delivery_items di2
      JOIN deliveries d2 ON d2.id = di2.delivery_id
      WHERE d2.customer_id IS NOT NULL AND di2.variant_id IS NOT NULL
      GROUP BY d2.customer_id, di2.variant_id
    )
  `);
  // Remembers whichever unit (bottles or crates) the customer was last billed in for
  // each bottle type, so the form can default back into it and prefill that price.
  const lastPrices = {};
  priceRows.forEach(r => {
    (lastPrices[r.customer_id] = lastPrices[r.customer_id] || {})[r.variant_id] = r.crates
      ? { unit: 'crate', price: r.price_per_crate }
      : { unit: 'bottle', price: r.price_per_bottle };
  });

  return {
    user: req.session.user, variants, customers, lastPrices,
    error: null, form: null, selectedCustomerId: '', ...extra
  };
}

router.get('/deliveries/new', async (req, res, next) => {
  try {
    // /admin/deliveries/new?customer=12 opens the form with that customer already chosen
    const wanted = parseInt(req.query.customer, 10);
    res.render('admin/delivery-form', await deliveryFormData(req, { selectedCustomerId: Number.isInteger(wanted) ? String(wanted) : '' }));
  } catch (err) { next(err); }
});

// Thrown for mistakes the person can fix (shown on the form), as opposed to real server errors.
class FormError extends Error {}

router.post('/deliveries', async (req, res, next) => {
  try {
    const {
      date, customer_id, client_name, destination, petrol_cost, notes,
      amount_paid, new_phone, new_opening_balance, save_customer
    } = req.body;
    const variants = await activeVariants();
    const showError = async (error) => res.render('admin/delivery-form', await deliveryFormData(req, {
      variants, error, form: req.body, selectedCustomerId: customer_id || ''
    }));

    // Each row can be entered either in bottles or in crates ("pets", 6 or 12 bottles depending on the type) - whichever
    // matches how the price was agreed with the customer. Either way the amount for that
    // row is just quantity-entered x price-entered, so the money is always exact; only
    // the bottle count (the stock/record unit) needs converting when it's crates.
    const items = variants.map(v => {
      const unit = req.body['unit_' + v.id] === 'crate' ? 'crate' : 'bottle';
      const enteredQty = parseInt(req.body['qty_' + v.id], 10) || 0;
      const enteredPrice = parseFloat(req.body['price_' + v.id]) || 0;
      const perPet = v.bottles_per_pet || 6;
      const quantity = unit === 'crate' ? enteredQty * perPet : enteredQty;
      const subtotal = round2(enteredQty * enteredPrice);
      return {
        variantId: v.id, quantity, subtotal,
        pricePerBottle: quantity > 0 ? round2(subtotal / quantity) : 0,
        crates: unit === 'crate' ? enteredQty : null,
        pricePerCrate: unit === 'crate' ? enteredPrice : null
      };
    }).filter(i => i.quantity > 0);

    if (items.length === 0) {
      return showError('Enter a quantity for at least one bottle type/quality.');
    }

    const totalBottles = items.reduce((s, i) => s + i.quantity, 0);
    const totalAmount = round2(items.reduce((s, i) => s + i.subtotal, 0));
    const paid = Math.max(0, round2(parseFloat(amount_paid) || 0));

    try {
      // One transaction: either the whole delivery is saved (customer, invoice
      // number, items, petrol expense) or none of it is.
      await pool.transaction(async (q) => {
        let customer = null;
        let clientName;

        if (customer_id) {
          // A regular customer picked from the list
          const [found] = await q('SELECT * FROM customers WHERE id = ?', [parseInt(customer_id, 10) || 0]);
          customer = found[0];
          if (!customer) throw new FormError('That customer could not be found. Please pick again.');
          clientName = customer.name;
        } else {
          // Someone new / one-time
          clientName = String(client_name || '').trim();
          if (!clientName) throw new FormError('Please enter the customer\'s name.');
          const existing = await findCustomerByName(clientName, q);
          if (existing) {
            throw new FormError(`"${existing.name}" is already in your Customers list. Pick them from the customer dropdown so their balance is tracked.`);
          }
          // Anyone who still owes money (or already owed some) has to be saved as a
          // customer - otherwise that debt would be lost track of.
          const owedBefore = round2(parseFloat(new_opening_balance) || 0);
          const stillOwes = round2(totalAmount - paid) !== 0;
          if (save_customer || owedBefore !== 0 || stillOwes) {
            const [ins] = await q(
              'INSERT INTO customers (name, phone, address, opening_balance) VALUES (?, ?, ?, ?) RETURNING id',
              [clientName, String(new_phone || '').trim() || null, String(destination || '').trim() || null, owedBefore]
            );
            customer = { id: ins[0].id, name: clientName };
          }
        }

        // Balance owed just before this delivery - frozen onto the invoice.
        const previousBalance = customer ? await getBalance(customer.id, q) : 0;
        const finalDestination = String(destination || '').trim() || (customer && customer.address) || null;

        const [counterRows] = await q('SELECT value FROM settings WHERE "key" = ?', ['invoice_counter']);
        const counter = parseInt(counterRows[0] && counterRows[0].value, 10) || 1000;
        const invoiceNumber = 'CD-' + counter;
        await q(
          'INSERT INTO settings ("key", value) VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET value = EXCLUDED.value',
          ['invoice_counter', String(counter + 1)]
        );

        const petrol = parseFloat(petrol_cost) || 0;
        const [rows] = await q(`
          INSERT INTO deliveries (date, client_name, destination, bottles_count, price_per_bottle, total_amount, petrol_cost, notes, invoice_number, customer_id, previous_balance, amount_paid)
          VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
          RETURNING id
        `, [date, clientName, finalDestination, totalBottles, totalAmount, petrol, notes || null, invoiceNumber,
            customer ? customer.id : null, previousBalance, paid]);

        const deliveryId = rows[0].id;
        for (const i of items) {
          await q(
            'INSERT INTO delivery_items (delivery_id, variant_id, quantity, price_per_bottle, subtotal, crates, price_per_crate) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [deliveryId, i.variantId, i.quantity, i.pricePerBottle, i.subtotal, i.crates, i.pricePerCrate]
          );
        }

        if (petrol > 0) {
          await q(
            `INSERT INTO expenses (date, category, amount, description) VALUES (?, 'petrol', ?, ?)`,
            [date, petrol, `Petrol for delivery to ${clientName}`]
          );
        }
      });
    } catch (err) {
      if (err instanceof FormError) return showError(err.message);
      throw err;
    }

    res.redirect('/admin/deliveries');
  } catch (err) { next(err); }
});

router.get('/deliveries/:id/invoice/:copyType', async (req, res, next) => {
  try {
    const [deliveryRows] = await pool.query('SELECT * FROM deliveries WHERE id = ?', [req.params.id]);
    const delivery = deliveryRows[0];
    if (!delivery) return res.status(404).send('Delivery not found');

    const [items] = await pool.query(`
      SELECT di.*, t.name AS type_name, q.name AS quality_name
      FROM delivery_items di
      LEFT JOIN bottle_variants v ON v.id = di.variant_id
      LEFT JOIN bottle_types t ON t.id = v.type_id
      LEFT JOIN bottle_qualities q ON q.id = v.quality_id
      WHERE di.delivery_id = ?
    `, [req.params.id]);
    const copyType = req.params.copyType === 'admin' ? 'admin' : 'client';

    const buffer = await generateInvoicePDF({ delivery, items, company: await getCompany(), copyType });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Content-Disposition', `attachment; filename="${delivery.invoice_number}-${copyType}.pdf"`);
    res.end(buffer);
  } catch (err) { next(err); }
});

// Delete a delivery (its line items go with it automatically). Note: this does
// NOT remove the matching auto-logged petrol expense (there's no link between
// them) - delete that separately on the Expenses page if needed. The invoice
// number is not reused.
router.delete('/deliveries/:id', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM deliveries WHERE id = ?', [req.params.id]);
    res.redirect('/admin/deliveries');
  } catch (err) { next(err); }
});

router.get('/deliveries/export.csv', async (req, res, next) => {
  try {
    const [rows] = await pool.query(`
      SELECT d.*,
        (d.previous_balance + d.total_amount - d.amount_paid) AS balance_due,
        (SELECT STRING_AGG(CONCAT(t.name, ' ', q.name, ' x', di.quantity, ' @', di.price_per_bottle), '; ')
         FROM delivery_items di
         JOIN bottle_variants v ON v.id = di.variant_id
         JOIN bottle_types t ON t.id = v.type_id
         JOIN bottle_qualities q ON q.id = v.quality_id
         WHERE di.delivery_id = d.id) AS breakdown
      FROM deliveries d ORDER BY d.date DESC
    `);
    const csv = toCSV(rows, [
      { key: 'date', label: 'Date' },
      { key: 'client_name', label: 'Client' },
      { key: 'destination', label: 'Destination' },
      { key: 'bottles_count', label: 'Bottles' },
      { key: 'breakdown', label: 'Breakdown (type quality x qty @price)' },
      { key: 'total_amount', label: 'Total Amount' },
      { key: 'previous_balance', label: 'Previous Balance' },
      { key: 'amount_paid', label: 'Paid At Delivery' },
      { key: 'balance_due', label: 'Balance Due After Delivery' },
      { key: 'petrol_cost', label: 'Petrol Cost' },
      { key: 'invoice_number', label: 'Invoice Number' },
      { key: 'notes', label: 'Notes' }
    ]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="deliveries.csv"');
    res.send(csv);
  } catch (err) { next(err); }
});

// ---------- EXPENSES ----------
router.get('/expenses', async (req, res, next) => {
  try {
    const [expenses] = await pool.query('SELECT * FROM expenses ORDER BY date DESC, id DESC');
    const [totalsByCategory] = await pool.query('SELECT category, COALESCE(SUM(amount),0) as total FROM expenses GROUP BY category');
    res.render('admin/expenses', { user: req.session.user, expenses, totalsByCategory });
  } catch (err) { next(err); }
});

router.post('/expenses', async (req, res, next) => {
  try {
    const { date, category, amount, description } = req.body;
    await pool.query('INSERT INTO expenses (date, category, amount, description) VALUES (?, ?, ?, ?)',
      [date, category, parseFloat(amount) || 0, description || null]);
    res.redirect('/admin/expenses');
  } catch (err) { next(err); }
});

router.delete('/expenses/:id', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM expenses WHERE id = ?', [req.params.id]);
    res.redirect('/admin/expenses');
  } catch (err) { next(err); }
});

router.get('/expenses/export.csv', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM expenses ORDER BY date DESC');
    const csv = toCSV(rows, [
      { key: 'date', label: 'Date' },
      { key: 'category', label: 'Category' },
      { key: 'amount', label: 'Amount' },
      { key: 'description', label: 'Description' }
    ]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="expenses.csv"');
    res.send(csv);
  } catch (err) { next(err); }
});

// ---------- MONTHLY REPORTS ----------
router.get('/reports', async (req, res, next) => {
  try {
    const [rows] = await pool.query(`
      SELECT DISTINCT TO_CHAR(date, 'YYYY-MM') AS ym FROM (
        SELECT date FROM attendance
        UNION SELECT date FROM deliveries
        UNION SELECT date FROM expenses
        UNION SELECT date FROM empty_bottle_purchases
        UNION SELECT date FROM material_purchases
      ) AS combined
      ORDER BY ym DESC
    `);
    const months = rows.map(r => r.ym);
    res.render('admin/reports', { user: req.session.user, months });
  } catch (err) { next(err); }
});

router.get('/reports/:year/:month/pdf', async (req, res, next) => {
  try {
    const { year, month } = req.params;
    const mm = String(month).padStart(2, '0');
    const prefix = `${year}-${mm}`;
    const monthStart = `${prefix}-01`;
    const monthEnd = `${prefix}-${String(lastDayOfMonth(year, month)).padStart(2, '0')}`;

    const one = async (sql, params) => (await pool.query(sql, params))[0][0].n;

    const revenue = await one(`SELECT COALESCE(SUM(total_amount),0) n FROM deliveries WHERE date BETWEEN ? AND ?`, [monthStart, monthEnd]);
    const wages = await one(`SELECT COALESCE(SUM(wage_amount),0) n FROM attendance WHERE date BETWEEN ? AND ?`, [monthStart, monthEnd]);
    const bottleCost = await one(`SELECT COALESCE(SUM(cost_total),0) n FROM empty_bottle_purchases WHERE date BETWEEN ? AND ?`, [monthStart, monthEnd]);
    const petrol = await one(`SELECT COALESCE(SUM(amount),0) n FROM expenses WHERE category='petrol' AND date BETWEEN ? AND ?`, [monthStart, monthEnd]);
    const maintenance = await one(`SELECT COALESCE(SUM(amount),0) n FROM expenses WHERE category='maintenance' AND date BETWEEN ? AND ?`, [monthStart, monthEnd]);
    const electricity = await one(`SELECT COALESCE(SUM(amount),0) n FROM expenses WHERE category='electricity' AND date BETWEEN ? AND ?`, [monthStart, monthEnd]);
    const otherExpenses = await one(`SELECT COALESCE(SUM(amount),0) n FROM expenses WHERE category='other' AND date BETWEEN ? AND ?`, [monthStart, monthEnd]);

    const bottlesFilled = await one(`SELECT COALESCE(SUM(bottles_filled),0) n FROM attendance WHERE date BETWEEN ? AND ?`, [monthStart, monthEnd]);
    const bottlesDelivered = await one(`SELECT COALESCE(SUM(bottles_count),0) n FROM deliveries WHERE date BETWEEN ? AND ?`, [monthStart, monthEnd]);
    const emptyBottlesPurchased = await one(`SELECT COALESCE(SUM(quantity),0) n FROM empty_bottle_purchases WHERE date BETWEEN ? AND ?`, [monthStart, monthEnd]);
    const deliveryCount = await one(`SELECT COUNT(*) n FROM deliveries WHERE date BETWEEN ? AND ?`, [monthStart, monthEnd]);

    const materialsCost = await one(`SELECT COALESCE(SUM(cost_total),0) n FROM material_purchases WHERE date BETWEEN ? AND ?`, [monthStart, monthEnd]);
    const { emptyStock: emptyStockNow, filledStock: filledStockNow } = await getBottleTotals();
    const materials = (await getMaterialsWithStock()).filter(m => m.active);

    const [workers] = await pool.query(`
      SELECT u.name,
        SUM(a.present) AS "daysPresent",
        COALESCE(SUM(a.bottles_filled),0) AS "bottlesFilled",
        COALESCE(SUM(a.wage_amount),0) AS "wagesPaid"
      FROM users u JOIN attendance a ON a.user_id = u.id
      WHERE a.date BETWEEN ? AND ?
      GROUP BY u.id, u.name ORDER BY u.name
    `, [monthStart, monthEnd]);

    const [topClients] = await pool.query(`
      SELECT client_name, SUM(bottles_count) AS bottles, SUM(total_amount) AS total
      FROM deliveries WHERE date BETWEEN ? AND ?
      GROUP BY client_name ORDER BY total DESC LIMIT 5
    `, [monthStart, monthEnd]);

    const [byVariant] = await pool.query(`
      SELECT t.name AS type_name, q.name AS quality_name,
        COALESCE(SUM(p.quantity),0) AS filled
      FROM bottle_variants v
      JOIN bottle_types t ON t.id = v.type_id
      JOIN bottle_qualities q ON q.id = v.quality_id
      LEFT JOIN production p ON p.variant_id = v.id
        AND p.attendance_id IN (SELECT id FROM attendance WHERE date BETWEEN ? AND ?)
      GROUP BY v.id, t.name, q.name
      HAVING COALESCE(SUM(p.quantity),0) > 0
      ORDER BY filled DESC
    `, [monthStart, monthEnd]);

    const monthLabel = new Date(`${prefix}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

    const buffer = await generateMonthlyReportPDF({
      company: await getCompany(),
      monthLabel,
      data: {
        revenue, wages, bottleCost, materialsCost, petrol, maintenance, electricity, otherExpenses, materials,
        bottlesFilled, bottlesDelivered, emptyBottlesPurchased, deliveryCount,
        emptyStockNow, filledStockNow, workers, topClients, byVariant
      }
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Content-Disposition', `attachment; filename="crystal-drinks-report-${prefix}.pdf"`);
    res.end(buffer);
  } catch (err) { next(err); }
});

// ---------- BACKUPS ----------
router.get('/settings/backup.json', async (req, res, next) => {
  try {
    const dump = await exportAllTablesAsJSON();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="crystal-drinks-backup-${todayStr()}.json"`);
    res.send(JSON.stringify(dump, null, 2));
  } catch (err) { next(err); }
});

// ---------- SETTINGS ----------
router.get('/settings', async (req, res, next) => {
  try {
    res.render('admin/settings', {
      user: req.session.user,
      settings: {
        company_name: await getSetting('company_name'),
        company_address: await getSetting('company_address'),
        company_phone: await getSetting('company_phone'),
        whatsapp_country_code: await getSetting('whatsapp_country_code'),
        wage_mode: await getSetting('wage_mode'),
        per_bottle_rate: await getSetting('per_bottle_rate'),
        low_stock_threshold_empty: await getSetting('low_stock_threshold_empty'),
        low_stock_threshold_filled: await getSetting('low_stock_threshold_filled')
      }
    });
  } catch (err) { next(err); }
});

router.post('/settings', async (req, res, next) => {
  try {
    const {
      company_name, company_address, company_phone, wage_mode, per_bottle_rate,
      low_stock_threshold_empty, low_stock_threshold_filled
    } = req.body;
    await setSetting('company_name', company_name || 'Crystal Drinks');
    await setSetting('company_address', company_address || '');
    await setSetting('company_phone', company_phone || '');
    await setSetting('whatsapp_country_code', String(req.body.whatsapp_country_code || '').replace(/\D/g, '') || '92');
    await setSetting('wage_mode', wage_mode === 'per_bottle' ? 'per_bottle' : 'per_day');
    await setSetting('per_bottle_rate', String(parseFloat(per_bottle_rate) || 0));
    await setSetting('low_stock_threshold_empty', String(parseInt(low_stock_threshold_empty, 10) || 0));
    await setSetting('low_stock_threshold_filled', String(parseInt(low_stock_threshold_filled, 10) || 0));
    res.redirect('/admin/settings');
  } catch (err) { next(err); }
});

module.exports = router;
