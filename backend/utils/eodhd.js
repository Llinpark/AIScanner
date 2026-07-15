const { normalizeSymbol } = require('../config/symbols');
const { normalizeInterval } = require('./marketIntervals');

const EODHD_SYMBOL_MAP = {
  'EUR/USD': 'EURUSD.FOREX',
  'GBP/USD': 'GBPUSD.FOREX',
  'XAU/USD': 'XAUUSD.FOREX',
  'XAG/USD': 'XAGUSD.FOREX',
  'AUD/USD': 'AUDUSD.FOREX',
  'USD/JPY': 'USDJPY.FOREX',
  'USD/CAD': 'USDCAD.FOREX',
  'NZD/USD': 'NZDUSD.FOREX',
  'USD/CHF': 'USDCHF.FOREX',
  'EUR/GBP': 'EURGBP.FOREX',
  'EUR/JPY': 'EURJPY.FOREX',
  'GBP/JPY': 'GBPJPY.FOREX',
  US30: 'DJI.INDX',
  US100: 'NDX.INDX',
  'USD/BTC': 'BTC-USD.CC'
};

const EODHD_INTRADAY_INTERVAL_MAP = {
  '1m': '1m',
  '5m': '5m',
  '15m': '5m',
  '30m': '5m',
  '1h': '1h',
  '4h': '1h'
};

const EODHD_PERIOD_MAP = {
  '1d': 'd',
  '1w': 'w',
  '1M': 'm'
};

function toEodhdSymbol(symbol) {
  const normalized = normalizeSymbol(symbol);
  if (EODHD_SYMBOL_MAP[normalized]) return EODHD_SYMBOL_MAP[normalized];
  const compact = normalized.replace('/', '');
  return `${compact}.FOREX`;
}

function toEodhdIntradayInterval(interval) {
  const canonical = normalizeInterval(interval);
  return EODHD_INTRADAY_INTERVAL_MAP[canonical] || '1h';
}

function isEodhdEodInterval(interval) {
  const canonical = normalizeInterval(interval);
  return Boolean(EODHD_PERIOD_MAP[canonical]);
}

function parseEodhdDatetime(value) {
  if (value == null) return Date.now();
  if (typeof value === 'number') return value * 1000;
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const parsed = Date.parse(raw.includes('T') ? raw : `${raw}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function normalizeEodhdCandles(rows = []) {
  return rows
    .map(row => ({
      time: parseEodhdDatetime(row.timestamp || row.datetime || row.date),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume || 0)
    }))
    .filter(c => Number.isFinite(c.close))
    .sort((a, b) => a.time - b.time);
}

async function parseEodhdResponse(response) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(
      typeof text === 'string' && text.length
        ? text.trim().slice(0, 160)
        : `EODHD HTTP ${response.status}`
    );
  }

  if (!response.ok) {
    throw new Error(
      typeof payload === 'string'
        ? payload
        : payload?.message || payload?.error || `EODHD HTTP ${response.status}`
    );
  }

  return payload;
}

async function fetchEodSeries({ apiKey, symbol, interval, limit = 100, baseUrl }) {
  if (!apiKey) throw new Error('EODHD API key not configured');

  const canonical = normalizeInterval(interval);
  const period = EODHD_PERIOD_MAP[canonical];
  if (!period) {
    throw new Error(`EODHD EOD endpoint does not support interval ${interval}`);
  }

  const ticker = toEodhdSymbol(symbol);
  const url = new URL(`${baseUrl.replace(/\/$/, '')}/eod/${ticker}`);
  url.searchParams.set('api_token', apiKey);
  url.searchParams.set('fmt', 'json');
  url.searchParams.set('period', period);
  url.searchParams.set('order', 'a');

  const response = await fetch(url);
  const payload = await parseEodhdResponse(response);
  const rows = Array.isArray(payload) ? payload : payload?.data || [];
  const candles = normalizeEodhdCandles(rows).slice(-limit);

  if (!candles.length) {
    throw new Error(`EODHD returned no ${canonical} candles for ${ticker}`);
  }

  return candles;
}

async function fetchIntradaySeries({ apiKey, symbol, interval, limit = 100, baseUrl }) {
  if (!apiKey) throw new Error('EODHD API key not configured');

  const ticker = toEodhdSymbol(symbol);
  const eodInterval = toEodhdIntradayInterval(interval);
  const url = new URL(`${baseUrl.replace(/\/$/, '')}/intraday/${ticker}`);
  url.searchParams.set('api_token', apiKey);
  url.searchParams.set('fmt', 'json');
  url.searchParams.set('interval', eodInterval);

  const response = await fetch(url);
  const payload = await parseEodhdResponse(response);
  const rows = Array.isArray(payload) ? payload : payload?.data || [];
  const candles = normalizeEodhdCandles(rows).slice(-limit);

  if (!candles.length) {
    throw new Error(`EODHD returned no intraday candles for ${ticker}`);
  }

  return candles;
}

async function fetchHistoricalSeries(params) {
  if (isEodhdEodInterval(params.interval)) {
    return fetchEodSeries(params);
  }
  return fetchIntradaySeries(params);
}

module.exports = {
  toEodhdSymbol,
  toEodhdIntradayInterval,
  normalizeEodhdCandles,
  fetchIntradaySeries,
  fetchEodSeries,
  fetchHistoricalSeries
};
