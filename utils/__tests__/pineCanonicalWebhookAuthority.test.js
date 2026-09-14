/**
 * Pine 1.3.0 emit contract — no canonical-webhook-authority / viz-only gate.
 * Restored to match production Fly v155 (Sept 7-era) generator output.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { PINE_CLIENT_VERSION, CURRENT_PINE_CAPABILITIES } = require('../PineClientVersion');
const { generateForUser } = require('../../services/PineScriptGeneratorService');

function codeOnly(src) {
  return String(src || '')
    .split(/\r?\n/)
    .filter(line => !line.trimStart().startsWith('//'))
    .join('\n');
}

function mint(strategy) {
  process.env.TRADINGVIEW_WEBHOOK_SECRET =
    process.env.TRADINGVIEW_WEBHOOK_SECRET || 'smoke-test-tv-webhook-secret';
  process.env.WEBHOOK_SIGNING_SECRET =
    process.env.WEBHOOK_SIGNING_SECRET || 'smoke-test-license-signing-secret';
  return generateForUser(
    {
      _id: '507f1f77bcf86cd799439011',
      email: 'authority@test.com',
      tradingviewUsername: 'demo_trader',
      subscription: { tier: 'professional', status: 'active' }
    },
    { strategy }
  );
}

function assertEmitContract(g, { strategy, canonicalPine, canonicalLabel }) {
  assert.equal(g.pineClientVersion, '1.3.1', `${strategy} version`);
  assert.equal(g.capabilities.includes('canonical_webhook_authority_v1'), false);
  assert.equal(g.capabilities.includes('canonical_emit_independent_v1'), false);
  assert.match(g.script, new RegExp(`CANONICAL_SIGNAL_TF = "${canonicalPine}"`));
  assert.equal(g.strategyArchitecture.canonicalSignalTimeframe, canonicalLabel);
  assert.equal(g.strategyArchitecture.bakedCanonicalSignalPine, canonicalPine);

  const code = codeOnly(g.script);
  assert.equal((code.match(/\balert\s*\(/g) || []).length, 1, `${strategy}: one live alert() gateway`);
  assert.match(code, /isCanonicalChart\s*=\s*timeframe\.period\s*==\s*CANONICAL_SIGNAL_TF/);
  assert.doesNotMatch(code, /isCanonicalAuthorityChart/);
  assert.match(code, /if barstate\.isrealtime\s*\r?\n\s*kachingPushId\(ids, eventId\)\s*\r?\n\s*kachingFireAlert\(payload\)/);
  assert.match(code, /kachingFireAlert\(string payload\)\s*=>\s*\r?\n\s*alert\(payload, alert\.freq_all\)/);
  assert.doesNotMatch(code, /alert\(livePayload/);
  assert.doesNotMatch(code, /alertFiredAt = timenow/);
  assert.doesNotMatch(code, /ALERT VIZ ONLY/);
  assert.doesNotMatch(code, /visualization-only charts never call alert/i);

  assert.match(g.script, /emitKachingEvent\("entry"/);
  assert.match(g.script, /emitKachingEvent\("take_profit_1"/);
}

describe('Pine 1.3.0 emit (no webhook-authority gate)', () => {
  it('stamps 1.3.0 without authority capabilities', () => {
    assert.equal(PINE_CLIENT_VERSION, '1.3.1');
    assert.equal(CURRENT_PINE_CAPABILITIES.includes('canonical_webhook_authority_v1'), false);
    assert.equal(CURRENT_PINE_CAPABILITIES.includes('canonical_emit_independent_v1'), false);
  });

  it('SCALP generated: 3m canonical; alert fires on realtime without authority gate', () => {
    const g = mint('scalping');
    assertEmitContract(g, { strategy: 'scalping', canonicalPine: '3', canonicalLabel: '3m' });
    assert.match(g.instructions[0], /1m, 3m, or 5m/);
    assert.doesNotMatch(g.instructions.join('\n'), /visualization-only/i);
    assert.doesNotMatch(g.instructions.join('\n'), /must not have webhook alerts/i);
  });

  it('DAY generated: 5m canonical; alert fires on realtime without authority gate', () => {
    const g = mint('daytrading');
    assertEmitContract(g, { strategy: 'daytrading', canonicalPine: '5', canonicalLabel: '5m' });
    assert.match(g.instructions[0], /5m or 15m/);
    assert.doesNotMatch(g.instructions.join('\n'), /visualization-only/i);
  });
});
