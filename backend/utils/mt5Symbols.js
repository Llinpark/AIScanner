const { normalizeSymbol } = require('../config/symbols');

const MT5_SYMBOL_MAP = {
  'EUR/USD': 'EURUSD',
  'GBP/USD': 'GBPUSD',
  'XAU/USD': 'XAUUSD',
  'XAG/USD': 'XAGUSD',
  'AUD/USD': 'AUDUSD',
  'USD/JPY': 'USDJPY',
  'USD/CAD': 'USDCAD',
  'NZD/USD': 'NZDUSD',
  'USD/CHF': 'USDCHF',
  'EUR/GBP': 'EURGBP',
  'EUR/JPY': 'EURJPY',
  'GBP/JPY': 'GBPJPY',
  US30: 'US30',
  US100: 'US100',
  'USD/BTC': 'BTCUSD'
};

function toMt5Symbol(symbol, suffix = '') {
  const normalized = normalizeSymbol(symbol);
  const base = MT5_SYMBOL_MAP[normalized] || normalized.replace('/', '');
  return `${base}${suffix || ''}`;
}

function mt5OrderType(direction) {
  const d = String(direction || '').toLowerCase();
  return d === 'long' || d === 'buy' ? 'buy' : 'sell';
}

module.exports = {
  MT5_SYMBOL_MAP,
  toMt5Symbol,
  mt5OrderType
};
