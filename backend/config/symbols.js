// Canonical market symbols and mock price seeds for the scanner / demo data.
const MARKET_SYMBOLS = {
  'EUR/USD': { basePrice: 1.085, category: 'forex' },
  'GBP/USD': { basePrice: 1.268, category: 'forex' },
  'XAU/USD': { basePrice: 2650, category: 'metal' },
  'XAG/USD': { basePrice: 31.5, category: 'metal' },
  'AUD/USD': { basePrice: 0.658, category: 'forex' },
  'USD/JPY': { basePrice: 149.5, category: 'forex' },
  'USD/CAD': { basePrice: 1.362, category: 'forex' },
  'NZD/USD': { basePrice: 0.612, category: 'forex' },
  'USD/CHF': { basePrice: 0.884, category: 'forex' },
  'EUR/GBP': { basePrice: 0.855, category: 'forex' },
  'EUR/JPY': { basePrice: 162.2, category: 'forex' },
  'GBP/JPY': { basePrice: 189.6, category: 'forex' },
  US30: { basePrice: 39100, category: 'index' },
  US100: { basePrice: 18250, category: 'index' },
  'BTC/USD': { basePrice: 97500, category: 'crypto' }
};

const ALL_CURRENCY_PAIRS = Object.keys(MARKET_SYMBOLS);

const SYMBOL_ALIASES = {
  XAUUSD: 'XAU/USD',
  XAGUSD: 'XAG/USD',
  EURUSD: 'EUR/USD',
  GBPUSD: 'GBP/USD',
  AUDUSD: 'AUD/USD',
  USDJPY: 'USD/JPY',
  USDCAD: 'USD/CAD',
  NZDUSD: 'NZD/USD',
  USDCHF: 'USD/CHF',
  EURGBP: 'EUR/GBP',
  EURJPY: 'EUR/JPY',
  GBPJPY: 'GBP/JPY',
  USDBTC: 'BTC/USD',
  BTCUSD: 'BTC/USD',
  BTCUSDT: 'BTC/USD',
  'USD/BTC': 'BTC/USD',
  NAS100: 'US100',
  USTEC: 'US100',
  NDX: 'US100',
  NDXUSD: 'US100',
  US100USD: 'US100',
  DJ30: 'US30',
  DJI: 'US30',
  DJIA: 'US30',
  US30USD: 'US30',
  DOW: 'US30'
};

/**
 * Normalize TradingView / broker / provider symbols to canonical app form.
 * Handles FX:EURUSD, OANDA:GBPUSD, TVC:DJI, EURUSD, EUR/USD, etc.
 */
function normalizeSymbol(symbol) {
  let raw = String(symbol || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (!raw) return '';

  // Strip exchange / broker prefixes (FX:EURUSD, TVC:DJI, BINANCE:BTCUSDT)
  if (raw.includes(':')) {
    const parts = raw.split(':').filter(Boolean);
    raw = parts[parts.length - 1];
  }

  // Strip common TradingView / feed suffixes
  raw = raw.replace(/!$/g, '');
  raw = raw.replace(/\.(P|FX|FOREX|CASH|CFD)$/i, '');

  if (SYMBOL_ALIASES[raw]) return SYMBOL_ALIASES[raw];
  if (raw.includes('/')) return raw;
  if (raw === 'US30' || raw === 'US100') return raw;
  if (/^[A-Z]{6}$/.test(raw)) return `${raw.slice(0, 3)}/${raw.slice(3)}`;
  return raw;
}

function getBasePrice(symbol) {
  const key = normalizeSymbol(symbol);
  return MARKET_SYMBOLS[key]?.basePrice ?? 1.085;
}

module.exports = {
  MARKET_SYMBOLS,
  ALL_CURRENCY_PAIRS,
  SYMBOL_ALIASES,
  normalizeSymbol,
  getBasePrice
};
