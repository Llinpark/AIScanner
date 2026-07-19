const mongoose = require('mongoose');
const Signal = require('../models/Signal');
const LearnedWeights = require('../models/LearnedWeights');
const { DEFAULT_WEIGHTS, normalizeWeights } = require('../utils/pipelineScoring');
const { applyScannerConfig, getScannerConfig } = require('../utils/scannerRuntimeConfig');
const { OUTCOME_R } = require('../utils/signalOutcome');

const PIPELINE_KEYS = [
  'liquiditySweep',
  'fvgRule',
  'expansionCandle',
  'htfBias',
  'fvgUnmitigated',
  'marketStructureShift'
];

const DEFAULT_AI_FACTOR_WEIGHTS = {
  fvg: 0.22,
  liquiditySweep: 0.18,
  engulfing: 0.15,
  rsi: 0.15,
  trendAlignment: 0.15
};

const AI_FACTOR_KEYS = Object.keys(DEFAULT_AI_FACTOR_WEIGHTS);

/** Closed outcomes used for learning: TP hits (positive) and SL (negative). */
const LEARNING_OUTCOMES = new Set(['tp1', 'tp2', 'tp3', 'sl']);
const TP_OUTCOMES = new Set(['tp1', 'tp2', 'tp3']);

const MIN_SAMPLES = Math.max(5, parseInt(process.env.LEARNING_MIN_SAMPLES, 10) || 20);
const LEARNING_RATE = Math.min(
  0.85,
  Math.max(0.05, Number(process.env.LEARNING_RATE || 0.35))
);
const FACTOR_ACTIVE_THRESHOLD = Math.min(
  90,
  Math.max(20, parseInt(process.env.LEARNING_FACTOR_ACTIVE_THRESHOLD, 10) || 50)
);
const RETRAIN_INTERVAL_MS = parseInt(process.env.LEARNING_RETRAIN_INTERVAL_MS, 10) || 0;
const OUTCOME_DEBOUNCE_MS = Math.max(
  5_000,
  parseInt(process.env.LEARNING_OUTCOME_DEBOUNCE_MS, 10) || 60_000
);

let cachedPipelineWeights = null;
let cachedAiFactorWeights = null;
let lastStatus = {
  lastRunAt: null,
  lastResult: null,
  lastError: null,
  applied: false
};
let retrainTimer = null;
let outcomeDebounceTimer = null;
let retrainInFlight = false;

function isDbReady() {
  return mongoose.connection.readyState === 1;
}

function getDefaultPipelineWeights() {
  return normalizeWeights(DEFAULT_WEIGHTS);
}

function getDefaultAiFactorWeights() {
  return { ...DEFAULT_AI_FACTOR_WEIGHTS };
}

function getPipelineWeights() {
  return cachedPipelineWeights ? { ...cachedPipelineWeights } : getDefaultPipelineWeights();
}

function getAiFactorWeights() {
  return cachedAiFactorWeights ? { ...cachedAiFactorWeights } : getDefaultAiFactorWeights();
}

function normalizeAiWeights(weights = DEFAULT_AI_FACTOR_WEIGHTS) {
  const merged = { ...DEFAULT_AI_FACTOR_WEIGHTS, ...weights };
  const entries = AI_FACTOR_KEYS.map(key => [key, Number(merged[key]) || 0]);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  // Preserve default total mass (~0.85) so confidence scale stays comparable.
  const targetTotal = Object.values(DEFAULT_AI_FACTOR_WEIGHTS).reduce((sum, w) => sum + w, 0);
  if (total <= 0) return getDefaultAiFactorWeights();
  return Object.fromEntries(entries.map(([key, w]) => [key, (w / total) * targetTotal]));
}

function roundWeights(weights, digits = 4) {
  return Object.fromEntries(
    Object.entries(weights).map(([key, value]) => [key, Number(Number(value).toFixed(digits))])
  );
}

function isLearningOutcome(outcome) {
  return LEARNING_OUTCOMES.has(String(outcome || ''));
}

/**
 * Primary learning label: TP1/TP2/TP3 credit by strategy R-multiple, SL = -1.
 * Higher TP levels reached (TP2/TP3) earn more positive credit than TP1 alone.
 */
function tpCreditFromOutcome(outcome, outcomeR) {
  const key = String(outcome || '');
  if (Object.prototype.hasOwnProperty.call(OUTCOME_R, key)) {
    return Number(OUTCOME_R[key]);
  }
  const fallback = Number(outcomeR);
  return Number.isFinite(fallback) ? fallback : 0;
}

