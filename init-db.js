// Optional standalone command: sets up tables, default settings, bottle
// types/qualities, and the default admin account, then exits.
//
//   npm run init-db
//
// You don't strictly need to run this yourself - server.js runs the exact
// same setup automatically every time the app starts. This is here for
// convenience (e.g. running it as a one-off deploy step, or checking your
// database connection works before starting the full app).

require('dotenv').config();
const pool = require('./db');
const { runMigrations } = require('./lib/migrate');

runMigrations(pool)
  .then(() => {
    console.log('Database is set up and ready.');
    process.exit(0);
  })
  .catch(err => {
    console.error('Database setup failed:', err);
    console.error('Check your DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME settings.');
    process.exit(1);
  });
