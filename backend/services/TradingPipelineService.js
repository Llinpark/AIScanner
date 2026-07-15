const { PATTERN_SCANNER_CONFIG } = require('../config/patternScanner');
const { sma } = require('../utils/technicalIndicators');
const { computeWeightedPipelineScore } = require('../utils/pipelineScoring');

const PIPELINE_STEPS = [
  'liquidityPools',
  'liquiditySweep',
  'marketStructureShift',
  'expansionCandle',
  'fvgRule',
  'fvgUnmitigated',
  'htfBias',
  'retracement',
  'entry',
  'slTp'
];

function candleMetrics(candle) {
  const range = candle.high - candle.low;
  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const wickTotal = upperWick + lowerWick;

  return {
    range,
    body,
    bodyRatio: range > 0 ? body / range : 0,
    wickRatio: range > 0 ? wickTotal / range : 1,
    isBullish: candle.close >= candle.open
  };
}

function averageRange(candles, lookback = 14) {
  const slice = candles.slice(-lookback);
  if (!slice.length) return 0;
  return slice.reduce((sum, c) => sum + (c.high - c.low), 0) / slice.length;
}

function getPipSize(symbol = '') {
  return String(symbol).toUpperCase().includes('JPY') ? 0.01 : 0.0001;
}

function findSwingPoints(candles, window = 2) {
  const swingLows = [];
  const swingHighs = [];

  for (let i = window; i < candles.length - window; i += 1) {
    const low = candles[i].low;
    const high = candles[i].high;
    let isSwingLow = true;
    let isSwingHigh = true;

    for (let j = 1; j <= window; j += 1) {
      if (low > candles[i - j].low || low > candles[i + j].low) isSwingLow = false;
      if (high < candles[i - j].high || high < candles[i + j].high) isSwingHigh = false;
    }

    if (isSwingLow) swingLows.push({ index: i, price: low });
    if (isSwingHigh) swingHighs.push({ index: i, price: high });
  }

  return { swingLows, swingHighs };
}

function stepLiquidityPools(candles, config) {
  const cfg = config.pipeline.liquidity;
  const minHistory = cfg.minHistoryBars || 8;
  if (candles.length < minHistory) {
    return { step: 1, key: 'liquidityPools', passed: false, reason: 'insufficient_history' };
  }

  const lookback = Math.min(cfg.lookbackBars || 24, candles.length);
  const slice = candles.slice(-lookback);
  const offset = candles.length - lookback;
  const { swingLows, swingHighs } = findSwingPoints(slice, cfg.swingWindow || 2);

  if (!swingLows.length || !swingHighs.length) {
    const minIdx = slice.reduce((best, c, i) => (c.low < slice[best].low ? i : best), 0);
    const maxIdx = slice.reduce((best, c, i) => (c.high > slice[best].high ? i : best), 0);
    if (!swingLows.length) swingLows.push({ index: minIdx, price: slice[minIdx].low });
    if (!swingHighs.length) swingHighs.push({ index: maxIdx, price: slice[maxIdx].high });
  }

  if (!swingLows.length || !swingHighs.length) {
    return { step: 1, key: 'liquidityPools', passed: false, reason: 'no_swing_points' };
  }

  const sellSide = swingLows[swingLows.length - 1];
  const buySide = swingHighs[swingHighs.length - 1];

  return {
    step: 1,
    key: 'liquidityPools',
    passed: true,
    data: {
      sellSide: { level: sellSide.price, index: offset + sellSide.index },
      buySide: { level: buySide.price, index: offset + buySide.index }
    }
  };
}