function extractPipelineFactorScores(signal) {
  const breakdown = Array.isArray(signal.pipelineScoreBreakdown)
    ? signal.pipelineScoreBreakdown
    : [];
  if (!breakdown.length) return null;

  const scores = {};
  for (const item of breakdown) {
    if (!item?.key || !PIPELINE_KEYS.includes(item.key)) continue;
    const score = Number(item.factorScore);
    if (Number.isFinite(score)) scores[item.key] = score;
  }
  return Object.keys(scores).length ? scores : null;
}

function extractAiFactorPresence(signal) {
  const items = signal.aiFactors?.items;
  if (!Array.isArray(items) || !items.length) return null;

  const presence = {};
  for (const item of items) {
    if (!item?.key || !AI_FACTOR_KEYS.includes(item.key)) continue;
    presence[item.key] = Boolean(item.confirmed);
  }
  return Object.keys(presence).length ? presence : null;
}

/**
 * TP-hit based weights: credit by which TP was reached (tp1=1R, tp2=2R, tp3=3R),
 * SL = -1R. Blended toward defaults and normalized. Active factors only.
 */
function computePerformanceWeights(keys, factorEvents, defaults, learningRate, normalizeFn) {
  const stats = {};
  for (const key of keys) {
    stats[key] = {
      samples: 0,
      tp1: 0,
      tp2: 0,
      tp3: 0,
      sl: 0,
      sumTpCredit: 0,
      avgTpCredit: 0,
      tpHitRate: null
    };
  }

  for (const event of factorEvents) {
    const { activeKeys, outcome, outcomeR } = event;
    if (!isLearningOutcome(outcome)) continue;
    const credit = tpCreditFromOutcome(outcome, outcomeR);
    for (const key of activeKeys) {
      if (!stats[key]) continue;
      stats[key].samples += 1;
      stats[key].sumTpCredit += credit;
      if (outcome === 'tp1') stats[key].tp1 += 1;
      else if (outcome === 'tp2') stats[key].tp2 += 1;
      else if (outcome === 'tp3') stats[key].tp3 += 1;
      else if (outcome === 'sl') stats[key].sl += 1;
    }
  }

  const rawScores = {};
  for (const key of keys) {
    const s = stats[key];
    if (s.samples > 0) {
      s.avgTpCredit = s.sumTpCredit / s.samples;
      const tpHits = s.tp1 + s.tp2 + s.tp3;
      s.tpHitRate = tpHits / s.samples;
    }

    // Primary signal: average TP credit (higher TP levels weigh more). Floor keeps factors alive.
    const avgTpCredit = s.samples > 0 ? s.avgTpCredit : 0;
    const tpHitBoost = s.tpHitRate == null ? 0.5 : s.tpHitRate;
    rawScores[key] = Math.max(0.05, 0.35 + avgTpCredit * 0.22 + tpHitBoost * 0.25);
  }

  const scoreTotal = keys.reduce((sum, key) => sum + rawScores[key], 0) || 1;
  const performanceWeights = Object.fromEntries(
    keys.map(key => [key, rawScores[key] / scoreTotal])
  );

  const blended = {};
  for (const key of keys) {
    const prior = Number(defaults[key]) || 0;
    blended[key] = (1 - learningRate) * prior + learningRate * performanceWeights[key];
  }

  const normalized = normalizeFn(blended);
  return { weights: roundWeights(normalized), stats, performanceWeights: roundWeights(performanceWeights) };
}

async function loadClosedSignals(limit = 2000) {
  if (!isDbReady()) return [];

  // Train only on TP hits and SL failures (skip pending / breakeven).
  return Signal.find({
    alertType: { $in: ['entry', 'signal'] },
    outcome: { $in: ['tp1', 'tp2', 'tp3', 'sl'] },
    outcomeR: { $ne: null }
  })
    .sort({ closedAt: -1, createdAt: -1 })
    .limit(limit)
    .select(
      'outcome outcomeR pattern pipelineScoreBreakdown aiFactors closedAt createdAt tradeStatus'
    )
    .lean();
}

async function getLatestVersion(kind) {
  if (!isDbReady()) return 0;
  const latest = await LearnedWeights.findOne({ kind }).sort({ version: -1 }).select('version').lean();
  return latest?.version || 0;
}

