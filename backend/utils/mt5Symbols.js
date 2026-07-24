const { normalizeSymbol } = require('../config/symbols');

/** Known catalog → common MT5 names (brokers still vary; suffix handles .m / .i / etc.). */
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
  'ETH/USD': 'ETHUSD',
  US30: 'US30',
  US100: 'US100',
  'BTC/USD': 'BTCUSD',
  GER40: 'GER40',
  UK100: 'UK100',
  SPX500: 'SPX500',
  ESP35: 'ESP35',
  FRA40: 'FRA40',
  JPN225: 'JPN225'
};

/**
 * Best-effort MT5 symbol for queueing — never refuses solely because the pair is unknown.
 * Strips TV/exchange noise, maps known aliases, then appends the user's broker suffix.
 */
function toMt5Symbol(symbol, suffix = '') {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return String(suffix || '');

  const mapped = MT5_SYMBOL_MAP[normalized];
  if (mapped) return `${mapped}${suffix || ''}`;

  // Pass through exotic / stock / crypto tickers: drop slashes, keep alphanumerics.
  const compact = normalized.replace(/\//g, '').replace(/[^A-Z0-9._\-]/gi, '');
  return `${compact || normalized}${suffix || ''}`;
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
