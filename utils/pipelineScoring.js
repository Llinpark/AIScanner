const DEFAULT_WEIGHTS = {
  liquiditySweep: 0.28,
  fvgRule: 0.18,
  expansionCandle: 0.06,
  htfBias: 0.24,
  fvgUnmitigated: 0.14,
  marketStructureShift: 0.1
};

function averageRange(candles, lookback = 14) {
  const slice = candles.slice(-lookback);
  if (!slice.length) return 0;
  return slice.reduce((sum, c) => sum + (c.high - c.low), 0) / slice.length;
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function normalizeWeights(weights = DEFAULT_WEIGHTS) {
  const entries = Object.entries({ ...DEFAULT_WEIGHTS, ...weights });
  const total = entries.reduce((sum, [, w]) => sum + Number(w), 0);
  if (total <= 0) return { ...DEFAULT_WEIGHTS };
  return Object.fromEntries(entries.map(([key, w]) => [key, Number(w) / total]));
}

function scoreLiquiditySweep(sweepStep, config) {
  if (!sweepStep?.passed || !sweepStep.data) return 0;

  const data = sweepStep.data;
  const long = data.direction === 'long';
  const level = data.sweepLevel;

  if (long) {
    const sweepDepth = level - (data.sweepLow ?? level);
    const reclaim = data.reclaimClose ?? data.close;
    const reclaimDepth = reclaim != null ? reclaim - level : 0;
    const depthScore = sweepDepth > 0 ? clamp(reclaimDepth / sweepDepth, 0, 1) : 0.75;
    return clamp(0.55 + depthScore * 0.45, 0, 1);
  }

  const sweepDepth = (data.sweepHigh ?? level) - level;
  const reclaim = data.reclaimClose ?? data.close;
  const reclaimDepth = reclaim != null ? level - reclaim : 0;
  const depthScore = sweepDepth > 0 ? clamp(reclaimDepth / sweepDepth, 0, 1) : 0.75;
  return clamp(0.55 + depthScore * 0.45, 0, 1);
}

function scoreFvgRule(fvgStep) {
  if (!fvgStep?.passed || !fvgStep.data) return 0;
  const fvg = fvgStep.data;
  const base = Number(fvg.confidence || 0.72);
  return clamp((base - 0.65) / 0.31, 0, 1);
}

function scoreExpansionCandle(expansionStep, config) {
  if (!expansionStep?.passed) return 0;
  const minBody = config.pipeline?.expansion?.minBodyRatio || 0.58;
  const idealBody = config.pipeline?.scoring?.expansionIdealBodyRatio || 0.82;
  const bodyRatio = expansionStep.data?.bodyRatio ?? minBody;
  return clamp((bodyRatio - minBody) / (idealBody - minBody), 0, 1);
}

function scoreHtfBias(htfStep) {
  if (!htfStep?.passed) return 0;
  if (htfStep.data?.note === 'htf_unavailable_skipped') return 0.75;
  const sma = Number(htfStep.data?.sma);
  const close = Number(htfStep.data?.close);
  if (!Number.isFinite(sma) || !Number.isFinite(close) || sma === 0) return 0.75;
  const distance = Math.abs(close - sma) / sma;
  return clamp(0.7 + distance * 100, 0, 1);
}

function scoreFvgUnmitigated(unmitigatedStep, candles, fvg, fvgEndIndex) {
  if (!unmitigatedStep?.passed || !fvg) return 0;

  const gapBottom = fvg.gapBottom;
  const gapTop = fvg.gapTop;
  const gapSize = Math.max(gapTop - gapBottom, 0.00001);
  const long = fvg.direction === 'long';
  const fromIndex = fvgEndIndex + 1;
  const toIndex = candles.length - 2;

  if (fromIndex > toIndex) return 1;

  let minDistance = Infinity;
  for (let i = fromIndex; i <= toIndex; i += 1) {
    const candle = candles[i];
    const distance = long ? candle.low - gapTop : gapBottom - candle.high;
    minDistance = Math.min(minDistance, distance);
  }

  if (!Number.isFinite(minDistance)) return 1;
  const proximityScore = clamp(minDistance / gapSize, 0, 1);
  return clamp(0.72 + proximityScore * 0.28, 0, 1);
}

function scoreMarketStructureShift(mssStep, candles, config) {
  if (!mssStep?.passed || !mssStep.data) return 0;

  const breakIndex = mssStep.data.breakIndex;
  const breakLevel = mssStep.data.breakLevel;
  const direction = mssStep.data.direction;
  const candle = candles[breakIndex];
  if (!candle) return 0.75;

  const atr = averageRange(candles.slice(0, breakIndex + 1));
  if (atr <= 0) return 0.75;

  const breakDistance =
    direction === 'long' ? candle.close - breakLevel : breakLevel - candle.close;
  return clamp(breakDistance / (atr * 0.35), 0, 1);
}

function computeWeightedPipelineScore(context) {
  const {
    steps = [],
    fvg,
    sweep,
    mss,
    expansion,
    candles = [],
    fvgEndIndex = 0,
    config = {}
  } = context;

  const weights = normalizeWeights(config.pipeline?.scoring?.weights);
  const stepByKey = key => steps.find(step => step.key === key);

  const sweepStep = stepByKey('liquiditySweep') || (sweep ? { passed: true, data: sweep } : null);
  const mssStep = stepByKey('marketStructureShift') || (mss ? { passed: true, data: mss } : null);
  const fvgStep = stepByKey('fvgRule') || (fvg ? { passed: true, data: fvg } : null);
  const expansionStep =
    stepByKey('expansionCandle') || (expansion ? { passed: true, data: expansion } : null);
  const htfStep = stepByKey('htfBias');
  const unmitigatedStep = stepByKey('fvgUnmitigated');

  const factorScores = {
    liquiditySweep: scoreLiquiditySweep(sweepStep, config),
    fvgRule: scoreFvgRule(fvgStep),
    expansionCandle: scoreExpansionCandle(expansionStep, config),
    htfBias: scoreHtfBias(htfStep),
    fvgUnmitigated: scoreFvgUnmitigated(unmitigatedStep, candles, fvg, fvgEndIndex),
    marketStructureShift: scoreMarketStructureShift(mssStep, candles, config)
  };

  const breakdown = Object.entries(weights).map(([key, weight]) => {
    const factorScore = factorScores[key] ?? 0;
    const weighted = factorScore * weight;
    return {
      key,
      label: formatFactorLabel(key),
      weight: Math.round(weight * 100),
      factorScore: Math.round(factorScore * 100),
      weightedScore: Math.round(weighted * 100)
    };
  });

  const score = breakdown.reduce((sum, item) => sum + item.weightedScore / 100, 0);
  const scorePercent = Math.round(score * 100);
  const threshold = Number(config.pipeline?.scoring?.premiumThreshold ?? 90);

  return {
    score,
    scorePercent,
    threshold,
    isPremium: scorePercent >= threshold,
    breakdown,
    factorScores
  };
}

function formatFactorLabel(key) {
  const labels = {
    liquiditySweep: 'Liquidity sweep occurred',
    fvgRule: 'Valid three-candle FVG',
    expansionCandle: 'Expansion candle strength',
    htfBias: 'Higher timeframe alignment',
    fvgUnmitigated: 'FVG still unmitigated',
    marketStructureShift: 'Market structure shift'
  };
  return labels[key] || key;
}

module.exports = {
  DEFAULT_WEIGHTS,
  computeWeightedPipelineScore,
  normalizeWeights
};
