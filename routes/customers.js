const express = require('express');
const router = express.Router();
const pool = require('../db');
const { toCSV } = require('../lib/csv');
const {
  round2, listCustomersWithBalances, getCustomerWithBalance, findCustomerByName, getLedger
} = require('../lib/customerService');
const { getSetting } = require('../lib/attendanceService');
const { generateStatementPDF } = require('../lib/statement');
const wa = require('../lib/whatsapp');

// Mounted inside routes/admin.js, so requireAdmin already protects everything here.

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function parseId(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}
async function whatsappContext() {
  return {
    company: (await getSetting('company_name')) || 'Crystal Drinks',
    cc: (await getSetting('whatsapp_country_code')) || '92'
  };
}
function cleanText(v) {
  const s = String(v == null ? '' : v).trim();
  return s.length ? s : null;
}

// ---------- LIST ----------
router.get('/', async (req, res, next) => {
  try {
    const customers = await listCustomersWithBalances();
    // Biggest amount owed first, so the people to chase are at the top.
    customers.sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name));
    const owing = customers.filter(c => c.balance > 0);
    const totalOwed = round2(owing.reduce((s, c) => s + c.balance, 0));

    // Offer to build the customer list from past deliveries when there are unlinked names.
    const [[{ n: unlinkedNames }]] = await pool.query(
      'SELECT COUNT(DISTINCT LOWER(TRIM(client_name))) AS n FROM deliveries WHERE customer_id IS NULL'
    );

    const { company, cc } = await whatsappContext();
    customers.forEach(c => {
      c.reminderUrl = c.balance > 0
        ? wa.waLink(c.phone, wa.reminderText({ company, customerName: c.name, balance: c.balance, date: todayStr() }), cc)
        : null;
    });

    res.render('admin/customers', {
      user: req.session.user, customers, totalOwed, owingCount: owing.length, unlinkedNames
    });
  } catch (err) { next(err); }
});

router.get('/export.csv', async (req, res, next) => {
  try {
    const customers = await listCustomersWithBalances();
    const csv = toCSV(customers, [
      { key: 'name', label: 'Customer' },
      { key: 'phone', label: 'Phone' },
      { key: 'address', label: 'Address' },
      { key: 'opening_balance', label: 'Opening Balance' },
      { key: 'balance', label: 'Balance Owed' },
      { key: 'last_delivery', label: 'Last Delivery' },
      { key: 'notes', label: 'Notes' }
    ]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="customers.csv"');
    res.send(csv);
  } catch (err) { next(err); }
});

// Builds the customer list from the client names already typed on past deliveries,
// and links those old deliveries to them. Safe to click more than once.
// Past deliveries were marked "paid in full" on upgrade, so nobody ends up owing anything.
router.post('/import-from-deliveries', async (req, res, next) => {
  try {
    await pool.transaction(async (q) => {
      const [names] = await q(`
        SELECT LOWER(TRIM(client_name)) AS lname, MIN(TRIM(client_name)) AS name
        FROM deliveries
        WHERE customer_id IS NULL AND TRIM(client_name) <> ''
        GROUP BY LOWER(TRIM(client_name))
      `);
      for (const n of names) {
        const existing = await findCustomerByName(n.name, q);
        if (!existing) {
          await q('INSERT INTO customers (name) VALUES (?)', [n.name]);
        }
      }
      await q(`
        UPDATE deliveries
        SET customer_id = (SELECT c.id FROM customers c WHERE LOWER(c.name) = LOWER(TRIM(deliveries.client_name)) ORDER BY c.id LIMIT 1)
        WHERE customer_id IS NULL
          AND EXISTS (SELECT 1 FROM customers c WHERE LOWER(c.name) = LOWER(TRIM(deliveries.client_name)))
      `);
    });
    res.redirect('/admin/customers');
  } catch (err) { next(err); }
});

// ---------- ADD ----------
router.get('/new', (req, res) => {
  res.render('admin/customer-form', { user: req.session.user, customer: null, error: null, form: {} });
});

router.post('/', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const renderError = (error) =>
      res.render('admin/customer-form', { user: req.session.user, customer: null, error, form: req.body });

    if (!name) return renderError('Please enter the customer\'s name.');
    const existing = await findCustomerByName(name);
    if (existing) return renderError(`"${existing.name}" is already in your customer list.`);

    const [rows] = await pool.query(
      'INSERT INTO customers (name, phone, address, notes, opening_balance) VALUES (?, ?, ?, ?, ?) RETURNING id',
      [name, cleanText(req.body.phone), cleanText(req.body.address), cleanText(req.body.notes), round2(parseFloat(req.body.opening_balance))]
    );
    res.redirect('/admin/customers/' + rows[0].id);
  } catch (err) { next(err); }
});

