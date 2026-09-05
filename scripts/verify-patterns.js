const PatternDetectionService = require('../services/PatternDetectionService');
const { PATTERN_SCANNER_CONFIG } = require('../config/patternScanner');

function candle(time, open, high, low, close, volume = 1_000_000) {
  return { time, open, high, low, close, volume };
}

function buildBullishPipelineFixture() {
  const candles = [];
  let t = 1;
  const push = (o, h, l, c, v = 1_000_000) => candles.push(candle(t++, o, h, l, c, v));

  push(1.086, 1.0864, 1.0856, 1.0861);
  push(1.0862, 1.0866, 1.0858, 1.0863);
  push(1.0864, 1.0868, 1.0859, 1.0865);
  push(1.0858, 1.0862, 1.085, 1.0853);
  push(1.0852, 1.0856, 1.0844, 1.0847);
  push(1.0846, 1.085, 1.0839, 1.0842);
  push(1.084, 1.0844, 1.0836, 1.0839);
  push(1.0838, 1.0842, 1.0832, 1.0835);
  push(1.0834, 1.0838, 1.0828, 1.0831);
  push(1.083, 1.0834, 1.0826, 1.0829);

  const poolLow = 1.0826;
  push(1.0832, 1.0836, poolLow, 1.0833);
  push(1.0834, 1.0838, 1.0829, 1.0836);

  push(1.0835, 1.084, 1.0824, 1.0839, 1_500_000);

  push(1.084, 1.0848, 1.0838, 1.0846);
  push(1.0846, 1.0856, 1.0844, 1.0854);
  push(1.0854, 1.0866, 1.0852, 1.0862);
  push(1.0862, 1.0874, 1.086, 1.0871);

  const c1High = 1.0842;
  push(1.0838, c1High, 1.0834, 1.0839);
  push(1.0844, 1.0882, 1.0843, 1.0878, 2_000_000);
  push(1.0876, 1.0892, 1.0874, 1.0889);

  push(1.089, 1.0896, 1.0888, 1.0893);
  push(1.0893, 1.09, 1.0891, 1.0897);
  push(1.0897, 1.0904, 1.0895, 1.0901);
  push(1.0901, 1.0908, 1.09, 1.0905);
  push(1.0905, 1.0912, 1.0903, 1.0909);

  push(1.0908, 1.091, 1.08732, 1.08775, 1_200_000);

  return candles;
}

function padHistory(candles, target = 25) {
  const padded = [...candles];
  while (padded.length < target) {
    const first = padded[0];
    padded.unshift({
      time: first.time - 1,
      open: first.open + 0.0002,
      high: first.high + 0.0002,
      low: first.low + 0.0002,
      close: first.close + 0.0002,
      volume: 900000
    });
  }
  return padded;
}

const rawFvgOnly = padHistory([
  { time: 100, open: 1.084, high: 1.0846, low: 1.0838, close: 1.0843, volume: 850000 },
  { time: 101, open: 1.0848, high: 1.0886, low: 1.0849, close: 1.0883, volume: 1650000 },
  { time: 102, open: 1.0878, high: 1.0892, low: 1.0875, close: 1.0889, volume: 1200000 }
]);

const pipelineCandles = buildBullishPipelineFixture();
const htfCandles = Array.from({ length: 30 }, (_, index) => {
  const base = 1.08 + index * 0.00025;
  return {
    time: index + 1,
    open: base,
    high: base + 0.0008,
    low: base - 0.0004,
    close: base + 0.0005,
    volume: 900_000
  };
});

const fvgOnlyResult = PatternDetectionService.scanLastCandles(rawFvgOnly, PATTERN_SCANNER_CONFIG, 'EUR/USD');
const pipelineResult = PatternDetectionService.scanLastCandles(pipelineCandles, PATTERN_SCANNER_CONFIG, 'EUR/USD', {
  htfCandles
});

console.log('FVG-only (should NOT entry):', fvgOnlyResult.entry ? fvgOnlyResult.entry.pattern : 'none');
console.log('Pipeline fixture:', pipelineResult.entry ? pipelineResult.entry.pattern : pipelineResult.pending ? 'pending' : 'none');

if (fvgOnlyResult.entry) {
  console.error('FAIL: bare FVG must not emit without full SMC pipeline');
  process.exit(1);
}

if (!pipelineResult.entry || pipelineResult.entry.pattern !== 'smc_pipeline') {
  console.error('FAIL: expected smc_pipeline entry from fixture');
  if (pipelineResult.pipeline?.pipelineScoreBreakdown) {
    console.error('Score breakdown:', pipelineResult.pipeline.pipelineScoreBreakdown);
  }
  process.exit(1);
}

const premiumThreshold = PATTERN_SCANNER_CONFIG.pipeline?.scoring?.premiumThreshold || 90;

if ((pipelineResult.entry.pipelineScore || 0) < premiumThreshold) {
  console.error(`FAIL: expected premium score >= ${premiumThreshold}%, got`, pipelineResult.entry.pipelineScore);
  console.error('Breakdown:', pipelineResult.entry.pipelineScoreBreakdown);
  process.exit(1);
}

console.log('OK: SMC pipeline verified');
console.log('Entry:', pipelineResult.entry.entry, 'SL:', pipelineResult.entry.stop_loss);
console.log('Premium score:', pipelineResult.entry.pipelineScore + '%');
