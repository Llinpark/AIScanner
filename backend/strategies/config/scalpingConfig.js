/**
 * Liquidity Sweep + Fair Value Gap (Scalping) — all thresholds in one place.
 * Override via env: SCALPING_* keys (see resolveScalpingConfig).
 * TP settings come from the Scalping Strategy TP Profile (independent of day trading).
 *
 * Timeframe allowlists come from strategyArchitecture.js (canonical).
 */

const { resolveTpProfile, SCALPING_TP_PROFILE } = require('../profiles');
const { resolveArchitectureTimeframes } = require('./strategyArchitecture');

const STRATEGY_ID = 'liquidity_sweep_fvg_scalp';
const STRATEGY_NAME = 'Liquidity Sweep + Fair Value Gap (Scalping)';
const STRATEGY_KEY = 'scalping';

const _scalpTp = SCALPING_TP_PROFILE;
const _archTf = resolveArchitectureTimeframes(STRATEGY_KEY);

const DEFAULT_SCALPING_CONFIG = Object.freeze({
  id: STRATEGY_ID,
  name: STRATEGY_NAME,
  enabled: process.env.SCALPING_STRATEGY_ENABLED !== 'false',

  // Timeframes — HTF is context only; entries never on HTF (canonical: 1m/3m/5m entry, 15m HTF)
  htfTimeframe: _archTf.htfTimeframe,
  htfTimeframes: Object.freeze([..._archTf.htfTimeframes]),
  entryTimeframes: Object.freeze([..._archTf.entryTimeframes]),
  defaultEntryTimeframe: _archTf.defaultEntryTimeframe,

  // Liquidity / swings
  swing: {
    sensitivity: Math.max(1, parseInt(process.env.SCALPING_SWING_SENSITIVITY || '2', 10)),
    lookbackBars: Math.max(20, parseInt(process.env.SCALPING_SWING_LOOKBACK || '48', 10)),
    equalToleranceAtrRatio: Number(process.env.SCALPING_EQH_EQL_TOLERANCE || 0.08),
    maxSweepsBeforeReject: Math.max(1, parseInt(process.env.SCALPING_MAX_SWEEPS || '2', 10))
  },

  // Sessions (UTC hours) for Asian / London / NY H/L
  sessions: {
    asian: { startHour: 0, endHour: 8 },
    london: { startHour: 7, endHour: 16 },
    ny: { startHour: 12, endHour: 21 }
  },

  // MSS
  mss: {
    structureLookbackBars: Math.max(8, parseInt(process.env.SCALPING_MSS_LOOKBACK || '24', 10))
  },

  // Displacement (mandatory)
  displacement: {
    atrPeriod: Math.max(5, parseInt(process.env.SCALPING_ATR_PERIOD || '14', 10)),
    minBodyRatio: Number(process.env.SCALPING_DISP_BODY_RATIO || 0.62),
    maxWickRatio: Number(process.env.SCALPING_DISP_MAX_WICK || 0.32),
    minBodyToAvgRatio: Number(process.env.SCALPING_DISP_BODY_AVG || 1.15),
    minRangeToAtrRatio: Number(process.env.SCALPING_DISP_ATR_MULT || 1.05),
    closeNearExtremeRatio: Number(process.env.SCALPING_DISP_CLOSE_EXTREME || 0.25)
  },

  // Engulfing — preferred, not mandatory by default
  engulfing: {
    required: process.env.SCALPING_ENGULFING_REQUIRED === 'true',
    lookbackBars: 6
  },

  // ICT FVG
  fvg: {
    minGapToAtrRatio: Number(process.env.SCALPING_MIN_FVG_ATR || 0.12),
    lookbackBars: Math.max(6, parseInt(process.env.SCALPING_FVG_LOOKBACK || '18', 10)),
    dojiBodyRatioMax: Number(process.env.SCALPING_DOJI_BODY || 0.12)
  },

  // Entry models: entire | upper_half | lower_half | ce (default CE 50%)
  entry: {
    model: process.env.SCALPING_ENTRY_MODEL || 'ce',
    maxWaitBars: Math.max(3, parseInt(process.env.SCALPING_RETRACE_WAIT || '10', 10)),
    neverEnterOnDisplacement: true
  },

  // Stop models: sweep | fvg | sweep_or_fvg (risk-valid closer preference)
  // maxStopAtrMult caps structural SL distance using entry-TF ATR (independent of TP ATR caps).
  stop: {
    model: process.env.SCALPING_STOP_MODEL || 'sweep',
    bufferAtrRatio: Number(process.env.SCALPING_SL_BUFFER_ATR || 0.05),
    maxStopAtrMult: Number(process.env.SCALPING_MAX_SL_ATR || 1.5)
  },

  // TP — Scalping Strategy Profile (independent of day trading)
  takeProfit: {
    profileId: _scalpTp.profileId,
    // smart_scoring (default) | dynamic_liquidity (alias) | rr | previous_swing | nearest_liquidity | next_ob | manual_rr
    model: process.env.SCALPING_TP_MODEL || _scalpTp.model,
    enableSmartTpScoring: process.env.SCALPING_SMART_TP !== 'false',
    enableDynamicTp: process.env.SCALPING_DYNAMIC_TP !== 'false',
    atrCaps: (process.env.SCALPING_TP_ATR_CAPS || _scalpTp.atrCaps.join(','))
      .split(',')
      .map(Number)
      .filter(n => Number.isFinite(n) && n > 0),
    maxAtrMultiplier: Number(process.env.SCALPING_TP_MAX_ATR || _scalpTp.maxAtrMultiplier),
    maxTpDistancePips:
      process.env.SCALPING_TP_MAX_PIPS !== undefined && process.env.SCALPING_TP_MAX_PIPS !== ''
        ? Number(process.env.SCALPING_TP_MAX_PIPS) || null
        : _scalpTp.maxTpDistancePips,
    minScore: Number(process.env.SCALPING_TP_MIN_SCORE || _scalpTp.minScore),
    scoreProximity: Number(process.env.SCALPING_TP_SCORE_PROXIMITY || _scalpTp.scoreProximity),
    allowRrFallback: process.env.SCALPING_TP_RR_FALLBACK !== 'false',
    minRr: Number(process.env.SCALPING_MIN_RR || 0.5),
    deferredLiquidityCategories: [..._scalpTp.deferredLiquidityCategories],
    scoreWeights: {
      internal_liquidity: Number(
        process.env.SCALPING_TP_W_INTERNAL || _scalpTp.scoreWeights.internal_liquidity
      ),
      external_liquidity: Number(
        process.env.SCALPING_TP_W_EXTERNAL || _scalpTp.scoreWeights.external_liquidity
      ),
      equal_high_low: Number(process.env.SCALPING_TP_W_EQH || _scalpTp.scoreWeights.equal_high_low),
      untapped_fvg: Number(process.env.SCALPING_TP_W_FVG || _scalpTp.scoreWeights.untapped_fvg),
      swing_high_low: Number(process.env.SCALPING_TP_W_SWING || _scalpTp.scoreWeights.swing_high_low),
      order_block: Number(process.env.SCALPING_TP_W_OB || _scalpTp.scoreWeights.order_block),
      breaker_block: Number(
        process.env.SCALPING_TP_W_BREAKER || _scalpTp.scoreWeights.breaker_block
      ),
      mitigation_block: Number(
        process.env.SCALPING_TP_W_MITIGATION || _scalpTp.scoreWeights.mitigation_block
      ),
      pdh_pdl: Number(process.env.SCALPING_TP_W_PD || _scalpTp.scoreWeights.pdh_pdl),
      pwh_pwl: Number(process.env.SCALPING_TP_W_PW || _scalpTp.scoreWeights.pwh_pwl),
      pmh_pml: Number(process.env.SCALPING_TP_W_PM || _scalpTp.scoreWeights.pmh_pml),
      atr_projection: Number(process.env.SCALPING_TP_W_ATR || _scalpTp.scoreWeights.atr_projection),
      rr_fallback: Number(process.env.SCALPING_TP_W_RR || _scalpTp.scoreWeights.rr_fallback)
    },
    liquidityPriority: (
      process.env.SCALPING_TP_LIQUIDITY_PRIORITY || _scalpTp.liquidityPriority.join(',')
    )
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    rrMultiples: (process.env.SCALPING_TP_RR || _scalpTp.rrMultiples.join(','))
      .split(',')
      .map(Number)
      .filter(n => Number.isFinite(n) && n > 0),
    manualRr: (process.env.SCALPING_MANUAL_RR || _scalpTp.manualRr.join(','))
      .split(',')
      .map(Number)
      .filter(n => Number.isFinite(n) && n > 0)
  },

  // Confidence 0–100
  confidence: {
    threshold: Number(process.env.SCALPING_CONFIDENCE_THRESHOLD || 70),
    weights: {
      sweep: 30,
      mss: 20,
      displacement: 15,
      fvg: 15,
      retrace: 10,
      engulfing: 5,
      doji: 5
    }
  },

  // Filters
  filters: {
    maxSpreadPipsByClass: {
      forex: Number(process.env.SCALPING_MAX_SPREAD_FOREX || 2.5),
      gold: Number(process.env.SCALPING_MAX_SPREAD_GOLD || 5),
      indices: Number(process.env.SCALPING_MAX_SPREAD_INDICES || 10)
    },
    maxSpreadPipsBySymbol: {},
    /** @deprecated Prefer maxSpreadPipsByClass / resolveMaxSpreadPips. */
    maxSpreadPips: Number(process.env.SCALPING_MAX_SPREAD_PIPS || 2.5),
    minAtrPips: Number(process.env.SCALPING_MIN_ATR_PIPS || 2.0),
    sidewaysAtrRatioMax: Number(process.env.SCALPING_SIDEWAYS_ATR || 0.55),
    sidewaysLookback: 20,
    rejectOnMajorNews: process.env.SCALPING_NEWS_FILTER !== 'false'
  },

  // Incremental cache
  cache: {
    maxCandlesHtf: 120,
    maxCandlesLtf: 180
  }
});

