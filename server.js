const express = require('express');
const session = require('express-session');
const path = require('path');
const methodOverride = require('method-override');
const pool = require('./db');
const { runMigrations } = require('./lib/migrate');
const { getOrCreateSessionSecret } = require('./lib/sessionSecret');

const app = express();
const PORT = process.env.PORT || 3000;

// The app may sit behind a hosting provider's reverse proxy (GoDaddy,
// Cloudflare, etc.) - trust its X-Forwarded-* headers so req.ip and
// "secure" cookie detection work correctly.
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: getOrCreateSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week
    secure: 'auto' // sends the cookie over HTTPS when available (hosted), plain HTTP otherwise (local dev)
  }
}));

app.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect(req.session.user.role === 'admin' ? '/admin' : '/worker');
  }
  res.redirect('/login');
});

app.use('/', require('./routes/auth'));
app.use('/admin', require('./routes/admin'));
app.use('/worker', require('./routes/worker'));

// Catch-all error handler for anything an async route handler passed to next(err).
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).send('Something went wrong on our end. Please try again, and let the admin know if it keeps happening.');
});

async function start() {
  try {
    console.log('Connecting to the database and applying any needed setup...');
    await runMigrations(pool);
    console.log('Database ready.');
  } catch (err) {
    console.error('\nFailed to set up the database. Check your DB_HOST / DB_USER / DB_PASSWORD / DB_NAME environment variables.');
    console.error(err);
    process.exit(1);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\nCrystal Drinks is running on port ${PORT}.`);
    console.log(`Locally: http://localhost:${PORT}`);
  });
}

start();
