const { normalizeSymbol } = require('../config/symbols');

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

const EODHD_INTERVAL_MAP = {
  '1m': '1m',
  '1min': '1m',
  '5m': '5m',
  '5min': '5m',
  '15m': '5m',
  '15min': '5m',
  '30m': '5m',
  '30min': '5m',
  '1h': '1h',
  '60min': '1h',
  '4h': '1h'
};

function toEodhdSymbol(symbol) {
  const normalized = normalizeSymbol(symbol);
  if (EODHD_SYMBOL_MAP[normalized]) return EODHD_SYMBOL_MAP[normalized];
  const compact = normalized.replace('/', '');
  return `${compact}.FOREX`;
}

function toEodhdInterval(interval) {
  const key = String(interval || '1h').trim();
  return EODHD_INTERVAL_MAP[key] || '1h';
}

function parseEodhdDatetime(value) {
  if (value == null) return Date.now();
  if (typeof value === 'number') return value * 1000;
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const parsed = Date.parse(`${raw.replace(' ', 'T')}Z`);
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

async function fetchIntradaySeries({ apiKey, symbol, interval, limit = 100, baseUrl }) {
  if (!apiKey) throw new Error('EODHD API key not configured');

  const ticker = toEodhdSymbol(symbol);
  const eodInterval = toEodhdInterval(interval);
  const url = new URL(`${baseUrl.replace(/\/$/, '')}/intraday/${ticker}`);
  url.searchParams.set('api_token', apiKey);
  url.searchParams.set('fmt', 'json');
  url.searchParams.set('interval', eodInterval);

  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(typeof payload === 'string' ? payload : payload?.message || `EODHD HTTP ${response.status}`);
  }

  const rows = Array.isArray(payload) ? payload : payload?.data || [];
  const candles = normalizeEodhdCandles(rows).slice(-limit);
  if (!candles.length) throw new Error(`EODHD returned no candles for ${ticker}`);
  return candles;
}

module.exports = {
  toEodhdSymbol,
  toEodhdInterval,
  normalizeEodhdCandles,
  fetchIntradaySeries
};
