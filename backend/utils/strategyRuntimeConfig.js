/**
 * Runtime + persisted overrides for Scalping / Day Trading strategies.
 * Mirrors scannerRuntimeConfig: env defaults → optional Mongo overrides → hot-reload registry.
 */

const mongoose = require('mongoose');
const {
  STRATEGY_ID: SCALPING_ID,
  STRATEGY_NAME: SCALPING_NAME,
  resolveScalpingConfig
} = require('../strategies/config/scalpingConfig');
const {
  STRATEGY_ID: DAYTRADING_ID,
  STRATEGY_NAME: DAYTRADING_NAME,
  resolveDayTradingConfig
} = require('../strategies/config/dayTradingConfig');

const DOC_KEY = 'strategies';

/** @type {Record<string, any>} */
let scalpingOverrides = {};
/** @type {Record<string, any>} */
let daytradingOverrides = {};

const SCALPING_WEIGHT_KEYS = ['sweep', 'mss', 'displacement', 'fvg', 'retrace', 'engulfing', 'doji'];
const DAYTRADING_WEIGHT_KEYS = [
  'htfBias',
  'sweep',
  'mss',
  'displacement',
  'fvg',
  'retrace',
  'optionalConfirmation'
];

function parseTimeframes(value, fallback) {
  if (Array.isArray(value)) {
    const list = value.map(s => String(s).trim()).filter(Boolean);
    return list.length ? list : fallback;
  }
  if (typeof value === 'string') {
    const list = value
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    return list.length ? list : fallback;
  }
  return fallback;
}

function parseNumberList(value, fallback) {
  if (Array.isArray(value)) {
    const list = value.map(Number).filter(n => Number.isFinite(n) && n > 0);
    return list.length ? list : fallback;
  }
  if (typeof value === 'string') {
    const list = value
      .split(',')
      .map(Number)
      .filter(n => Number.isFinite(n) && n > 0);
    return list.length ? list : fallback;
  }
  return fallback;
}

function pickScalpingAdminPatch(patch = {}) {
  if (!patch || typeof patch !== 'object') return {};
  const out = {};

  if (patch.enabled !== undefined) out.enabled = Boolean(patch.enabled);
  if (patch.htfTimeframe !== undefined) out.htfTimeframe = String(patch.htfTimeframe).trim() || '15m';
  if (patch.defaultEntryTimeframe !== undefined) {
    out.defaultEntryTimeframe = String(patch.defaultEntryTimeframe).trim() || '3m';
  }
  if (patch.entryTimeframes !== undefined) {
    out.entryTimeframes = parseTimeframes(patch.entryTimeframes, ['3m', '1m']);
  }

  if (patch.entry && typeof patch.entry === 'object') {
    out.entry = {};
    if (patch.entry.model !== undefined) out.entry.model = String(patch.entry.model);
    if (patch.entry.maxWaitBars !== undefined) {
      out.entry.maxWaitBars = Math.max(3, parseInt(patch.entry.maxWaitBars, 10) || 10);
    }
  }

  if (patch.stop && typeof patch.stop === 'object') {
    out.stop = {};
    if (patch.stop.model !== undefined) out.stop.model = String(patch.stop.model);
    if (patch.stop.bufferAtrRatio !== undefined) {
      out.stop.bufferAtrRatio = Number(patch.stop.bufferAtrRatio);
    }
  }

  if (patch.takeProfit && typeof patch.takeProfit === 'object') {
    out.takeProfit = {};
    if (patch.takeProfit.model !== undefined) out.takeProfit.model = String(patch.takeProfit.model);
    if (patch.takeProfit.rrMultiples !== undefined) {
      out.takeProfit.rrMultiples = parseNumberList(patch.takeProfit.rrMultiples, [2, 3, 4]);
    }
    if (patch.takeProfit.manualRr !== undefined) {
      out.takeProfit.manualRr = parseNumberList(patch.takeProfit.manualRr, [1.5, 2.5, 4]);
    }
  }

  if (patch.fvg && typeof patch.fvg === 'object') {
    out.fvg = {};
    if (patch.fvg.minGapToAtrRatio !== undefined) {
      out.fvg.minGapToAtrRatio = Number(patch.fvg.minGapToAtrRatio);
    }
  }

  if (patch.confidence && typeof patch.confidence === 'object') {
    out.confidence = {};
    if (patch.confidence.threshold !== undefined) {
      out.confidence.threshold = Math.min(
        100,
        Math.max(0, Number(patch.confidence.threshold) || 70)
      );
    }
    if (patch.confidence.weights && typeof patch.confidence.weights === 'object') {
      out.confidence.weights = {};
      for (const key of SCALPING_WEIGHT_KEYS) {
        if (patch.confidence.weights[key] !== undefined) {
          out.confidence.weights[key] = Number(patch.confidence.weights[key]);
        }
      }
    }
  }

  if (patch.filters && typeof patch.filters === 'object') {
    out.filters = {};
    if (patch.filters.maxSpreadPips !== undefined) {
      out.filters.maxSpreadPips = Number(patch.filters.maxSpreadPips);
    }
    if (patch.filters.minAtrPips !== undefined) {
      out.filters.minAtrPips = Number(patch.filters.minAtrPips);
    }
    if (patch.filters.rejectOnMajorNews !== undefined) {
      out.filters.rejectOnMajorNews = Boolean(patch.filters.rejectOnMajorNews);
    }
  }

  return out;
}

