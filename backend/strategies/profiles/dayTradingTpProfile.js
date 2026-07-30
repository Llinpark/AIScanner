/**
 * Day Trading Strategy TP Profile — larger swings, HTF external liquidity.
 * Optimised for Entry 5m/15m, HTF 1H/4H. Expected TP1 ~40–70 pips.
 */

const DAY_TRADING_TP_PROFILE = Object.freeze({
  profileId: 'daytrading',
  model: 'smart_scoring',
  enableSmartTpScoring: true,
  enableDynamicTp: true,
  atrCaps: Object.freeze([1.5, 2.5, 3.5]),
  maxAtrMultiplier: 3.5,
  maxTpDistancePips: 100,
  minScore: 0,
  scoreProximity: 5,
  allowRrFallback: true,
  /** No deferred categories — PDH/PWH/external are first-class targets. */
  deferredLiquidityCategories: Object.freeze([]),
  scoreWeights: Object.freeze({
    pdh_pdl: 48,
    pwh_pwl: 44,
    external_liquidity: 42,
    swing_high_low: 40,
    equal_high_low: 32,
    untapped_fvg: 30,
    internal_liquidity: 28,
    order_block: 25,
    breaker_block: 22,
    mitigation_block: 22,
    pmh_pml: 28,
    atr_projection: 8,
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
