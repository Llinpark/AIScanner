const { detectPerfectFVG, candleMetrics } = require('../services/PatternDetectionService');
const { computeRsi, sma } = require('./technicalIndicators');

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
    .filter(c => Number.isFinite(c.close));
}

function detectFvgFactor(signal, candles) {
  const long = isLongDirection(signal.direction);

  if (signal.pattern === 'perfect_fvg' || signal.pattern === 'smc_pipeline') {
    return {
      key: 'fvg',
      confirmed: true,
      label: long ? 'Bullish Fair Value Gap detected' : 'Bearish Fair Value Gap detected'
    };
  }

  if (candles.length >= 3) {
    const len = candles.length;
    const detected = detectPerfectFVG(candles[len - 3], candles[len - 2], candles[len - 1], candles);
    if (detected) {
      const matches = long ? detected.direction === 'long' : detected.direction === 'short';
      if (matches) {
        return {
          key: 'fvg',
          confirmed: true,
          label: long ? 'Bullish Fair Value Gap detected' : 'Bearish Fair Value Gap detected'
        };
      }
    }
  }

  return {
    key: 'fvg',
    confirmed: false,
    label: long ? 'Bullish Fair Value Gap not detected' : 'Bearish Fair Value Gap not detected'
  };
}

function detectLiquiditySweep(candles, direction) {
  const long = isLongDirection(direction);
  if (candles.length < 8) {
    return {
      key: 'liquiditySweep',
      confirmed: false,
      label: 'Liquidity sweep not confirmed'
    };
  }

  const prior = candles.slice(-8, -2);
  const probe = candles[candles.length - 2];
  const confirm = candles[candles.length - 1];

  if (long) {
    const swingLow = findSwingLow(prior);
    const swept = probe.low < swingLow && probe.close > swingLow;
    const reclaimed = confirm.close > confirm.open && confirm.close > probe.close;
    const confirmed = swept && reclaimed;
    return {
      key: 'liquiditySweep',
      confirmed,
      label: confirmed ? 'Liquidity sweep confirmed' : 'Liquidity sweep not confirmed'
    };
  }

  const swingHigh = findSwingHigh(prior);
  const swept = probe.high > swingHigh && probe.close < swingHigh;
  const reclaimed = confirm.close < confirm.open && confirm.close < probe.close;
  const confirmed = swept && reclaimed;
  return {
    key: 'liquiditySweep',
    confirmed,
    label: confirmed ? 'Liquidity sweep confirmed' : 'Liquidity sweep not confirmed'
  };
}

function findSwingLow(candles) {
  return Math.min(...candles.map(c => c.low));
}

function findSwingHigh(candles) {
  return Math.max(...candles.map(c => c.high));
}

function detectEngulfing(candles, direction) {
  const long = isLongDirection(direction);
  if (candles.length < 2) {
    return {
      key: 'engulfing',
      confirmed: false,
      label: long ? 'Bullish engulfing not confirmed' : 'Bearish engulfing not confirmed'
    };
  }

  const prev = candles[candles.length - 2];
  const curr = candles[candles.length - 1];
  const prevM = candleMetrics(prev);
  const currM = candleMetrics(curr);

  if (long) {
    const confirmed =
      !prevM.isBullish &&
      currM.isBullish &&
      curr.open <= prev.close &&
      curr.close >= prev.open &&
      currM.body > prevM.body * 1.05;
    return {
      key: 'engulfing',
      confirmed,
      label: confirmed ? 'Strong bullish engulfing candle' : 'Bullish engulfing not confirmed'
    };
  }

  const confirmed =
    prevM.isBullish &&
    !currM.isBullish &&
    curr.open >= prev.close &&
    curr.close <= prev.open &&
    currM.body > prevM.body * 1.05;
  return {
    key: 'engulfing',
    confirmed,
    label: confirmed ? 'Strong bearish engulfing candle' : 'Bearish engulfing not confirmed'
  };
}

function detectRsiFactor(candles, direction, threshold = 60) {
  const rsi = computeRsi(candles, 14);
  const long = isLongDirection(direction);

  if (rsi == null) {
    return {
      key: 'rsi',
      confirmed: false,
      value: null,
      label: 'RSI data insufficient'
    };
  }

  const confirmed = long ? rsi >= threshold : rsi <= 100 - threshold;
  return {
    key: 'rsi',
    confirmed,
    value: Number(rsi.toFixed(1)),
    label: long
      ? confirmed
        ? `RSI above ${threshold}`
        : `RSI below ${threshold}`
      : confirmed
        ? `RSI below ${100 - threshold}`
        : `RSI above ${100 - threshold}`
  };
}

function detectTrendAlignment(candles, direction, timeframe = '1h') {
  const long = isLongDirection(direction);
  if (candles.length < 21) {
    return {
      key: 'trendAlignment',
      confirmed: false,
      timeframe,
      label: `Trend not aligned with the ${timeframe} timeframe`
    };
  }

  const closes = candles.map(c => c.close);
  const sma20 = sma(closes, 20);
  const sma5 = sma(closes.slice(-5), 5);
  const current = closes[closes.length - 1];
  const prior = closes[closes.length - 6];

  if (sma20 == null || sma5 == null) {
    return {
      key: 'trendAlignment',
      confirmed: false,
      timeframe,
      label: `Trend not aligned with the ${timeframe} timeframe`
    };
  }

  const confirmed = long
    ? current > sma20 && sma5 >= sma20 && current > prior
    : current < sma20 && sma5 <= sma20 && current < prior;

  return {
    key: 'trendAlignment',
    confirmed,
    timeframe,
    label: confirmed
      ? `Trend aligned with the ${timeframe} timeframe`
      : `Trend not aligned with the ${timeframe} timeframe`
  };
}

function computeAiConfidence(items, baseConfidence = 0.5) {
  const weights = {
    fvg: 0.22,
    liquiditySweep: 0.18,
    engulfing: 0.15,
    rsi: 0.15,
    trendAlignment: 0.15
  };

  let score = Number(baseConfidence || 0.5) * 0.15;
  for (const item of items) {
    if (item.confirmed) {
      score += weights[item.key] || 0.1;
    }
  }

  return Math.min(Math.max(Math.round(score * 100), 48), 96);
}

function analyzeSignalFactors(signal, rawCandles = [], options = {}) {
  const candles = normalizeCandles(rawCandles);
  const timeframe = options.timeframe || signal.timeframe || '1h';
  const rsiThreshold = Number(options.rsiThreshold || 60);

  const items = [
    detectFvgFactor(signal, candles),
    detectLiquiditySweep(candles, signal.direction),
    detectEngulfing(candles, signal.direction),
    detectRsiFactor(candles, signal.direction, rsiThreshold),
    detectTrendAlignment(candles, signal.direction, timeframe)
  ];

  const confidence = computeAiConfidence(items, signal.confidence);
  const confirmedCount = items.filter(item => item.confirmed).length;

  return {
    items,
    confidence,
    confirmedCount,
    timeframe,
    generatedAt: new Date().toISOString()
  };
}

module.exports = {
  analyzeSignalFactors,
  isLongDirection,
  normalizeCandles
};
