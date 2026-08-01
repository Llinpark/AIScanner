/** Preferred Admin / UI catalog defaults (not a hard allowlist). */
export const PREFERRED_SCANNER_SYMBOLS = Object.freeze([
  'EUR/USD',
  'GBP/USD',
  'USD/JPY',
  'AUD/USD',
  'USD/CAD',
  'XAU/USD',
  'US30',
  'US100'
]);

/** @deprecated Use PREFERRED_SCANNER_SYMBOLS */
export const SUPPORTED_SCANNER_SYMBOLS = PREFERRED_SCANNER_SYMBOLS;

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

const PREFERRED_SET = new Set([...PREFERRED_SCANNER_SYMBOLS, ...SUPPORTED_COMPACT_SYMBOLS]);

const DOTTED_BROKER_SUFFIX_RE = /\.(FOREX|CASH|SPOT|MINI|CFD|PRO|FX|I|M|P)$/i;
const KNOWN_COMPACT_BASE_RE =
  /^(US30|US100|XAUUSD|NAS100|USTEC|NDX|NDXUSD|US100USD|DJ30|DJIA|US30USD|DOW)$/;

/**
 * Normalize TV/broker symbols for matching.
 * Known FX aliases map to slash form; unknown TV tickers pass through.
 */
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
  let prev = '';
  while (raw !== prev) {
    prev = raw;
    raw = raw.replace(DOTTED_BROKER_SUFFIX_RE, '');
  }

  if (/[MI]$/.test(raw) && raw.length >= 5) {
    const base = raw.slice(0, -1);
    const alreadyKnown = SYMBOL_ALIASES[raw] || PREFERRED_SET.has(raw);
    if (
      !alreadyKnown &&
      (SYMBOL_ALIASES[base] ||
        PREFERRED_SET.has(base) ||
        /^[A-Z]{6}$/.test(base) ||
        KNOWN_COMPACT_BASE_RE.test(base))
    ) {
      raw = base;
    }
  }

  if (SYMBOL_ALIASES[raw]) return SYMBOL_ALIASES[raw];
  if (raw.includes('/')) return raw;
  if (raw === 'US30' || raw === 'US100') return raw;
  if (/^[A-Z]{6}$/.test(raw)) return `${raw.slice(0, 3)}/${raw.slice(3)}`;
  return raw;
}

/** Compact form for display / matching. */
export function normalizeTradingViewSymbol(symbol) {
  const key = normalizeMarketSymbol(symbol);
  if (!key) return '';
  if (key === 'US30' || key === 'US100') return key;
  return key.replace(/\//g, '');
}

/**
 * Any non-empty TradingView / broker ticker is valid.
 * No hard allowlist — TV chart OHLC is the source of truth.
 */
export function isSupportedScannerSymbol(symbol) {
  return Boolean(normalizeMarketSymbol(symbol));
}

export function alertMatchesSymbol(alert, selectedSymbol) {
  if (!selectedSymbol || selectedSymbol === 'ALL') return true;
  return normalizeMarketSymbol(alert?.symbol) === normalizeMarketSymbol(selectedSymbol);
}
