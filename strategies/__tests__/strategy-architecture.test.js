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
  it('defines Scalping: entry 1m/3m/5m, HTF 15m, canonical 3m', () => {
    const a = STRATEGY_ARCHITECTURE.scalping;
    assert.deepEqual([...a.entryTimeframes], ['1m', '3m', '5m']);
    assert.deepEqual([...a.htfTimeframes], ['15m']);
    assert.equal(a.defaultEntryTimeframe, '3m');
    assert.equal(a.defaultHtfTimeframe, '15m');
    assert.equal(a.canonicalSignalTimeframe, '3m');
    assert.ok(a.entryTimeframes.includes('1m'));
  });

  it('defines Day Trading: entry 5m/15m, HTF 1h/4h, canonical 5m', () => {
    const a = STRATEGY_ARCHITECTURE.daytrading;
    assert.deepEqual([...a.entryTimeframes], ['5m', '15m']);
    assert.deepEqual([...a.htfTimeframes], ['1h', '4h']);
    assert.equal(a.defaultEntryTimeframe, '15m');
    assert.equal(a.defaultHtfTimeframe, '1h');
    assert.equal(a.canonicalSignalTimeframe, '5m');
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

  it('accepts 1m as scalping entry and rejects entry >= HTF', () => {
    const filtered = parseAllowedTimeframes(
      ['3m', '1m', '5m'],
      STRATEGY_ARCHITECTURE.scalping.entryTimeframes,
      [...STRATEGY_ARCHITECTURE.scalping.entryTimeframes]
    );
    assert.deepEqual(filtered, ['1m', '3m', '5m']);

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
    assert.ok(DEFAULT_SCALPING_CONFIG.entryTimeframes.includes('1m'));
  });

  it('dayTradingConfig matches architecture', () => {
    const arch = resolveArchitectureTimeframes('daytrading');
    assert.deepEqual([...DEFAULT_DAYTRADING_CONFIG.entryTimeframes], arch.entryTimeframes);
    assert.deepEqual([...DEFAULT_DAYTRADING_CONFIG.htfTimeframes], arch.htfTimeframes);
    assert.equal(DEFAULT_DAYTRADING_CONFIG.htfTimeframe, arch.htfTimeframe);
  });

  it('public summary exposes both strategies including canonical TF', () => {
    const summary = getArchitecturePublicSummary();
    assert.ok(summary.scalping);
    assert.ok(summary.daytrading);
    assert.equal(summary.scalping.canonicalSignalTimeframe, '3m');
    assert.equal(summary.daytrading.canonicalSignalTimeframe, '5m');
  });
});

