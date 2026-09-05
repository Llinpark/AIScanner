/** Shared chart helpers — price series only (no trade/SMC overlay builders). */

export function toChartTime(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

export function normalizeCandles(candles = []) {
  const byTime = new Map();

  for (const candle of candles) {
    const time = toChartTime(candle.time ?? candle.timestamp);
    if (!time) continue;
    const open = Number(candle.open);
    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);
    if (![open, high, low, close].every(Number.isFinite)) continue;
    const rawVolume = Number(candle.volume ?? candle.v ?? 0);
    const volume = Number.isFinite(rawVolume) && rawVolume > 0 ? rawVolume : 0;
    byTime.set(time, { time, open, high, low, close, volume });
  }

  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export function symbolsMatch(a, b) {
  const left = String(a || '').toUpperCase().replace(/\s/g, '');
  const right = String(b || '').toUpperCase().replace(/\s/g, '');
  if (!left || !right) return false;
  return left === right || left.replace('/', '') === right.replace('/', '');
}

export function normalizeInterval(interval) {
  const aliases = {
    '1m': '1m',
    '1min': '1m',
    M1: '1m',
    '3m': '3m',
    '3min': '3m',
    M3: '3m',
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
    W1: '1w',
    MN: '1M',
    '1M': '1M'
  };
  const raw = String(interval || '1h').trim();
  return aliases[raw] || aliases[raw.toLowerCase()] || raw;
}
