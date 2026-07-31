/**
 * Market Regime Filter — admin runtime settings (independent of strategy profiles).
 *
 * Default: filter ENABLED with conservative thresholds so extreme conditions
 * (closed FX market, high-impact news, tiny ATR) are skipped without blocking
 * normal London/NY sessions. Tune via Admin → Scanner.
 *
 * Maximum spread is symbol-aware: Forex 2.5 / Gold 5 / Indices 10 by default,
 * with admin class + per-symbol overrides.
 */

const {
  DEFAULT_MAX_SPREAD_PIPS_BY_CLASS,
  mergeClassDefaults,
  normalizeSymbolMap,
  resolveMaxSpreadPips,
  pickMaxSpreadAdminPatch
} = require('./maxSpreadLimits');
const { normalizeSymbol } = require('../config/symbols');

const DEFAULT_SESSIONS = Object.freeze({
  asian: { startHour: 0, endHour: 8 },
  london: { startHour: 7, endHour: 16 },
  ny: { startHour: 12, endHour: 21 }
});

/** Sensible production defaults — filter on, thresholds not aggressive. */
const DEFAULT_MARKET_REGIME_CONFIG = Object.freeze({
  enabled: true,
  minAtrPips: 3,
  /** @deprecated Prefer maxSpreadPipsByClass / resolveMaxSpreadPips(symbol). */
  maxSpreadPips: DEFAULT_MAX_SPREAD_PIPS_BY_CLASS.forex,
  maxSpreadPipsByClass: { ...DEFAULT_MAX_SPREAD_PIPS_BY_CLASS },
  maxSpreadPipsBySymbol: {},
  minVolatilityScore: 20,
  avoidHighImpactNews: true,
  avoidLowLiquiditySessions: false,
  allowAsianSession: true,
  allowLondonSession: true,
  allowNewYorkSession: true,
  allowSessionOverlap: true,
  minRegimeScore: 40,
  /** Cache TTL seconds (≈ one candle on common entry TFs; Redis/memory). */
  cacheTtlSeconds: 60,
  sessions: { ...DEFAULT_SESSIONS }
});

/** @type {Record<string, any>} */
let overrides = {};

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function getMarketRegimeConfig() {
  const o = overrides || {};
  const sessions = {
    asian: { ...DEFAULT_SESSIONS.asian, ...(o.sessions?.asian || {}) },
    london: { ...DEFAULT_SESSIONS.london, ...(o.sessions?.london || {}) },
    ny: { ...DEFAULT_SESSIONS.ny, ...(o.sessions?.ny || {}) }
  };
  const maxSpreadPipsByClass = mergeClassDefaults({
    ...DEFAULT_MARKET_REGIME_CONFIG.maxSpreadPipsByClass,
    ...(o.maxSpreadPipsByClass || {})
  });
  const maxSpreadPipsBySymbol = normalizeSymbolMap(o.maxSpreadPipsBySymbol || {});
  return {
    enabled: o.enabled !== undefined ? Boolean(o.enabled) : DEFAULT_MARKET_REGIME_CONFIG.enabled,
    minAtrPips: clampNumber(o.minAtrPips, DEFAULT_MARKET_REGIME_CONFIG.minAtrPips, 0, 500),
    maxSpreadPips: clampNumber(
      o.maxSpreadPips,
      maxSpreadPipsByClass.forex,
      0.1,
      500
    ),
    maxSpreadPipsByClass,
    maxSpreadPipsBySymbol,
    minVolatilityScore: clampNumber(
      o.minVolatilityScore,
      DEFAULT_MARKET_REGIME_CONFIG.minVolatilityScore,
      0,
      100
    ),
    avoidHighImpactNews:
      o.avoidHighImpactNews !== undefined
        ? Boolean(o.avoidHighImpactNews)
        : DEFAULT_MARKET_REGIME_CONFIG.avoidHighImpactNews,
    avoidLowLiquiditySessions:
      o.avoidLowLiquiditySessions !== undefined
        ? Boolean(o.avoidLowLiquiditySessions)
        : DEFAULT_MARKET_REGIME_CONFIG.avoidLowLiquiditySessions,
    allowAsianSession:
      o.allowAsianSession !== undefined
        ? Boolean(o.allowAsianSession)
        : DEFAULT_MARKET_REGIME_CONFIG.allowAsianSession,
    allowLondonSession:
      o.allowLondonSession !== undefined
        ? Boolean(o.allowLondonSession)
        : DEFAULT_MARKET_REGIME_CONFIG.allowLondonSession,
    allowNewYorkSession:
      o.allowNewYorkSession !== undefined
        ? Boolean(o.allowNewYorkSession)
        : DEFAULT_MARKET_REGIME_CONFIG.allowNewYorkSession,
    allowSessionOverlap:
      o.allowSessionOverlap !== undefined
        ? Boolean(o.allowSessionOverlap)
        : DEFAULT_MARKET_REGIME_CONFIG.allowSessionOverlap,
    minRegimeScore: clampNumber(
      o.minRegimeScore,
      DEFAULT_MARKET_REGIME_CONFIG.minRegimeScore,
      0,
      100
    ),
    cacheTtlSeconds: clampNumber(
      o.cacheTtlSeconds,
      DEFAULT_MARKET_REGIME_CONFIG.cacheTtlSeconds,
      5,
      3600
    ),
    sessions
  };
}