function stepLiquiditySweep(candles, pools, config) {
  const cfg = config.pipeline.liquidity;
  if (candles.length < 3) {
    return { step: 2, key: 'liquiditySweep', passed: false, reason: 'insufficient_history' };
  }

  const lookback = Math.min(cfg.lookbackBars || 24, candles.length);
  const history = candles.slice(-lookback);
  const offset = candles.length - lookback;
  let { swingLows, swingHighs } = findSwingPoints(history, cfg.swingWindow || 2);

  if (!swingLows.length && history.length) {
    const minIdx = history.reduce((best, c, i) => (c.low < history[best].low ? i : best), 0);
    swingLows = [{ index: minIdx, price: history[minIdx].low }];
  }
  if (!swingHighs.length && history.length) {
    const maxIdx = history.reduce((best, c, i) => (c.high > history[best].high ? i : best), 0);
    swingHighs = [{ index: maxIdx, price: history[maxIdx].high }];
  }

  for (let i = 1; i < candles.length; i += 1) {
    const probe = candles[i];

    for (const swing of swingLows) {
      const poolIndex = offset + swing.index;
      const level = swing.price;
      if (i <= poolIndex) continue;
      if (probe.low < level && probe.close > level) {
        return {
          step: 2,
          key: 'liquiditySweep',
          passed: true,
          data: {
            direction: 'long',
            sweepIndex: i,
            sweepLevel: level,
            sweepLow: probe.low,
            reclaimClose: probe.close,
            close: probe.close,
            poolType: 'sell_side',
            poolIndex
          }
        };
      }
    }

    for (const swing of swingHighs) {
      const poolIndex = offset + swing.index;
      const level = swing.price;
      if (i <= poolIndex) continue;
      if (probe.high > level && probe.close < level) {
        return {
          step: 2,
          key: 'liquiditySweep',
          passed: true,
          data: {
            direction: 'short',
            sweepIndex: i,
            sweepLevel: level,
            sweepHigh: probe.high,
            reclaimClose: probe.close,
            close: probe.close,
            poolType: 'buy_side',
            poolIndex
          }
        };
      }
    }
  }

  return { step: 2, key: 'liquiditySweep', passed: false, reason: 'no_sweep' };
}

function stepMarketStructureShift(candles, sweep, fvgEndIndex, config) {
  const cfg = config.pipeline.mss;
  const direction = sweep.direction;
  const lookback = cfg.structureLookbackBars || 20;
  const beforeSweep = candles.slice(Math.max(0, sweep.sweepIndex - lookback), sweep.sweepIndex);
  const afterSweep = candles.slice(sweep.sweepIndex, fvgEndIndex + 1);

  if (!beforeSweep.length || !afterSweep.length) {
    return { step: 3, key: 'marketStructureShift', passed: false, reason: 'insufficient_mss_window' };
  }

  if (direction === 'long') {
    const swingHigh = Math.max(...beforeSweep.map(c => c.high));
    for (let i = 0; i < afterSweep.length; i += 1) {
      if (afterSweep[i].close > swingHigh) {
        return {
          step: 3,
          key: 'marketStructureShift',
          passed: true,
          data: { breakLevel: swingHigh, breakIndex: sweep.sweepIndex + i, direction: 'long' }
        };
      }
    }
  } else {
    const swingLow = Math.min(...beforeSweep.map(c => c.low));
    for (let i = 0; i < afterSweep.length; i += 1) {
      if (afterSweep[i].close < swingLow) {
        return {
          step: 3,
          key: 'marketStructureShift',
          passed: true,
          data: { breakLevel: swingLow, breakIndex: sweep.sweepIndex + i, direction: 'short' }
        };
      }
    }
  }

  return { step: 3, key: 'marketStructureShift', passed: false, reason: 'no_structure_break' };
}

function stepExpansionCandle(candle, contextCandles, direction, config) {
  const cfg = config.pipeline.expansion;
  const metrics = candleMetrics(candle);
  const atr = averageRange(contextCandles);
  const long = direction === 'long';

  if (metrics.bodyRatio < (cfg.minBodyRatio || 0.58)) {
    return { step: 4, key: 'expansionCandle', passed: false, reason: 'weak_body' };
  }
  if (atr > 0 && metrics.range / atr < (cfg.minRangeToAtrRatio || 1.05)) {
    return { step: 4, key: 'expansionCandle', passed: false, reason: 'range_too_small' };
  }
  if (long && !metrics.isBullish) {
    return { step: 4, key: 'expansionCandle', passed: false, reason: 'not_bullish' };
  }
  if (!long && metrics.isBullish) {
    return { step: 4, key: 'expansionCandle', passed: false, reason: 'not_bearish' };
  }

  return { step: 4, key: 'expansionCandle', passed: true, data: { bodyRatio: metrics.bodyRatio } };
}