async function persistLearnedWeights({ kind, weights, previousWeights, sampleCount, factorStats, notes }) {
  const version = (await getLatestVersion(kind)) + 1;
  const doc = await LearnedWeights.create({
    kind,
    version,
    weights,
    previousWeights,
    sampleCount,
    factorStats,
    learningRate: LEARNING_RATE,
    notes: notes || null,
    createdAt: new Date()
  });
  return doc;
}

function describeWeightDelta(previous, next) {
  const keys = new Set([...Object.keys(previous || {}), ...Object.keys(next || {})]);
  const changes = [];
  for (const key of keys) {
    const before = Number(previous?.[key]);
    const after = Number(next?.[key]);
    if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
    const delta = after - before;
    if (Math.abs(delta) < 0.0005) continue;
    changes.push({
      key,
      from: Number(before.toFixed(4)),
      to: Number(after.toFixed(4)),
      delta: Number(delta.toFixed(4))
    });
  }
  return changes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

async function retrainPipelineWeights(signals) {
  const events = [];
  for (const signal of signals) {
    const scores = extractPipelineFactorScores(signal);
    if (!scores) continue;
    const activeKeys = PIPELINE_KEYS.filter(key => (scores[key] ?? 0) >= FACTOR_ACTIVE_THRESHOLD);
    if (!activeKeys.length) continue;
    events.push({
      activeKeys,
      outcome: signal.outcome,
      outcomeR: Number(signal.outcomeR) || 0
    });
  }

  if (events.length < MIN_SAMPLES) {
    return {
      kind: 'pipeline',
      skipped: true,
      reason: `insufficient_samples`,
      sampleCount: events.length,
      minSamples: MIN_SAMPLES,
      weights: getPipelineWeights()
    };
  }

  const previous = getScannerConfig().weights || getDefaultPipelineWeights();
  const { weights, stats, performanceWeights } = computePerformanceWeights(
    PIPELINE_KEYS,
    events,
    previous,
    LEARNING_RATE,
    normalizeWeights
  );

  cachedPipelineWeights = weights;
  applyScannerConfig({ weights });

  let saved = null;
  try {
    saved = await persistLearnedWeights({
      kind: 'pipeline',
      weights,
      previousWeights: previous,
      sampleCount: events.length,
      factorStats: { stats, performanceWeights },
      notes: 'pipeline_retrain'
    });
  } catch (error) {
    console.error('[WeightLearning] Failed to persist pipeline weights:', error.message);
  }

  const changes = describeWeightDelta(previous, weights);
  console.log(
    `[WeightLearning] Pipeline weights updated (n=${events.length}, v=${saved?.version || 'mem'}):`,
    changes.length ? changes.map(c => `${c.key} ${c.from}->${c.to}`).join(', ') : 'no material change'
  );

  return {
    kind: 'pipeline',
    skipped: false,
    sampleCount: events.length,
    minSamples: MIN_SAMPLES,
    version: saved?.version || null,
    weights,
    previousWeights: previous,
    changes,
    createdAt: saved?.createdAt || new Date()
  };
}

async function retrainAiFactorWeights(signals) {
  const events = [];
  for (const signal of signals) {
    // Prefer non-pipeline checklist factors; skip pure pipeline-mapped checklists.
    if (signal.aiFactors?.source === 'pipeline_scoring') continue;
    const presence = extractAiFactorPresence(signal);
    if (!presence) continue;
    const activeKeys = AI_FACTOR_KEYS.filter(key => presence[key]);
    if (!activeKeys.length) continue;
    events.push({
      activeKeys,
      outcome: signal.outcome,
      outcomeR: Number(signal.outcomeR) || 0
    });
  }

  if (events.length < MIN_SAMPLES) {
    return {
      kind: 'ai_factors',
      skipped: true,
      reason: 'insufficient_samples',
      sampleCount: events.length,
      minSamples: MIN_SAMPLES,
      weights: getAiFactorWeights()
    };
  }

  const previous = getAiFactorWeights();
  const { weights, stats, performanceWeights } = computePerformanceWeights(
    AI_FACTOR_KEYS,
    events,
    previous,
    LEARNING_RATE,
    normalizeAiWeights
  );

  cachedAiFactorWeights = weights;

  let saved = null;
  try {
    saved = await persistLearnedWeights({
      kind: 'ai_factors',
      weights,
      previousWeights: previous,
      sampleCount: events.length,
      factorStats: { stats, performanceWeights },
      notes: 'ai_factors_retrain'
    });
  } catch (error) {
    console.error('[WeightLearning] Failed to persist AI factor weights:', error.message);
  }

  const changes = describeWeightDelta(previous, weights);
  console.log(
    `[WeightLearning] AI factor weights updated (n=${events.length}, v=${saved?.version || 'mem'}):`,
    changes.length ? changes.map(c => `${c.key} ${c.from}->${c.to}`).join(', ') : 'no material change'
  );

  return {
    kind: 'ai_factors',
    skipped: false,
    sampleCount: events.length,
    minSamples: MIN_SAMPLES,
    version: saved?.version || null,
    weights,
    previousWeights: previous,
    changes,
    createdAt: saved?.createdAt || new Date()
  };
}

async function retrain(options = {}) {
  if (retrainInFlight) {
    return {
      ok: false,
      skipped: true,
      reason: 'retrain_in_flight',
      status: getStatus()
    };
  }

  retrainInFlight = true;
  const startedAt = new Date();

  try {
    if (!isDbReady()) {
      lastStatus = {
        lastRunAt: startedAt,
        lastResult: { skipped: true, reason: 'db_not_ready' },
        lastError: null,
        applied: Boolean(cachedPipelineWeights || cachedAiFactorWeights)
      };
      console.warn('[WeightLearning] Retrain skipped — MongoDB not ready');
      return { ok: false, skipped: true, reason: 'db_not_ready', ...lastStatus };
    }

    const signals = await loadClosedSignals(options.limit || 2000);
    const pipeline = await retrainPipelineWeights(signals);
    const aiFactors = await retrainAiFactorWeights(signals);

    lastStatus = {
      lastRunAt: startedAt,
      lastResult: { pipeline, aiFactors },
      lastError: null,
      applied: !pipeline.skipped || !aiFactors.skipped
    };

    return {
      ok: true,
      skipped: pipeline.skipped && aiFactors.skipped,
      pipeline,
      aiFactors,
      defaults: {
        pipeline: getDefaultPipelineWeights(),
        aiFactors: getDefaultAiFactorWeights()
      }
    };
  } catch (error) {
    lastStatus = {
      lastRunAt: startedAt,
      lastResult: null,
      lastError: error.message,
      applied: Boolean(cachedPipelineWeights || cachedAiFactorWeights)
    };
    console.error('[WeightLearning] Retrain failed (scanner continues):', error.message);
    return {
      ok: false,
      skipped: true,
      reason: 'error',
      error: error.message,
      status: getStatus()
    };
  } finally {
    retrainInFlight = false;
  }
}

async function loadPersistedWeights() {
  if (!isDbReady()) {
    console.warn('[WeightLearning] Skipping weight load — MongoDB not ready');
    return { loaded: false, reason: 'db_not_ready' };
  }

  try {
    const [pipelineDoc, aiDoc] = await Promise.all([
      LearnedWeights.findOne({ kind: 'pipeline' }).sort({ version: -1 }).lean(),
      LearnedWeights.findOne({ kind: 'ai_factors' }).sort({ version: -1 }).lean()
    ]);

    if (pipelineDoc?.weights) {
      cachedPipelineWeights = normalizeWeights(pipelineDoc.weights);
      applyScannerConfig({ weights: cachedPipelineWeights });
      console.log(
        `[WeightLearning] Loaded pipeline weights v${pipelineDoc.version} (n=${pipelineDoc.sampleCount})`
      );
    } else {
      cachedPipelineWeights = null;
      console.log('[WeightLearning] No learned pipeline weights — using defaults');
    }

    if (aiDoc?.weights) {
      cachedAiFactorWeights = normalizeAiWeights(aiDoc.weights);
      console.log(
        `[WeightLearning] Loaded AI factor weights v${aiDoc.version} (n=${aiDoc.sampleCount})`
      );
    } else {
      cachedAiFactorWeights = null;
    }

    lastStatus.applied = Boolean(pipelineDoc || aiDoc);
    return {
      loaded: true,
      pipeline: pipelineDoc
        ? {
            version: pipelineDoc.version,
            sampleCount: pipelineDoc.sampleCount,
            weights: cachedPipelineWeights,
            createdAt: pipelineDoc.createdAt
          }
        : null,
      aiFactors: aiDoc
        ? {
            version: aiDoc.version,
            sampleCount: aiDoc.sampleCount,
            weights: cachedAiFactorWeights,
            createdAt: aiDoc.createdAt
          }
        : null
    };
  } catch (error) {
    console.error('[WeightLearning] Failed to load persisted weights:', error.message);
    return { loaded: false, reason: 'error', error: error.message };
  }
}

function getStatus() {
  const config = getScannerConfig();
  return {
    learningMode: 'tp_hit_credit',
    tpCredits: { tp1: OUTCOME_R.tp1, tp2: OUTCOME_R.tp2, tp3: OUTCOME_R.tp3, sl: OUTCOME_R.sl },
    minSamples: MIN_SAMPLES,
    learningRate: LEARNING_RATE,
    factorActiveThreshold: FACTOR_ACTIVE_THRESHOLD,
    retrainIntervalMs: RETRAIN_INTERVAL_MS,
    outcomeDebounceMs: OUTCOME_DEBOUNCE_MS,
    scheduled: Boolean(retrainTimer),
    outcomeDebouncePending: Boolean(outcomeDebounceTimer),
    retrainInFlight,
    lastRunAt: lastStatus.lastRunAt,
    lastError: lastStatus.lastError,
    lastResult: lastStatus.lastResult,
    active: {
      pipeline: {
        source: cachedPipelineWeights ? 'learned' : 'defaults',
        weights: config.weights || getDefaultPipelineWeights()
      },
      aiFactors: {
        source: cachedAiFactorWeights ? 'learned' : 'defaults',
        weights: getAiFactorWeights()
      }
    },
    defaults: {
      pipeline: getDefaultPipelineWeights(),
      aiFactors: getDefaultAiFactorWeights()
    }
  };
}

/**
 * Debounced retrain after a TP/SL outcome is recorded. Batches bursts of closes
 * so we do not hit Mongo on every alert tick.
 */
function scheduleRetrainOnOutcome(outcome) {
  try {
    if (!isLearningOutcome(outcome)) return;
    if (outcomeDebounceTimer) clearTimeout(outcomeDebounceTimer);
    outcomeDebounceTimer = setTimeout(() => {
      outcomeDebounceTimer = null;
      console.log(`[WeightLearning] Debounced retrain after outcome=${outcome}`);
      retrain({ trigger: 'outcome_close' }).catch(err =>
        console.error('[WeightLearning] Outcome-triggered retrain error:', err.message)
      );
    }, OUTCOME_DEBOUNCE_MS);
  } catch (error) {
    console.error('[WeightLearning] scheduleRetrainOnOutcome failed:', error.message);
  }
}

async function getCurrentWeights() {
  const status = getStatus();
  if (!isDbReady()) return status;

  try {
    const recent = await LearnedWeights.find({})
      .sort({ createdAt: -1 })
      .limit(10)
      .select('kind version weights sampleCount createdAt notes')
      .lean();
    return { ...status, history: recent };
  } catch (error) {
    console.error('[WeightLearning] History load failed:', error.message);
    return { ...status, history: [], historyError: error.message };
  }
}

function startScheduledRetrain() {
  if (retrainTimer || !RETRAIN_INTERVAL_MS || RETRAIN_INTERVAL_MS < 60_000) {
    if (!RETRAIN_INTERVAL_MS) {
      console.log('[WeightLearning] Scheduled retrain disabled (LEARNING_RETRAIN_INTERVAL_MS unset/0)');
    }
    return;
  }

  const interval = Math.max(60_000, RETRAIN_INTERVAL_MS);
  retrainTimer = setInterval(() => {
    retrain().catch(err =>
      console.error('[WeightLearning] Scheduled retrain error:', err.message)
    );
  }, interval);

  console.log(`[WeightLearning] Scheduled retrain every ${interval}ms`);
}

function stopScheduledRetrain() {
  if (retrainTimer) {
    clearInterval(retrainTimer);
    retrainTimer = null;
  }
}

async function initWeightLearning() {
  try {
    await loadPersistedWeights();
    startScheduledRetrain();
  } catch (error) {
    console.error('[WeightLearning] Init failed (scanner continues):', error.message);
  }
}

module.exports = {
  DEFAULT_AI_FACTOR_WEIGHTS,
  MIN_SAMPLES,
  LEARNING_RATE,
  LEARNING_OUTCOMES,
  TP_OUTCOMES,
  getPipelineWeights,
  getAiFactorWeights,
  getDefaultPipelineWeights,
  getDefaultAiFactorWeights,
  retrain,
  loadPersistedWeights,
  getStatus,
  getCurrentWeights,
  scheduleRetrainOnOutcome,
  startScheduledRetrain,
  stopScheduledRetrain,
  initWeightLearning,
  // exposed for unit sanity checks
  computePerformanceWeights,
  describeWeightDelta,
  tpCreditFromOutcome,
  isLearningOutcome,
  PIPELINE_KEYS,
  AI_FACTOR_KEYS
};