/**
 * @param {Partial<typeof DEFAULT_SCALPING_CONFIG>} [overrides]
 */
function resolveScalpingConfig(overrides = {}) {
  const takeProfit = resolveTpProfile(STRATEGY_KEY, {
    ...DEFAULT_SCALPING_CONFIG.takeProfit,
    ...(overrides.takeProfit || {})
  });
  const archTf = resolveArchitectureTimeframes(STRATEGY_KEY, {
    entryTimeframes: overrides.entryTimeframes,
    defaultEntryTimeframe: overrides.defaultEntryTimeframe,
    htfTimeframe: overrides.htfTimeframe
  });
  return {
    ...DEFAULT_SCALPING_CONFIG,
    ...overrides,
    htfTimeframe: archTf.htfTimeframe,
    htfTimeframes: [...archTf.htfTimeframes],
    entryTimeframes: [...archTf.entryTimeframes],
    defaultEntryTimeframe: archTf.defaultEntryTimeframe,
    swing: { ...DEFAULT_SCALPING_CONFIG.swing, ...(overrides.swing || {}) },
    sessions: { ...DEFAULT_SCALPING_CONFIG.sessions, ...(overrides.sessions || {}) },
    mss: { ...DEFAULT_SCALPING_CONFIG.mss, ...(overrides.mss || {}) },
    displacement: { ...DEFAULT_SCALPING_CONFIG.displacement, ...(overrides.displacement || {}) },
    engulfing: { ...DEFAULT_SCALPING_CONFIG.engulfing, ...(overrides.engulfing || {}) },
    fvg: { ...DEFAULT_SCALPING_CONFIG.fvg, ...(overrides.fvg || {}) },
    entry: { ...DEFAULT_SCALPING_CONFIG.entry, ...(overrides.entry || {}) },
    stop: { ...DEFAULT_SCALPING_CONFIG.stop, ...(overrides.stop || {}) },
    takeProfit,
    confidence: {
      ...DEFAULT_SCALPING_CONFIG.confidence,
      ...(overrides.confidence || {}),
      weights: {
        ...DEFAULT_SCALPING_CONFIG.confidence.weights,
        ...(overrides.confidence?.weights || {})
      }
    },
    filters: {
      ...DEFAULT_SCALPING_CONFIG.filters,
      ...(overrides.filters || {}),
      maxSpreadPipsByClass: {
        ...(DEFAULT_SCALPING_CONFIG.filters.maxSpreadPipsByClass || {}),
        ...(overrides.filters?.maxSpreadPipsByClass || {})
      },
      maxSpreadPipsBySymbol: {
        ...(DEFAULT_SCALPING_CONFIG.filters.maxSpreadPipsBySymbol || {}),
        ...(overrides.filters?.maxSpreadPipsBySymbol || {})
      }
    },
    cache: { ...DEFAULT_SCALPING_CONFIG.cache, ...(overrides.cache || {}) }
  };
}

module.exports = {
  STRATEGY_ID,
  STRATEGY_NAME,
  STRATEGY_KEY,
  DEFAULT_SCALPING_CONFIG,
  resolveScalpingConfig
};
