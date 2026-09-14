'use strict';

/**
 * Staging canary — REAL providers only after fail-closed isolation + health PASS.
 *
 * Isolated Redis keys: kaching:staging:health:* (health) / canary Mongo tags soakRunId.
 * If isolation or health fails: STOP. Do not substitute mocks.
 *
 * Usage: node scripts/staging-canary.js
 */

const crypto = require('crypto');
const {
  loadEnvStaging,
  evaluateIsolation,
  REQUIRED_STAGING_DB
} = require('./lib/stagingIsolation');
const { runHealthProbes } = require('./lib/stagingHealthProbes');
const { runCanaryMatrix } = require('./lib/stagingCanaryMatrix');

async function pineContract() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('staging-canary refuses NODE_ENV=production');
  }
  const { generateForUser } = require('../services/PineScriptGeneratorService');
  const mint = strategy =>
    generateForUser(
      {
        _id: '507f1f77bcf86cd799439011',
        email: 'canary@test.com',
        tradingviewUsername: 'demo_trader',
        subscription: { tier: 'professional', status: 'active' }
      },
      { strategy }
    );
  const scalp = mint('scalping');
  const day = mint('daytrading');
  const codeOnly = src =>
    String(src || '')
      .split(/\r?\n/)
      .filter(line => !line.trimStart().startsWith('//'))
      .join('\n');
  const scalpCode = codeOnly(scalp.script);
  const dayCode = codeOnly(day.script);
  return {
    classification: 'SIMULATED',
    note: 'Generated Pine is not a live TradingView test',
    scalp: {
      pineClientVersion: scalp.pineClientVersion,
      canonicalTf: scalp.strategyArchitecture.canonicalSignalTimeframe,
      bakedCanonical: scalp.strategyArchitecture.bakedCanonicalSignalPine,
      alertCalls: (scalpCode.match(/\balert\s*\(/g) || []).length,
      authorityGate: /if barstate\.isrealtime and isCanonicalAuthorityChart/.test(scalpCode),
      freqAll: /alert\(livePayload, alert\.freq_all\)/.test(scalpCode),
      placeholderLeak: /\{\{[A-Z0-9_]+\}\}/.test(scalpCode)
    },
    day: {
      pineClientVersion: day.pineClientVersion,
      canonicalTf: day.strategyArchitecture.canonicalSignalTimeframe,
      bakedCanonical: day.strategyArchitecture.bakedCanonicalSignalPine,
      alertCalls: (dayCode.match(/\balert\s*\(/g) || []).length,
      authorityGate: /if barstate\.isrealtime and isCanonicalAuthorityChart/.test(dayCode),
      freqAll: /alert\(livePayload, alert\.freq_all\)/.test(dayCode),
      placeholderLeak: /\{\{[A-Z0-9_]+\}\}/.test(dayCode)
    }
  };
}

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
  const stagingFile = loadEnvStaging();
  const isolation = evaluateIsolation();

  if (!stagingFile.exists || !isolation.ok || isolation.loopbackDataPlane) {
    const report = {
      evidenceType: 'staging_canary',
      verdict: 'BLOCKED',
      failClosed: true,
      realStagingReached: false,
      runId,
      requiredDatabase: REQUIRED_STAGING_DB,
      pine: { status: 'NOT_RUN', reason: 'isolation_failed_canary_stopped' },
      scenarios: blockedMatrix('isolation_or_env_missing'),
      redis: { status: 'BLOCKED', evidence: 'canary stopped before Redis connect' },
      mongo: { status: 'BLOCKED', evidence: 'canary stopped before Mongo connect' },
      providers: { telegram: 'BLOCKED', email: 'BLOCKED' },
      tradingView: 'BLOCKED — LIVE TRADINGVIEW NOT AVAILABLE',
      blockers: [
        ...(stagingFile.exists ? [] : ['.env.staging missing']),
        ...(isolation.loopbackDataPlane
          ? ['loopback/localhost is not accepted as real kaching-api-staging']
          : []),
        ...isolation.blockers
      ],
      notes: [
        'Did not substitute mocks for the real-provider matrix.',
        'Did not fly deploy.',
        'Did not generate Pine inside the canary because isolation failed first.'
      ]
    };
    console.log(JSON.stringify(report, null, 2));
    process.exit(2);
  }

  const health = await runHealthProbes();
  if (health.verdict !== 'PASS') {
    const report = {
      evidenceType: 'staging_canary',
      verdict: 'BLOCKED',
      failClosed: true,
      realStagingReached: false,
      runId,
      health: health.verdict,
      scenarios: blockedMatrix('health_check_not_pass'),
      blockers: health.blockers,
      notes: ['Canary requires health PASS before any webhook or provider send.', 'Did not fly deploy.']
    };
    console.log(JSON.stringify(report, null, 2));
    process.exit(2);
  }

  const pine = await pineContract();
  const matrix = await runCanaryMatrix({ runId });
  const required = ['A_ENTRY', 'B_ENTRY_TP1', 'C_ENTRY_TP1_TP2_TP3', 'D_ENTRY_SL', 'E_DUPLICATE_WEBHOOK'];
  const requiredFailed = required.some(k => {
    const row = matrix.scenarios && matrix.scenarios[k];
    const status = row && row.status ? row.status : row;
    return status !== 'PASS';
  });

  const report = {
    evidenceType: 'staging_canary',
    verdict: matrix.executed && !requiredFailed ? 'PASS' : 'FAIL',
    failClosed: true,
    realStagingReached: Boolean(matrix.executed),
    runId,
    requiredDatabase: REQUIRED_STAGING_DB,
    pine,
    health: 'PASS',
    scenarios: matrix.scenarios,
    jobs: matrix.jobs || [],
    blockers: matrix.blockers || [],
    tradingView: 'BLOCKED — LIVE TRADINGVIEW NOT PART OF THIS API CANARY',
    notes: [
      'Required rows A–E must PASS for exit 0.',
      'F / I / J may remain BLOCKED without failing the API canary.',
      'Did not fly deploy.'
    ]
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.verdict === 'PASS' ? 0 : 2);
}

main().catch(err => {
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
});
