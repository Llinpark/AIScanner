'use strict';

/**
 * Local integration canary — NOT cloud staging, NOT production.
 * Runs only after local isolation + health PASS.
 *
 * Usage: node scripts/canary-local-canary.js
 */

const crypto = require('crypto');
const {
  loadEnvLocalCanary,
  evaluateLocalIntegration,
  REQUIRED_LOCAL_CANARY_DB,
  truthy
} = require('./lib/stagingIsolation');
const { runHealthProbes } = require('./lib/stagingHealthProbes');
const { runCanaryMatrix } = require('./lib/stagingCanaryMatrix');

function blockedMatrix(reason) {
  return {
    A_ENTRY: 'BLOCKED',
    B_ENTRY_TP1: 'BLOCKED',
    C_ENTRY_TP1_TP2_TP3: 'BLOCKED',
    D_ENTRY_SL: 'BLOCKED',
    E_DUPLICATE_WEBHOOK: 'BLOCKED',
    F_CHANNEL_INDEPENDENCE: 'BLOCKED',
    G_REDIS: 'BLOCKED',
    H_MONGODB: 'BLOCKED',
    I_PROCESS_RECOVERY: 'BLOCKED',
    J_ADMIN_OBSERVABILITY: 'BLOCKED',
    reason
  };
}

async function main() {
  const runId = `r${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  const envFile = loadEnvLocalCanary();
  const isolation = evaluateLocalIntegration();

  if (!envFile.exists || !isolation.ok) {
    const report = {
      evidenceType: 'local_integration_canary',
      classification: 'REAL LOCAL-INTEGRATION',
      verdict: 'BLOCKED',
      cloudStaging: 'NOT THIS MODE',
      runId,
      requiredDatabase: REQUIRED_LOCAL_CANARY_DB,
      scenarios: blockedMatrix('isolation_or_env_missing'),
      blockers: [...(envFile.exists ? [] : ['.env.local-canary missing']), ...isolation.blockers]
    };
    require('fs').writeSync(1, JSON.stringify(report, null, 2) + '\n');
    process.exit(2);
  }

  const requireTelegram = truthy('LOCAL_INTEGRATION_TELEGRAM_ENABLED');
  const requireEmail = truthy('LOCAL_INTEGRATION_EMAIL_ENABLED');
  const health = await runHealthProbes({
    allowLoopback: true,
    requiredDatabase: REQUIRED_LOCAL_CANARY_DB,
    requireTelegram,
    requireEmail,
    requireApi: true
  });
  if (health.verdict !== 'PASS') {
    const report = {
      evidenceType: 'local_integration_canary',
      classification: 'REAL LOCAL-INTEGRATION',
      verdict: 'BLOCKED',
      cloudStaging: 'NOT THIS MODE',
      runId,
      scenarios: blockedMatrix('health_check_not_pass'),
      blockers: health.blockers
    };
    require('fs').writeSync(1, JSON.stringify(report, null, 2) + '\n');
    process.exit(2);
  }

  const matrix = await runCanaryMatrix({
    runId,
    requiredDatabase: REQUIRED_LOCAL_CANARY_DB,
    passLabel: 'REAL LOCAL-INTEGRATION PASS',
    requireTelegram,
    requireEmail
  });
  const required = ['A_ENTRY', 'B_ENTRY_TP1', 'C_ENTRY_TP1_TP2_TP3', 'D_ENTRY_SL', 'E_DUPLICATE_WEBHOOK', 'G_REDIS', 'H_MONGODB'];
  const requiredFailed = required.some(k => {
    const row = matrix.scenarios && matrix.scenarios[k];
    const status = row && row.status ? row.status : row;
    return status !== 'PASS';
  });

  const report = {
    evidenceType: 'local_integration_canary',
    classification: 'REAL LOCAL-INTEGRATION',
    verdict: matrix.executed && !requiredFailed ? 'PASS' : 'FAIL',
    cloudStaging: 'NOT THIS MODE — do not call this REAL STAGING',
    runId,
    requiredDatabase: REQUIRED_LOCAL_CANARY_DB,
    health: 'PASS',
    scenarios: matrix.scenarios,
    jobs: matrix.jobs || [],
    blockers: matrix.blockers || [],
    tradingView: 'BLOCKED — live TradingView is optional and not this API canary',
    notes: [
      'This is LOCAL REAL-INTEGRATION, not cloud staging, not production.',
      'Telegram/Email are REAL only when LOCAL_INTEGRATION_*_ENABLED=true and test credentials are set.'
    ]
  };
  require('fs').writeSync(1, JSON.stringify(report, null, 2) + '\n');
  process.exit(report.verdict === 'PASS' ? 0 : 2);
}

main().catch(err => {
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
});
