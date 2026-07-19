const { fetchTimeSeries: fetchTwelveDataSeries } = require('./twelveData');
const { fetchHistoricalSeries: fetchEodhdSeries } = require('./eodhd');
const { DEFAULT_TTL_MS, getFresh, getStale, isRateLimitError, set } = require('./marketDataCache');

async function fetchHistoricalData(config, symbol, interval = '1h', limit = 100, options = {}) {
  const cacheKey = `market:${symbol}:${interval}:${limit}`;
  const forceRefresh = Boolean(options.forceRefresh);

  if (!forceRefresh) {
    const cached = getFresh(cacheKey);
    if (cached) return cached;
  }

  const primary = process.env.MARKET_DATA_PRIMARY || process.env.DATA_PROVIDER || 'twelve_data';
  const fallback = process.env.MARKET_DATA_FALLBACK || 'eodhd';
  const errors = [];

  const attempts = [
    {
      name: 'twelve_data',
      enabled: primary === 'twelve_data' || fallback === 'twelve_data',
      run: () =>
        fetchTwelveDataSeries({
          apiKey: config.providers.twelve_data.apiKey,
          symbol,
          interval,
          limit,
          baseUrl: config.providers.twelve_data.baseUrl,
          forceRefresh
        })
    },
    {
      name: 'eodhd',
      enabled: (primary === 'eodhd' || fallback === 'eodhd') && Boolean(config.providers.eodhd.apiKey),
      run: () =>
        fetchEodhdSeries({
          apiKey: config.providers.eodhd.apiKey,
          symbol,
          interval,
          limit,
          baseUrl: config.providers.eodhd.baseUrl
        })
    }
  ];

  const ordered = [primary, fallback]
    .filter(Boolean)
    .flatMap(name => attempts.filter(item => item.name === name && item.enabled));

  for (const attempt of ordered) {
    try {
      const candles = await attempt.run();
      set(cacheKey, candles, DEFAULT_TTL_MS);
      if (attempt.name !== primary) {
        console.warn(`[MarketData] Used fallback provider ${attempt.name} for ${symbol}`);
      }
      return candles;
    } catch (error) {
      errors.push(`${attempt.name}: ${error.message}`);
      if (isRateLimitError(error.message)) {
        break;
      }
    }
  }

  const stale = getStale(cacheKey);
  if (stale) {
    console.warn(`[MarketData] Providers failed for ${symbol}, serving stale cache`);
    return stale;
  }

  if (errors.some(entry => isRateLimitError(entry))) {
    throw new Error(`${errors.join(' | ')} (cached data unavailable — wait one minute or upgrade Twelve Data)`);
  }

  throw new Error(errors.join(' | ') || 'No market data providers configured');
}

module.exports = {
  fetchHistoricalData
};
