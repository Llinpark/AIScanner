/**
 * Liquidity Sweep + Fair Value Gap (Day Trading) — all thresholds.
 * Override via DAYTRADING_* env keys.
 */

const STRATEGY_ID = 'liquidity_sweep_fvg_daytrading';
const STRATEGY_NAME = 'Liquidity Sweep + Fair Value Gap (Day Trading)';

const DEFAULT_DAYTRADING_CONFIG = Object.freeze({
  id: STRATEGY_ID,
  name: STRATEGY_NAME,
  enabled: process.env.DAYTRADING_SWEEP_FVG_ENABLED !== 'false',

  // HTF: 4H bias (never entries); optional 1H refine; entries only 15m/5m
  htfTimeframe: process.env.DAYTRADING_HTF_TF || '4h',
  refineHtfTimeframe: process.env.DAYTRADING_REFINE_HTF_TF || '1h',
  useRefineHtf: process.env.DAYTRADING_USE_REFINE_HTF !== 'false',
  entryTimeframes: (process.env.DAYTRADING_ENTRY_TFS || '15m,5m')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  defaultEntryTimeframe: process.env.DAYTRADING_DEFAULT_ENTRY_TF || '15m',

  swing: {
    sensitivity: Math.max(1, parseInt(process.env.DAYTRADING_SWING_SENSITIVITY || '3', 10)),
    lookbackBars: Math.max(24, parseInt(process.env.DAYTRADING_SWING_LOOKBACK || '64', 10)),
    equalToleranceAtrRatio: Number(process.env.DAYTRADING_EQH_EQL_TOLERANCE || 0.1),
    maxSweepsBeforeReject: Math.max(1, parseInt(process.env.DAYTRADING_MAX_SWEEPS || '2', 10)),
    majorSwingLookback: Math.max(10, parseInt(process.env.DAYTRADING_MAJOR_SWING_LOOKBACK || '20', 10))
  },

  sessions: {
    asian: { startHour: 0, endHour: 8 },
    london: { startHour: 7, endHour: 16 },
    ny: { startHour: 12, endHour: 21 }
  },

  liquidity: {
    includeRoundLevels: process.env.DAYTRADING_ROUND_LEVELS !== 'false',
    includeWeekly: process.env.DAYTRADING_WEEKLY_LEVELS !== 'false',
    includeTrendline: process.env.DAYTRADING_TRENDLINE_LIQUIDITY === 'true',
    roundLevelStepMult: Number(process.env.DAYTRADING_ROUND_STEP || 1)
  },

  htfBias: {
    smaPeriod: Math.max(5, parseInt(process.env.DAYTRADING_BIAS_SMA || '20', 10)),
    structureLookback: Math.max(8, parseInt(process.env.DAYTRADING_BIAS_STRUCTURE || '12', 10)),
    requireNonNeutral: true
  },

  mss: {
    structureLookbackBars: Math.max(10, parseInt(process.env.DAYTRADING_MSS_LOOKBACK || '32', 10))
  },

  displacement: {
    atrPeriod: Math.max(5, parseInt(process.env.DAYTRADING_ATR_PERIOD || '14', 10)),
    minBodyRatio: Number(process.env.DAYTRADING_DISP_BODY_RATIO || 0.65),
    maxWickRatio: Number(process.env.DAYTRADING_DISP_MAX_WICK || 0.28),
    minBodyToAvgRatio: Number(process.env.DAYTRADING_DISP_BODY_AVG || 1.25),
    minRangeToAtrRatio: Number(process.env.DAYTRADING_DISP_ATR_MULT || 1.15),
    closeNearExtremeRatio: Number(process.env.DAYTRADING_DISP_CLOSE_EXTREME || 0.22)
  },

  engulfing: {
    required: false,
    lookbackBars: 8
  },

  fvg: {
    minGapToAtrRatio: Number(process.env.DAYTRADING_MIN_FVG_ATR || 0.15),
    lookbackBars: Math.max(8, parseInt(process.env.DAYTRADING_FVG_LOOKBACK || '24', 10)),
    dojiBodyRatioMax: Number(process.env.DAYTRADING_DOJI_BODY || 0.12)
  },

  entry: {
    model: process.env.DAYTRADING_ENTRY_MODEL || 'ce',
    maxWaitBars: Math.max(4, parseInt(process.env.DAYTRADING_RETRACE_WAIT || '16', 10)),
    neverEnterOnDisplacement: true,
    doNotChase: true
  },

  stop: {
    model: process.env.DAYTRADING_STOP_MODEL || 'sweep',
    bufferAtrRatio: Number(process.env.DAYTRADING_SL_BUFFER_ATR || 0.08),
    maxStopAtrMult: Number(process.env.DAYTRADING_MAX_SL_ATR || 2.5)
  },

  takeProfit: {
    // institutional: TP1 nearest swing, TP2 PDH/PDL, TP3 PWH/PWL (TV maps 1–3)
    // extras stay in diagnostics (TP4 liquidity, TP5–7 RR)
    model: process.env.DAYTRADING_TP_MODEL || 'institutional',
    rrMultiples: (process.env.DAYTRADING_TP_RR || '2,3,4')
      .split(',')
      .map(Number)
      .filter(n => Number.isFinite(n) && n > 0),
    manualRr: (process.env.DAYTRADING_MANUAL_RR || '2,3,4')
      .split(',')
      .map(Number)
      .filter(n => Number.isFinite(n) && n > 0),
    minRr: Number(process.env.DAYTRADING_MIN_RR || 2)
  },

  confidence: {
    threshold: Number(process.env.DAYTRADING_CONFIDENCE_THRESHOLD || 70),
    weights: {
      htfBias: 20,
      sweep: 25,
      mss: 15,
      displacement: 15,
      fvg: 10,
      retrace: 10,
      optionalConfirmation: 5
    }
  },

  filters: {
    tradeReversals: process.env.DAYTRADING_TRADE_REVERSALS === 'true',
    maxSpreadPips: Number(process.env.DAYTRADING_MAX_SPREAD_PIPS || 4),
    minAtrPips: Number(process.env.DAYTRADING_MIN_ATR_PIPS || 4),
    sidewaysAtrRatioMax: Number(process.env.DAYTRADING_SIDEWAYS_ATR || 0.6),
    sidewaysLookback: 24,
    rejectOnMajorNews: process.env.DAYTRADING_NEWS_FILTER !== 'false',
    newsWindowMinutes: Math.max(0, parseInt(process.env.DAYTRADING_NEWS_WINDOW_MIN || '60', 10)),
    maxSimultaneousTradesPerSymbol: Math.max(
      1,
      parseInt(process.env.DAYTRADING_MAX_TRADES_PER_SYMBOL || '1', 10)
    )
  },

  cache: {
    maxCandlesHtf: 160,
    maxCandlesLtf: 200
  }
});

