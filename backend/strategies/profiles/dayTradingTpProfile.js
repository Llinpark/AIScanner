/**
 * Day Trading Strategy TP Profile — larger swings, institutional liquidity.
 * Official defaults for Restore Default Day Trading Settings.
 * Fewer / higher-quality signals; wider TPs for multi-hour holds.
 * Optimised for Entry 5m/15m, HTF 1H. Expected TP1 ~40–70 pips.
 */

const DAY_TRADING_TP_PROFILE = Object.freeze({
  profileId: 'daytrading',
  model: 'smart_scoring',
  enableSmartTpScoring: true,
  enableDynamicTp: true,
  atrCaps: Object.freeze([1.0, 2.0, 3.5]),
  maxAtrMultiplier: 3.0,
  maxTpDistancePips: 150,
  minScore: 70,
  scoreProximity: 5,
  allowRrFallback: true,
  /** No deferred categories — PDH/PWH/external are first-class targets. */
  deferredLiquidityCategories: Object.freeze([]),
  scoreWeights: Object.freeze({
    internal_liquidity: 55,
    external_liquidity: 30,
    equal_high_low: 45,
    swing_high_low: 40,
    untapped_fvg: 45,
    order_block: 30,
    breaker_block: 25,
    mitigation_block: 25,
    pdh_pdl: 25,
    pwh_pwl: 15,
    pmh_pml: 10,
    atr_projection: 10,
    rr_fallback: 5
  }),
  liquidityPriority: Object.freeze([
    'pdh_pdl',
    'pwh_pwl',
    'swing_high_low',
    'nearest_liquidity_pool',
    'equal_high_low',
    'untapped_fvg'
  ]),
  rrMultiples: Object.freeze([1.5, 2, 3]),
  manualRr: Object.freeze([2, 3, 4]),
  minRr: 1.2
});

module.exports = { DAY_TRADING_TP_PROFILE };