function stepFvgRule(c1, c2, c3, contextCandles, config) {
  const { detectPerfectFVG } = require('./PatternDetectionService');
  const fvg = detectPerfectFVG(c1, c2, c3, contextCandles, config);
  if (!fvg) {
    return { step: 5, key: 'fvgRule', passed: false, reason: 'no_valid_fvg' };
  }

  return {
    step: 5,
    key: 'fvgRule',
    passed: true,
    data: fvg
  };
}

function stepFvgUnmitigated(candles, fvg, fromIndex, toIndex) {
  if (fromIndex > toIndex) {
    return { step: 6, key: 'fvgUnmitigated', passed: true };
  }

  const gapBottom = fvg.gapBottom;
  const gapTop = fvg.gapTop;
  const long = fvg.direction === 'long';

  for (let i = fromIndex; i <= toIndex; i += 1) {
    const candle = candles[i];
    if (long && candle.low <= gapTop) {
      return { step: 6, key: 'fvgUnmitigated', passed: false, reason: 'gap_touched', index: i };
    }
    if (!long && candle.high >= gapBottom) {
      return { step: 6, key: 'fvgUnmitigated', passed: false, reason: 'gap_touched', index: i };
    }
  }

  return { step: 6, key: 'fvgUnmitigated', passed: true };
}

function stepHtfBias(htfCandles, direction, config) {
  const cfg = config.pipeline.htf;
  const long = direction === 'long';

  if (!htfCandles.length) {
    if (cfg.requireData) {
      return { step: 7, key: 'htfBias', passed: false, reason: 'htf_data_missing' };
    }
    return { step: 7, key: 'htfBias', passed: true, data: { note: 'htf_unavailable_skipped' } };
  }

  const closes = htfCandles.map(c => Number(c.close));
  const smaPeriod = cfg.smaPeriod || 20;
  const smaValue = sma(closes, smaPeriod);
  const current = closes[closes.length - 1];

  if (smaValue == null) {
    return { step: 7, key: 'htfBias', passed: false, reason: 'htf_sma_insufficient' };
  }

  const trendAligned = long ? current > smaValue : current < smaValue;
  if (!trendAligned) {
    return { step: 7, key: 'htfBias', passed: false, reason: 'htf_trend_misaligned' };
  }

  if (cfg.requireStructure && htfCandles.length >= 6) {
    const recent = htfCandles.slice(-6);
    const structureOk = long
      ? recent[recent.length - 1].close >= recent[0].close
      : recent[recent.length - 1].close <= recent[0].close;
    if (!structureOk) {
      return { step: 7, key: 'htfBias', passed: false, reason: 'htf_structure_misaligned' };
    }
  }

  return {
    step: 7,
    key: 'htfBias',
    passed: true,
    data: { timeframe: cfg.timeframe || '4h', sma: smaValue, close: current }
  };
}

function stepRetracement(candle, fvg, direction, config) {
  const cfg = config.pipeline.retracement;
  const gapBottom = fvg.gapBottom;
  const gapTop = fvg.gapTop;
  const gapMid = (gapBottom + gapTop) / 2;
  const long = direction === 'long';

  if (long) {
    const touched = candle.low <= gapTop && candle.low >= gapBottom;
    const reaction =
      candle.close >= gapMid ||
      (candle.close > candle.open && candle.close > fvg.candles.c3.close * (1 - (cfg.minReactionRatio || 0.0005)));
    return {
      step: 8,
      key: 'retracement',
      passed: touched && reaction,
      data: { touchPrice: candle.low, gapMid }
    };
  }

  const touched = candle.high >= gapBottom && candle.high <= gapTop;
  const reaction =
    candle.close <= gapMid ||
    (candle.close < candle.open && candle.close < fvg.candles.c3.close * (1 + (cfg.minReactionRatio || 0.0005)));
  return {
    step: 8,
    key: 'retracement',
    passed: touched && reaction,
    data: { touchPrice: candle.high, gapMid }
  };
}

