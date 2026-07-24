const USER_FACING_MARKET_DATA_UNAVAILABLE =
  'Market data is temporarily unavailable. Please try again shortly.';

function looksLikeProviderTechnicalError(message) {
  const text = String(message || '').toLowerCase();
  if (!text) return false;
  return (
    text.includes('twelve_data:') ||
    text.includes('eodhd:') ||
    text.includes('api credits') ||
    text.includes('run out of api') ||
    text.includes('exceeded your daily') ||
    text.includes('cached data unavailable') ||
    text.includes('twelvedata.com') ||
    text.includes('eodhistoricaldata') ||
    text.includes('check eodhd') ||
    text.includes('rate limit') ||
    text.includes('too many requests')
  );
}

/** Calm copy for chart/API market-data failures; hide raw provider text. */
export function toUserFacingMarketDataError(message, fallback = USER_FACING_MARKET_DATA_UNAVAILABLE) {
  if (!message) return fallback;
  if (looksLikeProviderTechnicalError(message)) {
    return USER_FACING_MARKET_DATA_UNAVAILABLE;
  }
  return String(message);
}

export { USER_FACING_MARKET_DATA_UNAVAILABLE };
