import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OFFICIAL_SCALPING_RESTORE,
  SCALPING_CONFIDENCE_WEIGHTS,
  sumConfidenceWeights,
  normalizeConfidenceWeights
} from '../scalpingDefaults.js';
import {
  OFFICIAL_DAYTRADING_RESTORE,
  DAYTRADING_CONFIDENCE_WEIGHTS,
  sumConfidenceWeights as sumDayWeights
} from '../dayTradingDefaults.js';

describe('frontend scalpingDefaults', () => {
  it('confidence weights sum to 100', () => {
    assert.equal(sumConfidenceWeights(SCALPING_CONFIDENCE_WEIGHTS), 100);
  });

  it('restore pack has official core + strategy fields', () => {
    const pack = OFFICIAL_SCALPING_RESTORE;
    assert.equal(pack.activeStrategy, 'scalping');
    assert.equal(pack.core.autoScanIntervalMs, 60_000);
    assert.equal(pack.core.scanBatchSize, 5);
    assert.equal(pack.core.autoScanEnabled, true);
    assert.deepEqual([...pack.strategy.takeProfit.atrCaps], [0.8, 1.4, 2.0]);
    assert.equal(pack.strategy.takeProfit.minScore, 60);
    assert.equal(pack.marketRegime.avoidHighImpactNews, true);
    assert.equal(pack.strategy.filters.rejectOnMajorNews, true);
  });

  it('normalizeConfidenceWeights forces sum 100', () => {
    const keys = Object.keys(SCALPING_CONFIDENCE_WEIGHTS);
    const normalized = normalizeConfidenceWeights({ sweep: 50, mss: 50 }, keys);
    assert.equal(sumConfidenceWeights(normalized), 100);
  });
});

describe('frontend dayTradingDefaults', () => {
  it('confidence weights sum to 100 with mapped schema', () => {
    assert.equal(sumDayWeights(DAYTRADING_CONFIDENCE_WEIGHTS), 100);
    assert.equal(DAYTRADING_CONFIDENCE_WEIGHTS.htfBias, 0);
    assert.equal(DAYTRADING_CONFIDENCE_WEIGHTS.optionalConfirmation, 10);
  });

  it('restore pack matches official day trading defaults', () => {
    const pack = OFFICIAL_DAYTRADING_RESTORE;
    assert.equal(pack.activeStrategy, 'daytrading');
    assert.equal(pack.strategy.htfTimeframe, '1h');
    assert.equal(pack.strategy.confidence.threshold, 80);
    assert.deepEqual([...pack.strategy.takeProfit.atrCaps], [1.0, 2.0, 3.5]);
    assert.equal(pack.strategy.takeProfit.maxTpDistancePips, 150);
    assert.equal(pack.marketRegime.allowAsianSession, false);
    assert.equal(pack.marketRegime.avoidLowLiquiditySessions, true);
    assert.equal(pack.marketRegime.minVolatilityScore, 35);
    assert.equal(pack.strategy.filters.maxSpreadPipsByClass.gold, 8);
    assert.equal(pack.strategy.filters.maxSpreadPipsByClass.indices, 15);
  });
});
