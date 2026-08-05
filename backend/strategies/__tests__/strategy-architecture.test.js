/**
 * Strategy Architecture — canonical TF layout + Pine injection consistency.
 */

process.env.TRADINGVIEW_WEBHOOK_SECRET =
  process.env.TRADINGVIEW_WEBHOOK_SECRET || 'arch-test-tv-webhook-secret';
process.env.WEBHOOK_SIGNING_SECRET =
  process.env.WEBHOOK_SIGNING_SECRET || 'arch-test-license-signing-secret';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  STRATEGY_ARCHITECTURE,
  FUTURE_STRATEGY_KEYS,
  tfToPine,
  tfToMinutes,
  resolveArchitectureTimeframes,
  validateAllStrategyArchitectures,
  assertStrategyArchitecturesValid,
  buildPineTfVariables,
  parseAllowedTimeframes,
  getArchitecturePublicSummary
} = require('../config/strategyArchitecture');
const { DEFAULT_SCALPING_CONFIG } = require('../config/scalpingConfig');
const { DEFAULT_DAYTRADING_CONFIG } = require('../config/dayTradingConfig');
const Pine = require('../../services/PineScriptGeneratorService');

const DEMO_USER = {
  _id: '507f1f77bcf86cd799439011',
  email: 'arch@test.com',
  tradingviewUsername: 'demo_trader',
  subscription: { tier: 'professional', status: 'active' }
};

describe('Strategy Architecture canonical layout', () => {
  it('defines Scalping: entry 3m/5m, HTF 15m — no 1m', () => {
    const a = STRATEGY_ARCHITECTURE.scalping;
    assert.deepEqual([...a.entryTimeframes], ['3m', '5m']);
    assert.deepEqual([...a.htfTimeframes], ['15m']);
    assert.equal(a.defaultEntryTimeframe, '3m');
    assert.equal(a.defaultHtfTimeframe, '15m');
    assert.ok(!a.entryTimeframes.includes('1m'));
  });

  it('defines Day Trading: entry 5m/15m, HTF 1h/4h', () => {
    const a = STRATEGY_ARCHITECTURE.daytrading;
    assert.deepEqual([...a.entryTimeframes], ['5m', '15m']);
    assert.deepEqual([...a.htfTimeframes], ['1h', '4h']);
    assert.equal(a.defaultEntryTimeframe, '15m');
    assert.equal(a.defaultHtfTimeframe, '1h');
  });

  it('reserves future strategy keys without registering live math', () => {
    assert.ok(FUTURE_STRATEGY_KEYS.includes('swing'));
    assert.ok(FUTURE_STRATEGY_KEYS.includes('position'));
    assert.ok(FUTURE_STRATEGY_KEYS.includes('crypto'));
    assert.ok(FUTURE_STRATEGY_KEYS.includes('gold'));
    for (const key of FUTURE_STRATEGY_KEYS) {
      assert.equal(STRATEGY_ARCHITECTURE[key], undefined);
    }
  });

  it('validates all default architectures at startup shape', () => {
    const report = validateAllStrategyArchitectures();
    assert.equal(report.ok, true, report.errors.join('; '));
    assert.doesNotThrow(() => assertStrategyArchitecturesValid());
  });

  it('rejects 1m as scalping entry and entry >= HTF', () => {
    const filtered = parseAllowedTimeframes(
      ['3m', '1m', '5m'],
      STRATEGY_ARCHITECTURE.scalping.entryTimeframes,
      [...STRATEGY_ARCHITECTURE.scalping.entryTimeframes]
    );
    assert.deepEqual(filtered, ['3m', '5m']);

    const bad = validateAllStrategyArchitectures({
      scalping: { entryTimeframes: ['15m'], htfTimeframe: '15m' }
    });
    // resolveArchitectureTimeframes clamps invalid entries — force raw validation
    const {
      validateStrategyTimeframes,
      getStrategyArchitecture
    } = require('../config/strategyArchitecture');
    const check = validateStrategyTimeframes(getStrategyArchitecture('scalping'), {
      entryTimeframes: ['15m'],
      defaultEntryTimeframe: '15m',
      htfTimeframe: '15m',
      htfTimeframes: ['15m']
    });
    assert.equal(check.ok, false);
    assert.ok(check.errors.some(e => /must be lower than HTF|not in architecture allowlist/.test(e)));
    assert.ok(bad);
  });

  it('tfToPine maps app TFs to TradingView values', () => {
    assert.equal(tfToPine('15m'), '15');
    assert.equal(tfToPine('3m'), '3');
    assert.equal(tfToPine('5m'), '5');
    assert.equal(tfToPine('1h'), '60');
    assert.equal(tfToPine('4h'), '240');
    assert.equal(tfToMinutes('4h'), 240);
  });
});

describe('Backend configs consume Strategy Architecture', () => {
  it('scalpingConfig matches architecture', () => {
    const arch = resolveArchitectureTimeframes('scalping');
    assert.deepEqual([...DEFAULT_SCALPING_CONFIG.entryTimeframes], arch.entryTimeframes);
    assert.equal(DEFAULT_SCALPING_CONFIG.htfTimeframe, arch.htfTimeframe);
    assert.ok(!DEFAULT_SCALPING_CONFIG.entryTimeframes.includes('1m'));
  });

  it('dayTradingConfig matches architecture', () => {
    const arch = resolveArchitectureTimeframes('daytrading');
    assert.deepEqual([...DEFAULT_DAYTRADING_CONFIG.entryTimeframes], arch.entryTimeframes);
    assert.deepEqual([...DEFAULT_DAYTRADING_CONFIG.htfTimeframes], arch.htfTimeframes);
    assert.equal(DEFAULT_DAYTRADING_CONFIG.htfTimeframe, arch.htfTimeframe);
  });

  it('public summary exposes both strategies', () => {
    const summary = getArchitecturePublicSummary();
    assert.ok(summary.scalping);
    assert.ok(summary.daytrading);
  });
});

