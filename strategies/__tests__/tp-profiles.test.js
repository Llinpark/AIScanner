/**
 * Strategy TP Profile registry — independence, auto-load, safe fallback.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  getTpProfile,
  resolveTpProfile,
  registerTpProfile,
  SCALPING_TP_PROFILE,
  DAY_TRADING_TP_PROFILE,
  SYSTEM_DEFAULT_TP_PROFILE,
  TP_PROFILE_REGISTRY
} = require('../profiles');
const { resolveScalpingConfig } = require('../config/scalpingConfig');
const { resolveDayTradingConfig } = require('../config/dayTradingConfig');
const {
  applyStrategyConfig,
  getResolvedScalpingConfig,
  getResolvedDaytradingConfig,
  resetStrategyRuntimeConfigForTests
} = require('../../utils/strategyRuntimeConfig');

describe('TP Profile registry', () => {
  it('maps scalping and daytrading to independent default profiles', () => {
    const scalp = getTpProfile('scalping');
    const day = getTpProfile('daytrading');
    assert.equal(scalp.profileId, 'scalping');
    assert.equal(day.profileId, 'daytrading');
    assert.equal(scalp.maxTpDistancePips, 30);
    assert.equal(day.maxTpDistancePips, 150);
    assert.deepEqual([...scalp.atrCaps], [0.8, 1.4, 2.0]);
    assert.deepEqual([...day.atrCaps], [1.0, 2.0, 3.5]);
    assert.equal(scalp.minScore, 60);
    assert.equal(day.minScore, 70);
    assert.notDeepEqual(scalp.scoreWeights, day.scoreWeights);
    assert.ok(scalp.deferredLiquidityCategories.includes('pwh_pwl'));
    assert.equal(day.deferredLiquidityCategories.length, 0);
  });

  it('resolves full strategy ids via registry aliases', () => {
    assert.equal(getTpProfile('liquidity_sweep_fvg_scalp').profileId, 'scalping');
    assert.equal(getTpProfile('liquidity_sweep_fvg_daytrading').profileId, 'daytrading');
    assert.ok(TP_PROFILE_REGISTRY.scalping === SCALPING_TP_PROFILE);
    assert.ok(TP_PROFILE_REGISTRY.daytrading === DAY_TRADING_TP_PROFILE);
  });

  it('falls back to system defaults for missing profiles without throwing', () => {
    const missing = getTpProfile('swing_london_open_unknown');
    assert.equal(missing.profileId, SYSTEM_DEFAULT_TP_PROFILE.profileId);
    const resolved = resolveTpProfile('does_not_exist_xyz', { maxTpDistancePips: 77 });
    assert.equal(resolved.profileId, 'system_default');
    assert.equal(resolved.maxTpDistancePips, 77);
    assert.doesNotThrow(() => resolveTpProfile(null));
    assert.doesNotThrow(() => resolveTpProfile(undefined, null));
  });

  it('registerTpProfile extends registry without touching engine core', () => {
    const ok = registerTpProfile('news', {
      maxTpDistancePips: 60,
      atrCaps: [1, 2, 3],
      scoreWeights: { pdh_pdl: 50 }
    });
    assert.equal(ok, true);
    const news = getTpProfile('news');
    assert.equal(news.profileId, 'news');
    assert.equal(news.maxTpDistancePips, 60);
  });
});

describe('Strategy config independence via TP profiles', () => {
  beforeEach(() => {
    resetStrategyRuntimeConfigForTests();
  });

  it('changing scalping TP never mutates day trading TP', () => {
    applyStrategyConfig({
      scalping: {
        takeProfit: { maxTpDistancePips: 22, atrCaps: [0.5, 1.0, 1.5] }
      },
      daytrading: {
        takeProfit: { maxTpDistancePips: 100 }
      }
    });
    applyStrategyConfig({
      scalping: {
        takeProfit: { maxTpDistancePips: 15 }
      }
    });

    const scalp = getResolvedScalpingConfig();
    const day = getResolvedDaytradingConfig();
    assert.equal(scalp.takeProfit.maxTpDistancePips, 15);
    assert.equal(day.takeProfit.maxTpDistancePips, 100);
    assert.deepEqual(day.takeProfit.atrCaps, [1.0, 2.0, 3.5]);
    assert.notEqual(scalp.takeProfit.profileId, day.takeProfit.profileId);
  });

  it('resolve helpers auto-load the matching TP profile', () => {
    const scalp = resolveScalpingConfig();
    const day = resolveDayTradingConfig();
    assert.equal(scalp.takeProfit.profileId, 'scalping');
    assert.equal(day.takeProfit.profileId, 'daytrading');
    assert.equal(scalp.takeProfit.maxTpDistancePips, SCALPING_TP_PROFILE.maxTpDistancePips);
    assert.equal(day.takeProfit.maxTpDistancePips, DAY_TRADING_TP_PROFILE.maxTpDistancePips);
  });
});
