const crypto = require('crypto');

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function verificationExpiry() {
  return new Date(Date.now() + VERIFICATION_TTL_MS);
}

function resetExpiry() {
  return new Date(Date.now() + RESET_TTL_MS);
}

module.exports = {
  generateToken,
  hashToken,
  verificationExpiry,
  resetExpiry,
  VERIFICATION_TTL_MS,
  RESET_TTL_MS
};
