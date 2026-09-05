'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'utils/signalOutcome.js',
  'services/SignalOutcomeService.js',
  'services/TradeLifecycleService.js',
  'utils/mailer.js',
  'utils/deliveryIdempotency.js',
  'services/PipelineStatusService.js',
  'utils/durableDelivery.js',
  'utils/tradeEventIdentity.js',
  'Dockerfile',
  'fly.toml',
  'package.json'
];

const label = process.argv[2] || 'hash';
for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    console.log(`MISSING\t${rel}`);
    continue;
  }
  const hash = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  console.log(`${label}\t${hash}\t${rel}`);
}
