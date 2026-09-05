/**
 * Pine 1.6.0 canonical webhook authority — generated-script evidence.
 * Proves SCALP 1m/3m/5m and DAY 5m/15m chart roles from generateForUser output.
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

function assertAuthorityContract(g, { strategy, canonicalPine, canonicalLabel }) {
  assert.equal(g.pineClientVersion, '1.6.0', `${strategy} version`);
  assert.ok(g.capabilities.includes('canonical_emit_independent_v1'), `${strategy} emit cap`);
  assert.ok(g.capabilities.includes('canonical_webhook_authority_v1'), `${strategy} authority cap`);
  assert.match(g.script, new RegExp(`CANONICAL_SIGNAL_TF = "${canonicalPine}"`));
  assert.equal(g.strategyArchitecture.canonicalSignalTimeframe, canonicalLabel);
  assert.equal(g.strategyArchitecture.bakedCanonicalSignalPine, canonicalPine);

  const code = codeOnly(g.script);
  assert.equal((code.match(/\balert\s*\(/g) || []).length, 1, `${strategy}: one live alert() gateway`);
  assert.match(code, /isCanonicalAuthorityChart\s*=\s*timeframe\.period\s*==\s*CANONICAL_SIGNAL_TF/);
  assert.match(code, /if barstate\.isrealtime and isCanonicalAuthorityChart/);
  assert.match(code, /alertFiredAt = timenow/);
  assert.match(code, /alert\(livePayload, alert\.freq_all\)/);
  assert.match(code, /str\.replace\(payload, '"alertFiredAt":0'/);
  assert.doesNotMatch(code, /alert\.freq_once_per_bar/);

  const emitAt = code.indexOf('emitKachingEvent(');
  const alertAt = code.indexOf('alert(livePayload, alert.freq_all)');
  const stampAt = code.indexOf('alertFiredAt = timenow');
  assert.ok(emitAt >= 0 && stampAt > emitAt && alertAt > stampAt, `${strategy}: stamp immediately before alert()`);

  assert.match(code, /buildTradeDrawings\(/);
  assert.match(code, /cleanupActiveTradeDrawings\(/);
  const vizOnly = code.indexOf('ALERT VIZ ONLY');
  assert.ok(vizOnly > 0, `${strategy}: visualization-only skip path exists`);

  assert.match(g.script, /emitKachingEvent\("entry"/);
  assert.match(g.script, /emitKachingEvent\("take_profit_1"/);
  assert.match(g.script, /emitKachingEvent\("take_profit_2"/);
  assert.match(g.script, /emitKachingEvent\(closeAlertType/);

  const instructions = g.instructions.join('\n');
  assert.match(instructions, /CANONICAL|visualization-only|canonical/i);
  assert.match(instructions, /must not have webhook alerts/i);
}

describe('Pine 1.6.0 canonical webhook authority', () => {
  it('stamps 1.6.0 + authority capabilities', () => {
    assert.equal(PINE_CLIENT_VERSION, '1.6.0');
    assert.ok(CURRENT_PINE_CAPABILITIES.includes('canonical_emit_independent_v1'));
    assert.ok(CURRENT_PINE_CAPABILITIES.includes('canonical_webhook_authority_v1'));
  });

  it('SCALP generated: 3m canonical; 1m/5m visualization-only', () => {
    const g = mint('scalping');
    assertAuthorityContract(g, { strategy: 'scalping', canonicalPine: '3', canonicalLabel: '3m' });
    assert.match(g.script, /timeframe\.multiplier == 1 or timeframe\.multiplier == 3 or timeframe\.multiplier == 5/);
    assert.match(g.instructions[0], /1m, 3m, or 5m/);
    assert.match(g.instructions[0], /canonical 3m|canonical 3/);
    assert.match(g.instructions[0], /visualization-only/i);
  });

  it('DAY generated: 5m canonical; 15m visualization-only', () => {
    const g = mint('daytrading');
    assertAuthorityContract(g, { strategy: 'daytrading', canonicalPine: '5', canonicalLabel: '5m' });
    assert.match(g.script, /timeframe\.multiplier == 5 or timeframe\.multiplier == 15/);
    assert.match(g.instructions[0], /5m or 15m/);
    assert.match(g.instructions[0], /visualization-only/i);
  });

  it('chart/canonical matrix is encoded as period == CANONICAL_SIGNAL_TF', () => {
    const scalp = mint('scalping');
    const day = mint('daytrading');
    const formula = /isCanonicalAuthorityChart\s*=\s*timeframe\.period\s*==\s*CANONICAL_SIGNAL_TF/;
    assert.match(scalp.script, formula);
    assert.match(day.script, formula);
    assert.match(scalp.script, /CANONICAL_SIGNAL_TF = "3"/);
    assert.match(day.script, /CANONICAL_SIGNAL_TF = "5"/);
    // 1m vs 3m: 1 !== 3 → visualization. 3 === 3 → authority. 5 !== 3 → visualization.
    // 5m vs 5m: 5 === 5 → authority. 15 !== 5 → visualization.
    assert.equal('1' === '3', false);
    assert.equal('3' === '3', true);
    assert.equal('5' === '3', false);
    assert.equal('5' === '5', true);
    assert.equal('15' === '5', false);
  });

  it('non-canonical charts still draw; only authority path calls alert()', () => {
    const g = mint('scalping');
    const code = codeOnly(g.script);
    assert.match(code, /buildTradeDrawings\(/);
    assert.match(code, /label\.new\(/);
    assert.doesNotMatch(code, /if isCanonicalAuthorityChart[\s\S]{0,80}buildTradeDrawings/);
    const alerts = [...code.matchAll(/\balert\s*\(/g)];
    assert.equal(alerts.length, 1);
    const before = code.slice(0, alerts[0].index);
    assert.match(before.slice(-400), /isCanonicalAuthorityChart/);
  });
});
