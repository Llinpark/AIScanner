/**
 * Official Scalping restore pack — admin form shape.
 * Keep in sync with backend:
 *   strategies/config/strategyArchitecture.js  (Entry TF / HTF — canonical)
 *   strategies/config/scalpingConfig.js
 *   strategies/profiles/scalpingTpProfile.js
 *   utils/marketRegimeConfig.js
 *   config/patternScanner.js
 *
 * Restore updates form state only; click Save to persist globally.
 */

import { STRATEGY_ARCHITECTURE } from './strategyArchitecture.js';

const ARCH = STRATEGY_ARCHITECTURE.scalping;

export const SCALPING_CONFIDENCE_WEIGHTS = Object.freeze({
  sweep: 30,
  mss: 20,
  displacement: 15,
  fvg: 15,
  retrace: 10,
  engulfing: 5,
  doji: 5
});

export const SCALPING_TP_SCORE_WEIGHTS = Object.freeze({
  internal_liquidity: 50,
  external_liquidity: 25,
  equal_high_low: 45,
  untapped_fvg: 40,
  swing_high_low: 35,
  order_block: 25,
  breaker_block: 22,
  mitigation_block: 22,
  pdh_pdl: 18,
  pwh_pwl: 8,
  pmh_pml: 5,
  atr_projection: 8,
  rr_fallback: 5
});

export const SCALPING_CORE_DEFAULTS = Object.freeze({
  autoScanIntervalMs: 60_000,
  scanBatchSize: 5,
  autoScanEnabled: true
});

export const SCALPING_MARKET_REGIME_DEFAULTS = Object.freeze({
  enabled: true,
  minAtrPips: 3,
  maxSpreadPips: 2.5,
  maxSpreadPipsByClass: Object.freeze({
    forex: 2.5,
    gold: 5,
    indices: 10,
    metal: 5,
    crypto: 25,
    other: 10
  }),
  maxSpreadPipsBySymbol: Object.freeze({}),
  minVolatilityScore: 20,
  minRegimeScore: 40,
  avoidHighImpactNews: true,
  avoidLowLiquiditySessions: false,
  allowAsianSession: true,
  allowLondonSession: true,
  allowNewYorkSession: true,
  allowSessionOverlap: true
});

export const SCALPING_STRATEGY_DEFAULTS = Object.freeze({
  enabled: true,
  htfTimeframe: ARCH.defaultHtfTimeframe,
  htfTimeframes: ARCH.htfTimeframes,
  entryTimeframes: ARCH.entryTimeframes,
  defaultEntryTimeframe: ARCH.defaultEntryTimeframe,
  entry: Object.freeze({
    model: 'ce',
    maxWaitBars: 10
  }),
  stop: Object.freeze({
    model: 'sweep',
    bufferAtrRatio: 0.05
  }),
  takeProfit: Object.freeze({
    profileId: 'scalping',
    model: 'smart_scoring',
    enableSmartTpScoring: true,
    enableDynamicTp: true,
    atrCaps: Object.freeze([0.8, 1.4, 2.0]),
    maxAtrMultiplier: 2,
    maxTpDistancePips: 30,
    minScore: 60,
    allowRrFallback: true,
    rrMultiples: Object.freeze([1.5, 2, 3]),
    scoreWeights: SCALPING_TP_SCORE_WEIGHTS
  }),
  fvg: Object.freeze({
    minGapToAtrRatio: 0.12
  }),
  confidence: Object.freeze({
    threshold: 70,
    weights: SCALPING_CONFIDENCE_WEIGHTS
  }),
  filters: Object.freeze({
    maxSpreadPips: 2.5,
    maxSpreadPipsByClass: Object.freeze({
      forex: 2.5,
      gold: 5,
      indices: 10
    }),
    maxSpreadPipsBySymbol: Object.freeze({}),
    minAtrPips: 2,
    rejectOnMajorNews: true
  })
});

/** Full restore payload for Admin Scanner (core + regime + strategy). */
export const OFFICIAL_SCALPING_RESTORE = Object.freeze({
  activeStrategy: 'scalping',
  core: SCALPING_CORE_DEFAULTS,
  marketRegime: SCALPING_MARKET_REGIME_DEFAULTS,
  strategy: SCALPING_STRATEGY_DEFAULTS
});

export function sumConfidenceWeights(weights = {}) {
  return Object.values(weights).reduce((acc, v) => acc + (Number(v) || 0), 0);
}

export function normalizeConfidenceWeights(weights, keys) {
  const src = weights && typeof weights === 'object' ? weights : {};
  const next = {};
  let sum = 0;
  for (const key of keys) {
    const n = Math.max(0, Number(src[key]) || 0);
    next[key] = n;
    sum += n;
  }
  if (sum === 100) return next;
  if (sum <= 0) {
    const even = Math.floor(100 / keys.length);
    const remainder = 100 - even * keys.length;
    keys.forEach((key, i) => {
      next[key] = even + (i < remainder ? 1 : 0);
    });
    return next;
  }
  // Scale to 100 with integer rounding, fix remainder on first key
  let allocated = 0;
  keys.forEach((key, i) => {
    if (i === keys.length - 1) {
      next[key] = Math.max(0, 100 - allocated);
    } else {
      next[key] = Math.round((next[key] / sum) * 100);
      allocated += next[key];
    }
  });
  return next;
}
