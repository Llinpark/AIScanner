const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  applyStrategyConfig,
  getStrategyAdminConfig,
  getActiveStrategy,
  getResolvedScalpingConfig,
  getResolvedDaytradingConfig,
  resetStrategyRuntimeConfigForTests,
  normalizeActiveStrategy
} = require('../strategyRuntimeConfig');
const { applyScannerConfig, getScannerConfig } = require('../scannerRuntimeConfig');

describe('strategyRuntimeConfig persistence', () => {
  beforeEach(() => {
    resetStrategyRuntimeConfigForTests();
  });

  it('normalizeActiveStrategy accepts only scalping|daytrading', () => {
    assert.equal(normalizeActiveStrategy('scalping'), 'scalping');
    assert.equal(normalizeActiveStrategy('daytrading'), 'daytrading');
    assert.equal(normalizeActiveStrategy('DAYTRADING'), 'daytrading');
    assert.equal(normalizeActiveStrategy('nope', 'scalping'), 'scalping');
    assert.equal(normalizeActiveStrategy(undefined), 'daytrading');
  });

  it('persists activeStrategy in memory and returns it via scanner config', () => {
    applyScannerConfig({
      activeStrategy: 'scalping',
      strategies: {
        scalping: { htfTimeframe: '15m', enabled: true },
        daytrading: { htfTimeframe: '4h', enabled: true }
      }
    });

    const config = getScannerConfig();
    assert.equal(config.activeStrategy, 'scalping');
    assert.equal(getActiveStrategy(), 'scalping');
    assert.equal(config.strategies.scalping.htfTimeframe, '15m');
    assert.equal(config.strategies.daytrading.htfTimeframe, '4h');
  });

  it('keeps scalping and daytrading profiles independent', () => {
    applyStrategyConfig({
      activeStrategy: 'daytrading',
      scalping: { htfTimeframe: '15m', enabled: true },
      daytrading: { htfTimeframe: '4h', enabled: true }
    });

    applyStrategyConfig({
      activeStrategy: 'scalping',
      scalping: { htfTimeframe: '5m' }
    });

    const strategies = getStrategyAdminConfig();
    assert.equal(getActiveStrategy(), 'scalping');
    assert.equal(strategies.scalping.htfTimeframe, '5m');
    assert.equal(strategies.daytrading.htfTimeframe, '4h');
    assert.equal(getResolvedScalpingConfig().htfTimeframe, '5m');
    assert.equal(getResolvedDaytradingConfig().htfTimeframe, '4h');
  });

  it('does not silently reset activeStrategy when only the other profile is patched', () => {
    applyStrategyConfig({
      activeStrategy: 'scalping',
      scalping: { htfTimeframe: '15m' },
      daytrading: { htfTimeframe: '4h' }
    });

    applyStrategyConfig({
      daytrading: { htfTimeframe: '1h' }
    });

    assert.equal(getActiveStrategy(), 'scalping');
    assert.equal(getStrategyAdminConfig().scalping.htfTimeframe, '15m');
    assert.equal(getStrategyAdminConfig().daytrading.htfTimeframe, '1h');
  });

  it('keeps TP profile fields independent across strategies', () => {
    applyStrategyConfig({
      scalping: {
        takeProfit: { maxTpDistancePips: 25, atrCaps: [0.6, 1.1, 1.8] }
      },
      daytrading: {
        takeProfit: { maxTpDistancePips: 100, atrCaps: [1.5, 2.5, 3.5] }
      }
    });

    applyStrategyConfig({
      daytrading: {
        takeProfit: { maxTpDistancePips: 90 }
      }
    });

    const scalp = getResolvedScalpingConfig();
    const day = getResolvedDaytradingConfig();
    assert.equal(scalp.takeProfit.maxTpDistancePips, 25);
    assert.deepEqual(scalp.takeProfit.atrCaps, [0.6, 1.1, 1.8]);
    assert.equal(day.takeProfit.maxTpDistancePips, 90);
    assert.equal(scalp.takeProfit.profileId, 'scalping');
    assert.equal(day.takeProfit.profileId, 'daytrading');
  });
});
