/**
 * Build StrategyContext slices from a StrategyProfile + market bag.
 * Engine stays strategy-agnostic: HTF candles and default TF come from profile.dataRequirements.
 */

/**
 * @param {import('./StrategyProfile').StrategyProfile} profile
 * @param {Object} market - { candles, htfCandles, scalpingHtfCandles, ... }
 * @returns {Object[]} HTF candle series for this profile
 */
function resolveHtfCandles(profile, market = {}) {
  const req = profile?.dataRequirements || {};
  const primaryKey = req.htfContextKey;
  const fallbacks = req.fallbackHtfKeys || [];
  const keys = [primaryKey, ...fallbacks].filter(Boolean);
  for (const key of keys) {
    const series = market[key];
    if (Array.isArray(series) && series.length) return series;
  }
  // Generic fallback used by older callers
  if (Array.isArray(market.htfCandles) && market.htfCandles.length) return market.htfCandles;
  return [];
}

/**
 * @param {import('./StrategyProfile').StrategyProfile} profile
 * @param {Object} market
 * @param {Object} [overrides]
 * @returns {import('../types').StrategyContext}
 */
function buildStrategyContext(profile, market = {}, overrides = {}) {
  const req = profile.dataRequirements || {};
  const htfCandles = resolveHtfCandles(profile, market);
  const timeframe =
    overrides.timeframe ||
    market.timeframe ||
    req.defaultTimeframe ||
    profile.defaultEntryTimeframe;

  return {
    symbol: overrides.symbol || market.symbol,
    candles: overrides.candles || market.candles || [],
    htfCandles,
    // Preserve all series so strategies that read alternate keys still work
    daytradingHtfCandles: market.daytradingHtfCandles || market.htfCandles || [],
    scalpingHtfCandles: market.scalpingHtfCandles || market.htfCandles || [],
    htf4hCandles: market.htf4hCandles || market.htfCandles || [],
    htf1hCandles: market.htf1hCandles || market.refineHtfCandles || [],
    refineHtfCandles: market.refineHtfCandles || market.htf1hCandles || [],
    timeframe,
    spread: overrides.spread !== undefined ? overrides.spread : market.spread,
    now: overrides.now || market.now,
    state: overrides.state || market.state,
    cache: overrides.cache || market.cache,
    strictTimeframe: overrides.strictTimeframe === true || market.strictTimeframe === true,
    enforceEntryTf: overrides.enforceEntryTf || market.enforceEntryTf,
    strategyId: profile.id,
    strategyKey: profile.key,
    strategyVersion: profile.version
  };
}

module.exports = {
  resolveHtfCandles,
  buildStrategyContext
};
