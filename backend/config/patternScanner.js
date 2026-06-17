// Structural pattern scanner thresholds (FVG + Breakaway Gap)
const PATTERN_SCANNER_CONFIG = {
  symbols: ['EUR/USD', 'GBP/USD', 'AUD/USD', 'USD/JPY'],
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
    slPips: [30, 80, 100],
    tpRatios: [1.0, 2.0, 3.0],
    entryMode: 'close' // 'close' | 'gap_mid'
  },

  autoScanIntervalMs: parseInt(process.env.SCANNER_INTERVAL_MS, 10) || 60_000,
  autoScanEnabled: process.env.SCANNER_AUTO_ENABLED !== 'false'
};

module.exports = { PATTERN_SCANNER_CONFIG };
