/**
 * @typedef {import('../types').Candle} Candle
 */

/**
 * Normalize provider / TV / hub candle shapes to a consistent Candle.
 * @param {Object} raw
 * @returns {Candle}
 */
function normalizeCandle(raw) {
  const timeRaw = raw.time ?? raw.t ?? raw.timestamp ?? Date.now();
  let time = typeof timeRaw === 'string' ? Date.parse(timeRaw) : Number(timeRaw);
  // Seconds → ms heuristic
  if (Number.isFinite(time) && time > 0 && time < 1e12) time *= 1000;

  return {
    time: Number.isFinite(time) ? time : Date.now(),
    open: Number(raw.open ?? raw.o),
    high: Number(raw.high ?? raw.h),
    low: Number(raw.low ?? raw.l),
    close: Number(raw.close ?? raw.c),
    volume: Number(raw.volume ?? raw.v ?? 0)
  };
}

/**
 * @param {Candle} candle
 */
function candleMetrics(candle) {
  const range = candle.high - candle.low;
  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const wickTotal = upperWick + lowerWick;
  const isBullish = candle.close >= candle.open;

  return {
    range,
    body,
    upperWick,
    lowerWick,
    bodyRatio: range > 0 ? body / range : 0,
    wickRatio: range > 0 ? wickTotal / range : 1,
    isBullish,
    // Distance of close from the extreme in the trade direction (0 = at extreme)
    closeNearHigh: range > 0 ? (candle.high - candle.close) / range : 1,
    closeNearLow: range > 0 ? (candle.close - candle.low) / range : 1
  };
}

/**
 * True range average (ATR proxy without Wilder smoothing — fast for streaming).
 * @param {Candle[]} candles
 * @param {number} [period=14]
 */
function atr(candles, period = 14) {
  if (!candles.length) return 0;
  const n = Math.min(period, candles.length);
  const slice = candles.slice(-n);
  let sum = 0;
  for (let i = 0; i < slice.length; i += 1) {
    const c = slice[i];
    const prev = i > 0 ? slice[i - 1] : c;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close)
    );
    sum += tr;
  }
  return sum / slice.length;
}

/**
 * @param {Candle[]} candles
 * @param {number} [lookback=14]
 */
function averageBody(candles, lookback = 14) {
  const slice = candles.slice(-lookback);
  if (!slice.length) return 0;
  return slice.reduce((s, c) => s + Math.abs(c.close - c.open), 0) / slice.length;
}

/**
 * Pip / point size heuristic matching existing scanner conventions.
 * @param {string} [symbol='']
 */
function getPipSize(symbol = '') {
  const s = String(symbol).toUpperCase();
  if (s.includes('JPY')) return 0.01;
  if (s.includes('XAU') || s.includes('GOLD')) return 0.1;
  if (s.includes('XAG') || s.includes('SILVER')) return 0.01;
  return 0.0001;
}

/**
 * @param {number} priceDistance
 * @param {string} symbol
 */
function toPips(priceDistance, symbol) {
  const pip = getPipSize(symbol);
  return pip > 0 ? Math.abs(priceDistance) / pip : 0;
}

/**
 * Incremental swing scan — only evaluates bars that can newly confirm.
 * Confirmed swing at i requires window bars on each side.
 * @param {Candle[]} candles
 * @param {number} [window=2]
 * @param {number} [fromIndex=0] - start scanning from this candle index
 */
function findSwingPoints(candles, window = 2, fromIndex = 0) {
  /** @type {import('../types').SwingPoint[]} */
  const swingLows = [];
  /** @type {import('../types').SwingPoint[]} */
  const swingHighs = [];

  const start = Math.max(window, fromIndex);
  const end = candles.length - window;

  for (let i = start; i < end; i += 1) {
    const low = candles[i].low;
    const high = candles[i].high;
    let isSwingLow = true;
    let isSwingHigh = true;

    for (let j = 1; j <= window; j += 1) {
      if (low > candles[i - j].low || low > candles[i + j].low) isSwingLow = false;
      if (high < candles[i - j].high || high < candles[i + j].high) isSwingHigh = false;
      if (!isSwingLow && !isSwingHigh) break;
    }

    if (isSwingLow) {
      swingLows.push({ index: i, price: low, time: candles[i].time, type: 'low' });
    }
    if (isSwingHigh) {
      swingHighs.push({ index: i, price: high, time: candles[i].time, type: 'high' });
    }
  }

  return { swingLows, swingHighs };
}

/**
 * Sideways / range compression: ATR vs longer-range ATR collapses.
 * @param {Candle[]} candles
 * @param {{ lookback?: number, ratioMax?: number, atrPeriod?: number }} cfg
 */
function isSidewaysMarket(candles, cfg = {}) {
  const lookback = cfg.lookback || 20;
  const ratioMax = cfg.ratioMax || 0.55;
  const period = cfg.atrPeriod || 14;
  if (candles.length < lookback + period) return false;

  const recent = atr(candles.slice(-lookback), period);
  const baseline = atr(candles.slice(-(lookback * 2)), Math.min(period * 2, candles.length));
  if (baseline <= 0) return false;
  return recent / baseline < ratioMax;
}

module.exports = {
  normalizeCandle,
  candleMetrics,
  atr,
  averageBody,
  getPipSize,
  toPips,
  findSwingPoints,
  isSidewaysMarket
};
