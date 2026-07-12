const PatternDetectionService = require('../services/PatternDetectionService');

const base = 1.085;

const bullishFVG = [
  { time: 1, open: base - 0.001, high: base - 0.0004, low: base - 0.0012, close: base - 0.0007, volume: 850000 },
  { time: 2, open: base - 0.0002, high: base + 0.0038, low: base - 0.0001, close: base + 0.0035, volume: 1650000 },
  { time: 3, open: base + 0.0028, high: base + 0.0042, low: base + 0.0025, close: base + 0.0039, volume: 1200000 }
];

const breakaway = [
  { time: 1, open: base, high: base + 0.001, low: base - 0.0002, close: base + 0.0009, volume: 900000 },
  { time: 2, open: base + 0.0015, high: base + 0.0025, low: base + 0.0012, close: base + 0.0022, volume: 1100000 },
  { time: 3, open: base + 0.002, high: base + 0.0035, low: base + 0.0018, close: base + 0.0032, volume: 1000000 }
];

const fvgResult = PatternDetectionService.scanLastCandles(bullishFVG);
const breakResult = PatternDetectionService.scanLastCandles(breakaway);

console.log('FVG detection:', fvgResult.entry ? fvgResult.entry.pattern : 'none');
console.log('Breakaway detection:', breakResult.entry ? breakResult.entry.pattern : 'none');

if (!fvgResult.entry || fvgResult.entry.pattern !== 'perfect_fvg') {
  console.error('FAIL: expected perfect_fvg');
  process.exit(1);
}

if (!breakResult.entry || breakResult.entry.pattern !== 'breakaway_gap') {
  console.error('FAIL: expected breakaway_gap');
  process.exit(1);
}

console.log('OK: structural patterns verified');
console.log('Sample entry:', breakResult.entry.entry, 'SL:', breakResult.entry.stop_loss);