function pickDaytradingAdminPatch(patch = {}) {
  if (!patch || typeof patch !== 'object') return {};
  const out = {};

  if (patch.enabled !== undefined) out.enabled = Boolean(patch.enabled);
  if (patch.htfTimeframe !== undefined) out.htfTimeframe = String(patch.htfTimeframe).trim() || '4h';
  if (patch.refineHtfTimeframe !== undefined) {
    out.refineHtfTimeframe = String(patch.refineHtfTimeframe).trim() || '1h';
  }
  if (patch.useRefineHtf !== undefined) out.useRefineHtf = Boolean(patch.useRefineHtf);
  if (patch.defaultEntryTimeframe !== undefined) {
    out.defaultEntryTimeframe = String(patch.defaultEntryTimeframe).trim() || '15m';
  }
  if (patch.entryTimeframes !== undefined) {
    out.entryTimeframes = parseTimeframes(patch.entryTimeframes, ['15m', '5m']);
  }

  if (patch.entry && typeof patch.entry === 'object') {
    out.entry = {};
    if (patch.entry.model !== undefined) out.entry.model = String(patch.entry.model);
    if (patch.entry.maxWaitBars !== undefined) {
      out.entry.maxWaitBars = Math.max(4, parseInt(patch.entry.maxWaitBars, 10) || 16);
    }
  }

  if (patch.stop && typeof patch.stop === 'object') {
    out.stop = {};
    if (patch.stop.model !== undefined) out.stop.model = String(patch.stop.model);
    if (patch.stop.bufferAtrRatio !== undefined) {
      out.stop.bufferAtrRatio = Number(patch.stop.bufferAtrRatio);
    }
    if (patch.stop.maxStopAtrMult !== undefined) {
      out.stop.maxStopAtrMult = Number(patch.stop.maxStopAtrMult);
    }
  }

  if (patch.takeProfit && typeof patch.takeProfit === 'object') {
    out.takeProfit = {};
    if (patch.takeProfit.model !== undefined) out.takeProfit.model = String(patch.takeProfit.model);
    if (patch.takeProfit.rrMultiples !== undefined) {
      out.takeProfit.rrMultiples = parseNumberList(patch.takeProfit.rrMultiples, [2, 3, 4]);
    }
    if (patch.takeProfit.manualRr !== undefined) {
      out.takeProfit.manualRr = parseNumberList(patch.takeProfit.manualRr, [2, 3, 4]);
    }
    if (patch.takeProfit.minRr !== undefined) {
      out.takeProfit.minRr = Number(patch.takeProfit.minRr);
    }
  }

  if (patch.fvg && typeof patch.fvg === 'object') {
    out.fvg = {};
    if (patch.fvg.minGapToAtrRatio !== undefined) {
      out.fvg.minGapToAtrRatio = Number(patch.fvg.minGapToAtrRatio);
    }
  }

  if (patch.confidence && typeof patch.confidence === 'object') {
    out.confidence = {};
    if (patch.confidence.threshold !== undefined) {
      out.confidence.threshold = Math.min(
        100,
        Math.max(0, Number(patch.confidence.threshold) || 70)
      );
    }
    if (patch.confidence.weights && typeof patch.confidence.weights === 'object') {
      out.confidence.weights = {};
      for (const key of DAYTRADING_WEIGHT_KEYS) {
        if (patch.confidence.weights[key] !== undefined) {
          out.confidence.weights[key] = Number(patch.confidence.weights[key]);
        }
      }
    }
  }

  if (patch.filters && typeof patch.filters === 'object') {
    out.filters = {};
    if (patch.filters.maxSpreadPips !== undefined) {
      out.filters.maxSpreadPips = Number(patch.filters.maxSpreadPips);
    }
    if (patch.filters.minAtrPips !== undefined) {
      out.filters.minAtrPips = Number(patch.filters.minAtrPips);
    }
    if (patch.filters.rejectOnMajorNews !== undefined) {
      out.filters.rejectOnMajorNews = Boolean(patch.filters.rejectOnMajorNews);
    }
    if (patch.filters.newsWindowMinutes !== undefined) {
      out.filters.newsWindowMinutes = Math.max(
        0,
        parseInt(patch.filters.newsWindowMinutes, 10) || 0
      );
    }
    if (patch.filters.tradeReversals !== undefined) {
      out.filters.tradeReversals = Boolean(patch.filters.tradeReversals);
    }
  }

  return out;
}

