'use strict';

process.env.NODE_ENV = 'test';
process.env.TRADINGVIEW_WEBHOOK_SECRET =
  process.env.TRADINGVIEW_WEBHOOK_SECRET || 'smoke-test-tv-webhook-secret';
process.env.WEBHOOK_SIGNING_SECRET =
  process.env.WEBHOOK_SIGNING_SECRET || 'smoke-test-license-signing-secret';

const { generateForUser } = require('../services/PineScriptGeneratorService');

function mint(strategy) {
  return generateForUser(
    {
      _id: '507f1f77bcf86cd799439011',
      email: 'evidence@test.com',
      tradingviewUsername: 'demo_trader',
      subscription: { tier: 'professional', status: 'active' }
    },
    { strategy }
  );
}

function quoteAround(script, needle, radius = 180) {
  const i = script.indexOf(needle);
  if (i < 0) return `MISSING: ${needle}`;
  return script.slice(Math.max(0, i - 40), Math.min(script.length, i + needle.length + radius));
}

for (const strategy of ['scalping', 'daytrading']) {
  const g = mint(strategy);
  console.log(`\n===== ${strategy.toUpperCase()} =====`);
  console.log(`pineClientVersion=${g.pineClientVersion}`);
  console.log(`capabilities=${JSON.stringify(g.capabilities)}`);
  console.log(`CANONICAL_SIGNAL_TF baked=${g.strategyArchitecture.bakedCanonicalSignalPine}`);
  console.log(`canonicalSignalTimeframe=${g.strategyArchitecture.canonicalSignalTimeframe}`);
  console.log('--- isCanonicalAuthorityChart ---');
  console.log(quoteAround(g.script, 'isCanonicalAuthorityChart = timeframe.period == CANONICAL_SIGNAL_TF', 80));
  console.log('--- emit gateway ---');
  console.log(quoteAround(g.script, 'if barstate.isrealtime and isCanonicalAuthorityChart', 280));
  console.log('--- alertFiredAt ---');
  console.log(quoteAround(g.script, 'alertFiredAt = timenow', 160));
  console.log('--- alert() count ---');
  const code = g.script
    .split(/\r?\n/)
    .filter(l => !l.trimStart().startsWith('//'))
    .join('\n');
  console.log(`alert() calls=${(code.match(/\balert\s*\(/g) || []).length}`);
  console.log('--- instruction lead ---');
  console.log(g.instructions[0]);
}
