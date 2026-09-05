/**
 * Scalping Strategy TP Profile — nearby liquidity, tight ATR/pip caps.
 * Official defaults for Restore Default Scalping Settings.
 * Optimised for Entry TF 3m/5m, HTF 15m. Expected TP1 ~20–30 pips.
 */

const SCALPING_TP_PROFILE = Object.freeze({
  profileId: 'scalping',
  model: 'smart_scoring',
  enableSmartTpScoring: true,
  enableDynamicTp: true,
  atrCaps: Object.freeze([0.8, 1.4, 2.0]),
  maxAtrMultiplier: 2.0,
  maxTpDistancePips: 30,
  minScore: 60,
  scoreProximity: 5,
  allowRrFallback: true,
  /** Prefer nearby; weekly/monthly only when nothing nearby remains. */
  deferredLiquidityCategories: Object.freeze(['pwh_pwl', 'pmh_pml']),
  scoreWeights: Object.freeze({
    internal_liquidity: 50,
    equal_high_low: 45,
    untapped_fvg: 40,
    swing_high_low: 35,
    external_liquidity: 25,
    order_block: 25,
    breaker_block: 22,
    mitigation_block: 22,
    pdh_pdl: 18,
    pwh_pwl: 8,
    pmh_pml: 5,
    atr_projection: 8,
    rr_fallback: 5
  }),
  liquidityPriority: Object.freeze([
    'nearest_liquidity_pool',
    'equal_high_low',
    'untapped_fvg',
    'swing_high_low',
    'pdh_pdl',
    'pwh_pwl'
  ]),
  rrMultiples: Object.freeze([1.5, 2, 3]),
  manualRr: Object.freeze([1.5, 2.5, 4])
});

module.exports = { SCALPING_TP_PROFILE };