function roundPrice(value, symbol = '') {
  const decimals = String(symbol).toUpperCase().includes('JPY') ? 3 : 5;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function stepEntryAndSlTp({ fvg, sweep, direction, symbol, retrace }, config) {
  const riskCfg = config.risk;
  const pipelineRisk = config.pipeline.risk;
  const long = direction === 'long';
  const entryMode = riskCfg.entryMode || 'gap_mid';

  const entry =
    entryMode === 'gap_mid'
      ? (fvg.gapTop + fvg.gapBottom) / 2
      : retrace?.data?.touchPrice ?? (fvg.gapTop + fvg.gapBottom) / 2;

  const pip = getPipSize(symbol);
  const slBufferPips = pipelineRisk.slBufferPips ?? 5;

  let stop_loss;
  if (long) {
    const anchor = sweep.sweepLow ?? fvg.gapBottom;
    stop_loss = anchor - slBufferPips * pip;
  } else {
    const anchor = sweep.sweepHigh ?? fvg.gapTop;
    stop_loss = anchor + slBufferPips * pip;
  }

  const risk = Math.abs(entry - stop_loss);
  if (risk <= 0) {
    return { step: 9, key: 'entry', passed: false, reason: 'invalid_risk' };
  }

  const tpSign = long ? 1 : -1;
  const [r1, r2, r3] = riskCfg.tpRatios || [1, 2, 3];

  const levels = {
    entry: roundPrice(entry, symbol),
    stop_loss: roundPrice(stop_loss, symbol),
    stop_loss_1: roundPrice(stop_loss, symbol),
    take_profit_1: roundPrice(entry + tpSign * risk * r1, symbol),
    take_profit_2: roundPrice(entry + tpSign * risk * r2, symbol),
    take_profit_3: roundPrice(entry + tpSign * risk * r3, symbol)
  };

  return {
    step: 9,
    key: 'entry',
    passed: true,
    data: levels,
    slTp: { step: 10, key: 'slTp', passed: true, data: levels }
  };
}

function buildPipelineNotes(steps, levels, direction, scoring) {
  const side = direction.toUpperCase();
  return [
    'Premium SMC Pipeline Entry',
    `${side} @ ${levels.entry}`,
    `SL ${levels.stop_loss}`,
    `TP1 ${levels.take_profit_1} | TP2 ${levels.take_profit_2} | TP3 ${levels.take_profit_3}`,
    `Pipeline score: ${scoring.scorePercent}% (threshold ${scoring.threshold}%)`
  ].join(' | ');
}

function finalizePipelineEntry(context) {
  const {
    steps,
    levels,
    direction,
    fvg,
    config,
    candles,
    symbol,
    fvgEndIndex,
    sweep,
    mss,
    expansion
  } = context;

  const scoring = computeWeightedPipelineScore({
    steps,
    fvg,
    sweep,
    mss,
    expansion,
    candles,
    fvgEndIndex,
    config
  });

  if (!scoring.isPremium) {
    return {
      passed: false,
      stage: 'below_premium_threshold',
      pipelineScore: scoring.scorePercent,
      pipelineScoreBreakdown: scoring.breakdown,
      steps
    };
  }

  return {
    passed: true,
    stage: 'entry',
    entry: {
      pattern: 'smc_pipeline',
      patternLabel: 'Premium SMC Pipeline Signal',
      direction,
      alertType: 'entry',
      gapTop: fvg.gapTop,
      gapBottom: fvg.gapBottom,
      gapSize: fvg.gapSize,
      confidence: scoring.scorePercent / 100,
      pipelineScore: scoring.scorePercent,
      pipelineScoreBreakdown: scoring.breakdown,
      pipelineSteps: steps,
      pipelineVersion: 2,
      signalQuality: 'premium',
      isPremiumSignal: true,
      ...levels,
      notes: buildPipelineNotes(steps, levels, direction, scoring)
    },
    pipelineScore: scoring.scorePercent,
    pipelineScoreBreakdown: scoring.breakdown
  };
}

function evaluateFvgCandidate(candles, fvgEndIndex, options = {}) {
  const config = options.config || PATTERN_SCANNER_CONFIG;
  const htfCandles = options.htfCandles || [];
  const symbol = options.symbol || '';
  const requireRetracement = options.requireRetracement !== false;

  if (fvgEndIndex < 2 || fvgEndIndex >= candles.length) {
    return null;
  }

  const c1 = candles[fvgEndIndex - 2];
  const c2 = candles[fvgEndIndex - 1];
  const c3 = candles[fvgEndIndex];
  const context = candles.slice(0, fvgEndIndex + 1);
  const steps = [];

  const poolsStep = stepLiquidityPools(context.slice(0, fvgEndIndex - 2), config);
  steps.push(poolsStep);
  if (!poolsStep.passed) return { steps, passed: false };

  const sweepStep = stepLiquiditySweep(context.slice(0, fvgEndIndex), poolsStep.data, config);
  steps.push(sweepStep);
  if (!sweepStep.passed) return { steps, passed: false };

  const direction = sweepStep.data.direction;
  if (sweepStep.data.sweepIndex >= fvgEndIndex - 2) {
    steps.push({
      step: 2,
      key: 'liquiditySweep',
      passed: false,
      reason: 'sweep_must_precede_fvg'
    });
    return { steps, passed: false };
  }

  const mssStep = stepMarketStructureShift(context, sweepStep.data, fvgEndIndex, config);
  steps.push(mssStep);
  if (!mssStep.passed) return { steps, passed: false };

  const expansionStep = stepExpansionCandle(c2, context, direction, config);
  steps.push(expansionStep);
  if (!expansionStep.passed) return { steps, passed: false };

  const fvgStep = stepFvgRule(c1, c2, c3, context, config);
  steps.push(fvgStep);
  if (!fvgStep.passed) return { steps, passed: false };

  if (fvgStep.data.direction !== direction) {
    steps.push({ step: 5, key: 'fvgRule', passed: false, reason: 'fvg_direction_mismatch' });
    return { steps, passed: false };
  }

  const lastIndex = candles.length - 1;
  const unmitigatedStep = stepFvgUnmitigated(candles, fvgStep.data, fvgEndIndex + 1, lastIndex - 1);
  steps.push(unmitigatedStep);
  if (!unmitigatedStep.passed) return { steps, passed: false };

  const htfStep = stepHtfBias(htfCandles, direction, config);
  steps.push(htfStep);
  if (!htfStep.passed) return { steps, passed: false };

  const retraceStep = stepRetracement(candles[lastIndex], fvgStep.data, direction, config);
  steps.push(retraceStep);

  if (!retraceStep.passed) {
    if (requireRetracement) {
      return {
        steps,
        passed: false,
        stage: 'pending_retrace',
        pending: {
          symbol,
          direction,
          fvgEndIndex,
          fvg: fvgStep.data,
          sweep: sweepStep.data,
          pools: poolsStep.data,
          mss: mssStep.data,
          expansion: expansionStep.data,
          createdAt: candles[fvgEndIndex].time,
          expiresAfterBars: config.pipeline.retracement.maxWaitBars || 12
        }
      };
    }
    return { steps, passed: false };
  }

  const entryStep = stepEntryAndSlTp(
    { fvg: fvgStep.data, sweep: sweepStep.data, direction, symbol, retrace: retraceStep },
    config
  );
  steps.push(entryStep);
  steps.push(entryStep.slTp);

  if (!entryStep.passed) {
    return { steps, passed: false };
  }

  const fvg = fvgStep.data;
  const levels = entryStep.data;

  return finalizePipelineEntry({
    steps,
    levels,
    direction,
    fvg,
    config,
    candles,
    symbol,
    fvgEndIndex,
    sweep: sweepStep.data,
    mss: mssStep.data,
    expansion: expansionStep.data
  });
}

function runPipeline(candles, options = {}) {
  const config = options.config || PATTERN_SCANNER_CONFIG;
  const minBars = config.pipeline?.minBars || 30;

  if (!config.pipeline?.enabled) {
    return { stage: 'none', reason: 'pipeline_disabled' };
  }

  if (candles.length < minBars) {
    return { stage: 'none', reason: 'insufficient_candles', required: minBars };
  }

  const lastIndex = candles.length - 1;
  const lookback = config.pipeline.fvgLookbackBars || 20;
  const start = Math.max(2, lastIndex - lookback);
  let bestPending = null;

  for (let fvgEnd = start; fvgEnd < lastIndex; fvgEnd += 1) {
    const result = evaluateFvgCandidate(candles, fvgEnd, options);
    if (!result) continue;

    if (result.passed && result.stage === 'entry') {
      return result;
    }

    if (result.stage === 'below_premium_threshold') {
      continue;
    }

    if (result.stage === 'pending_retrace' && result.pending) {
      if (!bestPending || result.pending.fvgEndIndex > bestPending.fvgEndIndex) {
        bestPending = result;
      }
    }
  }

  if (bestPending) {
    return bestPending;
  }

  return { stage: 'none', steps: [] };
}

function checkPendingRetracement(candles, pending, options = {}) {
  const config = options.config || PATTERN_SCANNER_CONFIG;
  const htfCandles = options.htfCandles || [];
  const symbol = options.symbol || pending.symbol || '';
  const lastIndex = candles.length - 1;
  const barsSince = lastIndex - pending.fvgEndIndex;

  if (barsSince > (pending.expiresAfterBars || 12)) {
    return { expired: true };
  }

  const unmitigatedStep = stepFvgUnmitigated(candles, pending.fvg, pending.fvgEndIndex + 1, lastIndex - 1);
  if (!unmitigatedStep.passed) {
    return { expired: true, reason: 'fvg_mitigated' };
  }

  const htfStep = stepHtfBias(htfCandles, pending.direction, config);
  if (!htfStep.passed) {
    return { stage: 'none', reason: 'htf_bias_lost' };
  }

  const retraceStep = stepRetracement(candles[lastIndex], pending.fvg, pending.direction, config);
  if (!retraceStep.passed) {
    return { stage: 'pending_retrace', pending };
  }

  const entryStep = stepEntryAndSlTp(
    {
      fvg: pending.fvg,
      sweep: pending.sweep,
      direction: pending.direction,
      symbol,
      retrace: retraceStep
    },
    config
  );

  if (!entryStep.passed) {
    return { stage: 'none', reason: 'entry_calc_failed' };
  }

  const steps = [
    { step: 1, key: 'liquidityPools', passed: true, data: pending.pools },
    { step: 2, key: 'liquiditySweep', passed: true, data: pending.sweep },
    { step: 3, key: 'marketStructureShift', passed: true, data: pending.mss },
    { step: 4, key: 'expansionCandle', passed: true, data: pending.expansion },
    { step: 5, key: 'fvgRule', passed: true, data: pending.fvg },
    { step: 6, key: 'fvgUnmitigated', passed: true },
    htfStep,
    retraceStep,
    entryStep,
    entryStep.slTp
  ];

  const levels = entryStep.data;

  return finalizePipelineEntry({
    steps,
    levels,
    direction: pending.direction,
    fvg: pending.fvg,
    config,
    candles,
    symbol,
    fvgEndIndex: pending.fvgEndIndex,
    sweep: pending.sweep,
    mss: pending.mss,
    expansion: pending.expansion
  });
}

module.exports = {
  PIPELINE_STEPS,
  runPipeline,
  checkPendingRetracement,
  evaluateFvgCandidate,
  stepLiquidityPools,
  stepLiquiditySweep,
  stepMarketStructureShift,
  stepExpansionCandle,
  stepFvgRule,
  stepFvgUnmitigated,
  stepHtfBias,
  stepRetracement,
  finalizePipelineEntry
};
