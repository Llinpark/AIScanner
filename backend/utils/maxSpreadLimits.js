/**
 * Symbol-aware maximum spread limits (pips).
 *
 * Defaults by asset class; admins can override class defaults and/or
 * individual symbols via runtime config.
 */

const { normalizeSymbol, getSymbolAssetClass } = require('../config/symbols');

const DEFAULT_MAX_SPREAD_PIPS_BY_CLASS = Object.freeze({
  forex: 2.5,
  gold: 5,
  indices: 10,
  metal: 5,
  crypto: 25,
  other: 10
});

function clampSpread(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(500, Math.max(0.1, n));
}

function mergeClassDefaults(overrides = {}) {
  const merged = { ...DEFAULT_MAX_SPREAD_PIPS_BY_CLASS };
  if (!overrides || typeof overrides !== 'object') return merged;
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_MAX_SPREAD_PIPS_BY_CLASS, key)) continue;
    merged[key] = clampSpread(value, DEFAULT_MAX_SPREAD_PIPS_BY_CLASS[key]);
  }
  return merged;
}

function normalizeSymbolMap(map = {}) {
  if (!map || typeof map !== 'object') return {};
  const out = {};
  for (const [rawSymbol, value] of Object.entries(map)) {
    const symbol = normalizeSymbol(rawSymbol);
    const n = Number(value);
    if (!symbol || !Number.isFinite(n)) continue;
    out[symbol] = clampSpread(n, DEFAULT_MAX_SPREAD_PIPS_BY_CLASS.other);
  }
  return out;
}

/**
 * Resolve max spread for a symbol.
 * Priority: per-symbol override → class override → built-in class default.
 *
 * Legacy `maxSpreadPips` is ignored when class/symbol maps are in use so an
 * old global admin value (e.g. 25) cannot wipe the new asset-class defaults.
 *
 * @param {string} symbol
 * @param {object} [limits]
 * @param {Record<string, number>} [limits.maxSpreadPipsByClass]
 * @param {Record<string, number>} [limits.maxSpreadPipsBySymbol]
 * @returns {number}
 */
function resolveMaxSpreadPips(symbol, limits = {}) {
  const bySymbol = normalizeSymbolMap(limits.maxSpreadPipsBySymbol);
  const canonical = normalizeSymbol(symbol);
  if (canonical && Number.isFinite(bySymbol[canonical])) {
    return bySymbol[canonical];
  }

  const assetClass = getSymbolAssetClass(canonical || symbol);
  const byClass = mergeClassDefaults(limits.maxSpreadPipsByClass);
  return byClass[assetClass] ?? DEFAULT_MAX_SPREAD_PIPS_BY_CLASS.other;
}

/**
 * Persist helper — sanitize admin patch fragments for spread maps.
 */
function pickMaxSpreadAdminPatch(filtersOrRegime = {}) {
  const out = {};
  if (filtersOrRegime.maxSpreadPipsByClass && typeof filtersOrRegime.maxSpreadPipsByClass === 'object') {
    out.maxSpreadPipsByClass = mergeClassDefaults(filtersOrRegime.maxSpreadPipsByClass);
  }
  if (filtersOrRegime.maxSpreadPipsBySymbol && typeof filtersOrRegime.maxSpreadPipsBySymbol === 'object') {
    out.maxSpreadPipsBySymbol = normalizeSymbolMap(filtersOrRegime.maxSpreadPipsBySymbol);
  }
  // Drop legacy global unless explicitly clearing is needed — keep if still sent
  // so older clients don't error, but resolution no longer prefers it.
  if (filtersOrRegime.maxSpreadPips !== undefined && Number.isFinite(Number(filtersOrRegime.maxSpreadPips))) {
    out.maxSpreadPips = clampSpread(filtersOrRegime.maxSpreadPips, DEFAULT_MAX_SPREAD_PIPS_BY_CLASS.forex);
  }
  return out;
}

module.exports = {
  DEFAULT_MAX_SPREAD_PIPS_BY_CLASS,
  mergeClassDefaults,
  normalizeSymbolMap,
  resolveMaxSpreadPips,
  pickMaxSpreadAdminPatch,
  clampSpread
};
