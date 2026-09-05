/**
 * Official strategy defaults — restore packs + weight sum invariants.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SCALPING_TP_PROFILE } = require('../profiles/scalpingTpProfile');
const { DAY_TRADING_TP_PROFILE } = require('../profiles/dayTradingTpProfile');
const { DEFAULT_SCALPING_CONFIG } = require('../config/scalpingConfig');
const { DEFAULT_DAYTRADING_CONFIG } = require('../config/dayTradingConfig');
const { DEFAULT_MARKET_REGIME_CONFIG } = require('../../utils/marketRegimeConfig');

function sumWeights(weights) {
  return Object.values(weights).reduce((acc, v) => acc + Number(v), 0);
}

describe('Official Scalping defaults', () => {
  it('confidence weights sum to 100', () => {
    assert.equal(sumWeights(DEFAULT_SCALPING_CONFIG.confidence.weights), 100);
  });

  it('matches official TP profile (ATR caps, minScore, distance)', () => {
    assert.deepEqual([...SCALPING_TP_PROFILE.atrCaps], [0.8, 1.4, 2.0]);
    assert.equal(SCALPING_TP_PROFILE.maxAtrMultiplier, 2);
    assert.equal(SCALPING_TP_PROFILE.maxTpDistancePips, 30);
    assert.equal(SCALPING_TP_PROFILE.minScore, 60);
    assert.equal(SCALPING_TP_PROFILE.model, 'smart_scoring');
    assert.deepEqual([...SCALPING_TP_PROFILE.rrMultiples], [1.5, 2, 3]);
  });

  it('strategy core fields match restore pack', () => {
    assert.equal(DEFAULT_SCALPING_CONFIG.htfTimeframe, '15m');
    assert.deepEqual([...DEFAULT_SCALPING_CONFIG.entryTimeframes], ['1m', '3m', '5m']);
    assert.deepEqual([...DEFAULT_SCALPING_CONFIG.htfTimeframes], ['15m']);
    assert.equal(DEFAULT_SCALPING_CONFIG.defaultEntryTimeframe, '3m');
    assert.ok(DEFAULT_SCALPING_CONFIG.entryTimeframes.includes('1m'));
    assert.equal(DEFAULT_SCALPING_CONFIG.confidence.threshold, 70);
    assert.equal(DEFAULT_SCALPING_CONFIG.entry.model, 'ce');
    assert.equal(DEFAULT_SCALPING_CONFIG.entry.maxWaitBars, 10);
    assert.equal(DEFAULT_SCALPING_CONFIG.stop.model, 'sweep');
    assert.equal(DEFAULT_SCALPING_CONFIG.stop.bufferAtrRatio, 0.05);
    assert.equal(DEFAULT_SCALPING_CONFIG.fvg.minGapToAtrRatio, 0.12);
    assert.equal(DEFAULT_SCALPING_CONFIG.filters.minAtrPips, 2);
    assert.equal(DEFAULT_SCALPING_CONFIG.filters.rejectOnMajorNews, true);
    assert.equal(DEFAULT_SCALPING_CONFIG.filters.maxSpreadPipsByClass.forex, 2.5);
    assert.equal(DEFAULT_SCALPING_CONFIG.filters.maxSpreadPipsByClass.gold, 5);
    assert.equal(DEFAULT_SCALPING_CONFIG.filters.maxSpreadPipsByClass.indices, 10);
  });

  it('market regime defaults align with scalping restore', () => {
    assert.equal(DEFAULT_MARKET_REGIME_CONFIG.enabled, true);
    assert.equal(DEFAULT_MARKET_REGIME_CONFIG.minAtrPips, 3);
    assert.equal(DEFAULT_MARKET_REGIME_CONFIG.minVolatilityScore, 20);
    assert.equal(DEFAULT_MARKET_REGIME_CONFIG.minRegimeScore, 40);
    assert.equal(DEFAULT_MARKET_REGIME_CONFIG.avoidHighImpactNews, true);
    assert.equal(DEFAULT_MARKET_REGIME_CONFIG.avoidLowLiquiditySessions, false);
    assert.equal(DEFAULT_MARKET_REGIME_CONFIG.allowAsianSession, true);
  });
});

describe('Official Day Trading defaults', () => {
  it('confidence weights sum to 100 with mapped schema', () => {
    const w = DEFAULT_DAYTRADING_CONFIG.confidence.weights;
    assert.equal(w.htfBias, 0);
    assert.equal(w.sweep, 35);
    assert.equal(w.mss, 25);
    assert.equal(w.displacement, 10);
    assert.equal(w.fvg, 15);
    assert.equal(w.retrace, 5);
    assert.equal(w.optionalConfirmation, 10);
    assert.equal(sumWeights(w), 100);
  });

  it('matches official TP profile', () => {
    assert.deepEqual([...DAY_TRADING_TP_PROFILE.atrCaps], [1.0, 2.0, 3.5]);
    assert.equal(DAY_TRADING_TP_PROFILE.maxAtrMultiplier, 3);
    assert.equal(DAY_TRADING_TP_PROFILE.maxTpDistancePips, 150);
    assert.equal(DAY_TRADING_TP_PROFILE.minScore, 70);
    assert.equal(DAY_TRADING_TP_PROFILE.scoreWeights.internal_liquidity, 55);
    assert.equal(DAY_TRADING_TP_PROFILE.scoreWeights.untapped_fvg, 45);
  });

  it('strategy core fields match restore pack', () => {
    assert.equal(DEFAULT_DAYTRADING_CONFIG.htfTimeframe, '1h');
    assert.deepEqual([...DEFAULT_DAYTRADING_CONFIG.entryTimeframes], ['5m', '15m']);
    assert.deepEqual([...DEFAULT_DAYTRADING_CONFIG.htfTimeframes], ['1h', '4h']);
    assert.equal(DEFAULT_DAYTRADING_CONFIG.defaultEntryTimeframe, '15m');
    assert.equal(DEFAULT_DAYTRADING_CONFIG.confidence.threshold, 80);
    assert.equal(DEFAULT_DAYTRADING_CONFIG.entry.model, 'ce');
    assert.equal(DEFAULT_DAYTRADING_CONFIG.entry.maxWaitBars, 15);
    assert.equal(DEFAULT_DAYTRADING_CONFIG.stop.model, 'sweep');
    assert.equal(DEFAULT_DAYTRADING_CONFIG.stop.bufferAtrRatio, 0.08);
    assert.equal(DEFAULT_DAYTRADING_CONFIG.fvg.minGapToAtrRatio, 0.18);
    assert.equal(DEFAULT_DAYTRADING_CONFIG.filters.minAtrPips, 5);
    assert.equal(DEFAULT_DAYTRADING_CONFIG.filters.maxSpreadPipsByClass.forex, 2.5);
    assert.equal(DEFAULT_DAYTRADING_CONFIG.filters.maxSpreadPipsByClass.gold, 8);
    assert.equal(DEFAULT_DAYTRADING_CONFIG.filters.maxSpreadPipsByClass.indices, 15);
  });
});
