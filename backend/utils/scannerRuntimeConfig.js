const { PATTERN_SCANNER_CONFIG } = require('../config/patternScanner');

function getScannerConfig() {
  const scoring = PATTERN_SCANNER_CONFIG.pipeline?.scoring || {};
  return {
    autoScanEnabled: Boolean(PATTERN_SCANNER_CONFIG.autoScanEnabled),
    autoScanIntervalMs: Number(PATTERN_SCANNER_CONFIG.autoScanIntervalMs),
    scanBatchSize: Number(PATTERN_SCANNER_CONFIG.scanBatchSize),
    premiumThreshold: Number(scoring.premiumThreshold),
    weights: { ...(scoring.weights || {}) }
  };
}

function applyScannerConfig(patch = {}) {
  if (patch.autoScanEnabled !== undefined) {
    PATTERN_SCANNER_CONFIG.autoScanEnabled = Boolean(patch.autoScanEnabled);
  }
  if (patch.autoScanIntervalMs !== undefined) {
    const ms = Math.max(60_000, parseInt(patch.autoScanIntervalMs, 10) || 300_000);
    PATTERN_SCANNER_CONFIG.autoScanIntervalMs = ms;
  }
  if (patch.scanBatchSize !== undefined) {
    PATTERN_SCANNER_CONFIG.scanBatchSize = Math.max(1, parseInt(patch.scanBatchSize, 10) || 2);
  }
  if (patch.premiumThreshold !== undefined) {
    const threshold = Math.min(100, Math.max(50, parseInt(patch.premiumThreshold, 10) || 90));
    PATTERN_SCANNER_CONFIG.pipeline.scoring.premiumThreshold = threshold;
  }
  if (patch.weights && typeof patch.weights === 'object') {
    const allowed = [
      'liquiditySweep',
      'fvgRule',
      'expansionCandle',
      'htfBias',
      'fvgUnmitigated',
      'marketStructureShift'
    ];
    for (const key of allowed) {
      if (patch.weights[key] !== undefined) {
        PATTERN_SCANNER_CONFIG.pipeline.scoring.weights[key] = Number(patch.weights[key]);
      }
    }
  }
  return getScannerConfig();
}

module.exports = {
  getScannerConfig,
  applyScannerConfig
};
