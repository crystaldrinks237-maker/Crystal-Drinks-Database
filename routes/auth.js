const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const pool = require('../db');

// Basic protection against password guessing now that the app can be reached
// from the internet, not just your Wi-Fi. In-memory is fine for a
// single-process app like this; it resets on restart, which is acceptable.
const failedAttempts = new Map(); // ip -> { count, firstAttemptAt }
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

function isRateLimited(ip) {
  const entry = failedAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.firstAttemptAt > WINDOW_MS) {
    failedAttempts.delete(ip);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}
function recordFailure(ip) {
  const entry = failedAttempts.get(ip);
  if (!entry || Date.now() - entry.firstAttemptAt > WINDOW_MS) {
    failedAttempts.set(ip, { count: 1, firstAttemptAt: Date.now() });
  } else {
    entry.count += 1;
  }
}
function clearFailures(ip) {
  failedAttempts.delete(ip);
}

router.get('/login', (req, res) => {
  if (req.session.user) {
    return res.redirect(req.session.user.role === 'admin' ? '/admin' : '/worker');
  }
  res.render('login', { error: null });
});

router.post('/login', async (req, res, next) => {
  try {
    if (isRateLimited(req.ip)) {
      return res.render('login', { error: 'Too many attempts. Please wait a few minutes and try again.' });
    }

    const { username, password } = req.body;
    const [rows] = await pool.query('SELECT * FROM users WHERE username = ? AND active = 1', [username]);
    const user = rows[0];

    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      recordFailure(req.ip);
      return res.render('login', { error: 'Invalid username or password.' });
    }

    clearFailures(req.ip);
    req.session.user = { id: user.id, name: user.name, username: user.username, role: user.role };
    res.redirect(user.role === 'admin' ? '/admin' : '/worker');
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

router.post('/change-password', async (req, res, next) => {
  if (!req.session.user) return res.redirect('/login');
  try {
    const { current_password, new_password } = req.body;
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
    const user = rows[0];

    if (!user || !bcrypt.compareSync(current_password, user.password_hash)) {
      return res.redirect(req.get('Referer') || '/');
    }
    const hash = bcrypt.hashSync(new_password, 10);
    await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, user.id]);
    res.redirect(user.role === 'admin' ? '/admin/settings' : '/worker');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
