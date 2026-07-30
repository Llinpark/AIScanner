const { PATTERN_SCANNER_CONFIG } = require('../config/patternScanner');
const {
  getStrategyAdminConfig,
  getStrategyCatalog,
  getActiveStrategy,
  setActiveStrategy,
  applyStrategyConfig
} = require('./strategyRuntimeConfig');
const {
  getMarketRegimeConfig,
  applyMarketRegimeConfig
} = require('./marketRegimeConfig');

function getScannerConfig() {
  return {
    autoScanEnabled: Boolean(PATTERN_SCANNER_CONFIG.autoScanEnabled),
    autoScanIntervalMs: Number(PATTERN_SCANNER_CONFIG.autoScanIntervalMs),
    scanBatchSize: Number(PATTERN_SCANNER_CONFIG.scanBatchSize),
    activeStrategy: getActiveStrategy(),
    // BC: nested settings keyed by scalping | daytrading
    strategies: getStrategyAdminConfig(),
    // Strategy Engine catalog (live + stub profiles) for Admin Strategies list
    strategyCatalog: getStrategyCatalog(),
    // Independent of strategy profiles — pre-scan market suitability gate
    marketRegime: getMarketRegimeConfig()
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
  if (patch.activeStrategy !== undefined) {
    setActiveStrategy(patch.activeStrategy);
  }
  if (patch.strategies && typeof patch.strategies === 'object') {
    // Honor nested activeStrategy only when top-level was omitted
    if (patch.activeStrategy === undefined && patch.strategies.activeStrategy !== undefined) {
      setActiveStrategy(patch.strategies.activeStrategy);
    }
    applyStrategyConfig(patch.strategies);
  }
  if (patch.marketRegime && typeof patch.marketRegime === 'object') {
    applyMarketRegimeConfig(patch.marketRegime);
  }
  return getScannerConfig();
}

module.exports = {
  getScannerConfig,
  applyScannerConfig
};
