const { fetchTimeSeries: fetchTwelveDataSeries } = require('./twelveData');
const { fetchHistoricalSeries: fetchEodhdSeries } = require('./eodhd');
const {
  DEFAULT_TTL_MS,
  getFresh,
  getStale,
  isCreditExhaustedError,
  isRateLimitError,
  set
} = require('./marketDataCache');

const TWELVE_DATA_CREDIT_SKIP_MS = Math.max(
  60_000,
  Number(process.env.TWELVE_DATA_CREDIT_SKIP_MS || 6 * 60 * 60 * 1000)
);
const TWELVE_DATA_RATE_SKIP_MS = Math.max(
  30_000,
  Number(process.env.MARKET_DATA_RATE_LIMIT_COOLDOWN_MS || 65_000)
);

/** Skip Twelve Data until this timestamp after credit/rate-limit failures. */
let twelveDataSkipUntil = 0;

function shouldSkipTwelveData() {
  return Date.now() < twelveDataSkipUntil;
}

function markTwelveDataUnavailable(errorMessage) {
  const now = Date.now();
  if (isCreditExhaustedError(errorMessage)) {
    twelveDataSkipUntil = Math.max(twelveDataSkipUntil, now + TWELVE_DATA_CREDIT_SKIP_MS);
    console.warn(
      `[MarketData] Twelve Data plan credits exhausted — routing to EODHD for ${TWELVE_DATA_CREDIT_SKIP_MS}ms`
    );
    return;
  }
  if (isRateLimitError(errorMessage)) {
    // Per-minute free-tier limits ("current minute") use the short cooldown only.
    twelveDataSkipUntil = Math.max(twelveDataSkipUntil, now + TWELVE_DATA_RATE_SKIP_MS);
    console.warn(
      `[MarketData] Twelve Data rate limited — routing to EODHD for ${TWELVE_DATA_RATE_SKIP_MS}ms`
    );
  }
}

function twelveDataSkipStatus() {
  const now = Date.now();
  return {
    skipped: now < twelveDataSkipUntil,
    skipUntil: twelveDataSkipUntil > now ? new Date(twelveDataSkipUntil).toISOString() : null
  };
}

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
    if (attempt.name === 'twelve_data' && shouldSkipTwelveData()) {
      errors.push('twelve_data: skipped (credit/rate-limit cooldown — using fallback)');
      continue;
    }

    try {
      const candles = await attempt.run();
      set(cacheKey, candles, DEFAULT_TTL_MS);
      if (attempt.name !== primary) {
        console.warn(`[MarketData] Used fallback provider ${attempt.name} for ${symbol}`);
      }
      return candles;
    } catch (error) {
      errors.push(`${attempt.name}: ${error.message}`);
      if (attempt.name === 'twelve_data') {
        markTwelveDataUnavailable(error.message);
      }
      // Fall through immediately to the next provider (EODHD on credit outage).
    }
  }

  const stale = getStale(cacheKey);
  if (stale) {
    console.warn(`[MarketData] Providers failed for ${symbol}, serving stale cache`);
    return stale;
  }

  if (errors.some(entry => isRateLimitError(entry))) {
    throw new Error(
      `${errors.join(' | ')} (cached data unavailable — wait one minute or check EODHD/Twelve Data keys)`
    );
  }

  throw new Error(errors.join(' | ') || 'No market data providers configured');
}

module.exports = {
  fetchHistoricalData,
  shouldSkipTwelveData,
  twelveDataSkipStatus,
  markTwelveDataUnavailable
};