// ---------- STATEMENT (one customer) ----------
async function renderDetail(req, res, id, extra = {}) {
  const customer = await getCustomerWithBalance(id);
  if (!customer) return res.status(404).send('Customer not found');
  const ledger = await getLedger(customer);
  const totalBilled = round2(ledger.reduce((s, e) => s + e.billed, 0));
  const totalPaid = round2(ledger.reduce((s, e) => s + e.paid, 0));
  const hasHistory = ledger.some(e => e.kind !== 'opening');

  const { company, cc } = await whatsappContext();
  const date = todayStr();
  const reminderUrl = customer.balance > 0
    ? wa.waLink(customer.phone, wa.reminderText({ company, customerName: customer.name, balance: customer.balance, date }), cc) : null;
  const statementUrl = wa.waLink(customer.phone, wa.statementText({ company, customerName: customer.name, balance: customer.balance, date }), cc);
  ledger.forEach(e => {
    if (e.kind === 'delivery') {
      e.whatsappUrl = wa.waLink(customer.phone, wa.invoiceText({
        company, customerName: customer.name, invoiceNumber: e.invoice_number || ('#' + e.id),
        date: e.date, billed: e.billed, paid: e.paid, balance: e.balance
      }), cc);
    }
  });

  res.render('admin/customer-detail', {
    user: req.session.user, customer, ledger, totalBilled, totalPaid, hasHistory,
    reminderUrl, statementUrl, hasPhone: !!wa.normalizePhone(customer.phone, cc),
    today: todayStr(), error: null, ...extra
  });
}

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).send('Customer not found');
    await renderDetail(req, res, id);
  } catch (err) { next(err); }
});

// ---------- EDIT ----------
router.get('/:id/edit', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const customer = id ? await getCustomerWithBalance(id) : null;
    if (!customer) return res.status(404).send('Customer not found');
    res.render('admin/customer-form', { user: req.session.user, customer, error: null, form: {} });
  } catch (err) { next(err); }
});

router.post('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const customer = id ? await getCustomerWithBalance(id) : null;
    if (!customer) return res.status(404).send('Customer not found');

    const name = String(req.body.name || '').trim();
    const renderError = (error) =>
      res.render('admin/customer-form', { user: req.session.user, customer, error, form: req.body });

    if (!name) return renderError('Please enter the customer\'s name.');
    const clash = await findCustomerByName(name, pool.query, id);
    if (clash) return renderError(`"${clash.name}" is already in your customer list.`);

    await pool.transaction(async (q) => {
      await q(
        'UPDATE customers SET name = ?, phone = ?, address = ?, notes = ?, opening_balance = ?, active = ? WHERE id = ?',
        [name, cleanText(req.body.phone), cleanText(req.body.address), cleanText(req.body.notes),
         round2(parseFloat(req.body.opening_balance)), req.body.active ? 1 : 0, id]
      );
      // Keep the name on their past deliveries in step, so monthly reports
      // ("top clients") don't split one customer into two after a rename.
      if (name !== customer.name) {
        await q('UPDATE deliveries SET client_name = ? WHERE customer_id = ?', [name, id]);
      }
    });
    res.redirect('/admin/customers/' + id);
  } catch (err) { next(err); }
});

// A customer can only be deleted if nothing has ever been recorded against them.
// Otherwise untick "Active" on the edit page to hide them from the delivery form.
router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).send('Customer not found');
    const [[{ n: deliveries }]] = await pool.query('SELECT COUNT(*) AS n FROM deliveries WHERE customer_id = ?', [id]);
    const [[{ n: payments }]] = await pool.query('SELECT COUNT(*) AS n FROM payments WHERE customer_id = ?', [id]);
    if (deliveries > 0 || payments > 0) {
      return renderDetail(req, res, id, {
        error: 'This customer has deliveries or payments on record, so they can\'t be deleted. Untick "Active" on the edit page to hide them instead.'
      });
    }
    await pool.query('DELETE FROM customers WHERE id = ?', [id]);
    res.redirect('/admin/customers');
  } catch (err) { next(err); }
});

// ---------- PAYMENTS ----------
router.post('/:id/payments', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const customer = id ? await getCustomerWithBalance(id) : null;
    if (!customer) return res.status(404).send('Customer not found');

    const amount = round2(parseFloat(req.body.amount));
    if (!(amount > 0)) {
      return renderDetail(req, res, id, { error: 'Enter the amount received (more than 0).' });
    }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '') ? req.body.date : todayStr();
    await pool.query(
      'INSERT INTO payments (customer_id, date, amount, notes) VALUES (?, ?, ?, ?)',
      [id, date, amount, cleanText(req.body.notes)]
    );
    res.redirect('/admin/customers/' + id);
  } catch (err) { next(err); }
});

router.delete('/:id/payments/:paymentId', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const paymentId = parseId(req.params.paymentId);
    if (!id || !paymentId) return res.status(404).send('Not found');
    await pool.query('DELETE FROM payments WHERE id = ? AND customer_id = ?', [paymentId, id]);
    res.redirect('/admin/customers/' + id);
  } catch (err) { next(err); }
});

// ---------- STATEMENT PDF ----------
router.get('/:id/statement.pdf', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const customer = id ? await getCustomerWithBalance(id) : null;
    if (!customer) return res.status(404).send('Customer not found');

    const ledger = (await getLedger(customer)).reverse(); // oldest first reads like a bank statement
    const company = {
      company_name: await getSetting('company_name'),
      company_address: await getSetting('company_address'),
      company_phone: await getSetting('company_phone')
    };
    const buffer = await generateStatementPDF({ customer, ledger, company, asOf: todayStr() });
    const safeName = customer.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'customer';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Content-Disposition', `attachment; filename="statement-${safeName}-${todayStr()}.pdf"`);
    res.end(buffer);
  } catch (err) { next(err); }
});

module.exports = router;