function deepMergeOverrides(base, patch) {
  const out = { ...base, ...patch };
  for (const key of Object.keys(patch || {})) {
    const pv = patch[key];
    const bv = base[key];
    if (pv && typeof pv === 'object' && !Array.isArray(pv) && bv && typeof bv === 'object' && !Array.isArray(bv)) {
      out[key] = { ...bv, ...pv };
    }
  }
  return out;
}

function toAdminScalpingView(cfg) {
  return {
    id: SCALPING_ID,
    name: SCALPING_NAME,
    enabled: Boolean(cfg.enabled),
    htfTimeframe: cfg.htfTimeframe,
    entryTimeframes: [...(cfg.entryTimeframes || [])],
    defaultEntryTimeframe: cfg.defaultEntryTimeframe,
    entry: {
      model: cfg.entry?.model || 'ce',
      maxWaitBars: cfg.entry?.maxWaitBars
    },
    stop: {
      model: cfg.stop?.model || 'sweep',
      bufferAtrRatio: cfg.stop?.bufferAtrRatio
    },
    takeProfit: {
      model: cfg.takeProfit?.model || 'rr',
      rrMultiples: [...(cfg.takeProfit?.rrMultiples || [])],
      manualRr: [...(cfg.takeProfit?.manualRr || [])]
    },
    fvg: {
      minGapToAtrRatio: cfg.fvg?.minGapToAtrRatio
    },
    confidence: {
      threshold: cfg.confidence?.threshold,
      weights: { ...(cfg.confidence?.weights || {}) }
    },
    filters: {
      maxSpreadPips: cfg.filters?.maxSpreadPips,
      minAtrPips: cfg.filters?.minAtrPips,
      rejectOnMajorNews: Boolean(cfg.filters?.rejectOnMajorNews)
    }
  };
}

function toAdminDaytradingView(cfg) {
  return {
    id: DAYTRADING_ID,
    name: DAYTRADING_NAME,
    enabled: Boolean(cfg.enabled),
    htfTimeframe: cfg.htfTimeframe,
    refineHtfTimeframe: cfg.refineHtfTimeframe,
    useRefineHtf: Boolean(cfg.useRefineHtf),
    entryTimeframes: [...(cfg.entryTimeframes || [])],
    defaultEntryTimeframe: cfg.defaultEntryTimeframe,
    entry: {
      model: cfg.entry?.model || 'ce',
      maxWaitBars: cfg.entry?.maxWaitBars
    },
    stop: {
      model: cfg.stop?.model || 'sweep',
      bufferAtrRatio: cfg.stop?.bufferAtrRatio,
      maxStopAtrMult: cfg.stop?.maxStopAtrMult
    },
    takeProfit: {
      model: cfg.takeProfit?.model || 'institutional',
      rrMultiples: [...(cfg.takeProfit?.rrMultiples || [])],
      manualRr: [...(cfg.takeProfit?.manualRr || [])],
      minRr: cfg.takeProfit?.minRr
    },
    fvg: {
      minGapToAtrRatio: cfg.fvg?.minGapToAtrRatio
    },
    confidence: {
      threshold: cfg.confidence?.threshold,
      weights: { ...(cfg.confidence?.weights || {}) }
    },
    filters: {
      maxSpreadPips: cfg.filters?.maxSpreadPips,
      minAtrPips: cfg.filters?.minAtrPips,
      rejectOnMajorNews: Boolean(cfg.filters?.rejectOnMajorNews),
      newsWindowMinutes: cfg.filters?.newsWindowMinutes,
      tradeReversals: Boolean(cfg.filters?.tradeReversals)
    }
  };
}

