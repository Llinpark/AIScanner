const SYMBOL_PRICE_FORMAT = {
  'XAU/USD': { precision: 2, minMove: 0.01 },
  XAUUSD: { precision: 2, minMove: 0.01 },
  'XAG/USD': { precision: 3, minMove: 0.001 },
  XAGUSD: { precision: 3, minMove: 0.001 },
  US30: { precision: 2, minMove: 0.01 },
  US100: { precision: 2, minMove: 0.01 },
  'USD/BTC': { precision: 2, minMove: 0.01 },
  USDBTC: { precision: 2, minMove: 0.01 },
  BTCUSD: { precision: 2, minMove: 0.01 }
};

function normalizeInstrumentSymbol(symbol) {
  const raw = String(symbol || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');

  if (!raw) return '';
  if (SYMBOL_PRICE_FORMAT[raw]) return raw;
  if (raw.includes('/')) return raw;
  if (raw === 'US30' || raw === 'US100') return raw;
  if (raw.length === 6) return `${raw.slice(0, 3)}/${raw.slice(3)}`;
  return raw;
}

export function getPricePrecision(symbol) {
  const normalized = normalizeInstrumentSymbol(symbol);
  const compact = normalized.replace('/', '');

  if (SYMBOL_PRICE_FORMAT[normalized]) {
    return SYMBOL_PRICE_FORMAT[normalized];
  }
  if (SYMBOL_PRICE_FORMAT[compact]) {
    return SYMBOL_PRICE_FORMAT[compact];
  }
  if (normalized.includes('JPY')) {
    return { precision: 3, minMove: 0.001 };
  }
  if (/^[A-Z]{3}\/[A-Z]{3}$/.test(normalized)) {
    return { precision: 5, minMove: 0.00001 };
  }

  return { precision: 5, minMove: 0.00001 };
}

export function formatInstrumentPrice(value, symbol) {
  if (!Number.isFinite(value)) return '—';
  const { precision } = getPricePrecision(symbol);
  return value.toFixed(precision);
}

export function getChartPriceFormat(symbol) {
  const { precision, minMove } = getPricePrecision(symbol);
  return {
    type: 'price',
    precision,
    minMove
  };
}
