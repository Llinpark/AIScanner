'use strict';

/**
 * Local integration preflight — NOT cloud staging.
 * Loads only .env.local-canary. Does not connect, send, or write.
 *
 * Usage: node scripts/preflight-local-canary.js
 */

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  loadEnvLocalCanary,
  evaluateLocalIntegration,
  probePort,
  present,
  REQUIRED_LOCAL_CANARY_DB
} = require('./lib/stagingIsolation');

async function main() {
  const envFile = loadEnvLocalCanary();
  const isolation = evaluateLocalIntegration();
  const redisLocal = await probePort('127.0.0.1', 6379);
  const mongoLocal = await probePort('127.0.0.1', 27017);
  const apiLocal = await probePort('127.0.0.1', Number(process.env.PORT || 4010));

  const blockers = [...isolation.blockers];
  if (!envFile.exists) {
    blockers.push('.env.local-canary is missing — copy .env.local-canary.example and fill local-only values');
  }

  const report = {
    evidenceType: 'local_integration_preflight',
    classification: 'REAL LOCAL-INTEGRATION',
    verdict: blockers.length ? 'BLOCKED' : 'PASS',
    cloudStaging: 'NOT THIS MODE',
    requiredDatabase: REQUIRED_LOCAL_CANARY_DB,
    isolationOk: isolation.ok && envFile.exists,
    files: {
      envLocalCanary: envFile.exists ? 'present' : 'missing',
      envLocalCanaryExample: fs.existsSync(path.join(ROOT, '.env.local-canary.example'))
        ? 'present'
        : 'missing'
    },
    flags: isolation.flags,
    ports: {
      mongo27017: mongoLocal ? 'reachable' : 'unreachable',
      redis6379: redisLocal ? 'reachable' : 'unreachable',
      api: apiLocal ? 'reachable' : 'unreachable'
    },
    mongo: isolation.mongo,
    redis: isolation.redis,
    api: { host: isolation.apiHostRedacted, configured: present('PUBLIC_BACKEND_URL') },
    blockers,
    next: isolation.ok && envFile.exists
      ? ['node scripts/health-local-canary.js', 'If health PASS: node scripts/canary-local-canary.js']
      : ['See LOCAL_INTEGRATION.md', 'Never fly deploy. Never use production Mongo/Redis.']
  };
  require('fs').writeSync(1, JSON.stringify(report, null, 2) + '\n');
  process.exit(blockers.length ? 2 : 0);
}

main().catch(err => {
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
});
