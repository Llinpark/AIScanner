const { candleMetrics } = require('../services/PatternDetectionService');

function isLongDirection(direction) {
  const d = String(direction || '').toLowerCase();
  return d === 'long' || d === 'buy';
}

function normalizeCandles(candles = []) {
  return candles
    .map(c => ({
      time: c.time || c.t || Date.now(),
      open: Number(c.open ?? c.o),
      high: Number(c.high ?? c.h),
      low: Number(c.low ?? c.l),
      close: Number(c.close ?? c.c),
      volume: Number(c.volume ?? c.v ?? 0)
    }))
    .filter(c => Number.isFinite(c.close))
    .sort((a, b) => a.time - b.time);
}

function toMs(time) {
  const value = Number(time);
  if (!Number.isFinite(value)) return Date.now();
  return value > 1e12 ? value : value * 1000;
}

function zoneTimeRange(candles, startIndex, endIndex) {
  if (!candles.length) return { timeStart: null, timeEnd: null };
  const start = candles[Math.max(0, startIndex)];
  const end = candles[Math.min(candles.length - 1, endIndex)];
  return {
    timeStart: toMs(start?.time),
    timeEnd: toMs(end?.time)
  };
}

function detectOrderBlock(candles, direction) {
  const long = isLongDirection(direction);
  if (candles.length < 4) return null;

  const search = candles.slice(-12, -1);
  let obCandle = null;
  let obIndex = -1;

  for (let i = search.length - 1; i >= 0; i -= 1) {
    const candle = search[i];
    const metrics = candleMetrics(candle);
    if (long && !metrics.isBullish && metrics.bodyRatio >= 0.35) {
      obCandle = candle;
      obIndex = candles.length - search.length + i;
      break;
    }
    if (!long && metrics.isBullish && metrics.bodyRatio >= 0.35) {
      obCandle = candle;
      obIndex = candles.length - search.length + i;
      break;
    }
  }

  if (!obCandle) return null;

  const top = long ? Number(obCandle.open) : Number(obCandle.high);
  const bottom = long ? Number(obCandle.low) : Number(obCandle.open);
  const { timeStart } = zoneTimeRange(candles, obIndex, obIndex);
  const { timeEnd } = zoneTimeRange(candles, candles.length - 1, candles.length - 1);

  return {
    top: Math.max(top, bottom),
    bottom: Math.min(top, bottom),
    timeStart,
    timeEnd
  };
}

function detectLiquidityZone(candles, direction) {
  const long = isLongDirection(direction);
  if (candles.length < 8) return null;

  const prior = candles.slice(-8, -2);
  const probe = candles[candles.length - 2];
  const swingLow = Math.min(...prior.map(c => c.low));
  const swingHigh = Math.max(...prior.map(c => c.high));
  const buffer = Math.max((swingHigh - swingLow) * 0.08, Math.abs(probe.close) * 0.00015);

  if (long) {
    const swept = probe.low < swingLow;
    if (!swept) return null;
    return {
      top: swingLow + buffer,
      bottom: swingLow - buffer,
      timeStart: toMs(prior[0]?.time),
      timeEnd: toMs(candles[candles.length - 1]?.time)
    };
  }

  const swept = probe.high > swingHigh;
  if (!swept) return null;
  return {
    top: swingHigh + buffer,
    bottom: swingHigh - buffer,
    timeStart: toMs(prior[0]?.time),
    timeEnd: toMs(candles[candles.length - 1]?.time)
  };
}

function buildFvgZone(signal, candles) {
  const top = Number(signal.gapTop);
  const bottom = Number(signal.gapBottom);
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return null;

  if (candles.length >= 3) {
    const c1 = candles[candles.length - 3];
    const c3 = candles[candles.length - 1];
    return {
      top: Math.max(top, bottom),
      bottom: Math.min(top, bottom),
      timeStart: toMs(c1.time),
      timeEnd: toMs(c3.time)
    };
  }

  const now = Date.now();
  return {
    top: Math.max(top, bottom),
    bottom: Math.min(top, bottom),
    timeStart: signal.createdAt ? Date.parse(signal.createdAt) : now - 3 * 3600000,
    timeEnd: signal.createdAt ? Date.parse(signal.createdAt) + 3600000 : now
  };
}

function buildChartZones(signal, rawCandles = []) {
  const candles = normalizeCandles(rawCandles);
  const direction = signal?.direction;

  const fvg =
    signal?.chartZones?.fvg ||
    (signal?.gapTop != null && signal?.gapBottom != null ? buildFvgZone(signal, candles) : null);

  const orderBlock =
    signal?.chartZones?.orderBlock ||
    (signal?.orderBlockTop != null && signal?.orderBlockBottom != null
      ? {
          top: Number(signal.orderBlockTop),
          bottom: Number(signal.orderBlockBottom),
          timeStart: signal.orderBlockTimeStart || null,
          timeEnd: signal.orderBlockTimeEnd || null
        }
      : detectOrderBlock(candles, direction));

  const liquidity =
    signal?.chartZones?.liquidity ||
    (signal?.liquidityZoneTop != null && signal?.liquidityZoneBottom != null
      ? {
          top: Number(signal.liquidityZoneTop),
          bottom: Number(signal.liquidityZoneBottom),
          timeStart: signal.liquidityTimeStart || null,
          timeEnd: signal.liquidityTimeEnd || null
        }
      : detectLiquidityZone(candles, direction));

  return { fvg, orderBlock, liquidity };
}

function flattenChartZonesForStorage(chartZones) {
  if (!chartZones) return {};
  const patch = {};
  if (chartZones.fvg) {
    patch.gapTop = chartZones.fvg.top;
    patch.gapBottom = chartZones.fvg.bottom;
    patch.fvgTimeStart = chartZones.fvg.timeStart;
    patch.fvgTimeEnd = chartZones.fvg.timeEnd;
  }
  if (chartZones.orderBlock) {
    patch.orderBlockTop = chartZones.orderBlock.top;
    patch.orderBlockBottom = chartZones.orderBlock.bottom;
    patch.orderBlockTimeStart = chartZones.orderBlock.timeStart;
    patch.orderBlockTimeEnd = chartZones.orderBlock.timeEnd;
  }
  if (chartZones.liquidity) {
    patch.liquidityZoneTop = chartZones.liquidity.top;
    patch.liquidityZoneBottom = chartZones.liquidity.bottom;
    patch.liquidityTimeStart = chartZones.liquidity.timeStart;
    patch.liquidityTimeEnd = chartZones.liquidity.timeEnd;
  }
  return patch;
}

module.exports = {
  buildChartZones,
  flattenChartZonesForStorage,
  detectOrderBlock,
  detectLiquidityZone,
  buildFvgZone
};
