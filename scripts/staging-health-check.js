'use strict';

/**
 * Staging health check — fail closed on production-like config.
 * Never FLUSHALL/FLUSHDB. Never prints credentials.
 * Does not send trading signals.
 *
 * Usage: node scripts/staging-health-check.js
 * Exit 0 = PASS. Exit 2 = BLOCKED or FAIL.
 */

const { loadEnvStaging, evaluateIsolation } = require('./lib/stagingIsolation');
const { runHealthProbes } = require('./lib/stagingHealthProbes');

async function main() {
  const stagingFile = loadEnvStaging();
  const isolation = evaluateIsolation();
  if (!stagingFile.exists || !isolation.ok || isolation.loopbackDataPlane) {
    const report = {
      evidenceType: 'health_check',
      verdict: 'BLOCKED',
      failClosed: true,
      realStagingReached: false,
      probes: {},
      blockers: [
        ...(stagingFile.exists ? [] : ['.env.staging missing']),
        ...(isolation.loopbackDataPlane
          ? ['loopback/localhost is not accepted as real kaching-api-staging']
          : []),
        ...isolation.blockers
      ],
      forbidden: [
        'Did not connect to Redis/Mongo because isolation failed or target is loopback',
        'Did not fly deploy'
      ]
    };
    console.log(JSON.stringify(report, null, 2));
    process.exit(2);
  }

  const health = await runHealthProbes();
  const report = {
    evidenceType: 'health_check',
    verdict: health.verdict,
    failClosed: true,
    realStagingReached: health.realStagingReached,
    probes: health.probes,
    blockers: health.blockers,
    forbidden: [
      'Did not fly deploy',
      'Did not FLUSHALL/FLUSHDB',
      'Did not send Telegram or Email trade alerts',
      'Did not mutate subscriber collections'
    ]
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(health.verdict === 'PASS' ? 0 : 2);
}

main().catch(err => {
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
});
