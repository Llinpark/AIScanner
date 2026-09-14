'use strict';

/**
 * Local integration health — NOT cloud staging.
 * Loopback Mongo/Redis/API are allowed only in this mode.
 *
 * Usage: node scripts/health-local-canary.js
 */

const {
  loadEnvLocalCanary,
  evaluateLocalIntegration,
  REQUIRED_LOCAL_CANARY_DB,
  truthy
} = require('./lib/stagingIsolation');
const { runHealthProbes } = require('./lib/stagingHealthProbes');

async function main() {
  const envFile = loadEnvLocalCanary();
  const isolation = evaluateLocalIntegration();
  if (!envFile.exists || !isolation.ok) {
    const report = {
      evidenceType: 'local_integration_health',
      classification: 'REAL LOCAL-INTEGRATION',
      verdict: 'BLOCKED',
      cloudStaging: 'NOT THIS MODE',
      probes: {},
      blockers: [...(envFile.exists ? [] : ['.env.local-canary missing']), ...isolation.blockers],
      forbidden: ['Did not connect because isolation failed', 'Did not fly deploy']
    };
    require('fs').writeSync(1, JSON.stringify(report, null, 2) + '\n');
    process.exit(2);
  }

  const health = await runHealthProbes({
    allowLoopback: true,
    requiredDatabase: REQUIRED_LOCAL_CANARY_DB,
    requireTelegram: truthy('LOCAL_INTEGRATION_TELEGRAM_ENABLED'),
    requireEmail: truthy('LOCAL_INTEGRATION_EMAIL_ENABLED'),
    requireApi: true
  });

  const report = {
    evidenceType: 'local_integration_health',
    classification: 'REAL LOCAL-INTEGRATION',
    verdict: health.verdict,
    cloudStaging: 'NOT THIS MODE — do not call this REAL STAGING',
    requiredDatabase: REQUIRED_LOCAL_CANARY_DB,
    probes: health.probes,
    blockers: health.blockers,
    forbidden: ['Did not fly deploy', 'Did not FLUSHALL', 'Did not send subscriber messages']
  };
  require('fs').writeSync(1, JSON.stringify(report, null, 2) + '\n');
  process.exit(health.verdict === 'PASS' ? 0 : 2);
}

main().catch(err => {
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
});
