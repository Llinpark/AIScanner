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

/** Normalize TV/broker symbols (FX:EURUSD, TVC:DJI, EURUSD) to app form. */
export function normalizeMarketSymbol(symbol) {
  let raw = String(symbol || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (!raw) return '';

  if (raw.includes(':')) {
    const parts = raw.split(':').filter(Boolean);
    raw = parts[parts.length - 1];
  }

  raw = raw.replace(/!$/g, '');
  raw = raw.replace(/\.(P|FX|FOREX|CASH|CFD)$/i, '');

  if (SYMBOL_ALIASES[raw]) return SYMBOL_ALIASES[raw];
  if (raw.includes('/')) return raw;
  if (raw === 'US30' || raw === 'US100') return raw;
  if (/^[A-Z]{6}$/.test(raw)) return `${raw.slice(0, 3)}/${raw.slice(3)}`;
  return raw;
}

export function alertMatchesSymbol(alert, selectedSymbol) {
  if (!selectedSymbol || selectedSymbol === 'ALL') return true;
  return normalizeMarketSymbol(alert?.symbol) === normalizeMarketSymbol(selectedSymbol);
}
