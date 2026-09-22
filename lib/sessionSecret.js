const crypto = require('crypto');

// On a hosted platform, the filesystem may not persist or may not be shared
// across restarts/instances, so the session secret should come from an
// environment variable (SESSION_SECRET) rather than a local file.
// If none is set, we generate one for this process only - sessions will
// simply reset (everyone logged out) whenever the app restarts, which is
// safe but a little inconvenient. Set SESSION_SECRET in your hosting
// provider's environment variables to avoid that.
function getOrCreateSessionSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim()) {
    return process.env.SESSION_SECRET.trim();
  }
  console.warn(
    '[session] No SESSION_SECRET environment variable set - generating a ' +
    'temporary one for this run. Everyone will be logged out on the next ' +
    'restart. Set SESSION_SECRET in your hosting provider\'s environment ' +
    'variables to fix this permanently.'
  );
  return crypto.randomBytes(48).toString('hex');
}

module.exports = { getOrCreateSessionSecret };
