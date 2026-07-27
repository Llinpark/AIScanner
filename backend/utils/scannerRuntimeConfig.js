const { PATTERN_SCANNER_CONFIG } = require('../config/patternScanner');
const { getStrategyAdminConfig } = require('./strategyRuntimeConfig');

function getScannerConfig() {
  return {
    autoScanEnabled: Boolean(PATTERN_SCANNER_CONFIG.autoScanEnabled),
    autoScanIntervalMs: Number(PATTERN_SCANNER_CONFIG.autoScanIntervalMs),
    scanBatchSize: Number(PATTERN_SCANNER_CONFIG.scanBatchSize),
    strategies: getStrategyAdminConfig()
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
  if (patch.strategies && typeof patch.strategies === 'object') {
    const { applyStrategyConfig } = require('./strategyRuntimeConfig');
    applyStrategyConfig(patch.strategies);
  }
  return getScannerConfig();
}

module.exports = {
  getScannerConfig,
  applyScannerConfig
};