function applyMarketRegimeConfig(patch = {}) {
  if (!patch || typeof patch !== 'object') return getMarketRegimeConfig();
  const next = { ...overrides };
  const boolKeys = [
    'enabled',
    'avoidHighImpactNews',
    'avoidLowLiquiditySessions',
    'allowAsianSession',
    'allowLondonSession',
    'allowNewYorkSession',
    'allowSessionOverlap'
  ];
  for (const key of boolKeys) {
    if (patch[key] !== undefined) next[key] = Boolean(patch[key]);
  }
  const numKeys = ['minAtrPips', 'minVolatilityScore', 'minRegimeScore', 'cacheTtlSeconds'];
  for (const key of numKeys) {
    if (patch[key] !== undefined && Number.isFinite(Number(patch[key]))) {
      next[key] = Number(patch[key]);
    }
  }

  const spreadPatch = pickMaxSpreadAdminPatch(patch);
  if (spreadPatch.maxSpreadPipsByClass) {
    next.maxSpreadPipsByClass = {
      ...(next.maxSpreadPipsByClass || {}),
      ...spreadPatch.maxSpreadPipsByClass
    };
  }
  if (patch.maxSpreadPipsBySymbol && typeof patch.maxSpreadPipsBySymbol === 'object') {
    const mergedSymbols = { ...(next.maxSpreadPipsBySymbol || {}) };
    for (const [raw, value] of Object.entries(patch.maxSpreadPipsBySymbol)) {
      const symbol = normalizeSymbol(raw);
      if (!symbol) continue;
      if (value == null || value === '') {
        delete mergedSymbols[symbol];
      } else if (Number.isFinite(Number(value))) {
        mergedSymbols[symbol] = Number(value);
      }
    }
    next.maxSpreadPipsBySymbol = normalizeSymbolMap(mergedSymbols);
  }
  if (spreadPatch.maxSpreadPips !== undefined) {
    next.maxSpreadPips = spreadPatch.maxSpreadPips;
  }

  if (patch.sessions && typeof patch.sessions === 'object') {
    next.sessions = {
      ...(next.sessions || {}),
      ...patch.sessions
    };
  }
  overrides = next;
  return getMarketRegimeConfig();
}

function getMarketRegimeOverrides() {
  return { ...overrides };
}

function loadMarketRegimeOverrides(docOverrides) {
  overrides =
    docOverrides && typeof docOverrides === 'object' ? { ...docOverrides } : {};
  return getMarketRegimeConfig();
}

function resetMarketRegimeConfigForTests() {
  overrides = {};
}

function resolveRegimeMaxSpreadPips(symbol, config = getMarketRegimeConfig()) {
  return resolveMaxSpreadPips(symbol, config);
}

module.exports = {
  DEFAULT_MARKET_REGIME_CONFIG,
  DEFAULT_SESSIONS,
  DEFAULT_MAX_SPREAD_PIPS_BY_CLASS,
  getMarketRegimeConfig,
  applyMarketRegimeConfig,
  getMarketRegimeOverrides,
  loadMarketRegimeOverrides,
  resetMarketRegimeConfigForTests,
  resolveRegimeMaxSpreadPips,
  resolveMaxSpreadPips
};
