const { normalizeSymbol } = require('../config/symbols');

const TWELVE_DATA_SYMBOL_MAP = {
  US30: 'DJI',
  US100: 'NDX',
  'USD/BTC': 'BTC/USD'
};

const INTERVAL_MAP = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '30m': '30min',
  '1h': '1h',
  '4h': '4h',
  '1D': '1day',
  '1W': '1week'
};

const cache = new Map();
const DEFAULT_CACHE_TTL_MS = Number(process.env.TWELVE_DATA_CACHE_TTL_MS || 60000);

function toTwelveDataSymbol(symbol) {
  const normalized = normalizeSymbol(symbol);
  return TWELVE_DATA_SYMBOL_MAP[normalized] || normalized;
}

function toTwelveDataInterval(interval) {
  const key = String(interval || '1h').trim();
  return INTERVAL_MAP[key] || key;
}

function parseTwelveDataDatetime(value) {
  if (!value) return Date.now();
  const isoLike = String(value).trim().replace(' ', 'T');
  const parsed = Date.parse(isoLike.endsWith('Z') ? isoLike : `${isoLike}Z`);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function normalizeTwelveDataCandles(values = []) {
  return values
    .map(row => ({
      time: parseTwelveDataDatetime(row.datetime),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume || 0)
    }))
    .filter(c => Number.isFinite(c.close))
    .sort((a, b) => a.time - b.time);
}

function getCachedSeries(cacheKey) {
  const entry = cache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > entry.ttlMs) {
    cache.delete(cacheKey);
    return null;
  }
  return entry.data;
}

function setCachedSeries(cacheKey, data, ttlMs = DEFAULT_CACHE_TTL_MS) {
  cache.set(cacheKey, { data, storedAt: Date.now(), ttlMs });
}

async function fetchTimeSeries({ apiKey, symbol, interval, limit = 100, baseUrl }) {
  if (!apiKey) {
    throw new Error('Twelve Data API key not configured');
  }

  const tdSymbol = toTwelveDataSymbol(symbol);
  const tdInterval = toTwelveDataInterval(interval);
  const outputsize = Math.min(Math.max(Number(limit) || 100, 1), 5000);
  const cacheKey = `${tdSymbol}:${tdInterval}:${outputsize}`;
  const cached = getCachedSeries(cacheKey);
  if (cached) return cached;

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

  setCachedSeries(cacheKey, candles);
  return candles;
}

module.exports = {
  toTwelveDataSymbol,
  toTwelveDataInterval,
  normalizeTwelveDataCandles,
  fetchTimeSeries
};