/**
 * @param {Partial<typeof DEFAULT_DAYTRADING_CONFIG>} [overrides]
 */
function resolveDayTradingConfig(overrides = {}) {
  return {
    ...DEFAULT_DAYTRADING_CONFIG,
    ...overrides,
    swing: { ...DEFAULT_DAYTRADING_CONFIG.swing, ...(overrides.swing || {}) },
    sessions: { ...DEFAULT_DAYTRADING_CONFIG.sessions, ...(overrides.sessions || {}) },
    liquidity: { ...DEFAULT_DAYTRADING_CONFIG.liquidity, ...(overrides.liquidity || {}) },
    htfBias: { ...DEFAULT_DAYTRADING_CONFIG.htfBias, ...(overrides.htfBias || {}) },
    mss: { ...DEFAULT_DAYTRADING_CONFIG.mss, ...(overrides.mss || {}) },
    displacement: { ...DEFAULT_DAYTRADING_CONFIG.displacement, ...(overrides.displacement || {}) },
    engulfing: { ...DEFAULT_DAYTRADING_CONFIG.engulfing, ...(overrides.engulfing || {}) },
    fvg: { ...DEFAULT_DAYTRADING_CONFIG.fvg, ...(overrides.fvg || {}) },
    entry: { ...DEFAULT_DAYTRADING_CONFIG.entry, ...(overrides.entry || {}) },
    stop: { ...DEFAULT_DAYTRADING_CONFIG.stop, ...(overrides.stop || {}) },
    takeProfit: {
      ...DEFAULT_DAYTRADING_CONFIG.takeProfit,
      ...(overrides.takeProfit || {}),
      rrMultiples:
        overrides.takeProfit?.rrMultiples || DEFAULT_DAYTRADING_CONFIG.takeProfit.rrMultiples,
      manualRr: overrides.takeProfit?.manualRr || DEFAULT_DAYTRADING_CONFIG.takeProfit.manualRr
    },
    confidence: {
      ...DEFAULT_DAYTRADING_CONFIG.confidence,
      ...(overrides.confidence || {}),
      weights: {
        ...DEFAULT_DAYTRADING_CONFIG.confidence.weights,
        ...(overrides.confidence?.weights || {})
      }
    },
    filters: { ...DEFAULT_DAYTRADING_CONFIG.filters, ...(overrides.filters || {}) },
    cache: { ...DEFAULT_DAYTRADING_CONFIG.cache, ...(overrides.cache || {}) }
  };
}

module.exports = {
  STRATEGY_ID,
  STRATEGY_NAME,
  DEFAULT_DAYTRADING_CONFIG,
  resolveDayTradingConfig
};
