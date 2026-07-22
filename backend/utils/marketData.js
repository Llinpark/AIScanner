const { fetchTimeSeries: fetchTwelveDataSeries } = require('./twelveData');
const {
  fetchEodSeries,
  fetchHistoricalSeries: fetchEodhdSeries,
  isEodhdEodInterval
} = require('./eodhd');
const { normalizeInterval } = require('./marketIntervals');
const {
  DEFAULT_TTL_MS,
  getFresh,
  getStale,
  isCreditExhaustedError,
  isEodhdEodOnlyError,
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

/** When Twelve Data is unavailable, serve EODHD end-of-day daily candles. */
const EOD_FALLBACK_INTERVAL = '1d';

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

function attachMeta(candles, meta) {
  if (Array.isArray(candles)) {
    candles.meta = meta;
  }
  return candles;
}

/**
 * Decide how to call EODHD for a requested interval.
 * When Twelve Data is credit/rate-limited and the request is intraday, force daily EOD.
 */
function planEodhdFetch(requestedInterval, { forceEodFallback = false } = {}) {
  const canonical = normalizeInterval(requestedInterval);
  if (isEodhdEodInterval(canonical)) {
    return { interval: canonical, remapped: false, proactive: false };
  }
  if (forceEodFallback) {
    return { interval: EOD_FALLBACK_INTERVAL, remapped: true, proactive: true };
  }
  return { interval: canonical, remapped: false, proactive: false, tryIntradayFirst: true };
}

function buildMeta({ provider, primary, remapped, effectiveInterval }) {
  const meta = {
    provider,
    fallback_used: provider !== primary || Boolean(remapped),
    fallback_interval: remapped ? effectiveInterval : null
  };
  return meta;
}

function cacheCandles(symbol, requestedInterval, limit, candles, meta) {
  const cacheKey = `market:${symbol}:${requestedInterval}:${limit}`;
  const enriched = attachMeta(candles, meta);
  set(cacheKey, enriched, DEFAULT_TTL_MS);

  // Also store under the effective EOD key so a later 1d request can reuse this fetch.
  if (meta.fallback_interval && meta.fallback_interval !== requestedInterval) {
    const eodKey = `market:${symbol}:${meta.fallback_interval}:${limit}`;
    set(
      eodKey,
      attachMeta(candles.slice(), {
        provider: meta.provider,
        fallback_used: false,
        fallback_interval: null
      }),
      DEFAULT_TTL_MS
    );
  }

  return enriched;
}

async function fetchFromEodhd({ apiKey, symbol, interval, limit, baseUrl, forceEodFallback }) {
  const plan = planEodhdFetch(interval, { forceEodFallback });

  if (!plan.tryIntradayFirst) {
    if (plan.proactive) {
      console.warn(
        `[MarketData] Twelve Data unavailable — using EODHD ${plan.interval} EOD for ${symbol} (requested ${normalizeInterval(interval)})`
      );
    }
    const candles = await fetchEodSeries({
      apiKey,
      symbol,
      interval: plan.interval,
      limit,
      baseUrl
    });
    return { candles, effectiveInterval: plan.interval, remapped: plan.remapped };
  }

  try {
    const candles = await fetchEodhdSeries({
      apiKey,
      symbol,
      interval: plan.interval,
      limit,
      baseUrl
    });
    return { candles, effectiveInterval: plan.interval, remapped: false };
  } catch (error) {
    if (!isEodhdEodOnlyError(error.message)) {
      throw error;
    }
    console.warn(
      `[MarketData] EODHD free tier blocks intraday — using ${EOD_FALLBACK_INTERVAL} EOD for ${symbol}`
    );
    const candles = await fetchEodSeries({
      apiKey,
      symbol,
      interval: EOD_FALLBACK_INTERVAL,
      limit,
      baseUrl
    });
    return { candles, effectiveInterval: EOD_FALLBACK_INTERVAL, remapped: true };
  }
}

async function fetchHistoricalData(config, symbol, interval = '1h', limit = 100, options = {}) {
  const canonicalInterval = normalizeInterval(interval);
  const cacheKey = `market:${symbol}:${canonicalInterval}:${limit}`;
  const forceRefresh = Boolean(options.forceRefresh);

  if (!forceRefresh) {
    const cached = getFresh(cacheKey);
    if (cached) return cached;
  }

  const primary = process.env.MARKET_DATA_PRIMARY || process.env.DATA_PROVIDER || 'twelve_data';
  const fallback = process.env.MARKET_DATA_FALLBACK || 'eodhd';
  const errors = [];
  let twelveLimited = shouldSkipTwelveData();

  const providers = {
    twelve_data: {
      enabled: primary === 'twelve_data' || fallback === 'twelve_data',
      run: async () => {
        const candles = await fetchTwelveDataSeries({
          apiKey: config.providers.twelve_data.apiKey,
          symbol,
          interval: canonicalInterval,
          limit,
          baseUrl: config.providers.twelve_data.baseUrl,
          forceRefresh
        });
        return {
          candles,
          meta: buildMeta({
            provider: 'twelve_data',
            primary,
            remapped: false,
            effectiveInterval: canonicalInterval
          })
        };
      }
    },
    eodhd: {
      enabled: (primary === 'eodhd' || fallback === 'eodhd') && Boolean(config.providers.eodhd.apiKey),
      run: async () => {
        const forceEodFallback = twelveLimited && !isEodhdEodInterval(canonicalInterval);
        const result = await fetchFromEodhd({
          apiKey: config.providers.eodhd.apiKey,
          symbol,
          interval: canonicalInterval,
          limit,
          baseUrl: config.providers.eodhd.baseUrl,
          forceEodFallback
        });
        return {
          candles: result.candles,
          meta: buildMeta({
            provider: 'eodhd',
            primary,
            remapped: result.remapped,
            effectiveInterval: result.effectiveInterval
          })
        };
      }
    }
  };

  const ordered = [primary, fallback]
    .filter(Boolean)
    .filter((name, index, list) => list.indexOf(name) === index)
    .filter(name => providers[name]?.enabled);

  for (const name of ordered) {
    if (name === 'twelve_data' && shouldSkipTwelveData()) {
      errors.push('twelve_data: skipped (credit/rate-limit cooldown — using fallback)');
      twelveLimited = true;
      continue;
    }

    try {
      const { candles, meta } = await providers[name].run();
      if (name !== primary || meta.fallback_interval) {
        console.warn(
          `[MarketData] Used ${name}${meta.fallback_interval ? ` ${meta.fallback_interval} EOD` : ''} for ${symbol}`
        );
      }
      return cacheCandles(symbol, canonicalInterval, limit, candles, meta);
    } catch (error) {
      errors.push(`${name}: ${error.message}`);
      if (name === 'twelve_data') {
        markTwelveDataUnavailable(error.message);
        if (isRateLimitError(error.message) || isCreditExhaustedError(error.message)) {
          twelveLimited = true;
        }
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
  markTwelveDataUnavailable,
  planEodhdFetch,
  EOD_FALLBACK_INTERVAL
};
