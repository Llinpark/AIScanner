/**
 * Offline sanity check for TP-hit based WeightLearningService math (no Mongo).
 * Run: node backend/scripts/sanity-weight-learning.js
 */
const {
  computePerformanceWeights,
  describeWeightDelta,
  getDefaultPipelineWeights,
  getDefaultAiFactorWeights,
  tpCreditFromOutcome,
  isLearningOutcome,
  PIPELINE_KEYS,
  AI_FACTOR_KEYS
} = require('../services/WeightLearningService');
const { normalizeWeights } = require('../utils/pipelineScoring');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(tpCreditFromOutcome('tp1') === 1, 'tp1 credit');
assert(tpCreditFromOutcome('tp2') === 2, 'tp2 credit');
assert(tpCreditFromOutcome('tp3') === 3, 'tp3 credit');
assert(tpCreditFromOutcome('sl') === -1, 'sl credit');
assert(isLearningOutcome('tp2') && !isLearningOutcome('breakeven'), 'learning outcome filter');

const defaults = getDefaultPipelineWeights();
const events = [];

// TP3 hits on liquiditySweep/htfBias → strong positive
for (let i = 0; i < 20; i += 1) {
  events.push({
    activeKeys: ['liquiditySweep', 'htfBias'],
    outcome: 'tp3',
    outcomeR: 3
  });
}
// TP1-only partials on fvgRule → milder positive
for (let i = 0; i < 10; i += 1) {
  events.push({
    activeKeys: ['fvgRule'],
    outcome: 'tp1',
    outcomeR: 1
  });
}
// SL on expansionCandle → negative
for (let i = 0; i < 15; i += 1) {
  events.push({
    activeKeys: ['expansionCandle'],
    outcome: 'sl',
    outcomeR: -1
  });
}

const { weights, stats } = computePerformanceWeights(
  PIPELINE_KEYS,
  events,
  defaults,
  0.5,
  normalizeWeights
);

const weightSum = Object.values(weights).reduce((a, b) => a + b, 0);
assert(Math.abs(weightSum - 1) < 0.01, `pipeline weights must sum ~1, got ${weightSum}`);
assert(weights.liquiditySweep > defaults.liquiditySweep, 'TP3 factors should gain weight');
assert(weights.expansionCandle < defaults.expansionCandle, 'SL factors should lose weight');
assert(weights.liquiditySweep > weights.fvgRule, 'TP3 credit should outrank TP1-only credit');
assert(stats.liquiditySweep.tp3 === 20, 'tp3 hit count');
assert(stats.fvgRule.tp1 === 10, 'tp1 hit count');
assert(stats.expansionCandle.sl === 15, 'sl count');
assert(stats.liquiditySweep.avgTpCredit > stats.fvgRule.avgTpCredit, 'avg TP credit ordering');

const changes = describeWeightDelta(defaults, weights);
assert(changes.length > 0, 'expected weight deltas');

const aiDefaults = getDefaultAiFactorWeights();
assert(AI_FACTOR_KEYS.every(k => aiDefaults[k] > 0), 'ai defaults present');

console.log('WeightLearning TP-hit sanity OK');
console.log('Sample pipeline weights:', weights);
console.log('Top changes:', changes.slice(0, 3));
console.log('TP stats liquiditySweep:', stats.liquiditySweep);
