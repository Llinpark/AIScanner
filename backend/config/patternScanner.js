const { ALL_CURRENCY_PAIRS } = require('./symbols');

// Structural pattern scanner thresholds (FVG + Breakaway Gap)
const PATTERN_SCANNER_CONFIG = {
  symbols: ALL_CURRENCY_PAIRS,
  candleBufferSize: 120,
  duplicateBarCooldownMs: 60_000,

  // Pattern A — Perfect Fair Value Gap
  fvg: {
    minDisplacementBodyRatio: 0.62,
    maxWickToRangeRatio: 0.28,
    volumeMultiplier: 1.15,
    minGapToAtrRatio: 0.15
  },

  // Pattern B — Breakaway Gap
  breakaway: {
    minC1BodyRatio: 0.55,
    minGapToC1RangeRatio: 0.08,
    requireCleanGap: true
  },

  // Risk / reward for actionable instructions
  risk: {
    slPips: 30,
    tpRatios: [1.0, 2.0, 3.0],
    entryMode: 'close' // 'close' | 'gap_mid'
  },

  autoScanIntervalMs: parseInt(process.env.SCANNER_INTERVAL_MS, 10) || 300_000,
  scanBatchSize: Math.max(1, parseInt(process.env.SCANNER_BATCH_SIZE, 10) || 2),
  autoScanEnabled: process.env.SCANNER_AUTO_ENABLED !== 'false',

  // 10-step SMC pipeline (liquidity → sweep → MSS → expansion → FVG → retrace → entry)
  pipeline: {
    enabled: process.env.SCANNER_PIPELINE_ENABLED !== 'false',
    minBars: 22,
    fvgLookbackBars: 22,
    liquidity: {
      lookbackBars: 24,
      minHistoryBars: 8,
      swingWindow: 2,
      sweepLookbackBars: 18
    },
    mss: {
      structureLookbackBars: 20
    },
    expansion: {
      minBodyRatio: 0.58,
      minRangeToAtrRatio: 1.05
    },
    htf: {
      timeframe: process.env.SCANNER_HTF_TIMEFRAME || '4h',
      smaPeriod: 20,
      requireData: false,
      requireStructure: true
    },
    retracement: {
      maxWaitBars: 12,
      minReactionRatio: 0.0005
    },
    risk: {
      slBufferPips: 5
    },
    scoring: {
      premiumThreshold: Number(process.env.SCANNER_PREMIUM_THRESHOLD || 90),
      expansionIdealBodyRatio: 0.82,
      weights: {
        liquiditySweep: 0.28,
        fvgRule: 0.18,
        expansionCandle: 0.06,
        htfBias: 0.24,
        fvgUnmitigated: 0.14,
        marketStructureShift: 0.1
      }
    }
  }
};

module.exports = { PATTERN_SCANNER_CONFIG };
