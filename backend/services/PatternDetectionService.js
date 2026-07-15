const { PATTERN_SCANNER_CONFIG } = require('../config/patternScanner');
const TradingPipelineService = require('./TradingPipelineService');

function normalizeCandle(raw) {
  return {
    time: raw.time || raw.t || Date.now(),
    open: Number(raw.open ?? raw.o),
    high: Number(raw.high ?? raw.h),
    low: Number(raw.low ?? raw.l),
    close: Number(raw.close ?? raw.c),
    volume: Number(raw.volume ?? raw.v ?? 0)
  };
}

function candleMetrics(candle) {
  const range = candle.high - candle.low;
  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const wickTotal = upperWick + lowerWick;

  return {
    range,
    body,
    upperWick,
    lowerWick,
    bodyRatio: range > 0 ? body / range : 0,
    wickRatio: range > 0 ? wickTotal / range : 1,
    isBullish: candle.close >= candle.open
  };
}

function averageVolume(candles, lookback = 20) {
  const slice = candles.slice(-lookback);
  if (!slice.length) return 0;
  return slice.reduce((sum, c) => sum + (c.volume || 0), 0) / slice.length;
}

function averageRange(candles, lookback = 14) {
  const slice = candles.slice(-lookback);
  if (!slice.length) return 0;
  return slice.reduce((sum, c) => sum + (c.high - c.low), 0) / slice.length;
}

/**
 * Pattern A: Perfect Fair Value Gap (3-candle sequence: c1 oldest → c3 newest)
 */
function detectPerfectFVG(c1, c2, c3, candles, config = PATTERN_SCANNER_CONFIG) {
  const fvgCfg = config.fvg;
  const bullish = c1.high < c3.low;
  const bearish = c1.low > c3.high;

  if (!bullish && !bearish) {
    return null;
  }

  const direction = bullish ? 'long' : 'short';
  const gapBottom = bullish ? c1.high : c3.high;
  const gapTop = bullish ? c3.low : c1.low;
  const gapSize = gapTop - gapBottom;

  if (gapSize <= 0) {
    return null;
  }

  const m2 = candleMetrics(c2);
  if (m2.bodyRatio < fvgCfg.minDisplacementBodyRatio) {
    return null;
  }
  if (m2.wickRatio > fvgCfg.maxWickToRangeRatio) {
    return null;
  }

  const avgVol = averageVolume(candles);
  if (avgVol > 0 && c2.volume < avgVol * fvgCfg.volumeMultiplier) {
    return null;
  }

  const atr = averageRange(candles);
  if (atr > 0 && gapSize / atr < fvgCfg.minGapToAtrRatio) {
    return null;
  }

  const displacementAligned =
    (bullish && m2.isBullish) || (!bullish && !m2.isBullish);
  if (!displacementAligned) {
    return null;
  }

  let confidence = 0.72;
  if (m2.bodyRatio >= 0.75) confidence += 0.08;
  if (avgVol > 0 && c2.volume >= avgVol * (fvgCfg.volumeMultiplier + 0.25)) confidence += 0.06;
  if (atr > 0 && gapSize / atr >= fvgCfg.minGapToAtrRatio * 1.5) confidence += 0.06;
  confidence = Math.min(confidence, 0.96);

  return {
    pattern: 'perfect_fvg',
    patternLabel: 'Pattern A: Perfect Fair Value Gap',
    direction,
    alertType: 'entry',
    gapTop,
    gapBottom,
    gapSize,
    confidence,
    candles: { c1, c2, c3 }
  };
}

/**
 * Pattern B stage 1: displacement + gap (c1 → c2). Confirmation waits for c3.
 */
function detectBreakawaySetup(c1, c2, config = PATTERN_SCANNER_CONFIG) {
  const cfg = config.breakaway;
  const m1 = candleMetrics(c1);

  if (m1.bodyRatio < cfg.minC1BodyRatio) {
    return null;
  }

  const c1Range = c1.high - c1.low;
  if (c1Range <= 0) {
    return null;
  }

  const bullishGap = c2.open > c1.high && (cfg.requireCleanGap ? c2.low > c1.high : c2.close > c1.high);
  const bearishGap = c2.open < c1.low && (cfg.requireCleanGap ? c2.high < c1.low : c2.close < c1.low);

  if (!bullishGap && !bearishGap) {
    return null;
  }

  const direction = bullishGap ? 'long' : 'short';
  const gapSize = bullishGap ? c2.low - c1.high : c1.low - c2.high;

  if (gapSize / c1Range < cfg.minGapToC1RangeRatio) {
    return null;
  }

  return {
    pattern: 'breakaway_gap',
    stage: 'pending',
    direction,
    c1,
    c2,
    gapSize,
    createdAt: c2.time
  };
}

/**
 * Pattern B stage 2: c3 close confirms breakout direction
 */
