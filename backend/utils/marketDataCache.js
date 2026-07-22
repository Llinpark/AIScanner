const cache = new Map();
const inFlight = new Map();

const DEFAULT_TTL_MS = Number(
  process.env.MARKET_DATA_CACHE_TTL_MS || process.env.TWELVE_DATA_CACHE_TTL_MS || 60_000
);
const STALE_TTL_MS = Number(process.env.MARKET_DATA_STALE_TTL_MS || 900000);

/** Soft per-minute throttle (e.g. free tier 8 credits/min) — not a plan outage. */
function isPerMinuteCreditError(message) {
  const text = String(message || '').toLowerCase();
  return (
    text.includes('current minute') ||
    text.includes('wait for the next minute') ||
    text.includes('local credit budget') ||
    text.includes('credits were used, with the current limit')
  );
}

function isRateLimitError(message) {
  const text = String(message || '').toLowerCase();
  return (
    isPerMinuteCreditError(text) ||
    text.includes('run out of api credits') ||
    text.includes('api credits') ||
    text.includes('credit limit') ||
    text.includes('insufficient credits') ||
    text.includes('rate limit') ||
    text.includes('too many requests') ||
    text.includes('429')
  );
}

/**
 * True when Twelve Data has exhausted plan/monthly credits (long cooldown).
 * Per-minute free-tier messages must NOT match — those are soft rate limits.
 */
function isCreditExhaustedError(message) {
  if (isPerMinuteCreditError(message)) return false;
  const text = String(message || '').toLowerCase();
  return (
    text.includes('run out of api credits') ||
    text.includes('api credits') ||
    text.includes('credit limit') ||
    text.includes('insufficient credits')
  );
}

/** EODHD free tier rejects intraday endpoints. */
function isEodhdEodOnlyError(message) {
  const text = String(message || '').toLowerCase();
  return (
    text.includes('only eod data allowed') ||
    text.includes('only eod data') ||
    text.includes('eod data allowed for free')
  );
}


function getEntry(key) {
  return cache.get(key) || null;
}

function getFresh(key) {
  const entry = getEntry(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > entry.ttlMs) return null;
  return entry.data;
}

function getStale(key) {
  const entry = getEntry(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > STALE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function set(key, data, ttlMs = DEFAULT_TTL_MS) {
  cache.set(key, { data, storedAt: Date.now(), ttlMs });
}

async function dedupeFetch(key, fetcher) {
  if (inFlight.has(key)) {
    return inFlight.get(key);
  }

  const promise = Promise.resolve()
    .then(fetcher)
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise;
}

module.exports = {
  DEFAULT_TTL_MS,
  STALE_TTL_MS,
  isPerMinuteCreditError,
  isRateLimitError,
  isCreditExhaustedError,
  isEodhdEodOnlyError,
  getFresh,
  getStale,
  set,
  dedupeFetch
};
