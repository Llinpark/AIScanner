const { normalizeSymbol } = require('../config/symbols');
const { normalizeInterval } = require('./marketIntervals');
const {
  DEFAULT_TTL_MS,
  dedupeFetch,
  getFresh,
  set
} = require('./marketDataCache');

const TWELVE_DATA_SYMBOL_MAP = {
  US30: 'DJI',
  US100: 'NDX',
  'BTC/USD': 'BTC/USD'
};

const TWELVE_DATA_INTERVAL_MAP = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '30m': '30min',
  '1h': '1h',
  '4h': '4h',
  '1d': '1day',
  '1w': '1week',
  '1M': '1month'
};

/** Stay under free-tier 8 credits/min (leave 1 credit headroom). */
const CREDITS_PER_MINUTE = Math.max(
  1,
  Math.min(60, Number(process.env.TWELVE_DATA_CREDITS_PER_MINUTE || 7))
);
const MIN_CALL_SPACING_MS = Math.ceil(60_000 / CREDITS_PER_MINUTE);

let lastApiCallAt = 0;
let apiCallChain = Promise.resolve();

function enqueueApiCall(fetcher) {
  const run = async () => {
    const waitMs = Math.max(0, lastApiCallAt + MIN_CALL_SPACING_MS - Date.now());
    if (waitMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
    lastApiCallAt = Date.now();
    return fetcher();
  };

  const next = apiCallChain.then(run, run);
  apiCallChain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

function toTwelveDataSymbol(symbol) {
  const normalized = normalizeSymbol(symbol);
  return TWELVE_DATA_SYMBOL_MAP[normalized] || normalized;
}

function toTwelveDataInterval(interval) {
  const canonical = normalizeInterval(interval);
  return TWELVE_DATA_INTERVAL_MAP[canonical] || canonical;
}

function parseTwelveDataDatetime(value) {
  if (!value) return null;
  const isoLike = String(value).trim().replace(' ', 'T');
  const parsed = Date.parse(isoLike.endsWith('Z') ? isoLike : `${isoLike}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTwelveDataCandles(values = []) {
  return values
    .map(row => {
      const time = parseTwelveDataDatetime(row.datetime);
      if (!time) return null;
      return {
        time,
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume || 0)
      };
    })
    .filter(c => c && Number.isFinite(c.close))
    .sort((a, b) => a.time - b.time);
}

async function fetchTimeSeries({ apiKey, symbol, interval, limit = 100, baseUrl, forceRefresh = false }) {
  if (!apiKey) {
    throw new Error('Twelve Data API key not configured');
  }

  const tdSymbol = toTwelveDataSymbol(symbol);
  const tdInterval = toTwelveDataInterval(interval);
  const outputsize = Math.min(Math.max(Number(limit) || 100, 1), 5000);
  const cacheKey = `twelve:${tdSymbol}:${tdInterval}:${outputsize}`;

  if (!forceRefresh) {
    const cached = getFresh(cacheKey);
    if (cached) return cached;
  }

  return dedupeFetch(cacheKey, async () => {
    if (!forceRefresh) {
      const freshCached = getFresh(cacheKey);
      if (freshCached) return freshCached;
    }

    return enqueueApiCall(async () => {
      // Re-check cache after waiting in the credit queue.
      if (!forceRefresh) {
        const freshCached = getFresh(cacheKey);
        if (freshCached) return freshCached;
      }

      const url = new URL(`${baseUrl}/time_series`);
      url.searchParams.set('symbol', tdSymbol);
      url.searchParams.set('interval', tdInterval);
      url.searchParams.set('outputsize', String(outputsize));
      url.searchParams.set('order', 'asc');
      url.searchParams.set('timezone', 'UTC');
      url.searchParams.set('apikey', apiKey);

      const response = await fetch(url);
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload?.message || `Twelve Data HTTP ${response.status}`);
      }

      if (payload.status === 'error') {
        throw new Error(payload.message || 'Twelve Data API error');
      }

      const candles = normalizeTwelveDataCandles(payload.values || []);
      if (!candles.length) {
        throw new Error(`Twelve Data returned no candles for ${tdSymbol}`);
      }

      set(cacheKey, candles, DEFAULT_TTL_MS);
      return candles;
    });
  });
}

module.exports = {
  toTwelveDataSymbol,
  toTwelveDataInterval,
  normalizeTwelveDataCandles,
  fetchTimeSeries
};
