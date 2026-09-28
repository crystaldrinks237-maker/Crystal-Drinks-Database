const pool = require('../db');

/** Rounds to 2 decimal places (avoids 0.1 + 0.2 = 0.30000000000000004 style surprises). */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * The ONE definition of "how much does this customer owe us":
 *
 *   opening balance (what they owed before using this system)
 *   + everything billed on their deliveries
 *   - what they paid at the time of those deliveries
 *   - payments received separately afterwards
 *
 * Positive = they owe us. Negative = they've paid ahead (credit).
 * Nothing is stored, so deleting a delivery or a payment can never leave a
 * stale balance behind. Expects the customers table aliased as "c".
 */
const BALANCE_SQL = `(c.opening_balance
  + COALESCE((SELECT SUM(d.total_amount - d.amount_paid) FROM deliveries d WHERE d.customer_id = c.id), 0)
  - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.customer_id = c.id), 0))`;

/** All customers, each with a computed .balance and .last_delivery date. `query` can be a transaction's query fn. */
async function listCustomersWithBalances(query = pool.query) {
  const [rows] = await query(`
    SELECT c.*,
      ${BALANCE_SQL} AS balance,
      (SELECT MAX(d.date) FROM deliveries d WHERE d.customer_id = c.id) AS last_delivery
    FROM customers c
    ORDER BY c.name
  `);
  return rows.map(r => ({ ...r, balance: round2(r.balance) }));
}

/** One customer with computed .balance, or null. */
async function getCustomerWithBalance(id, query = pool.query) {
  const [rows] = await query(`SELECT c.*, ${BALANCE_SQL} AS balance FROM customers c WHERE c.id = ?`, [id]);
  if (!rows[0]) return null;
  return { ...rows[0], balance: round2(rows[0].balance) };
}

/** Just the balance number for a customer (0 if they don't exist). */
async function getBalance(id, query = pool.query) {
  const c = await getCustomerWithBalance(id, query);
  return c ? c.balance : 0;
}

/** Case-insensitive lookup by name, ignoring stray spaces. Optionally ignore one id (used when renaming). */
async function findCustomerByName(name, query = pool.query, ignoreId = null) {
  const [rows] = await query('SELECT * FROM customers WHERE LOWER(name) = LOWER(?)', [String(name || '').trim()]);
  return rows.find(r => r.id !== ignoreId) || null;
}

/**
 * The customer's full statement, newest first, each row carrying the running
 * balance as it stood right after that row.
 * Row shape: { kind: 'opening'|'delivery'|'payment', id, date, description, billed, paid, balance, invoice_number? }
 */
async function getLedger(customer, query = pool.query) {
  const [deliveries] = await query(
    'SELECT id, date, invoice_number, total_amount, amount_paid, created_at FROM deliveries WHERE customer_id = ?',
    [customer.id]
  );
  const [payments] = await query(
    'SELECT id, date, amount, notes, created_at FROM payments WHERE customer_id = ?',
    [customer.id]
  );

  const entries = [];
  const opening = round2(customer.opening_balance);
  if (opening !== 0) {
    entries.push({
      kind: 'opening', id: 0, date: '', sortCreated: '',
      description: opening > 0 ? 'Balance owed before using this system' : 'Credit before using this system',
      billed: opening > 0 ? opening : 0,
      paid: opening < 0 ? -opening : 0
    });
  }
  deliveries.forEach(d => entries.push({
    kind: 'delivery', id: d.id, date: d.date, sortCreated: String(d.created_at || ''),
    description: 'Delivery - invoice ' + (d.invoice_number || '#' + d.id),
    invoice_number: d.invoice_number,
    billed: round2(d.total_amount), paid: round2(d.amount_paid)
  }));
  payments.forEach(p => entries.push({
    kind: 'payment', id: p.id, date: p.date, sortCreated: String(p.created_at || ''),
    description: 'Payment received' + (p.notes ? ' - ' + p.notes : ''),
    billed: 0, paid: round2(p.amount)
  }));

  entries.sort((a, b) =>
    String(a.date).localeCompare(String(b.date)) ||
    a.sortCreated.localeCompare(b.sortCreated) ||
    a.id - b.id
  );

  let running = 0;
  entries.forEach(e => {
    running = round2(running + e.billed - e.paid);
    e.balance = running;
  });
  return entries.reverse();
}

module.exports = { round2, BALANCE_SQL, listCustomersWithBalances, getCustomerWithBalance, getBalance, findCustomerByName, getLedger };
