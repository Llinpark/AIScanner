const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const {
  applyStrategyConfig,
  getStrategyAdminConfig,
  getActiveStrategy,
  getResolvedScalpingConfig,
  getResolvedDaytradingConfig,
  resetStrategyRuntimeConfigForTests,
  normalizeActiveStrategy,
  resolveLoadedActiveStrategy,
  loadPersistedStrategyConfig,
  initStrategyRuntimeConfig,
  DEFAULT_ACTIVE_STRATEGY
} = require('../strategyRuntimeConfig');
const {
  applyScannerConfig,
  getScannerConfig,
  getCoreScannerOverrides,
  loadCoreScannerOverrides,
  resetScannerRuntimeConfigForTests,
  DEFAULT_AUTO_SCAN_INTERVAL_MS
} = require('../scannerRuntimeConfig');
const StrategyRuntimeConfig = require('../../models/StrategyRuntimeConfig');

describe('strategyRuntimeConfig persistence', () => {
  beforeEach(() => {
    resetStrategyRuntimeConfigForTests();
    resetScannerRuntimeConfigForTests();
  });

  it('normalizeActiveStrategy accepts only scalping|daytrading', () => {
    assert.equal(normalizeActiveStrategy('scalping'), 'scalping');
    assert.equal(normalizeActiveStrategy('daytrading'), 'daytrading');
    assert.equal(normalizeActiveStrategy('DAYTRADING'), 'daytrading');
    assert.equal(normalizeActiveStrategy('nope', 'daytrading'), 'daytrading');
    assert.equal(normalizeActiveStrategy(undefined), 'scalping');
  });

  it('defaults prefer/active strategy to scalping when unset', () => {
    assert.equal(DEFAULT_ACTIVE_STRATEGY, 'scalping');
    assert.equal(getActiveStrategy(), 'scalping');
    assert.equal(getScannerConfig().activeStrategy, 'scalping');
  });

  it('legacy Mongo daytrading without explicit flag loads as scalping', () => {
    assert.equal(
      resolveLoadedActiveStrategy({ activeStrategy: 'daytrading' }),
      'scalping'
    );
    assert.equal(
      resolveLoadedActiveStrategy({ activeStrategy: 'daytrading', activeStrategyExplicit: false }),
      'scalping'
    );
  });

  it('honors explicit Mongo daytrading prefer across profile patches', () => {
    assert.equal(
      resolveLoadedActiveStrategy({
        activeStrategy: 'daytrading',
        activeStrategyExplicit: true
      }),
      'daytrading'
    );
    applyScannerConfig({ activeStrategy: 'daytrading' });
    assert.equal(getActiveStrategy(), 'daytrading');
    applyScannerConfig({
      strategies: { scalping: { htfTimeframe: '5m' } }
    });
    assert.equal(getActiveStrategy(), 'daytrading');
    assert.equal(getScannerConfig().activeStrategy, 'daytrading');
    // Invalid scalping HTF is clamped by Strategy Architecture
    assert.equal(getScannerConfig().strategies.scalping.htfTimeframe, '15m');
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
      // Invalid scalping HTF must clamp to architecture default (15m)
      scalping: { htfTimeframe: '5m' }
    });

    const strategies = getStrategyAdminConfig();
    assert.equal(getActiveStrategy(), 'scalping');
    assert.equal(strategies.scalping.htfTimeframe, '15m');
    assert.equal(strategies.daytrading.htfTimeframe, '4h');
    assert.equal(getResolvedScalpingConfig().htfTimeframe, '15m');
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

  it('uses 70 scalp / 80 daytrading confidence threshold pick fallbacks', () => {
    applyStrategyConfig({
      scalping: { confidence: { threshold: 'not-a-number' } },
      daytrading: { confidence: { threshold: 'not-a-number' } }
    });
    assert.equal(getResolvedScalpingConfig().confidence.threshold, 70);
    assert.equal(getResolvedDaytradingConfig().confidence.threshold, 80);
  });

  it('skips Mongo load when disconnected and keeps in-memory overrides', async () => {
    assert.notEqual(mongoose.connection.readyState, 1);
    applyStrategyConfig({
      scalping: { confidence: { threshold: 55 }, entry: { maxWaitBars: 7 } },
      daytrading: { confidence: { threshold: 90 }, entry: { maxWaitBars: 12 } }
    });
    await loadPersistedStrategyConfig();
    assert.equal(getResolvedScalpingConfig().confidence.threshold, 55);
    assert.equal(getResolvedScalpingConfig().entry.maxWaitBars, 7);
    assert.equal(getResolvedDaytradingConfig().confidence.threshold, 90);
    assert.equal(getResolvedDaytradingConfig().entry.maxWaitBars, 12);
  });
});

