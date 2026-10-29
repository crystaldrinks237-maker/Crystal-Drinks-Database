const pool = require('../db');

/** Rounds to 3 decimal places (kg quantities), avoiding floating-point noise like 0.1 + 0.2. */
function round3(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

/** Shows a material quantity the way people read it: kg up to 3 decimals (trailing zeros dropped), pcs as whole numbers. */
function fmtQty(n, unit) {
  if (unit === 'pcs') return String(Math.round(Number(n) || 0));
  const v = round3(n);
  return Number.isInteger(v) ? String(v) : String(parseFloat(v.toFixed(3)));
}

async function one(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows[0].n;
}

/**
 * The ONE definition of bottle stock, used by the dashboard, Inventory page and monthly report:
 *
 *   empty stock  = empty bottles purchased + empty adjustments - bottles filled
 *   filled stock = bottles filled + filled adjustments - bottles delivered
 *
 * "Adjustments" are the opening-stock / stock-count entries (stock_adjustments table).
 */
async function getBottleTotals() {
  const purchased = await one('SELECT COALESCE(SUM(quantity),0) AS n FROM empty_bottle_purchases');
  const filled = await one('SELECT COALESCE(SUM(bottles_filled),0) AS n FROM attendance');
  const delivered = await one('SELECT COALESCE(SUM(bottles_count),0) AS n FROM deliveries');
  const adjEmpty = await one("SELECT COALESCE(SUM(quantity),0) AS n FROM stock_adjustments WHERE kind = 'empty'");
  const adjFilled = await one("SELECT COALESCE(SUM(quantity),0) AS n FROM stock_adjustments WHERE kind = 'filled'");
  return {
    purchased, filled, delivered, adjEmpty, adjFilled,
    emptyStock: purchased + adjEmpty - filled,
    filledStock: filled + adjFilled - delivered
  };
}

/** Per-variant stock, as a map: variant id -> { emptyStock, filledStock, ... }. Same formulas as above, per type/quality. */
async function getVariantStockMap() {
  const map = {};
  const slot = id => (map[id] = map[id] || { purchased: 0, produced: 0, delivered: 0, adjEmpty: 0, adjFilled: 0 });

  const [purchased] = await pool.query('SELECT variant_id, SUM(quantity) AS n FROM empty_bottle_purchases WHERE variant_id IS NOT NULL GROUP BY variant_id');
  purchased.forEach(r => { slot(r.variant_id).purchased = r.n; });
  const [produced] = await pool.query('SELECT variant_id, SUM(quantity) AS n FROM production GROUP BY variant_id');
  produced.forEach(r => { slot(r.variant_id).produced = r.n; });
  const [delivered] = await pool.query('SELECT variant_id, SUM(quantity) AS n FROM delivery_items WHERE variant_id IS NOT NULL GROUP BY variant_id');
  delivered.forEach(r => { slot(r.variant_id).delivered = r.n; });
  const [adj] = await pool.query('SELECT variant_id, kind, SUM(quantity) AS n FROM stock_adjustments GROUP BY variant_id, kind');
  adj.forEach(r => { slot(r.variant_id)[r.kind === 'empty' ? 'adjEmpty' : 'adjFilled'] = r.n; });

  Object.values(map).forEach(s => {
    s.emptyStock = s.purchased + s.adjEmpty - s.produced;
    s.filledStock = s.produced + s.adjFilled - s.delivered;
  });
  return map;
}

const EMPTY_SLOT = { purchased: 0, produced: 0, delivered: 0, adjEmpty: 0, adjFilled: 0, emptyStock: 0, filledStock: 0 };

/** Current computed stock for a single variant (used by the "set to actual count" form). */
async function getVariantStock(variantId) {
  const map = await getVariantStockMap();
  return map[variantId] || { ...EMPTY_SLOT };
}

/** Every material with .purchased, .adjusted, .stock and .low (below its warning level). */
async function getMaterialsWithStock() {
  const [rows] = await pool.query(`
    SELECT m.*,
      COALESCE((SELECT SUM(quantity) FROM material_purchases WHERE material_id = m.id), 0) AS purchased,
      COALESCE((SELECT SUM(quantity) FROM material_adjustments WHERE material_id = m.id), 0) AS adjusted
    FROM materials m
    ORDER BY m.active DESC, m.name
  `);
  return rows.map(m => {
    const stock = round3(m.purchased + m.adjusted);
    return {
      ...m, stock,
      low: !!m.active && m.low_stock_threshold > 0 && stock < m.low_stock_threshold
    };
  });
}

module.exports = { round3, fmtQty, getBottleTotals, getVariantStockMap, getVariantStock, getMaterialsWithStock };
