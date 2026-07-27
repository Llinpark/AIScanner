/**
 * Liquidity Sweep + Fair Value Gap (Scalping) — all thresholds in one place.
 * Override via env: SCALPING_* keys (see resolveScalpingConfig).
 */

const STRATEGY_ID = 'liquidity_sweep_fvg_scalp';
const STRATEGY_NAME = 'Liquidity Sweep + Fair Value Gap (Scalping)';

const DEFAULT_SCALPING_CONFIG = Object.freeze({
  id: STRATEGY_ID,
  name: STRATEGY_NAME,
  enabled: process.env.SCALPING_STRATEGY_ENABLED !== 'false',

  // Timeframes — HTF is context only; entries never on 15m
  htfTimeframe: process.env.SCALPING_HTF_TF || '15m',
  entryTimeframes: (process.env.SCALPING_ENTRY_TFS || '3m,1m')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  defaultEntryTimeframe: process.env.SCALPING_DEFAULT_ENTRY_TF || '3m',

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

  // Stop models: sweep | fvg | sweep_or_fvg (more protective)
  stop: {
    model: process.env.SCALPING_STOP_MODEL || 'sweep',
    bufferAtrRatio: Number(process.env.SCALPING_SL_BUFFER_ATR || 0.05)
  },

  // TP models — partials map to TP1/TP2/TP3
  takeProfit: {
    // rr | previous_swing | nearest_liquidity | next_ob | manual_rr
    model: process.env.SCALPING_TP_MODEL || 'rr',
    rrMultiples: (process.env.SCALPING_TP_RR || '2,3,4')
      .split(',')
      .map(Number)
      .filter(n => Number.isFinite(n) && n > 0),
    manualRr: (process.env.SCALPING_MANUAL_RR || '1.5,2.5,4')
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
    maxSpreadPips: Number(process.env.SCALPING_MAX_SPREAD_PIPS || 3.5),
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
  return {
    ...DEFAULT_SCALPING_CONFIG,
    ...overrides,
    swing: { ...DEFAULT_SCALPING_CONFIG.swing, ...(overrides.swing || {}) },
    sessions: { ...DEFAULT_SCALPING_CONFIG.sessions, ...(overrides.sessions || {}) },
    mss: { ...DEFAULT_SCALPING_CONFIG.mss, ...(overrides.mss || {}) },
    displacement: { ...DEFAULT_SCALPING_CONFIG.displacement, ...(overrides.displacement || {}) },
    engulfing: { ...DEFAULT_SCALPING_CONFIG.engulfing, ...(overrides.engulfing || {}) },
    fvg: { ...DEFAULT_SCALPING_CONFIG.fvg, ...(overrides.fvg || {}) },
    entry: { ...DEFAULT_SCALPING_CONFIG.entry, ...(overrides.entry || {}) },
    stop: { ...DEFAULT_SCALPING_CONFIG.stop, ...(overrides.stop || {}) },
    takeProfit: {
      ...DEFAULT_SCALPING_CONFIG.takeProfit,
      ...(overrides.takeProfit || {}),
      rrMultiples:
        overrides.takeProfit?.rrMultiples || DEFAULT_SCALPING_CONFIG.takeProfit.rrMultiples,
      manualRr: overrides.takeProfit?.manualRr || DEFAULT_SCALPING_CONFIG.takeProfit.manualRr
    },
    confidence: {
      ...DEFAULT_SCALPING_CONFIG.confidence,
      ...(overrides.confidence || {}),
      weights: {
        ...DEFAULT_SCALPING_CONFIG.confidence.weights,
        ...(overrides.confidence?.weights || {})
      }
    },
    filters: { ...DEFAULT_SCALPING_CONFIG.filters, ...(overrides.filters || {}) },
    cache: { ...DEFAULT_SCALPING_CONFIG.cache, ...(overrides.cache || {}) }
  };
}

module.exports = {
  STRATEGY_ID,
  STRATEGY_NAME,
  DEFAULT_SCALPING_CONFIG,
  resolveScalpingConfig
};
