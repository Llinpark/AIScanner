'use strict';

/**
 * Print NEW staging-only secrets to stdout. Does not write files.
 * Does not read production .env or Fly secrets.
 *
 * Usage: node scripts/generate-staging-secrets.js
 */

const crypto = require('crypto');

function secret() {
  return crypto.randomBytes(32).toString('hex');
}

console.log('# Unique STAGING secrets — paste into .env.staging and:');
console.log('#   fly secrets set -a kaching-api-staging -c fly.staging.toml ...');
console.log('# Do NOT copy these from production. Do NOT commit them.');
console.log('');
console.log(`JWT_SECRET=${secret()}`);
console.log(`WEBHOOK_SIGNING_SECRET=${secret()}`);
console.log(`TRADINGVIEW_WEBHOOK_SECRET=${secret()}`);
console.log(`TELEGRAM_WEBHOOK_SECRET=${secret()}`);
