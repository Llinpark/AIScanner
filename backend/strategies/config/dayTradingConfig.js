/**
 * Liquidity Sweep + Fair Value Gap (Day Trading) — all thresholds.
 * Override via DAYTRADING_* env keys.
 * TP settings come from the Day Trading Strategy TP Profile (independent of scalping).
 */

const { resolveTpProfile, DAY_TRADING_TP_PROFILE } = require('../profiles');

const STRATEGY_ID = 'liquidity_sweep_fvg_daytrading';
const STRATEGY_NAME = 'Liquidity Sweep + Fair Value Gap (Day Trading)';
const STRATEGY_KEY = 'daytrading';

const _dayTp = DAY_TRADING_TP_PROFILE;

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
    profileId: _dayTp.profileId,
    // smart_scoring (default) | dynamic_liquidity (alias) | institutional | rr | previous_swing | nearest_liquidity | manual_rr
    model: process.env.DAYTRADING_TP_MODEL || _dayTp.model,
    enableSmartTpScoring: process.env.DAYTRADING_SMART_TP !== 'false',
    enableDynamicTp: process.env.DAYTRADING_DYNAMIC_TP !== 'false',
    atrCaps: (process.env.DAYTRADING_TP_ATR_CAPS || _dayTp.atrCaps.join(','))
      .split(',')
      .map(Number)
      .filter(n => Number.isFinite(n) && n > 0),
    maxAtrMultiplier: Number(process.env.DAYTRADING_TP_MAX_ATR || _dayTp.maxAtrMultiplier),
    maxTpDistancePips:
      process.env.DAYTRADING_TP_MAX_PIPS !== undefined && process.env.DAYTRADING_TP_MAX_PIPS !== ''
        ? Number(process.env.DAYTRADING_TP_MAX_PIPS) || null
        : _dayTp.maxTpDistancePips,
    minScore: Number(process.env.DAYTRADING_TP_MIN_SCORE || _dayTp.minScore),
    scoreProximity: Number(process.env.DAYTRADING_TP_SCORE_PROXIMITY || _dayTp.scoreProximity),
    allowRrFallback: process.env.DAYTRADING_TP_RR_FALLBACK !== 'false',
    deferredLiquidityCategories: [..._dayTp.deferredLiquidityCategories],
    scoreWeights: {
      internal_liquidity: Number(
        process.env.DAYTRADING_TP_W_INTERNAL || _dayTp.scoreWeights.internal_liquidity
      ),
      external_liquidity: Number(
        process.env.DAYTRADING_TP_W_EXTERNAL || _dayTp.scoreWeights.external_liquidity
      ),
      equal_high_low: Number(process.env.DAYTRADING_TP_W_EQH || _dayTp.scoreWeights.equal_high_low),
      untapped_fvg: Number(process.env.DAYTRADING_TP_W_FVG || _dayTp.scoreWeights.untapped_fvg),
      swing_high_low: Number(
        process.env.DAYTRADING_TP_W_SWING || _dayTp.scoreWeights.swing_high_low
      ),
      order_block: Number(process.env.DAYTRADING_TP_W_OB || _dayTp.scoreWeights.order_block),
      breaker_block: Number(
        process.env.DAYTRADING_TP_W_BREAKER || _dayTp.scoreWeights.breaker_block
      ),
      mitigation_block: Number(
        process.env.DAYTRADING_TP_W_MITIGATION || _dayTp.scoreWeights.mitigation_block
      ),
      pdh_pdl: Number(process.env.DAYTRADING_TP_W_PD || _dayTp.scoreWeights.pdh_pdl),
      pwh_pwl: Number(process.env.DAYTRADING_TP_W_PW || _dayTp.scoreWeights.pwh_pwl),
      pmh_pml: Number(process.env.DAYTRADING_TP_W_PM || _dayTp.scoreWeights.pmh_pml),
      atr_projection: Number(process.env.DAYTRADING_TP_W_ATR || _dayTp.scoreWeights.atr_projection),
      rr_fallback: Number(process.env.DAYTRADING_TP_W_RR || _dayTp.scoreWeights.rr_fallback)
    },
    liquidityPriority: (
      process.env.DAYTRADING_TP_LIQUIDITY_PRIORITY || _dayTp.liquidityPriority.join(',')
    )
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    rrMultiples: (process.env.DAYTRADING_TP_RR || _dayTp.rrMultiples.join(','))
      .split(',')
      .map(Number)
      .filter(n => Number.isFinite(n) && n > 0),
    manualRr: (process.env.DAYTRADING_MANUAL_RR || _dayTp.manualRr.join(','))
      .split(',')
      .map(Number)
      .filter(n => Number.isFinite(n) && n > 0),
    minRr: Number(process.env.DAYTRADING_MIN_RR || _dayTp.minRr)
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
  const takeProfit = resolveTpProfile(STRATEGY_KEY, {
    ...DEFAULT_DAYTRADING_CONFIG.takeProfit,
    ...(overrides.takeProfit || {})
  });
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
    takeProfit,
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
  STRATEGY_KEY,
  DEFAULT_DAYTRADING_CONFIG,
  resolveDayTradingConfig
};
