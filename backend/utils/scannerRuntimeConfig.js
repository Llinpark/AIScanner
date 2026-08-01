const { PATTERN_SCANNER_CONFIG } = require('../config/patternScanner');
const {
  ALL_CURRENCY_PAIRS,
  normalizeSymbol
} = require('../config/symbols');
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

/** Default scan interval when env / patch value is missing or invalid. */
const DEFAULT_AUTO_SCAN_INTERVAL_MS = 60_000;

/**
 * Admin-applied core scan overrides (persisted in StrategyRuntimeConfig.coreScanner).
 * Env / patternScanner defaults remain the baseline until an override is set.
 * @type {{ autoScanEnabled?: boolean, autoScanIntervalMs?: number, scanBatchSize?: number, symbols?: string[] }}
 */
let coreOverrides = {};

function sanitizeAdminSymbols(symbols) {
  if (!Array.isArray(symbols)) return null;
  const next = [];
  const seen = new Set();
  for (const raw of symbols) {
    const normalized = normalizeSymbol(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    next.push(normalized);
  }
  return next.length ? next : [...ALL_CURRENCY_PAIRS];
}

function clampAutoScanIntervalMs(value) {
  const parsed = parseInt(value, 10);
  const fallback = Number.isFinite(Number(coreOverrides.autoScanIntervalMs))
    ? Number(coreOverrides.autoScanIntervalMs)
    : DEFAULT_AUTO_SCAN_INTERVAL_MS;
  const ms = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(DEFAULT_AUTO_SCAN_INTERVAL_MS, ms);
}

function getScannerConfig() {
  return {
    autoScanEnabled: Boolean(PATTERN_SCANNER_CONFIG.autoScanEnabled),
    autoScanIntervalMs: Number(PATTERN_SCANNER_CONFIG.autoScanIntervalMs),
    scanBatchSize: Number(PATTERN_SCANNER_CONFIG.scanBatchSize),
    symbols: [...(PATTERN_SCANNER_CONFIG.symbols || ALL_CURRENCY_PAIRS)],
    // Preferred Admin UI defaults only — not a hard ingest allowlist.
    preferredSymbols: [...ALL_CURRENCY_PAIRS],
    supportedSymbols: [...ALL_CURRENCY_PAIRS],
    activeStrategy: getActiveStrategy(),
    // BC: nested settings keyed by scalping | daytrading
    strategies: getStrategyAdminConfig(),
    // Strategy Engine catalog (live + stub profiles) for Admin Strategies list
    strategyCatalog: getStrategyCatalog(),
    // Independent of strategy profiles — pre-scan market suitability gate
    marketRegime: getMarketRegimeConfig()
  };
}

function applyCoreScannerFields(patch = {}) {
  if (!patch || typeof patch !== 'object') return;
  if (patch.autoScanEnabled !== undefined) {
    const enabled = Boolean(patch.autoScanEnabled);
    PATTERN_SCANNER_CONFIG.autoScanEnabled = enabled;
    coreOverrides.autoScanEnabled = enabled;
  }
  if (patch.autoScanIntervalMs !== undefined) {
    const ms = clampAutoScanIntervalMs(patch.autoScanIntervalMs);
    PATTERN_SCANNER_CONFIG.autoScanIntervalMs = ms;
    coreOverrides.autoScanIntervalMs = ms;
  }
  if (patch.scanBatchSize !== undefined) {
    const size = Math.max(1, parseInt(patch.scanBatchSize, 10) || 2);
    PATTERN_SCANNER_CONFIG.scanBatchSize = size;
    coreOverrides.scanBatchSize = size;
  }
  if (patch.symbols !== undefined) {
    const symbols = sanitizeAdminSymbols(patch.symbols);
    PATTERN_SCANNER_CONFIG.symbols = symbols;
    coreOverrides.symbols = symbols;
  }
}

function applyScannerConfig(patch = {}) {
  applyCoreScannerFields(patch);
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

function getCoreScannerOverrides() {
  return { ...coreOverrides };
}

/**
 * Restore core scan overrides from Mongo on boot.
 * Missing/empty doc leaves env defaults (new installs → 60000 interval).
 * Does not wipe intentionally saved values when fields are absent.
 */
function loadCoreScannerOverrides(docOverrides) {
  if (!docOverrides || typeof docOverrides !== 'object') return getScannerConfig();
  const patch = {};
  if (docOverrides.autoScanEnabled !== undefined) {
    patch.autoScanEnabled = docOverrides.autoScanEnabled;
  }
  if (docOverrides.autoScanIntervalMs !== undefined) {
    patch.autoScanIntervalMs = docOverrides.autoScanIntervalMs;
  }
  if (docOverrides.scanBatchSize !== undefined) {
    patch.scanBatchSize = docOverrides.scanBatchSize;
  }
  if (docOverrides.symbols !== undefined) {
    patch.symbols = docOverrides.symbols;
  }
  applyCoreScannerFields(patch);
  return getScannerConfig();
}

/** Test helper — reset in-memory core overrides without touching Mongo. */
function resetScannerRuntimeConfigForTests() {
  coreOverrides = {};
  // Re-apply module defaults from env (patternScanner was already required)
  const envMs = parseInt(process.env.SCANNER_INTERVAL_MS, 10);
  PATTERN_SCANNER_CONFIG.autoScanIntervalMs = Number.isFinite(envMs)
    ? Math.max(DEFAULT_AUTO_SCAN_INTERVAL_MS, envMs)
    : DEFAULT_AUTO_SCAN_INTERVAL_MS;
  PATTERN_SCANNER_CONFIG.scanBatchSize = Math.max(
    1,
    parseInt(process.env.SCANNER_BATCH_SIZE, 10) || 5
  );
  PATTERN_SCANNER_CONFIG.autoScanEnabled = process.env.SCANNER_AUTO_ENABLED !== 'false';
  PATTERN_SCANNER_CONFIG.symbols = [...ALL_CURRENCY_PAIRS];
}

module.exports = {
  DEFAULT_AUTO_SCAN_INTERVAL_MS,
  getScannerConfig,
  applyScannerConfig,
  getCoreScannerOverrides,
  loadCoreScannerOverrides,
  resetScannerRuntimeConfigForTests
};