function confirmBreakawayGap(pending, c3, config = PATTERN_SCANNER_CONFIG) {
  if (!pending || pending.stage !== 'pending') {
    return null;
  }

  const { direction, c1, c2 } = pending;
  let confirmed = false;

  if (direction === 'long') {
    confirmed = c3.close > c2.open && c3.close > c1.high && c3.close >= c3.open;
  } else {
    confirmed = c3.close < c2.open && c3.close < c1.low && c3.close <= c3.open;
  }

  if (!confirmed) {
    return null;
  }

  const gapBottom = direction === 'long' ? c1.high : c3.high;
  const gapTop = direction === 'long' ? c3.low : c1.low;

  return {
    pattern: 'breakaway_gap',
    patternLabel: 'Pattern B: Breakaway Gap (C3 confirmed)',
    direction,
    alertType: 'entry',
    gapTop: direction === 'long' ? Math.max(c2.open, c3.high) : c1.low,
    gapBottom: direction === 'long' ? c1.high : Math.min(c2.open, c3.low),
    gapSize: pending.gapSize,
    confidence: 0.78,
    candles: { c1, c2, c3 }
  };
}

function getPipSize(symbol = '') {
  return String(symbol).toUpperCase().includes('JPY') ? 0.01 : 0.0001;
}

function buildTradeInstructions(detection, config = PATTERN_SCANNER_CONFIG) {
  const { direction, gapTop, gapBottom, candles, symbol } = detection;
  const c3 = candles?.c3;
  const riskCfg = config.risk;

  const entry =
    riskCfg.entryMode === 'gap_mid'
      ? (gapTop + gapBottom) / 2
      : c3?.close ?? (gapTop + gapBottom) / 2;

  const pip = getPipSize(symbol);
  const slPips = riskCfg.slPips || 30;
  const slSign = direction === 'long' ? -1 : 1;

  const stop_loss = entry + slSign * slPips * pip;

  const risk = Math.abs(entry - stop_loss);
  if (risk <= 0) {
    return null;
  }

  const tpSign = direction === 'long' ? 1 : -1;
  const [r1, r2, r3] = riskCfg.tpRatios;

  return {
    entry: roundPrice(entry),
    stop_loss: roundPrice(stop_loss),
    stop_loss_1: roundPrice(stop_loss),
    take_profit_1: roundPrice(entry + tpSign * risk * r1),
    take_profit_2: roundPrice(entry + tpSign * risk * r2),
    take_profit_3: roundPrice(entry + tpSign * risk * r3),
    riskReward: { r1, r2, r3 }
  };
}

function roundPrice(value, decimals = 5) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function buildActionableNotes(detection, levels) {
  const side = detection.direction.toUpperCase();
  return [
    `${detection.patternLabel}`,
    `${side} Kaching Entry @ ${levels.entry}`,
    `Kaching SL ${levels.stop_loss}`,
    `Kaching TP1 ${levels.take_profit_1} | Kaching TP2 ${levels.take_profit_2} | Kaching TP3 ${levels.take_profit_3}`,
    `Gap zone: ${detection.gapBottom} – ${detection.gapTop}`
  ].join(' | ');
}

function scanLastCandles(candles, config = PATTERN_SCANNER_CONFIG, symbol = '', options = {}) {
  if (config.pipeline?.enabled === false) {
    return legacyScanLastCandles(candles, config, symbol);
  }

  const pipelineResult = TradingPipelineService.runPipeline(candles, {
    config,
    symbol,
    htfCandles: options.htfCandles || []
  });

  if (pipelineResult.passed && pipelineResult.stage === 'entry') {
    return {
      entry: { ...pipelineResult.entry, symbol },
      pending: null,
      pipeline: pipelineResult
    };
  }

  if (pipelineResult.stage === 'pending_retrace' && pipelineResult.pending) {
    return {
      entry: null,
      pending: { ...pipelineResult.pending, symbol },
      pipeline: pipelineResult
    };
  }

  if (pipelineResult.stage === 'below_premium_threshold') {
    return {
      entry: null,
      pending: null,
      stage: 'below_premium_threshold',
      pipelineScore: pipelineResult.pipelineScore,
      pipelineScoreBreakdown: pipelineResult.pipelineScoreBreakdown,
      pipeline: pipelineResult
    };
  }

  return { entry: null, pending: null, pipeline: pipelineResult };
}

function legacyScanLastCandles(candles, config = PATTERN_SCANNER_CONFIG, symbol = '') {
  if (candles.length < 3) {
    return { entry: null, pending: null };
  }

  const len = candles.length;
  const c1 = candles[len - 3];
  const c2 = candles[len - 2];
  const c3 = candles[len - 1];

  const fvg = detectPerfectFVG(c1, c2, c3, candles, config);
  if (fvg) {
    const levels = buildTradeInstructions({ ...fvg, symbol }, config);
    if (levels) {
      return {
        entry: {
          ...fvg,
          ...levels,
          notes: buildActionableNotes(fvg, levels)
        },
        pending: null
      };
    }
  }

  const breakawaySetup = detectBreakawaySetup(c1, c2, config);
  if (breakawaySetup) {
    const confirmed = confirmBreakawayGap(
      { ...breakawaySetup, stage: 'pending' },
      c3,
      config
    );
    if (confirmed) {
      const levels = buildTradeInstructions({ ...confirmed, symbol }, config);
      if (levels) {
        return {
          entry: {
            ...confirmed,
            ...levels,
            notes: buildActionableNotes(confirmed, levels)
          },
          pending: null
        };
      }
    }
  }

  return { entry: null, pending: null };
}

module.exports = {
  normalizeCandle,
  candleMetrics,
  detectPerfectFVG,
  detectBreakawaySetup,
  confirmBreakawayGap,
  buildTradeInstructions,
  buildActionableNotes,
  scanLastCandles,
  getPipSize,
  averageVolume,
  averageRange
};
