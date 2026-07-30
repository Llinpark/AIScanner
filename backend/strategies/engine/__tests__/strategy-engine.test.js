/**
 * Strategy Engine — registry, ScannerEngine genericity, profile independence.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  StrategyProfileRegistry,
  ScannerEngine,
  bootstrapStrategyProfiles,
  resetBootstrapFlag,
  resetProfileRegistry,
  resolvePreferStrategyId,
  createStubProfile,
  buildStrategyContext,
  createScalpingProfile,
  createDayTradingProfile
} = require('../index');
const {
  createDefaultRegistry,
  resetDefaultRegistry,
  SCALPING_ID,
  DAYTRADING_ID
} = require('../../index');
const {
  applyStrategyConfig,
  getStrategyCatalog,
  getStrategyAdminConfig,
  resetStrategyRuntimeConfigForTests,
  getActiveStrategy
} = require('../../../utils/strategyRuntimeConfig');

describe('Strategy Engine architecture', () => {
  beforeEach(() => {
    resetStrategyRuntimeConfigForTests();
    resetBootstrapFlag();
    resetProfileRegistry();
    resetDefaultRegistry();
    bootstrapStrategyProfiles(undefined, { force: true, includeStubs: true });
  });

  it('registers live + stub profiles in the profile registry', () => {
    const registry = new StrategyProfileRegistry();
    bootstrapStrategyProfiles(registry, { force: true, includeStubs: true });

    const keys = registry.list().map(p => p.key);
    assert.ok(keys.includes('scalping'));
    assert.ok(keys.includes('daytrading'));
    assert.ok(keys.includes('swing'));
    assert.ok(keys.includes('london_open'));
    assert.ok(keys.includes('ny_reversal'));
    assert.ok(keys.includes('asian_session'));
    assert.ok(keys.includes('trend_continuation'));

    assert.equal(registry.getByKey('swing').status, 'stub');
    assert.equal(registry.getByKey('scalping').status, 'live');
    assert.equal(registry.listExecutable().length, 2);
  });

  it('createDefaultRegistry instantiates only live profiles without hardcoding names in loop', () => {
    const registry = createDefaultRegistry({
      scalpingConfig: { enabled: true },
      daytradingConfig: { enabled: true }
    });
    const ids = registry.list().map(s => s.id).sort();
    assert.deepEqual(ids.sort(), [DAYTRADING_ID, SCALPING_ID].sort());
  });

  it('ScannerEngine.runEnabled does not branch on strategy name strings', () => {
    const profileRegistry = new StrategyProfileRegistry();
    profileRegistry.registerStrategy(createDayTradingProfile());
    profileRegistry.registerStrategy(createScalpingProfile());
    profileRegistry.registerStrategy(
      createStubProfile({
        id: 'fake_stub',
        key: 'fake_stub',
        name: 'Fake Stub'
      })
    );

    const strategyRegistry = createDefaultRegistry({
      scalpingConfig: { enabled: true },
      daytradingConfig: { enabled: true }
    });

    const engine = new ScannerEngine({ profileRegistry, strategyRegistry });
    const source = engine.runEnabled.toString();
    assert.equal(source.includes("'scalping'"), false);
    assert.equal(source.includes("'daytrading'"), false);
    assert.equal(source.includes('SCALPING'), false);

    const result = engine.runEnabled(
      { candles: [], htfCandles: [], scalpingHtfCandles: [], timeframe: '15m' },
      { prefer: 'daytrading' }
    );
    assert.ok(result.results);
    assert.ok(result.results.every(r => r.strategyId));
    // Stub must not appear in enabled run
    assert.ok(!result.results.some(r => r.strategyId === 'fake_stub'));
  });

  it('buildStrategyContext uses profile dataRequirements (no name ifs)', () => {
    const scalp = createScalpingProfile();
    const day = createDayTradingProfile();
    const market = {
      symbol: 'EURUSD',
      candles: [{ time: 1, open: 1, high: 1, low: 1, close: 1 }],
      htfCandles: [{ time: 2, open: 2, high: 2, low: 2, close: 2 }],
      scalpingHtfCandles: [{ time: 3, open: 3, high: 3, low: 3, close: 3 }]
    };

    const scalpCtx = buildStrategyContext(scalp, market);
    assert.equal(scalpCtx.htfCandles[0].time, 3);
    assert.equal(scalpCtx.timeframe, '3m');

    const dayCtx = buildStrategyContext(day, market);
    assert.equal(dayCtx.htfCandles[0].time, 2);
    assert.equal(dayCtx.timeframe, '15m');
  });

  it('resolvePreferStrategyId maps short keys and rejects stubs', () => {
    assert.equal(resolvePreferStrategyId('scalping'), SCALPING_ID);
    assert.equal(resolvePreferStrategyId('daytrading'), DAYTRADING_ID);
    assert.equal(resolvePreferStrategyId(SCALPING_ID), SCALPING_ID);
    assert.equal(resolvePreferStrategyId('swing'), DAYTRADING_ID);
    assert.equal(resolvePreferStrategyId('nope'), DAYTRADING_ID);
  });

  it('keeps scalping and daytrading admin configs independent via catalog', () => {
    applyStrategyConfig({
      scalping: { htfTimeframe: '5m', takeProfit: { maxTpDistancePips: 22 } },
      daytrading: { htfTimeframe: '4h', takeProfit: { maxTpDistancePips: 100 } }
    });
    applyStrategyConfig({
      daytrading: { takeProfit: { maxTpDistancePips: 88 } }
    });

    const admin = getStrategyAdminConfig();
    assert.equal(admin.scalping.htfTimeframe, '5m');
    assert.equal(admin.scalping.takeProfit.maxTpDistancePips, 22);
    assert.equal(admin.daytrading.takeProfit.maxTpDistancePips, 88);

    const catalog = getStrategyCatalog();
    const scalpEntry = catalog.find(c => c.key === 'scalping');
    const swingEntry = catalog.find(c => c.key === 'swing');
    assert.ok(scalpEntry);
    assert.equal(scalpEntry.status, 'live');
    assert.equal(scalpEntry.settings.htfTimeframe, '5m');
    assert.ok(swingEntry);
    assert.equal(swingEntry.status, 'stub');
    assert.equal(swingEntry.comingSoon, true);
  });

  it('stub analyze never produces entries', () => {
    const stub = createStubProfile({
      id: 'london_open',
      key: 'london_open',
      name: 'London Open'
    });
    const runner = stub.createInstance();
    const result = runner.analyze({ candles: [{ time: 1, open: 1, high: 1, low: 1, close: 1 }] });
    assert.equal(result.signal, false);
    assert.equal(result.stage, 'stub');
    assert.equal(runner.enabled, false);
  });

  it('activeStrategy remains a live prefer key after stub catalog load', () => {
    assert.equal(getActiveStrategy(), 'daytrading');
    applyStrategyConfig({ activeStrategy: 'scalping' });
    assert.equal(getActiveStrategy(), 'scalping');
  });
});
