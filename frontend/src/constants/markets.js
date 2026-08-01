/** Supported KachingScanner assets ONLY (Admin invariant). */
export const SUPPORTED_SCANNER_SYMBOLS = Object.freeze([
  'EUR/USD',
  'GBP/USD',
  'USD/JPY',
  'AUD/USD',
  'USD/CAD',
  'XAU/USD',
  'US30',
  'US100'
]);

export const SUPPORTED_COMPACT_SYMBOLS = Object.freeze([
  'EURUSD',
  'GBPUSD',
  'USDJPY',
  'AUDUSD',
  'USDCAD',
  'XAUUSD',
  'US30',
  'US100'
]);

const SYMBOL_ALIASES = {
  XAUUSD: 'XAU/USD',
  EURUSD: 'EUR/USD',
  GBPUSD: 'GBP/USD',
  AUDUSD: 'AUD/USD',
  USDJPY: 'USD/JPY',
  USDCAD: 'USD/CAD',
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

const SUPPORTED_SET = new Set([...SUPPORTED_SCANNER_SYMBOLS, ...SUPPORTED_COMPACT_SYMBOLS]);

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

const UNSUPPORTED_SYMBOL_RE =
  /\b(DERIV|DERIVE|JUMP|VOLATILITY|BOOM|CRASH|STEP\s*INDEX|RANGE\s*BREAK|SYNTH|BTC|ETH|XBT|USDT|XAG|SILVER|NZD|CHF)\b/i;

/** Platform allowlist — Deriv / Jump / Volatility / BTC / crypto never pass. */
export function isSupportedScannerSymbol(symbol) {
  const raw = String(symbol || '').trim();
  if (!raw) return false;
  if (UNSUPPORTED_SYMBOL_RE.test(raw.replace(/[_-]+/g, ' '))) return false;
  const key = normalizeMarketSymbol(symbol);
  if (!key) return false;
  if (UNSUPPORTED_SYMBOL_RE.test(key.replace(/\//g, ' '))) return false;
  if (SUPPORTED_SET.has(key)) return true;
  return SUPPORTED_SET.has(key.replace(/\//g, ''));
}

export function alertMatchesSymbol(alert, selectedSymbol) {
  if (!selectedSymbol || selectedSymbol === 'ALL') return true;
  return normalizeMarketSymbol(alert?.symbol) === normalizeMarketSymbol(selectedSymbol);
}
