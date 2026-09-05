const MARKET_DATA_PROVIDER_LABELS = {
  twelve_data: 'Twelve Data',
  eodhd: 'EODHD',
  mock: 'Mock'
};

export function formatMarketDataProvider(provider) {
  if (!provider) return null;
  const key = String(provider).trim();
  if (!key) return null;
  return MARKET_DATA_PROVIDER_LABELS[key] || MARKET_DATA_PROVIDER_LABELS[key.toLowerCase()] || key;
}

export { MARKET_DATA_PROVIDER_LABELS };
