const cache = new Map();
const inFlight = new Map();

const DEFAULT_TTL_MS = Number(
  process.env.MARKET_DATA_CACHE_TTL_MS || process.env.TWELVE_DATA_CACHE_TTL_MS || 60_000
);
const STALE_TTL_MS = Number(process.env.MARKET_DATA_STALE_TTL_MS || 900000);

function isRateLimitError(message) {
  const text = String(message || '').toLowerCase();
  return (
    text.includes('run out of api credits') ||
    text.includes('api credits') ||
    text.includes('credit limit') ||
    text.includes('insufficient credits') ||
    text.includes('rate limit') ||
    text.includes('too many requests') ||
    text.includes('429')
  );
}

/** True when Twelve Data has exhausted paid credits (not a short soft 429). */
function isCreditExhaustedError(message) {
  const text = String(message || '').toLowerCase();
  return (
    text.includes('run out of api credits') ||
    text.includes('api credits') ||
    text.includes('credit limit') ||
    text.includes('insufficient credits')
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
  isRateLimitError,
  isCreditExhaustedError,
  getFresh,
  getStale,
  set,
  dedupeFetch
};
