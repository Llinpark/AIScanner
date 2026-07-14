const { fetchTimeSeries: fetchTwelveDataSeries } = require('./twelveData');
const { fetchIntradaySeries: fetchEodhdSeries } = require('./eodhd');

const memoryCache = new Map();
const DEFAULT_CACHE_TTL_MS = Number(process.env.MARKET_DATA_CACHE_TTL_MS || process.env.TWELVE_DATA_CACHE_TTL_MS || 60000);

function getCache(key) {
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > entry.ttlMs) {
    memoryCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data, ttlMs = DEFAULT_CACHE_TTL_MS) {
  memoryCache.set(key, { data, storedAt: Date.now(), ttlMs });
}

async function fetchHistoricalData(config, symbol, interval = '1h', limit = 100) {
  const cacheKey = `${symbol}:${interval}:${limit}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

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
          baseUrl: config.providers.twelve_data.baseUrl
        })
    },
    {
      name: 'eodhd',
      enabled: primary === 'eodhd' || fallback === 'eodhd',
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
      setCache(cacheKey, candles);
      if (attempt.name !== primary) {
        console.warn(`[MarketData] Used fallback provider ${attempt.name} for ${symbol}`);
      }
      return candles;
    } catch (error) {
      errors.push(`${attempt.name}: ${error.message}`);
    }
  }

  throw new Error(errors.join(' | ') || 'No market data providers configured');
}

module.exports = {
  fetchHistoricalData
};