describe('Pine generator injects Strategy Configuration', () => {
  it('buildPineTfVariables injects entry/HTF expressions and diagnostics', () => {
    const scalp = buildPineTfVariables('scalping');
    assert.equal(scalp.HTF_TF, '15');
    assert.match(scalp.ENTRY_CHART_OK, /multiplier == 3/);
    assert.match(scalp.ENTRY_CHART_OK, /multiplier == 5/);
    assert.doesNotMatch(scalp.ENTRY_CHART_OK, /multiplier == 1\b/);
    assert.equal(scalp.HTF_TF_OK, 'htfSec == 900');
    assert.match(scalp.DIAG_WRONG_ENTRY, /Wrong Entry Timeframe \(Scalping\)/);
    assert.match(scalp.DIAG_WRONG_HTF, /Wrong HTF Configuration \(Scalping\)/);
    assert.match(scalp.DIAG_CHART_IS_HTF, /Chart opened on HTF \(Scalping\)/);
    assert.match(scalp.DIAG_UNSUPPORTED, /Unsupported Strategy Configuration/);
    assert.match(scalp.DIAG_MISSING_HTF, /Missing HTF Confirmation \(Scalping\)/);

    const day = buildPineTfVariables('daytrading');
    assert.equal(day.HTF_TF, '60'); // default HTF baked = 1h
    assert.match(day.ENTRY_CHART_OK, /multiplier == 5/);
    assert.match(day.ENTRY_CHART_OK, /multiplier == 15/);
    assert.match(day.HTF_TF_OK, /htfSec == 3600/);
    assert.match(day.HTF_TF_OK, /htfSec == 14400/);
  });

  it('generated Pine matches configuration (scalping + daytrading)', () => {
    const scalp = Pine.generateForUser(DEMO_USER, { strategy: 'scalping' });
    const day = Pine.generateForUser(DEMO_USER, { strategy: 'daytrading' });

    assert.deepEqual(scalp.strategyArchitecture.entryTimeframes, ['3m', '5m']);
    assert.deepEqual(scalp.strategyArchitecture.htfTimeframes, ['15m']);
    assert.equal(scalp.strategyArchitecture.bakedHtfPine, '15');
    assert.match(scalp.script, /input\.timeframe\("15"/);
    assert.match(scalp.script, /Wrong Entry Timeframe \(Scalping\)/);
    assert.match(scalp.script, /Wrong HTF Configuration \(Scalping\)/);
    assert.match(scalp.script, /Chart opened on HTF \(Scalping\)/);
    assert.match(scalp.script, /Unsupported Strategy Configuration/);
    assert.match(scalp.script, /Missing HTF Confirmation \(Scalping\)/);
    assert.match(scalp.script, /timeframe\.multiplier == 3 or timeframe\.multiplier == 5/);
    assert.doesNotMatch(scalp.script, /timeframe\.multiplier == 1 or/);
    assert.ok(!/SCALPING_ENTRY_TFS.*1m|entries on 3m \/ 1m/.test(scalp.script));

    assert.deepEqual(day.strategyArchitecture.entryTimeframes, ['5m', '15m']);
    assert.deepEqual(day.strategyArchitecture.htfTimeframes, ['1h', '4h']);
    assert.equal(day.strategyArchitecture.bakedHtfPine, '60');
    assert.match(day.script, /input\.timeframe\("60"/);
    assert.match(day.script, /htfSec == 3600 or htfSec == 14400/);
    assert.match(day.script, /Wrong Entry Timeframe \(Day Trading\)/);
    assert.match(day.instructions[0], /Day Trading/);
    assert.match(day.instructions[0], /5m or 15m/);
    assert.match(scalp.instructions[0], /Scalping/);
    assert.match(scalp.instructions[0], /3m or 5m/);
    assert.match(scalp.instructions[0], /Day Trading/);
  });

  it('Pine templates contain placeholders — not hardcoded TF multipliers as sole source', () => {
    const fs = require('fs');
    const path = require('path');
    const scalpTpl = fs.readFileSync(
      path.join(__dirname, '../../templates/kaching-sweep-fvg-scalp.pine.template'),
      'utf8'
    );
    const dayTpl = fs.readFileSync(
      path.join(__dirname, '../../templates/kaching-sweep-fvg-daytrading.pine.template'),
      'utf8'
    );
    for (const tpl of [scalpTpl, dayTpl]) {
      assert.match(tpl, /\{\{ENTRY_CHART_OK\}\}/);
      assert.match(tpl, /\{\{HTF_TF_OK\}\}/);
      assert.match(tpl, /\{\{HTF_TF\}\}/);
      assert.match(tpl, /\{\{DIAG_WRONG_ENTRY\}\}/);
      assert.match(tpl, /\{\{DIAG_WRONG_HTF\}\}/);
      assert.match(tpl, /\{\{DIAG_CHART_IS_HTF\}\}/);
      assert.match(tpl, /\{\{DIAG_UNSUPPORTED\}\}/);
      assert.match(tpl, /\{\{DIAG_MISSING_HTF\}\}/);
      assert.doesNotMatch(tpl, /timeframe\.multiplier == 3 or timeframe\.multiplier == 5/);
      assert.doesNotMatch(tpl, /htfSec == 900$/m);
    }
  });
});
