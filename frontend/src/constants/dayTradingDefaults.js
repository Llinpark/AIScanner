/**
 * Official Day Trading restore pack — admin form shape.
 * Keep in sync with backend:
 *   strategies/config/dayTradingConfig.js
 *   strategies/profiles/dayTradingTpProfile.js
 *
 * Intent: fewer/higher-quality signals, HTF alignment, wider TPs,
 * institutional liquidity, filter ranging / low-vol / Asian sessions.
 *
 * Confidence mapping (daytrading schema):
 *   User Sweep/MSS/Displacement/FVG/Retrace + Engulfing+Doji
 *   → htfBias=0, sweep=35, mss=25, displacement=10, fvg=15,
 *     retrace=5, optionalConfirmation=10 (engulfing+doji). Sum=100.
 *
 * Restore updates form state only; click Save to persist globally.
 */

export const DAYTRADING_CONFIDENCE_WEIGHTS = Object.freeze({
  htfBias: 0,
  sweep: 35,
  mss: 25,
  displacement: 10,
  fvg: 15,
  retrace: 5,
  optionalConfirmation: 10
});

export const DAYTRADING_TP_SCORE_WEIGHTS = Object.freeze({
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
});

export const DAYTRADING_MARKET_REGIME_DEFAULTS = Object.freeze({
  enabled: true,
  minAtrPips: 5,
  maxSpreadPips: 2.5,
  maxSpreadPipsByClass: Object.freeze({
    forex: 2.5,
    gold: 8,
    indices: 15,
    metal: 8,
    crypto: 25,
    other: 10
  }),
  maxSpreadPipsBySymbol: Object.freeze({}),
  minVolatilityScore: 35,
  minRegimeScore: 55,
  avoidHighImpactNews: true,
  avoidLowLiquiditySessions: true,
  allowAsianSession: false,
  allowLondonSession: true,
  allowNewYorkSession: true,
  allowSessionOverlap: true
});

export const DAYTRADING_STRATEGY_DEFAULTS = Object.freeze({
  enabled: true,
  htfTimeframe: '1h',
  refineHtfTimeframe: '1h',
  useRefineHtf: false,
  entryTimeframes: Object.freeze(['15m', '5m']),
  defaultEntryTimeframe: '15m',
  entry: Object.freeze({
    model: 'ce',
    maxWaitBars: 15
  }),
  stop: Object.freeze({
    model: 'sweep',
    bufferAtrRatio: 0.08
  }),
  takeProfit: Object.freeze({
    profileId: 'daytrading',
    model: 'smart_scoring',
    enableSmartTpScoring: true,
    enableDynamicTp: true,
    atrCaps: Object.freeze([1.0, 2.0, 3.5]),
    maxAtrMultiplier: 3,
    maxTpDistancePips: 150,
    minScore: 70,
    allowRrFallback: true,
    rrMultiples: Object.freeze([1.5, 2, 3]),
    scoreWeights: DAYTRADING_TP_SCORE_WEIGHTS
  }),
  fvg: Object.freeze({
    minGapToAtrRatio: 0.18
  }),
  confidence: Object.freeze({
    threshold: 80,
    weights: DAYTRADING_CONFIDENCE_WEIGHTS
  }),
  filters: Object.freeze({
    maxSpreadPips: 2.5,
    maxSpreadPipsByClass: Object.freeze({
      forex: 2.5,
      gold: 8,
      indices: 15
    }),
    maxSpreadPipsBySymbol: Object.freeze({}),
    minAtrPips: 5,
    rejectOnMajorNews: true
  })
});

/** Full restore payload for Admin Scanner (regime + strategy). */
export const OFFICIAL_DAYTRADING_RESTORE = Object.freeze({
  activeStrategy: 'daytrading',
  marketRegime: DAYTRADING_MARKET_REGIME_DEFAULTS,
  strategy: DAYTRADING_STRATEGY_DEFAULTS
});

export function sumConfidenceWeights(weights = {}) {
  return Object.values(weights).reduce((acc, v) => acc + (Number(v) || 0), 0);
}
