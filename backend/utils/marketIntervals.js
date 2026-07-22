const REFRESH_MS_BY_CANONICAL = {
  // Keep 1m/5m slower than Twelve Data free-tier (~8 credits/min) allows.
  '1m': 60_000,
  '5m': 60_000,
  '15m': 45_000,
  '30m': 60_000,
  '1h': 120_000,
  '4h': 300_000,
  '1d': 600_000,
  '1w': 1_800_000,
  '1M': 3_600_000
};

const INTERVAL_ALIASES = {
  '1m': '1m',
  '1min': '1m',
  M1: '1m',
  '5m': '5m',
  '5min': '5m',
  M5: '5m',
  '15m': '15m',
  '15min': '15m',
  M15: '15m',
  '30m': '30m',
  '30min': '30m',
  M30: '30m',
  '1h': '1h',
  '60min': '1h',
  H1: '1h',
  '4h': '4h',
  H4: '4h',
  '1D': '1d',
  '1d': '1d',
  '1day': '1d',
  D1: '1d',
  '1W': '1w',
  '1w': '1w',
  '1week': '1w',
  W1: '1w',
  MN: '1M',
  '1M': '1M',
  '1month': '1M'
};

function normalizeInterval(interval) {
  const raw = String(interval || '1h').trim();
  return INTERVAL_ALIASES[raw] || INTERVAL_ALIASES[raw.toLowerCase()] || raw;
}

function refreshMsForInterval(interval) {
  return REFRESH_MS_BY_CANONICAL[normalizeInterval(interval)] || REFRESH_MS_BY_CANONICAL['1h'];
}

function cacheTtlSecondsForInterval(interval) {
  return Math.max(60, Math.ceil(refreshMsForInterval(interval) / 1000) * 2);
}

module.exports = {
  REFRESH_MS_BY_CANONICAL,
  normalizeInterval,
  refreshMsForInterval,
  cacheTtlSecondsForInterval
};
