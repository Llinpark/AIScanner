/**
 * Strategy TP Profile registry.
 *
 * Map strategyId → TpProfile. TakeProfitEngine consumes a resolved profile
 * (via config.takeProfit) and never hardcodes strategy-specific values.
 * New strategies (Swing, News, London Open, …) register via registerTpProfile.
 */

const { SCALPING_TP_PROFILE } = require('./scalpingTpProfile');
const { DAY_TRADING_TP_PROFILE } = require('./dayTradingTpProfile');

/** Safe system fallback when a strategy profile is missing. Never crash. */
const SYSTEM_DEFAULT_TP_PROFILE = Object.freeze({
  profileId: 'system_default',
  model: 'smart_scoring',
  enableSmartTpScoring: true,
  enableDynamicTp: true,
  atrCaps: Object.freeze([1.0, 1.5, 2.5]),
  maxAtrMultiplier: 2.5,
  maxTpDistancePips: 50,
  minScore: 0,
  scoreProximity: 5,
  allowRrFallback: true,
  deferredLiquidityCategories: Object.freeze([]),
  scoreWeights: Object.freeze({
    internal_liquidity: 45,
    external_liquidity: 38,
    equal_high_low: 40,
    untapped_fvg: 35,
    swing_high_low: 30,
    order_block: 25,
    breaker_block: 22,
    mitigation_block: 22,
    pdh_pdl: 20,
    pwh_pwl: 15,
    pmh_pml: 10,
    atr_projection: 8,
    rr_fallback: 5
  }),
  liquidityPriority: Object.freeze([
    'nearest_liquidity_pool',
    'equal_high_low',
    'swing_high_low',
    'pdh_pdl',
    'pwh_pwl',
    'untapped_fvg'
  ]),
  rrMultiples: Object.freeze([1.5, 2, 3]),
  manualRr: Object.freeze([1.5, 2.5, 4])
});

/**
 * Canonical registry: short admin keys + full strategy ids.
 * @type {Readonly<Record<string, Readonly<object>>>}
 */
const TP_PROFILE_REGISTRY = Object.freeze({
  scalping: SCALPING_TP_PROFILE,
  daytrading: DAY_TRADING_TP_PROFILE,
  liquidity_sweep_fvg_scalp: SCALPING_TP_PROFILE,
  liquidity_sweep_fvg_daytrading: DAY_TRADING_TP_PROFILE
});

/** Runtime extensions for future strategies (Swing, News, …). */
const RuntimeTpProfiles = Object.create(null);

/**
 * @param {string} strategyId
 * @returns {string|null}
 */
function normalizeProfileKey(strategyId) {
  const raw = String(strategyId || '')
    .toLowerCase()
    .trim();
  if (!raw) return null;
  if (TP_PROFILE_REGISTRY[raw] || RuntimeTpProfiles[raw]) return raw;
  if (raw.includes('scalp')) return 'scalping';
  if (raw.includes('day')) return 'daytrading';
  return raw;
}

/**
 * Look up a TP profile. Never throws — missing → system defaults.
 * @param {string} [strategyId]
 * @returns {Readonly<object>}
 */
function getTpProfile(strategyId) {
  try {
    const key = normalizeProfileKey(strategyId);
    if (key && RuntimeTpProfiles[key]) return RuntimeTpProfiles[key];
    if (key && TP_PROFILE_REGISTRY[key]) return TP_PROFILE_REGISTRY[key];
  } catch (_) {
    // fall through
  }
  return SYSTEM_DEFAULT_TP_PROFILE;
}

/**
 * Deep-clone a profile into a mutable plain object.
 * @param {object} [profile]
 */
function cloneTpProfile(profile) {
  const src = profile && typeof profile === 'object' ? profile : SYSTEM_DEFAULT_TP_PROFILE;
  return {
    ...src,
    atrCaps: [...(src.atrCaps || SYSTEM_DEFAULT_TP_PROFILE.atrCaps)],
    deferredLiquidityCategories: [...(src.deferredLiquidityCategories || [])],
    scoreWeights: { ...(src.scoreWeights || SYSTEM_DEFAULT_TP_PROFILE.scoreWeights) },
    liquidityPriority: [...(src.liquidityPriority || [])],
    rrMultiples: [...(src.rrMultiples || SYSTEM_DEFAULT_TP_PROFILE.rrMultiples)],
    manualRr: [...(src.manualRr || SYSTEM_DEFAULT_TP_PROFILE.manualRr)]
  };
}

/**
 * Merge admin/env overrides onto a strategy's TP profile.
 * Missing profile → system defaults. Never throws.
 * @param {string} [strategyId]
 * @param {object} [overrides]
 */
function resolveTpProfile(strategyId, overrides = {}) {
  try {
    const base = cloneTpProfile(getTpProfile(strategyId));
    const patch = overrides && typeof overrides === 'object' ? overrides : {};
    const merged = {
      ...base,
      ...patch,
      atrCaps:
        Array.isArray(patch.atrCaps) && patch.atrCaps.length ? [...patch.atrCaps] : base.atrCaps,
      deferredLiquidityCategories: Array.isArray(patch.deferredLiquidityCategories)
        ? [...patch.deferredLiquidityCategories]
        : base.deferredLiquidityCategories,
      scoreWeights: {
        ...base.scoreWeights,
        ...(patch.scoreWeights && typeof patch.scoreWeights === 'object' ? patch.scoreWeights : {})
      },
      liquidityPriority:
        Array.isArray(patch.liquidityPriority) && patch.liquidityPriority.length
          ? [...patch.liquidityPriority]
          : base.liquidityPriority,
      rrMultiples:
        Array.isArray(patch.rrMultiples) && patch.rrMultiples.length
          ? [...patch.rrMultiples]
          : base.rrMultiples,
      manualRr:
        Array.isArray(patch.manualRr) && patch.manualRr.length ? [...patch.manualRr] : base.manualRr
    };
    if (patch.profileId === undefined) {
      merged.profileId = base.profileId;
    }
    return merged;
  } catch (_) {
    return cloneTpProfile(SYSTEM_DEFAULT_TP_PROFILE);
  }
}

/**
 * Register a new strategy TP profile without changing TakeProfitEngine core.
 * @param {string} strategyId
 * @param {object} profile
 */
function registerTpProfile(strategyId, profile) {
  const key = String(strategyId || '')
    .toLowerCase()
    .trim();
  if (!key || !profile || typeof profile !== 'object') return false;
  RuntimeTpProfiles[key] = Object.freeze({ ...cloneTpProfile(profile), profileId: key });
  return true;
}

module.exports = {
  SCALPING_TP_PROFILE,
  DAY_TRADING_TP_PROFILE,
  SYSTEM_DEFAULT_TP_PROFILE,
  TP_PROFILE_REGISTRY,
  normalizeProfileKey,
  getTpProfile,
  cloneTpProfile,
  resolveTpProfile,
  registerTpProfile
};
