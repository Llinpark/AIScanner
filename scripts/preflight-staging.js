'use strict';

/**
 * Staging preflight — fail closed.
 * Does not deploy, does not print secrets, does not mutate data.
 *
 * Usage: node scripts/preflight-staging.js
 * Exit 0 = isolation flags + dedicated staging config present.
 * Exit 2 = blocked (missing or production-like).
 */

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  loadEnvStaging,
  evaluateIsolation,
  probePort,
  present
} = require('./lib/stagingIsolation');

async function main() {
  const stagingFile = loadEnvStaging();
  const examplePath = path.join(ROOT, '.env.staging.example');
  const isolation = evaluateIsolation();

  const redisLocal = await probePort('127.0.0.1', 6379);
  const mongoLocal = await probePort('127.0.0.1', 27017);
  const apiLocal = await probePort('127.0.0.1', Number(process.env.PORT || 4000));

  const blockers = [...isolation.blockers];
  if (!stagingFile.exists) {
    blockers.push('.env.staging is missing — copy .env.staging.example and fill dedicated non-production values');
  }

  const report = {
    evidenceType: 'preflight',
    verdict: blockers.length ? 'BLOCKED' : 'PASS',
    failClosed: true,
    realStagingReached: false,
    isolationOk: isolation.ok && stagingFile.exists,
    files: {
      envStaging: stagingFile.exists ? 'present' : 'missing',
      envStagingExample: fs.existsSync(examplePath) ? 'present' : 'missing',
      flyStagingToml: fs.existsSync(path.join(ROOT, 'fly.staging.toml')) ? 'present' : 'missing',
      envStagingKeys: stagingFile.keys,
      flyTomlApp: 'kaching-api (production; this script does not deploy it)',
      flyStagingApp: 'kaching-api-staging (config only; this script does not deploy)'
    },
    flags: isolation.flags,
    services: {
      API: {
        status: present('PUBLIC_BACKEND_URL') ? 'configured' : 'missing',
        host: isolation.apiHostRedacted,
        localPort: apiLocal ? 'reachable' : 'unreachable'
      },
      MongoDB: {
        status: present('MONGODB_URI') ? (isolation.mongo.blocked ? 'blocked' : 'configured') : 'missing',
        database: isolation.mongo.dbName || 'unknown',
        host: isolation.mongo.hostRedacted,
        local27017: mongoLocal ? 'reachable' : 'unreachable'
      },
      Redis: {
        status: present('REDIS_URL') ? (isolation.redis.blocked ? 'blocked' : 'configured') : 'missing',
        host: isolation.redis.hostRedacted,
        local6379: redisLocal ? 'reachable' : 'unreachable'
      },
      Telegram: {
        status:
          present('TELEGRAM_BOT_TOKEN') && present('STAGING_TELEGRAM_CHAT_ID') ? 'configured' : 'missing',
        enabledFlag: isolation.flags.STAGING_TELEGRAM_ENABLED
      },
      Email: {
        status:
          present('STAGING_EMAIL_TO') &&
          present('EMAIL_FROM') &&
          present('SMTP2GO_API_KEY')
            ? 'configured'
            : 'missing',
        enabledFlag: isolation.flags.STAGING_EMAIL_ENABLED
      },
      TradingViewWebhook: {
        status: present('PUBLIC_BACKEND_URL') ? 'configured' : 'missing',
        host: isolation.apiHostRedacted
      }
    },
    blockers,
    next: isolation.ok && stagingFile.exists
      ? ['Run: node scripts/staging-health-check.js', 'If health PASS: node scripts/staging-canary.js']
      : [
          'See STAGING_SETUP.md',
          'cp .env.staging.example .env.staging  then fill isolated credentials',
          'node scripts/generate-staging-secrets.js',
          'Never fly deploy (uses production fly.toml). Staging deploy is fly deploy -a kaching-api-staging -c fly.staging.toml after operator review.'
        ]
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(blockers.length ? 2 : 0);
}

main().catch(err => {
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
});