function getResolvedScalpingConfig() {
  return resolveScalpingConfig(scalpingOverrides);
}

function getResolvedDaytradingConfig() {
  return resolveDayTradingConfig(daytradingOverrides);
}

function getRegistryOptions() {
  return {
    scalpingConfig: getResolvedScalpingConfig(),
    daytradingConfig: getResolvedDaytradingConfig()
  };
}

function getStrategyAdminConfig() {
  return {
    scalping: toAdminScalpingView(getResolvedScalpingConfig()),
    daytrading: toAdminDaytradingView(getResolvedDaytradingConfig())
  };
}

function rebuildDefaultRegistry() {
  const { createDefaultRegistry, setDefaultRegistry } = require('../strategies/registry');
  const registry = createDefaultRegistry(getRegistryOptions());
  setDefaultRegistry(registry);
  return registry;
}

/**
 * Apply admin patch in-memory and rebuild strategy registry.
 * @param {{ scalping?: object, daytrading?: object }} patch
 */
function applyStrategyConfig(patch = {}) {
  if (patch.scalping && typeof patch.scalping === 'object') {
    scalpingOverrides = deepMergeOverrides(scalpingOverrides, pickScalpingAdminPatch(patch.scalping));
  }
  if (patch.daytrading && typeof patch.daytrading === 'object') {
    daytradingOverrides = deepMergeOverrides(
      daytradingOverrides,
      pickDaytradingAdminPatch(patch.daytrading)
    );
  }
  rebuildDefaultRegistry();
  return getStrategyAdminConfig();
}

async function persistStrategyConfig({ updatedBy } = {}) {
  if (mongoose.connection.readyState !== 1) {
    return null;
  }
  const StrategyRuntimeConfig = require('../models/StrategyRuntimeConfig');
  const doc = await StrategyRuntimeConfig.findOneAndUpdate(
    { key: DOC_KEY },
    {
      $set: {
        scalping: scalpingOverrides,
        daytrading: daytradingOverrides,
        updatedAt: new Date(),
        updatedBy: updatedBy || null
      },
      $unset: { legacyEnabled: 1 }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  return doc;
}

async function loadPersistedStrategyConfig() {
  if (mongoose.connection.readyState !== 1) {
    rebuildDefaultRegistry();
    return getStrategyAdminConfig();
  }
  const StrategyRuntimeConfig = require('../models/StrategyRuntimeConfig');
  const doc = await StrategyRuntimeConfig.findOne({ key: DOC_KEY }).lean();
  if (doc) {
    scalpingOverrides =
      doc.scalping && typeof doc.scalping === 'object' ? { ...doc.scalping } : {};
    daytradingOverrides =
      doc.daytrading && typeof doc.daytrading === 'object' ? { ...doc.daytrading } : {};
  }
  rebuildDefaultRegistry();
  return getStrategyAdminConfig();
}

async function initStrategyRuntimeConfig() {
  try {
    await loadPersistedStrategyConfig();
    console.log('[StrategyRuntime] Loaded strategy overrides and rebuilt registry.');
  } catch (err) {
    console.error('[StrategyRuntime] Boot init error (env defaults kept):', err.message);
    rebuildDefaultRegistry();
  }
}

module.exports = {
  SCALPING_ID,
  DAYTRADING_ID,
  SCALPING_WEIGHT_KEYS,
  DAYTRADING_WEIGHT_KEYS,
  getRegistryOptions,
  getResolvedScalpingConfig,
  getResolvedDaytradingConfig,
  getStrategyAdminConfig,
  applyStrategyConfig,
  persistStrategyConfig,
  loadPersistedStrategyConfig,
  initStrategyRuntimeConfig,
  rebuildDefaultRegistry
};
