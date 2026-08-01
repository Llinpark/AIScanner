// Canonical KachingScanner market symbols.
// Platform invariant: ONLY these assets may generate / accept / display trade signals.
// TradingView chart ticker is still the runtime source for prices, but unsupported
// instruments (Deriv / Jump / Volatility / crypto / extras) are rejected end-to-end.

const SUPPORTED_SCANNER_SYMBOLS = Object.freeze({
  'EUR/USD': { basePrice: 1.085, category: 'forex', compact: 'EURUSD' },
  'GBP/USD': { basePrice: 1.268, category: 'forex', compact: 'GBPUSD' },
  'USD/JPY': { basePrice: 149.5, category: 'forex', compact: 'USDJPY' },
  'AUD/USD': { basePrice: 0.658, category: 'forex', compact: 'AUDUSD' },
  'USD/CAD': { basePrice: 1.362, category: 'forex', compact: 'USDCAD' },
  'XAU/USD': { basePrice: 2650, category: 'metal', compact: 'XAUUSD' },
  US30: { basePrice: 39100, category: 'index', compact: 'US30' },
  US100: { basePrice: 18250, category: 'index', compact: 'US100' }
});

/** Chart / scanner / webhook catalog — supported assets only. */
const MARKET_SYMBOLS = SUPPORTED_SCANNER_SYMBOLS;

/** Ordered list used by Admin Scanner defaults and tier catalogs. */
const ALL_CURRENCY_PAIRS = Object.freeze(Object.keys(SUPPORTED_SCANNER_SYMBOLS));

/** Compact codes (EURUSD, US30, …) for Pine / webhook payloads. */
const SUPPORTED_COMPACT_SYMBOLS = Object.freeze(
  Object.values(SUPPORTED_SCANNER_SYMBOLS).map(s => s.compact)
);

const SUPPORTED_SYMBOL_SET = new Set([
  ...ALL_CURRENCY_PAIRS,
  ...SUPPORTED_COMPACT_SYMBOLS
]);

/** ISO-style codes used only to decide whether to insert a slash in 6-letter FX tickers. */
const FX_CURRENCY_CODES = new Set([
  'EUR',
  'USD',
  'GBP',
  'JPY',
  'AUD',
  'NZD',
  'CAD',
  'CHF',
  'XAU',
  'XAG',
  'BTC',
  'ETH',
  'SGD',
  'HKD',
  'SEK',
  'NOK',
  'DKK',
  'ZAR',
  'MXN',
  'TRY',
  'PLN',
  'CNH',
  'CNY'
]);

/**
 * Aliases map broker / TV variants → canonical app form (slash FX / US30 / US100).
 * Only aliases that resolve into SUPPORTED_SCANNER_SYMBOLS are accepted by isSupportedScannerSymbol.
 */
const SYMBOL_ALIASES = Object.freeze({
  XAUUSD: 'XAU/USD',
  // Common mistype / broker variant seen on some feeds
  UAXUSD: 'XAU/USD',
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
});

/**
 * Sanitize / normalize a TradingView / broker / provider ticker.
 * Does NOT enforce the supported-asset allowlist — use isSupportedScannerSymbol for that.
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

  // Strip common TradingView / feed / continuous-contract suffixes
  raw = raw.replace(/!$/g, '');
  raw = raw.replace(/\.(P|FX|FOREX|CASH|CFD|PRO|MINI|SPOT)$/i, '');

  // Allowlist of safe ticker characters
  raw = raw.replace(/[^A-Z0-9._\-\/]/g, '');
  if (!raw) return '';

  if (SYMBOL_ALIASES[raw]) return SYMBOL_ALIASES[raw];
  if (MARKET_SYMBOLS[raw]) return raw;
  if (raw.includes('/')) return raw;

  // Only insert FX slash when both legs look like currency codes (avoid SPX500 → SPX/500)
  if (/^[A-Z]{6}$/.test(raw)) {
    const a = raw.slice(0, 3);
    const b = raw.slice(3);
    if (FX_CURRENCY_CODES.has(a) && FX_CURRENCY_CODES.has(b)) {
      return `${a}/${b}`;
    }
  }

  return raw;
}

/** Explicit reject patterns — never trade / display these as scanner assets. */
const UNSUPPORTED_SYMBOL_RE =
  /\b(DERIV|DERIVE|JUMP|VOLATILITY|BOOM|CRASH|STEP\s*INDEX|RANGE\s*BREAK|SYNTH|BTC|ETH|XBT|USDT|XAG|SILVER|NZD|CHF|GBP\/?JPY|EUR\/?GBP|EUR\/?JPY)\b/i;

/**
 * True only for the eight Admin-supported KachingScanner assets (and their aliases).
 * Rejects Deriv / Jump / Volatility / BTC / crypto / unlisted FX / etc.
 */
function isSupportedScannerSymbol(symbol) {
  const raw = String(symbol || '').trim();
  if (!raw) return false;
  if (UNSUPPORTED_SYMBOL_RE.test(raw.replace(/[_-]+/g, ' '))) return false;
  const key = normalizeSymbol(symbol);
  if (!key) return false;
  if (UNSUPPORTED_SYMBOL_RE.test(key.replace(/\//g, ' '))) return false;
  if (SUPPORTED_SYMBOL_SET.has(key)) return true;
  const compact = key.replace(/\//g, '');
  return SUPPORTED_SYMBOL_SET.has(compact);
}

/** Compact webhook / Pine form: EURUSD, XAUUSD, US30, US100. */
function toCompactSymbol(symbol) {
  const key = normalizeSymbol(symbol);
  if (!key) return '';
  const meta = MARKET_SYMBOLS[key];
  if (meta?.compact) return meta.compact;
  return key.replace(/\//g, '');
}

function getBasePrice(symbol) {
  const key = normalizeSymbol(symbol);
  return MARKET_SYMBOLS[key]?.basePrice ?? 1.085;
}

const INDEX_SYMBOL_RE = /^(US30|US100|NAS100|USTEC|NDX|DJ30|DJI|DJIA|DOW)/i;

/**
 * Classify a symbol for spread / risk defaults.
 * @returns {'forex'|'gold'|'indices'|'metal'|'crypto'|'other'}
 */
function getSymbolAssetClass(symbol) {
  const key = normalizeSymbol(symbol);
  const catalogCategory = MARKET_SYMBOLS[key]?.category;
  if (catalogCategory === 'forex') return 'forex';
  if (catalogCategory === 'index') return 'indices';
  if (catalogCategory === 'crypto') return 'crypto';
  if (catalogCategory === 'metal') {
    if (key.includes('XAU') || key.includes('GOLD')) return 'gold';
    return 'metal';
  }

  const compact = key.replace(/\//g, '');
  if (compact.includes('XAU') || compact.includes('GOLD')) return 'gold';
  if (INDEX_SYMBOL_RE.test(compact)) return 'indices';
  if (compact.includes('BTC') || compact.includes('ETH') || compact.includes('USDT')) return 'crypto';
  if (compact.includes('XAG') || compact.includes('SILVER')) return 'metal';
  if (key.includes('/')) return 'forex';
  return 'other';
}

module.exports = {
  SUPPORTED_SCANNER_SYMBOLS,
  SUPPORTED_COMPACT_SYMBOLS,
  MARKET_SYMBOLS,
  ALL_CURRENCY_PAIRS,
  SYMBOL_ALIASES,
  FX_CURRENCY_CODES,
  normalizeSymbol,
  isSupportedScannerSymbol,
  toCompactSymbol,
  getBasePrice,
  getSymbolAssetClass
};
