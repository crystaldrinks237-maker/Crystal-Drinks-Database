const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireWorker } = require('../middleware/auth');
const { activeVariants, getProductionMap, saveAttendance } = require('../lib/attendanceService');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

router.use(requireWorker);

router.get('/', async (req, res, next) => {
  try {
    const userId = req.session.user.id;
    const today = todayStr();

    const [todayRows] = await pool.query('SELECT * FROM attendance WHERE user_id = ? AND date = ?', [userId, today]);
    const todayEntry = todayRows[0] || null;

    const [history] = await pool.query(
      'SELECT * FROM attendance WHERE user_id = ? ORDER BY date DESC LIMIT 30', [userId]
    );

    const variants = await activeVariants();
    const productionMap = todayEntry ? await getProductionMap(todayEntry.id) : {};

    res.render('worker/dashboard', {
      user: req.session.user,
      today,
      todayEntry,
      history,
      variants,
      productionMap
    });
  } catch (err) {
    next(err);
  }
});

router.post('/attendance', async (req, res, next) => {
  try {
    const userId = req.session.user.id;
    const { date, present, notes } = req.body;

    const variants = await activeVariants();
    const variantQuantities = variants.map(v => ({
      variantId: v.id,
      quantity: req.body['variant_' + v.id]
    }));

    await saveAttendance({ userId, date, present, notes, variantQuantities, source: 'worker' });

    res.redirect('/worker');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
