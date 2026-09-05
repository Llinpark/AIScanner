'use strict';

/**
 * Controlled local/staging soak runner.
 * Does not deploy. Does not claim live TradingView/Email/Telegram unless those
 * providers are actually configured and this process reaches them.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.KACHING_TEST_ONLY = process.env.KACHING_TEST_ONLY || '1';
process.env.TRADINGVIEW_WEBHOOK_SECRET =
  process.env.TRADINGVIEW_WEBHOOK_SECRET || 'smoke-test-tv-webhook-secret';
process.env.WEBHOOK_SIGNING_SECRET =
  process.env.WEBHOOK_SIGNING_SECRET || 'smoke-test-license-signing-secret';

const net = require('net');
const fs = require('fs');
const path = require('path');
const { generateForUser } = require('../services/PineScriptGeneratorService');

function probePort(host, port, timeoutMs = 700) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const done = ok => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

function mint(strategy) {
  return generateForUser(
    {
      _id: '507f1f77bcf86cd799439011',
      email: 'soak@test.com',
      tradingviewUsername: 'demo_trader',
      subscription: { tier: 'professional', status: 'active' }
    },
    { strategy }
  );
}

function codeOnly(src) {
  return String(src || '')
    .split(/\r?\n/)
    .filter(line => !line.trimStart().startsWith('//'))
    .join('\n');
}

async function main() {
  const redisLocal = await probePort('127.0.0.1', 6379);
  const mongoLocal = await probePort('127.0.0.1', 27017);
  const hasStagingEnv = fs.existsSync(path.join(__dirname, '..', '.env.staging'));
  const hasCompose = ['docker-compose.yml', 'docker-compose.yaml'].some(f =>
    fs.existsSync(path.join(__dirname, '..', f))
  );

  const scalp = mint('scalping');
  const day = mint('daytrading');
  const scalpCode = codeOnly(scalp.script);
  const dayCode = codeOnly(day.script);

  const report = {
    evidenceType: 'local_controlled_soak',
    realStagingReached: false,
    realTradingViewTest: false,
    realEmailTest: false,
    realTelegramTest: false,
    realRedisTest: Boolean(process.env.REDIS_URL) && redisLocal === false ? 'url_set_not_probed' : redisLocal,
    environment: {
      NODE_ENV: process.env.NODE_ENV,
      REDIS_URL_SET: Boolean(process.env.REDIS_URL),
      REDIS_ENABLED: process.env.REDIS_ENABLED || null,
      MONGODB_URI_SET: Boolean(process.env.MONGODB_URI),
      redisLocal6379: redisLocal,
      mongoLocal27017: mongoLocal,
      hasStagingEnv,
      hasDockerCompose: hasCompose,
      flyTomlApp: 'kaching-api (production config; this script does not deploy)'
    },
    pine: {
      scalp: {
        pineClientVersion: scalp.pineClientVersion,
        canonicalTf: scalp.strategyArchitecture.canonicalSignalTimeframe,
        bakedCanonical: scalp.strategyArchitecture.bakedCanonicalSignalPine,
        alertCalls: (scalpCode.match(/\balert\s*\(/g) || []).length,
        authorityGate: /if barstate\.isrealtime and isCanonicalAuthorityChart/.test(scalpCode)
      },
      day: {
        pineClientVersion: day.pineClientVersion,
        canonicalTf: day.strategyArchitecture.canonicalSignalTimeframe,
        bakedCanonical: day.strategyArchitecture.bakedCanonicalSignalPine,
        alertCalls: (dayCode.match(/\balert\s*\(/g) || []).length,
        authorityGate: /if barstate\.isrealtime and isCanonicalAuthorityChart/.test(dayCode)
      }
    },
    next: [
      'Run: node --test services/__tests__/stagingSoakValidation.test.js',
      'Run focused Pine / sequencer / parity / recovery suites',
      'Run full npm test',
      'Do not treat this script as a live TradingView or provider soak'
    ]
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