describe('strategyRuntimeConfig boot Mongo sync', () => {
  let originalFindOne;
  let readyStateDesc;

  beforeEach(() => {
    resetStrategyRuntimeConfigForTests();
    resetScannerRuntimeConfigForTests();
    originalFindOne = StrategyRuntimeConfig.findOne;
    readyStateDesc = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
  });

  afterEach(() => {
    StrategyRuntimeConfig.findOne = originalFindOne;
    if (readyStateDesc) {
      Object.defineProperty(mongoose.connection, 'readyState', readyStateDesc);
    } else {
      delete mongoose.connection.readyState;
    }
    resetStrategyRuntimeConfigForTests();
    resetScannerRuntimeConfigForTests();
  });

  it('registers reload-on-connect after boot skip and applies Mongo overrides', async () => {
    assert.notEqual(mongoose.connection.readyState, 1);

    await initStrategyRuntimeConfig();
    assert.equal(getResolvedScalpingConfig().confidence.threshold, 70);
    assert.equal(getResolvedDaytradingConfig().confidence.threshold, 80);
    assert.ok(
      mongoose.connection.listenerCount('connected') >= 1,
      'expected connected listener after boot skip'
    );

    StrategyRuntimeConfig.findOne = () => ({
      lean: async () => ({
        key: 'strategies',
        scalping: {
          confidence: { threshold: 62 },
          entry: { maxWaitBars: 8 }
        },
        daytrading: {
          confidence: { threshold: 88 },
          entry: { maxWaitBars: 11 }
        },
        activeStrategy: 'scalping',
        activeStrategyExplicit: true
      })
    });

    Object.defineProperty(mongoose.connection, 'readyState', {
      configurable: true,
      enumerable: true,
      get: () => 1
    });

    mongoose.connection.emit('connected');
    // Allow the async reload handler to settle
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(getResolvedScalpingConfig().confidence.threshold, 62);
    assert.equal(getResolvedScalpingConfig().entry.maxWaitBars, 8);
    assert.equal(getResolvedDaytradingConfig().confidence.threshold, 88);
    assert.equal(getResolvedDaytradingConfig().entry.maxWaitBars, 11);
  });
});

describe('scannerRuntimeConfig core persistence', () => {
  beforeEach(() => {
    resetStrategyRuntimeConfigForTests();
    resetScannerRuntimeConfigForTests();
  });

  it('defaults autoScanIntervalMs to 60000 when unset', () => {
    assert.equal(DEFAULT_AUTO_SCAN_INTERVAL_MS, 60_000);
    const config = getScannerConfig();
    assert.ok(config.autoScanIntervalMs >= 60_000);
    // After reset without SCANNER_INTERVAL_MS override, expect the module default
    if (!process.env.SCANNER_INTERVAL_MS) {
      assert.equal(config.autoScanIntervalMs, 60_000);
    }
  });

  it('defaults autoScanEnabled ON unless SCANNER_AUTO_ENABLED=false', () => {
    const prev = process.env.SCANNER_AUTO_ENABLED;
    try {
      delete process.env.SCANNER_AUTO_ENABLED;
      resetScannerRuntimeConfigForTests();
      assert.equal(getScannerConfig().autoScanEnabled, true);

      process.env.SCANNER_AUTO_ENABLED = 'false';
      resetScannerRuntimeConfigForTests();
      assert.equal(getScannerConfig().autoScanEnabled, false);

      process.env.SCANNER_AUTO_ENABLED = 'true';
      resetScannerRuntimeConfigForTests();
      assert.equal(getScannerConfig().autoScanEnabled, true);
    } finally {
      if (prev === undefined) delete process.env.SCANNER_AUTO_ENABLED;
      else process.env.SCANNER_AUTO_ENABLED = prev;
      resetScannerRuntimeConfigForTests();
    }
  });

  it('tracks core overrides for Mongo persistence and restores them on load', () => {
    applyScannerConfig({
      autoScanIntervalMs: 120_000,
      scanBatchSize: 7,
      autoScanEnabled: true
    });

    const overrides = getCoreScannerOverrides();
    assert.equal(overrides.autoScanIntervalMs, 120_000);
    assert.equal(overrides.scanBatchSize, 7);
    assert.equal(overrides.autoScanEnabled, true);
    assert.equal(getScannerConfig().autoScanIntervalMs, 120_000);

    resetScannerRuntimeConfigForTests();
    assert.notEqual(getScannerConfig().autoScanIntervalMs, 120_000);

    loadCoreScannerOverrides(overrides);
    assert.equal(getScannerConfig().autoScanIntervalMs, 120_000);
    assert.equal(getScannerConfig().scanBatchSize, 7);
    assert.equal(getScannerConfig().autoScanEnabled, true);
  });

  it('clamps scan interval to at least 60000', () => {
    applyScannerConfig({ autoScanIntervalMs: 5_000 });
    assert.equal(getScannerConfig().autoScanIntervalMs, 60_000);
  });

  it('does not clear core runtime when only strategies are patched', () => {
    applyScannerConfig({
      autoScanIntervalMs: 90_000,
      scanBatchSize: 4,
      activeStrategy: 'scalping',
      strategies: {
        scalping: { enabled: true, htfTimeframe: '15m' }
      }
    });

    applyScannerConfig({
      strategies: {
        daytrading: { htfTimeframe: '1h' }
      }
    });

    assert.equal(getScannerConfig().autoScanIntervalMs, 90_000);
    assert.equal(getScannerConfig().scanBatchSize, 4);
    assert.equal(getActiveStrategy(), 'scalping');
  });
});
