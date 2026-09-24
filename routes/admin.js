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

router.use(requireAdmin);

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
    const [[{ n: emptyPurchased }]] = await pool.query('SELECT COALESCE(SUM(quantity),0) AS n FROM empty_bottle_purchases');
    const [[{ n: totalFilled }]] = await pool.query('SELECT COALESCE(SUM(bottles_filled),0) AS n FROM attendance');
    const [[{ n: totalDelivered }]] = await pool.query('SELECT COALESCE(SUM(bottles_count),0) AS n FROM deliveries');

    const emptyStock = emptyPurchased - totalFilled;
    const filledStock = totalFilled - totalDelivered;

    const [[{ n: totalRevenue }]] = await pool.query('SELECT COALESCE(SUM(total_amount),0) AS n FROM deliveries');
    const [[{ n: totalWages }]] = await pool.query('SELECT COALESCE(SUM(wage_amount),0) AS n FROM attendance');
    const [[{ n: totalExpenses }]] = await pool.query('SELECT COALESCE(SUM(amount),0) AS n FROM expenses');
    const [[{ n: totalBottleCost }]] = await pool.query('SELECT COALESCE(SUM(cost_total),0) AS n FROM empty_bottle_purchases');

    const today = todayStr();
    const [todaysAttendance] = await pool.query(
      'SELECT a.*, u.name FROM attendance a JOIN users u ON u.id = a.user_id WHERE a.date = ?', [today]
    );
    const [recentDeliveries] = await pool.query('SELECT * FROM deliveries ORDER BY date DESC, id DESC LIMIT 5');

    const lowStockEmptyThreshold = parseInt((await getSetting('low_stock_threshold_empty')) || '200', 10);
    const lowStockFilledThreshold = parseInt((await getSetting('low_stock_threshold_filled')) || '100', 10);

    res.render('admin/dashboard', {
      user: req.session.user,
      emptyStock, filledStock,
      lowStockEmptyThreshold, lowStockFilledThreshold,
      lowEmpty: emptyStock < lowStockEmptyThreshold,
      lowFilled: filledStock < lowStockFilledThreshold,
      totalRevenue, totalWages, totalExpenses, totalBottleCost,
      netEstimate: totalRevenue - totalWages - totalExpenses - totalBottleCost,
      todaysAttendance, recentDeliveries, today
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

    const [[{ n: emptyPurchased }]] = await pool.query('SELECT COALESCE(SUM(quantity),0) AS n FROM empty_bottle_purchases');
    const [[{ n: totalFilled }]] = await pool.query('SELECT COALESCE(SUM(bottles_filled),0) AS n FROM attendance');
    const [[{ n: totalDelivered }]] = await pool.query('SELECT COALESCE(SUM(bottles_count),0) AS n FROM deliveries');

    const allVariants = await allVariantsIncludingInactive();
    const byVariant = [];
    for (const v of allVariants) {
      const [[{ n: purchased }]] = await pool.query('SELECT COALESCE(SUM(quantity),0) n FROM empty_bottle_purchases WHERE variant_id = ?', [v.id]);
      const [[{ n: filled }]] = await pool.query('SELECT COALESCE(SUM(p.quantity),0) n FROM production p WHERE p.variant_id = ?', [v.id]);
      const [[{ n: delivered }]] = await pool.query('SELECT COALESCE(SUM(di.quantity),0) n FROM delivery_items di WHERE di.variant_id = ?', [v.id]);
      byVariant.push({ ...v, emptyStock: purchased - filled, filledStock: filled - delivered });
    }

    res.render('admin/inventory', {
      user: req.session.user,
      purchases,
      emptyStock: emptyPurchased - totalFilled,
      filledStock: totalFilled - totalDelivered,
      byVariant,
      variantsForPurchase: await activeVariants()
    });
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
    if (name && name.trim()) {
      try {
        await pool.query('INSERT INTO bottle_types (name) VALUES (?)', [name.trim()]);
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
    await pool.query('UPDATE bottle_types SET name = ?, active = ? WHERE id = ?', [name, active ? 1 : 0, req.params.id]);
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

router.get('/deliveries/new', async (req, res, next) => {
  try {
    res.render('admin/delivery-form', { user: req.session.user, delivery: null, variants: await activeVariants() });
  } catch (err) { next(err); }
});

router.post('/deliveries', async (req, res, next) => {
  try {
    const { date, client_name, destination, petrol_cost, notes } = req.body;
    const variants = await activeVariants();

    const items = variants.map(v => {
      const quantity = parseInt(req.body['qty_' + v.id], 10) || 0;
      const price = parseFloat(req.body['price_' + v.id]) || 0;
      return { variantId: v.id, quantity, price, subtotal: quantity * price };
    }).filter(i => i.quantity > 0);

    if (items.length === 0) {
      return res.render('admin/delivery-form', {
        user: req.session.user, delivery: null, variants,
        error: 'Enter a quantity for at least one bottle type/quality.'
      });
    }

    const totalBottles = items.reduce((s, i) => s + i.quantity, 0);
    const totalAmount = items.reduce((s, i) => s + i.subtotal, 0);

    let counter = parseInt((await getSetting('invoice_counter')) || '1000', 10);
    const invoiceNumber = 'CD-' + counter;
    await setSetting('invoice_counter', String(counter + 1));

    const [rows] = await pool.query(`
      INSERT INTO deliveries (date, client_name, destination, bottles_count, price_per_bottle, total_amount, petrol_cost, notes, invoice_number)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
      RETURNING id
    `, [date, client_name, destination || null, totalBottles, totalAmount, parseFloat(petrol_cost) || 0, notes || null, invoiceNumber]);

    const deliveryId = rows[0].id;
    for (const i of items) {
      await pool.query(
        'INSERT INTO delivery_items (delivery_id, variant_id, quantity, price_per_bottle, subtotal) VALUES (?, ?, ?, ?, ?)',
        [deliveryId, i.variantId, i.quantity, i.price, i.subtotal]
      );
    }

    if (parseFloat(petrol_cost) > 0) {
      await pool.query(
        `INSERT INTO expenses (date, category, amount, description) VALUES (?, 'petrol', ?, ?)`,
        [date, parseFloat(petrol_cost), `Petrol for delivery to ${client_name}`]
      );
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

    const emptyPurchasedAllTime = await one('SELECT COALESCE(SUM(quantity),0) n FROM empty_bottle_purchases', []);
    const filledAllTime = await one('SELECT COALESCE(SUM(bottles_filled),0) n FROM attendance', []);
    const deliveredAllTime = await one('SELECT COALESCE(SUM(bottles_count),0) n FROM deliveries', []);
    const emptyStockNow = emptyPurchasedAllTime - filledAllTime;
    const filledStockNow = filledAllTime - deliveredAllTime;

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
        revenue, wages, bottleCost, petrol, maintenance, electricity, otherExpenses,
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
    await setSetting('wage_mode', wage_mode === 'per_bottle' ? 'per_bottle' : 'per_day');
    await setSetting('per_bottle_rate', String(parseFloat(per_bottle_rate) || 0));
    await setSetting('low_stock_threshold_empty', String(parseInt(low_stock_threshold_empty, 10) || 0));
    await setSetting('low_stock_threshold_filled', String(parseInt(low_stock_threshold_filled, 10) || 0));
    res.redirect('/admin/settings');
  } catch (err) { next(err); }
});

module.exports = router;
