export function toChartTime(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

export function normalizeCandles(candles = []) {
  return candles
    .map(candle => {
      const time = toChartTime(candle.time ?? candle.timestamp);
      if (!time) return null;
      return {
        time,
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close)
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);
}

function isLongDirection(direction) {
  const d = String(direction || '').toLowerCase();
  return d === 'long' || d === 'buy';
}

function candleMetrics(candle) {
  const range = candle.high - candle.low;
  const body = Math.abs(candle.close - candle.open);
  return {
    bodyRatio: range > 0 ? body / range : 0,
    isBullish: candle.close >= candle.open
  };
}

function toMs(time) {
  const value = Number(time);
  if (!Number.isFinite(value)) return Date.now();
  return value > 1e12 ? value : value * 1000;
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

  return {
    top: Math.max(top, bottom),
    bottom: Math.min(top, bottom),
    timeStart: toMs(obCandle.time),
    timeEnd: toMs(candles[candles.length - 1]?.time)
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

  const createdAt = signal.createdAt ? Date.parse(signal.createdAt) : Date.now();
  return {
    top: Math.max(top, bottom),
    bottom: Math.min(top, bottom),
    timeStart: createdAt - 3 * 3600000,
    timeEnd: createdAt + 3600000
  };
}

function resolveZoneTimes(zone, candles, intervalSeconds) {
  if (!zone) return null;
  const lastTime = candles[candles.length - 1]?.time;
  const start = toChartTime(zone.timeStart) || (lastTime ? lastTime - intervalSeconds * 8 : null);
  const end = toChartTime(zone.timeEnd) || (lastTime ? lastTime + intervalSeconds : null);
  if (!start || !end) return null;
  return {
    ...zone,
    chartTimeStart: Math.min(start, end),
    chartTimeEnd: Math.max(start, end) + intervalSeconds
  };
}

export function buildChartZones(signal, candles = [], intervalSeconds = 3600) {
  if (!signal) return { fvg: null, orderBlock: null, liquidity: null };

  const normalized = normalizeCandles(candles);
  const direction = signal.direction;

  const stored = signal.chartZones || {};
  const fvgRaw =
    stored.fvg ||
    (signal.gapTop != null && signal.gapBottom != null ? buildFvgZone(signal, normalized) : null);

  const orderBlockRaw =
    stored.orderBlock ||
    (signal.orderBlockTop != null && signal.orderBlockBottom != null
      ? {
          top: Number(signal.orderBlockTop),
          bottom: Number(signal.orderBlockBottom),
          timeStart: signal.orderBlockTimeStart,
          timeEnd: signal.orderBlockTimeEnd
        }
      : detectOrderBlock(normalized, direction));

  const liquidityRaw =
    stored.liquidity ||
    (signal.liquidityZoneTop != null && signal.liquidityZoneBottom != null
      ? {
          top: Number(signal.liquidityZoneTop),
          bottom: Number(signal.liquidityZoneBottom),
          timeStart: signal.liquidityTimeStart,
          timeEnd: signal.liquidityTimeEnd
        }
      : detectLiquidityZone(normalized, direction));

  return {
    fvg: resolveZoneTimes(fvgRaw, normalized, intervalSeconds),
    orderBlock: resolveZoneTimes(orderBlockRaw, normalized, intervalSeconds),
    liquidity: resolveZoneTimes(liquidityRaw, normalized, intervalSeconds)
  };
}

export function buildChartOverlay(signal, candles = [], interval = '1h') {
  if (!signal) return null;

  const entry = Number(signal.entry);
  const stopLoss = Number(signal.stop_loss_1 ?? signal.stop_loss);
  const tp1 = Number(signal.take_profit_1);
  const tp2 = Number(signal.take_profit_2);
  const tp3 = Number(signal.take_profit_3);

  if (!Number.isFinite(entry)) return null;

  const intervalSeconds = intervalToSeconds(interval);
  const zones = buildChartZones(signal, candles, intervalSeconds);

  return {
    direction: String(signal.direction || 'long').toLowerCase(),
    entry,
    stopLoss,
    tp1,
    tp2,
    tp3,
    pattern: signal.pattern || null,
    patternLabel: signal.patternLabel || signal.pattern_label || null,
    alertType: signal.alertType || 'entry',
    createdAt: signal.createdAt || null,
    zones
  };
}

export function buildOverlayFromSignal(signal, candles = [], interval = '1h') {
  return buildChartOverlay(signal, candles, interval);
}

export function findLatestEntrySignal(signals = [], symbol) {
  const normalized = String(symbol || '').toUpperCase();
  return signals.find(signal => {
    const signalSymbol = String(signal.symbol || '').toUpperCase().replace(/\s/g, '');
    const targetSymbol = normalized.replace(/\s/g, '');
    const sameSymbol =
      signalSymbol === targetSymbol ||
      signalSymbol.replace('/', '') === targetSymbol.replace('/', '');
    const alertType = signal.alertType || 'signal';
    return sameSymbol && (alertType === 'entry' || alertType === 'signal');
  });
}

export function symbolsMatch(a, b) {
  const left = String(a || '').toUpperCase().replace(/\s/g, '');
  const right = String(b || '').toUpperCase().replace(/\s/g, '');
  if (!left || !right) return false;
  return left === right || left.replace('/', '') === right.replace('/', '');
}

export function intervalToSeconds(interval) {
  const map = {
    '1m': 60,
    '1min': 60,
    '5m': 300,
    '5min': 300,
    '15m': 900,
    '15min': 900,
    '30m': 1800,
    '30min': 1800,
    '1h': 3600,
    '60min': 3600,
    '4h': 14400,
    '1D': 86400,
    '1day': 86400
  };
  return map[String(interval || '1h')] || 3600;
}
