function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'admin') return res.status(403).send('Admins only.');
  next();
}

function requireWorker(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'worker') return res.status(403).send('Workers only.');
  next();
}

module.exports = { requireLogin, requireAdmin, requireWorker };
