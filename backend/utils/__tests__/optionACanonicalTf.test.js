/**
 * Option A — one canonical signal across allowed entry/display timeframes.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  STRATEGY_ARCHITECTURE,
  buildPineTfVariables,
  tfToPine
} = require('../../strategies/config/strategyArchitecture');
const ActiveSignalRegistry = require('../activeSignalRegistry');
const TradeLifecycleService = require('../../services/TradeLifecycleService');
const { buildSignalData } = require('../../services/TradingViewAlertService');
const { PINE_CLIENT_VERSION, CURRENT_PINE_CAPABILITIES, resolveCompatibilityMode, COMPAT_MODE } = require('../PineClientVersion');

const SCALP_TPL = fs.readFileSync(
  path.join(__dirname, '../../templates/kaching-sweep-fvg-scalp.pine.template'),
  'utf8'
);
const DAY_TPL = fs.readFileSync(
  path.join(__dirname, '../../templates/kaching-sweep-fvg-daytrading.pine.template'),
  'utf8'
);

describe('Option A architecture config', () => {
  it('scalping: HTF 15m, canonical 3m, allowed 1/3/5', () => {
    const a = STRATEGY_ARCHITECTURE.scalping;
    assert.deepEqual(a.entryTimeframes, ['1m', '3m', '5m']);
    assert.equal(a.canonicalSignalTimeframe, '3m');
    assert.deepEqual(a.htfTimeframes, ['15m']);
    const v = buildPineTfVariables('scalping');
    assert.equal(v.CANONICAL_SIGNAL_TF, '3');
    assert.equal(tfToPine(a.canonicalSignalTimeframe), '3');
  });

  it('daytrading: canonical 5m, allowed 5/15, HTF 1h/4h', () => {
    const a = STRATEGY_ARCHITECTURE.daytrading;
    assert.deepEqual(a.entryTimeframes, ['5m', '15m']);
    assert.equal(a.canonicalSignalTimeframe, '5m');
    assert.ok(a.htfTimeframes.includes('1h'));
    assert.ok(a.htfTimeframes.includes('4h'));
    const v = buildPineTfVariables('daytrading');
    assert.equal(v.CANONICAL_SIGNAL_TF, '5');
  });
});

describe('Option A Pine contract', () => {
  it('wrong-TF lock only uses entryChartOk (not canonical!=chart)', () => {
    for (const [label, tpl] of [
      ['scalp', SCALP_TPL],
      ['day', DAY_TPL]
    ]) {
      assert.match(
        tpl,
        /tfMsg = not strategyCfgOk \? "\{\{DIAG_UNSUPPORTED\}\}" : not entryChartOk \? "\{\{DIAG_WRONG_ENTRY\}\}" : ""/,
        `${label}: wrong-TF must be allowlist-only`
      );
      assert.match(tpl, /canonSignalTuple\(\)/, `${label}: missing canon engine`);
      assert.match(tpl, /makeCanonicalSignalId/, `${label}: missing canonical id`);
      assert.match(tpl, /"timeframe":"' \+ jsonEsc\(CANONICAL_SIGNAL_TF\)/, `${label}: payload TF must be canonical`);
      assert.match(tpl, /"chartTf":/, `${label}: missing chartTf`);
      assert.match(tpl, /"canonicalSignalKey":/, `${label}: missing canonicalSignalKey`);
      assert.doesNotMatch(tpl, /fireLong\s*=\s*.*entryTfOk/, `${label}: fire must not gate on entryTfOk`);
      assert.match(
        tpl,
        /^indicator\([^;\n]*overlay\s*=\s*true\s*,\s*dynamic_requests\s*=\s*true/m,
        `${label}: indicator() must set dynamic_requests=true immediately after overlay=true`
      );
    }
  });

  it('templates must not embed {{EVENT_BRIDGE}} inside comments (prevents stray ). injection)', () => {
    // Regression: comment text "{{EVENT_BRIDGE}})." caused renderTemplate to inject the
    // full bridge snippet mid-comment, leaving a dangling ")." and duplicating the bridge.
    for (const [label, tpl] of [
      ['scalp', SCALP_TPL],
      ['day', DAY_TPL]
    ]) {
      const placeholders = tpl.match(/\{\{EVENT_BRIDGE\}\}/g) || [];
      assert.equal(placeholders.length, 1, `${label}: exactly one EVENT_BRIDGE placeholder`);
      assert.match(tpl, /^\{\{EVENT_BRIDGE\}\}\s*$/m, `${label}: placeholder must be its own line`);
      assert.doesNotMatch(
        tpl,
        /\/\/[^\n]*\{\{EVENT_BRIDGE\}\}/,
        `${label}: {{EVENT_BRIDGE}} must not appear inside // comments`
      );
      const snippetSlots = ['EVENT_ARM', 'DRAWING_ENGINE', 'DRAWING_RUNTIME'];
      for (const slot of snippetSlots) {
        const reComment = new RegExp(`//[^\\n]*\\{\\{${slot}\\}\\}`);
        assert.doesNotMatch(tpl, reComment, `${label}: {{${slot}}} must not appear inside // comments`);
      }
    }
  });
});

describe('Option A backend identity / dedupe', () => {
  beforeEach(() => {
    ActiveSignalRegistry.resetForTests?.();
  });

  it('buildSignalData accepts additive Option A fields', () => {
    const data = buildSignalData({
      symbol: 'EURUSD',
      direction: 'long',
      alertType: 'entry',
      timeframe: '3',
      chartTf: '5',
      canonicalSignalTf: '3',
      canonicalSignalKey: 'EURUSD-scalping-c3-123-long',
      signalUuid: 'EURUSD-scalping-c3-123-long',
      entry: 1.1,
      stop_loss: 1.09,
      take_profit_1: 1.11,
      take_profit_2: 1.12,
      take_profit_3: 1.13,
      pattern: 'liquidity_sweep_fvg_scalp',
      confidence: 0.8,
      gapTop: 1.105,
      gapBottom: 1.1
    });
    assert.equal(data.timeframe, '3m');
    assert.equal(data.chartTf, '5');
    assert.equal(data.canonicalSignalTf, '3');
    assert.equal(data.canonicalSignalKey, 'EURUSD-scalping-c3-123-long');
    assert.equal(data.signalUuid, 'EURUSD-scalping-c3-123-long');
  });

  it('same UUID from another chartTf is idempotent (CROSS_TF_CANONICAL_DUPLICATE)', async () => {
    const uuid = 'JUMP-scalping-c3-999-short';
    await ActiveSignalRegistry.registerActive({
      symbol: 'JUMP_75_INDEX',
      timeframe: '3m',
      strategyName: 'Liquidity Sweep + Fair Value Gap (Scalping)',
      signalUuid: uuid,
      lifecycleStage: 'ACTIVE'
    });
    const gate = await TradeLifecycleService.assertCanOpenEntry({
      symbol: 'JUMP_75_INDEX',
      timeframe: '3m',
      chartTf: '5',
      canonicalSignalTf: '3',
      canonicalSignalKey: uuid,
      signalUuid: uuid,
      alertType: 'entry',
      direction: 'short'
    });
    assert.equal(gate.allowed, false);
    assert.equal(gate.reason, 'duplicate_webhook_replay');
    assert.equal(gate.detail, 'CROSS_TF_CANONICAL_DUPLICATE');
  });

  it('Pine 1.2.1 stamp remains major-family CURRENT with 1.0/1.1/1.2', () => {
    assert.equal(PINE_CLIENT_VERSION, '1.2.1');
    assert.ok(CURRENT_PINE_CAPABILITIES.includes('canonical_tf_v1'));
    assert.ok(CURRENT_PINE_CAPABILITIES.includes('event_bridge_v1'));
    assert.equal(resolveCompatibilityMode('1.0.0').mode, COMPAT_MODE.CURRENT);
    assert.equal(resolveCompatibilityMode('1.1.0').mode, COMPAT_MODE.CURRENT);
    assert.equal(resolveCompatibilityMode('1.2.0').mode, COMPAT_MODE.CURRENT);
    assert.equal(resolveCompatibilityMode('1.2.1').mode, COMPAT_MODE.CURRENT);
  });
});
