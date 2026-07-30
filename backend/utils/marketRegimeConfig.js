/**
 * Market Regime Filter — admin runtime settings (independent of strategy profiles).
 *
 * Default: filter ENABLED with conservative thresholds so extreme conditions
 * (closed FX market, high-impact news, tiny ATR) are skipped without blocking
 * normal London/NY sessions. Tune via Admin → Scanner.
 */

const DEFAULT_SESSIONS = Object.freeze({
  asian: { startHour: 0, endHour: 8 },
  london: { startHour: 7, endHour: 16 },
  ny: { startHour: 12, endHour: 21 }
});

/** Sensible production defaults — filter on, thresholds not aggressive. */
const DEFAULT_MARKET_REGIME_CONFIG = Object.freeze({
  enabled: true,
  minAtrPips: 3,
  maxSpreadPips: 25,
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
  return {
    enabled: o.enabled !== undefined ? Boolean(o.enabled) : DEFAULT_MARKET_REGIME_CONFIG.enabled,
    minAtrPips: clampNumber(o.minAtrPips, DEFAULT_MARKET_REGIME_CONFIG.minAtrPips, 0, 500),
    maxSpreadPips: clampNumber(o.maxSpreadPips, DEFAULT_MARKET_REGIME_CONFIG.maxSpreadPips, 0.1, 500),
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
  const numKeys = [
    'minAtrPips',
    'maxSpreadPips',
    'minVolatilityScore',
    'minRegimeScore',
    'cacheTtlSeconds'
  ];
  for (const key of numKeys) {
    if (patch[key] !== undefined && Number.isFinite(Number(patch[key]))) {
      next[key] = Number(patch[key]);
    }
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

module.exports = {
  DEFAULT_MARKET_REGIME_CONFIG,
  DEFAULT_SESSIONS,
  getMarketRegimeConfig,
  applyMarketRegimeConfig,
  getMarketRegimeOverrides,
  loadMarketRegimeOverrides,
  resetMarketRegimeConfigForTests
};
