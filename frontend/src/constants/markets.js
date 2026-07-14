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
  USDBTC: 'USD/BTC',
  BTCUSD: 'USD/BTC',
  NAS100: 'US100',
  USTEC: 'US100',
  DJ30: 'US30'
};

export function normalizeMarketSymbol(symbol) {
  const raw = String(symbol || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (!raw) return '';
  if (SYMBOL_ALIASES[raw]) return SYMBOL_ALIASES[raw];
  if (raw.includes('/')) return raw;
  if (raw === 'US30' || raw === 'US100') return raw;
  if (raw.length === 6) return `${raw.slice(0, 3)}/${raw.slice(3)}`;
  return raw;
}

export function alertMatchesSymbol(alert, selectedSymbol) {
  if (!selectedSymbol || selectedSymbol === 'ALL') return true;
  return normalizeMarketSymbol(alert?.symbol) === normalizeMarketSymbol(selectedSymbol);
}