describe('Pine generator injects Strategy Configuration', () => {
  it('buildPineTfVariables injects entry/HTF/canonical expressions and Option A diagnostics', () => {
    const scalp = buildPineTfVariables('scalping');
    assert.equal(scalp.HTF_TF, '15');
    assert.equal(scalp.CANONICAL_SIGNAL_TF, '3');
    assert.equal(scalp.ARCH_CANONICAL_SIGNAL_TF, '3m');
    assert.match(scalp.ENTRY_CHART_OK, /multiplier == 1/);
    assert.match(scalp.ENTRY_CHART_OK, /multiplier == 3/);
    assert.match(scalp.ENTRY_CHART_OK, /multiplier == 5/);
    assert.equal(scalp.HTF_TF_OK, 'htfSec == 900');
    assert.match(scalp.DIAG_WRONG_ENTRY, /Wrong Entry Timeframe \(Scalping\)/);
    assert.match(scalp.DIAG_WRONG_ENTRY, /allowed display TF/);
    assert.match(scalp.DIAG_WRONG_ENTRY, /canonical signal TF 3m/);
    assert.doesNotMatch(scalp.DIAG_WRONG_ENTRY, /alerts still evaluate/i);
    assert.match(scalp.DIAG_UNSUPPORTED, /Unsupported Strategy Configuration/);
    assert.match(scalp.instructionLead, /canonical 3m/i);
    assert.match(scalp.instructionLead, /1m, 3m, or 5m/);

    const day = buildPineTfVariables('daytrading');
    assert.equal(day.HTF_TF, '60'); // default HTF baked = 1h
    assert.equal(day.CANONICAL_SIGNAL_TF, '5');
    assert.equal(day.ARCH_CANONICAL_SIGNAL_TF, '5m');
    assert.match(day.ENTRY_CHART_OK, /multiplier == 5/);
    assert.match(day.ENTRY_CHART_OK, /multiplier == 15/);
    assert.match(day.HTF_TF_OK, /htfSec == 3600/);
    assert.match(day.HTF_TF_OK, /htfSec == 14400/);
    assert.match(day.DIAG_WRONG_ENTRY, /Wrong Entry Timeframe \(Day Trading\)/);
    assert.match(day.instructionLead, /canonical 5m/i);
  });

  it('generated Pine matches Option A configuration (scalping + daytrading)', () => {
    const scalp = Pine.generateForUser(DEMO_USER, { strategy: 'scalping' });
    const day = Pine.generateForUser(DEMO_USER, { strategy: 'daytrading' });

    assert.deepEqual(scalp.strategyArchitecture.entryTimeframes, ['1m', '3m', '5m']);
    assert.deepEqual(scalp.strategyArchitecture.htfTimeframes, ['15m']);
    assert.equal(scalp.strategyArchitecture.bakedHtfPine, '15');
    assert.equal(scalp.strategyArchitecture.canonicalSignalTimeframe, '3m');
    assert.equal(scalp.strategyArchitecture.bakedCanonicalSignalPine, '3');
    assert.match(scalp.script, /input\.timeframe\("15"/);
    assert.match(scalp.script, /CANONICAL_SIGNAL_TF = "3"/);
    assert.match(scalp.script, /canonSignalTuple/);
    assert.match(scalp.script, /makeCanonicalSignalId/);
    assert.match(scalp.script, /request\.security_lower_tf/);
    assert.match(scalp.script, /Wrong Entry Timeframe \(Scalping\)/);
    assert.match(scalp.script, /Unsupported Strategy Configuration/);
    assert.match(scalp.script, /tradingStyle\s*=/);
    assert.match(
      scalp.script,
      /setupLong\s*=\s*licenseOk and isAllowedDisplayTf and newCanonLong/
    );
    assert.match(scalp.script, /resolveValidStop/);
    assert.match(scalp.script, /maxStopAtrMult/);
    assert.doesNotMatch(
      scalp.script,
      /fireLong\s*=\s*licenseOk and entryTfOk/
    );
    assert.match(
      scalp.script,
      /tfMsg\s*=\s*not strategyCfgOk \? "[^"]+" : not entryChartOk \? "[^"]+" : ""/
    );
    assert.doesNotMatch(
      scalp.script,
      /tfMsg\s*=.*chartIsHtf/
    );
    assert.match(
      scalp.script,
      /timeframe\.multiplier == 1 or timeframe\.multiplier == 3 or timeframe\.multiplier == 5/
    );

    assert.deepEqual(day.strategyArchitecture.entryTimeframes, ['5m', '15m']);
    assert.deepEqual(day.strategyArchitecture.htfTimeframes, ['1h', '4h']);
    assert.equal(day.strategyArchitecture.bakedHtfPine, '60');
    assert.equal(day.strategyArchitecture.canonicalSignalTimeframe, '5m');
    assert.equal(day.strategyArchitecture.bakedCanonicalSignalPine, '5');
    assert.match(day.script, /input\.timeframe\("60"/);
    assert.match(day.script, /CANONICAL_SIGNAL_TF = "5"/);
    assert.match(day.script, /htfSec == 3600 or htfSec == 14400/);
    assert.match(day.script, /Wrong Entry Timeframe \(Day Trading\)/);
    assert.match(day.instructions[0], /Day Trading/);
    assert.match(day.instructions[0], /5m or 15m/);
    assert.match(day.instructions[0], /canonical 5m/i);
    assert.match(scalp.instructions[0], /Scalping/);
    assert.match(scalp.instructions[0], /1m, 3m, or 5m/);
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
      assert.match(tpl, /\{\{TRADING_STYLE_EXPR\}\}/);
      assert.match(tpl, /\{\{HTF_TF\}\}/);
      assert.match(tpl, /\{\{CANONICAL_SIGNAL_TF\}\}/);
      assert.match(tpl, /\{\{EVENT_BRIDGE\}\}/);
      assert.match(tpl, /\{\{EVENT_ARM\}\}/);
      assert.match(tpl, /\{\{DRAWING_RUNTIME\}\}/);
      assert.match(tpl, /\{\{DIAG_WRONG_ENTRY\}\}/);
      assert.match(tpl, /\{\{DIAG_UNSUPPORTED\}\}/);
      assert.match(tpl, /canonSignalTuple/);
      assert.match(tpl, /isAllowedDisplayTf/);
      assert.doesNotMatch(tpl, /timeframe\.multiplier == 3 or timeframe\.multiplier == 5/);
      assert.doesNotMatch(tpl, /htfSec == 900$/m);
    }
  });
});
