// Preferred KachingScanner market catalog for Admin UI / subscription tier defaults.
// TradingView chart ticker is the runtime source of truth — ANY instrument may signal.
// Webhooks and Pine never reject symbols for missing this list.

const PREFERRED_SCANNER_SYMBOLS = Object.freeze({
  'EUR/USD': { basePrice: 1.085, category: 'forex', compact: 'EURUSD' },
  'GBP/USD': { basePrice: 1.268, category: 'forex', compact: 'GBPUSD' },
  'USD/JPY': { basePrice: 149.5, category: 'forex', compact: 'USDJPY' },
  'AUD/USD': { basePrice: 0.658, category: 'forex', compact: 'AUDUSD' },
  'USD/CAD': { basePrice: 1.362, category: 'forex', compact: 'USDCAD' },
  'XAU/USD': { basePrice: 2650, category: 'metal', compact: 'XAUUSD' },
  US30: { basePrice: 39100, category: 'index', compact: 'US30' },
  US100: { basePrice: 18250, category: 'index', compact: 'US100' }
});

/** @deprecated Use PREFERRED_SCANNER_SYMBOLS — kept for import BC. */
const SUPPORTED_SCANNER_SYMBOLS = PREFERRED_SCANNER_SYMBOLS;

/** Chart / scanner preferred catalog — not a hard allowlist. */
const MARKET_SYMBOLS = PREFERRED_SCANNER_SYMBOLS;

/** Ordered preferred list used by Admin Scanner defaults and tier catalogs. */
const ALL_CURRENCY_PAIRS = Object.freeze(Object.keys(PREFERRED_SCANNER_SYMBOLS));

/** Compact codes (EURUSD, US30, …) for common FX/index aliases. */
const SUPPORTED_COMPACT_SYMBOLS = Object.freeze(
  Object.values(PREFERRED_SCANNER_SYMBOLS).map(s => s.compact)
);

const PREFERRED_SYMBOL_SET = new Set([...ALL_CURRENCY_PAIRS, ...SUPPORTED_COMPACT_SYMBOLS]);

/** @deprecated Use PREFERRED_SYMBOL_SET. */
const SUPPORTED_SYMBOL_SET = PREFERRED_SYMBOL_SET;

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
 * Aliases map common broker / TV variants → preferred app form (slash FX / US30 / US100).
 * Unknown instruments pass through unchanged after light sanitization.
 */
const SYMBOL_ALIASES = Object.freeze({
  XAUUSD: 'XAU/USD',
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

const DOTTED_BROKER_SUFFIX_RE = /\.(FOREX|CASH|SPOT|MINI|CFD|PRO|FX|I|M|P)$/i;
const KNOWN_COMPACT_BASE_RE =
  /^(US30|US100|XAUUSD|NAS100|USTEC|NDX|NDXUSD|US100USD|DJ30|DJIA|US30USD|DOW)$/;

/**
 * Strip exchange prefixes + common broker/TV suffixes to a clean ticker core.
 * Does NOT reject unknown instruments.
 */
function stripTradingViewBrokerDecorators(symbol) {
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

  // Keep letters/digits and common ticker punctuation (spaces already removed).
  raw = raw.replace(/[^A-Z0-9._\-\/]/g, '');
  if (!raw) return '';

  if (/[MI]$/.test(raw) && raw.length >= 5) {
    const base = raw.slice(0, -1);
    const alreadyKnown =
      SYMBOL_ALIASES[raw] || MARKET_SYMBOLS[raw] || PREFERRED_SYMBOL_SET.has(raw);
    if (
      !alreadyKnown &&
      (SYMBOL_ALIASES[base] ||
        MARKET_SYMBOLS[base] ||
        PREFERRED_SYMBOL_SET.has(base) ||
        /^[A-Z]{6}$/.test(base) ||
        KNOWN_COMPACT_BASE_RE.test(base))
    ) {
      raw = base;
    }
  }

  return raw;
}

/**
 * Sanitize / normalize a TradingView / broker / provider ticker.
 * Known FX aliases map to slash form; all other TV instruments pass through.
 */
function normalizeSymbol(symbol) {
  let raw = stripTradingViewBrokerDecorators(symbol);
  if (!raw) return '';

  if (SYMBOL_ALIASES[raw]) return SYMBOL_ALIASES[raw];
  if (MARKET_SYMBOLS[raw]) return raw;
  if (raw.includes('/')) return raw;

  if (/^[A-Z]{6}$/.test(raw)) {
    const a = raw.slice(0, 3);
    const b = raw.slice(3);
    if (FX_CURRENCY_CODES.has(a) && FX_CURRENCY_CODES.has(b)) {
      return `${a}/${b}`;
    }
  }

  return raw;
}

/**
 * Compact form for display / matching (EURUSD, XAUUSD, or raw TV ticker).
 */
function normalizeTradingViewSymbol(symbol) {
  return toCompactSymbol(symbol);
}

/**
 * True for any non-empty TradingView / broker ticker.
 * No hard allowlist — TV chart OHLC is the source of truth.
 */
function isSupportedScannerSymbol(symbol) {
  return Boolean(normalizeSymbol(symbol));
}

/** Compact webhook form when catalogued; otherwise cleaned ticker. */
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
  PREFERRED_SCANNER_SYMBOLS,
  SUPPORTED_SCANNER_SYMBOLS,
  SUPPORTED_COMPACT_SYMBOLS,
  MARKET_SYMBOLS,
  ALL_CURRENCY_PAIRS,
  SYMBOL_ALIASES,
  FX_CURRENCY_CODES,
  stripTradingViewBrokerDecorators,
  normalizeSymbol,
  normalizeTradingViewSymbol,
  isSupportedScannerSymbol,
  toCompactSymbol,
  getBasePrice,
  getSymbolAssetClass
};
