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
const {
  SCALPING_TP_PROFILE,
  DAY_TRADING_TP_PROFILE,
  SYSTEM_DEFAULT_TP_PROFILE,
  getTpProfile
} = require('../strategies/profiles');

const DOC_KEY = 'strategies';
/** Live keys that drive analyze prefer (stubs cannot be active prefer). */
const ACTIVE_STRATEGY_VALUES = Object.freeze(['scalping', 'daytrading']);

/** @type {Record<string, any>} */
let scalpingOverrides = {};
/** @type {Record<string, any>} */
let daytradingOverrides = {};
/** Per-profile overrides for stub/future keys (enabled flags, etc.) — additive. */
/** @type {Record<string, any>} */
let profileOverrides = {};
/** @type {'scalping'|'daytrading'} */
let activeStrategy = 'daytrading';

function normalizeActiveStrategy(value, fallback = 'daytrading') {
  const v = String(value || '')
    .toLowerCase()
    .trim();
  if (ACTIVE_STRATEGY_VALUES.includes(v)) return v;
  // Allow selecting stub keys in Admin for UX, but prefer falls back for analyze
  try {
    const { getProfileRegistry, bootstrapStrategyProfiles } = require('../strategies/engine');
    bootstrapStrategyProfiles();
    const profile = getProfileRegistry().getByKey(v);
    if (profile && profile.status === 'live') return profile.key;
  } catch (_) {
    /* ignore */
  }
  return ACTIVE_STRATEGY_VALUES.includes(fallback) ? fallback : 'daytrading';
}

function getActiveStrategy() {
  return activeStrategy;
}

function setActiveStrategy(value) {
  activeStrategy = normalizeActiveStrategy(value, activeStrategy);
  return activeStrategy;
}

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

const TP_SCORE_WEIGHT_KEYS = [
  'internal_liquidity',
  'external_liquidity',
  'equal_high_low',
  'untapped_fvg',
  'swing_high_low',
  'order_block',
  'breaker_block',
  'mitigation_block',
  'pdh_pdl',
  'pwh_pwl',
  'pmh_pml',
  'atr_projection',
  'rr_fallback'
];

const DEFAULT_TP_SCORE_WEIGHTS = Object.freeze({
  ...SYSTEM_DEFAULT_TP_PROFILE.scoreWeights
});

const SCALPING_TP_SCORE_WEIGHTS = Object.freeze({
  ...SCALPING_TP_PROFILE.scoreWeights
});

const DAYTRADING_TP_SCORE_WEIGHTS = Object.freeze({
  ...DAY_TRADING_TP_PROFILE.scoreWeights
});

function pickTakeProfitAdminPatch(patchTp, atrCapsFallback) {
  if (!patchTp || typeof patchTp !== 'object') return null;
  const out = {};

  if (patchTp.model !== undefined) out.model = String(patchTp.model);
  if (patchTp.enableSmartTpScoring !== undefined) {
    out.enableSmartTpScoring = Boolean(patchTp.enableSmartTpScoring);
    // Keep legacy key in sync
    out.enableDynamicTp = Boolean(patchTp.enableSmartTpScoring);
  }
  if (patchTp.enableDynamicTp !== undefined) {
    out.enableDynamicTp = Boolean(patchTp.enableDynamicTp);
    if (patchTp.enableSmartTpScoring === undefined) {
      out.enableSmartTpScoring = Boolean(patchTp.enableDynamicTp);
    }
  }
  if (patchTp.atrCaps !== undefined) {
    out.atrCaps = parseNumberList(patchTp.atrCaps, atrCapsFallback);
  }
  if (patchTp.maxAtrMultiplier !== undefined) {
    out.maxAtrMultiplier = Number(patchTp.maxAtrMultiplier);
  }
  if (patchTp.maxTpDistancePips !== undefined) {
    const v = Number(patchTp.maxTpDistancePips);
    out.maxTpDistancePips = Number.isFinite(v) && v > 0 ? v : null;
  }
  if (patchTp.minScore !== undefined) {
    const v = Number(patchTp.minScore);
    out.minScore = Number.isFinite(v) && v >= 0 ? v : 0;
  }
  if (patchTp.scoreProximity !== undefined) {
    const v = Number(patchTp.scoreProximity);
    out.scoreProximity = Number.isFinite(v) && v >= 0 ? v : 5;
  }
  if (patchTp.allowRrFallback !== undefined) {
    out.allowRrFallback = Boolean(patchTp.allowRrFallback);
  }
  if (patchTp.liquidityPriority !== undefined) {
    out.liquidityPriority = parseTimeframes(patchTp.liquidityPriority, [
      'nearest_liquidity_pool',
      'equal_high_low',
      'swing_high_low',
      'pdh_pdl',
      'pwh_pwl',
      'untapped_fvg'
    ]);
  }
  if (patchTp.scoreWeights && typeof patchTp.scoreWeights === 'object') {
    out.scoreWeights = {};
    for (const key of TP_SCORE_WEIGHT_KEYS) {
      if (patchTp.scoreWeights[key] !== undefined) {
        out.scoreWeights[key] = Number(patchTp.scoreWeights[key]);
      }
    }
  }
  if (patchTp.rrMultiples !== undefined) {
    out.rrMultiples = parseNumberList(patchTp.rrMultiples, [2, 3, 4]);
  }
  if (patchTp.manualRr !== undefined) {
    out.manualRr = parseNumberList(patchTp.manualRr, atrCapsFallback);
  }
  if (patchTp.minRr !== undefined) {
    out.minRr = Number(patchTp.minRr);
  }
  if (patchTp.deferredLiquidityCategories !== undefined) {
    out.deferredLiquidityCategories = parseTimeframes(patchTp.deferredLiquidityCategories, []);
  }
  if (patchTp.profileId !== undefined) {
    out.profileId = String(patchTp.profileId);
  }

  return Object.keys(out).length ? out : null;
}

function toAdminTakeProfitView(cfgTp, defaults) {
  const enableSmart =
    cfgTp?.enableSmartTpScoring === false || cfgTp?.enableDynamicTp === false
      ? false
      : true;
  const maxPips =
    cfgTp?.maxTpDistancePips !== undefined
      ? cfgTp.maxTpDistancePips
      : defaults.maxTpDistancePips !== undefined
        ? defaults.maxTpDistancePips
        : null;
  const weightDefaults = defaults.scoreWeights || DEFAULT_TP_SCORE_WEIGHTS;
  return {
    profileId: cfgTp?.profileId || defaults.profileId || null,
    model: cfgTp?.model || defaults.model || 'smart_scoring',
    enableSmartTpScoring: enableSmart,
    enableDynamicTp: enableSmart,
    atrCaps: [...(cfgTp?.atrCaps || defaults.atrCaps || [])],
    maxAtrMultiplier: cfgTp?.maxAtrMultiplier ?? defaults.maxAtrMultiplier,
    maxTpDistancePips: maxPips,
    minScore: cfgTp?.minScore ?? 0,
    scoreProximity: cfgTp?.scoreProximity ?? 5,
    allowRrFallback: cfgTp?.allowRrFallback !== false,
    deferredLiquidityCategories: [
      ...(cfgTp?.deferredLiquidityCategories || defaults.deferredLiquidityCategories || [])
    ],
    liquidityPriority: [...(cfgTp?.liquidityPriority || [])],
    scoreWeights: {
      ...weightDefaults,
      ...(cfgTp?.scoreWeights || {})
    },
    rrMultiples: [...(cfgTp?.rrMultiples || [])],
    manualRr: [...(cfgTp?.manualRr || [])],
    ...(defaults.includeMinRr ? { minRr: cfgTp?.minRr } : {})
  };
}

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
    const tp = pickTakeProfitAdminPatch(patch.takeProfit, [0.7, 1.3, 2.0]);
    if (tp) out.takeProfit = tp;
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
    const tp = pickTakeProfitAdminPatch(patch.takeProfit, [1.5, 2.5, 3.5]);
    if (tp) out.takeProfit = tp;
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
      // One extra nest for takeProfit.scoreWeights / confidence.weights
      const merged = { ...bv, ...pv };
      for (const nestedKey of Object.keys(pv)) {
        const npv = pv[nestedKey];
        const nbv = bv[nestedKey];
        if (
          npv &&
          typeof npv === 'object' &&
          !Array.isArray(npv) &&
          nbv &&
          typeof nbv === 'object' &&
          !Array.isArray(nbv)
        ) {
          merged[nestedKey] = { ...nbv, ...npv };
        }
      }
      out[key] = merged;
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
    takeProfit: toAdminTakeProfitView(cfg.takeProfit, {
      profileId: SCALPING_TP_PROFILE.profileId,
      model: 'smart_scoring',
      atrCaps: [...SCALPING_TP_PROFILE.atrCaps],
      maxAtrMultiplier: SCALPING_TP_PROFILE.maxAtrMultiplier,
      maxTpDistancePips: SCALPING_TP_PROFILE.maxTpDistancePips,
      deferredLiquidityCategories: [...SCALPING_TP_PROFILE.deferredLiquidityCategories],
      scoreWeights: SCALPING_TP_SCORE_WEIGHTS,
      includeMinRr: false
    }),
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
    takeProfit: toAdminTakeProfitView(cfg.takeProfit, {
      profileId: DAY_TRADING_TP_PROFILE.profileId,
      model: 'smart_scoring',
      atrCaps: [...DAY_TRADING_TP_PROFILE.atrCaps],
      maxAtrMultiplier: DAY_TRADING_TP_PROFILE.maxAtrMultiplier,
      maxTpDistancePips: DAY_TRADING_TP_PROFILE.maxTpDistancePips,
      deferredLiquidityCategories: [...DAY_TRADING_TP_PROFILE.deferredLiquidityCategories],
      scoreWeights: DAYTRADING_TP_SCORE_WEIGHTS,
      includeMinRr: true
    }),
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

/**
 * Full Strategy Profile catalog for Admin Strategies list (live + stubs).
 * Live entries merge runtime admin views; stubs remain disabled / coming soon.
 */
function getStrategyCatalog() {
  try {
    const {
      bootstrapStrategyProfiles,
      getProfileRegistry,
      toCatalogEntry
    } = require('../strategies/engine');
    bootstrapStrategyProfiles();
    const admin = getStrategyAdminConfig();
    return getProfileRegistry()
      .list()
      .map(profile => {
        const liveView = admin[profile.key];
        const stubOverride = profileOverrides[profile.key];
        if (liveView) {
          return {
            ...toCatalogEntry(profile, {
              enabled: liveView.enabled,
              entryTimeframes: liveView.entryTimeframes,
              higherTimeframes: liveView.htfTimeframe
                ? [liveView.htfTimeframe, liveView.refineHtfTimeframe].filter(Boolean)
                : profile.higherTimeframes,
              defaultEntryTimeframe: liveView.defaultEntryTimeframe
            }),
            settings: liveView
          };
        }
        return {
          ...toCatalogEntry(profile, {
            enabled: false,
            ...(stubOverride && typeof stubOverride === 'object' ? stubOverride : {})
          }),
          settings: null,
          comingSoon: true
        };
      });
  } catch (_) {
    const admin = getStrategyAdminConfig();
    return [
      {
        id: SCALPING_ID,
        key: 'scalping',
        name: SCALPING_NAME,
        status: 'live',
        enabled: Boolean(admin.scalping?.enabled),
        configurable: true,
        settings: admin.scalping
      },
      {
        id: DAYTRADING_ID,
        key: 'daytrading',
        name: DAYTRADING_NAME,
        status: 'live',
        enabled: Boolean(admin.daytrading?.enabled),
        configurable: true,
        settings: admin.daytrading
      }
    ];
  }
}

function rebuildDefaultRegistry() {
  const { createDefaultRegistry, setDefaultRegistry } = require('../strategies/registry');
  const registry = createDefaultRegistry(getRegistryOptions());
  setDefaultRegistry(registry);
  return registry;
}

/**
 * Apply admin patch in-memory and rebuild strategy registry.
 * Profiles are independent: a scalping-only patch never clears daytrading (and vice versa).
 * @param {{ scalping?: object, daytrading?: object, activeStrategy?: string, profiles?: object }} patch
 */
function applyStrategyConfig(patch = {}) {
  if (patch.activeStrategy !== undefined) {
    setActiveStrategy(patch.activeStrategy);
  }
  if (patch.scalping && typeof patch.scalping === 'object') {
    scalpingOverrides = deepMergeOverrides(scalpingOverrides, pickScalpingAdminPatch(patch.scalping));
  }
  if (patch.daytrading && typeof patch.daytrading === 'object') {
    daytradingOverrides = deepMergeOverrides(
      daytradingOverrides,
      pickDaytradingAdminPatch(patch.daytrading)
    );
  }
  // Additive: stub/future profile metadata overrides (never enables stubs for analyze)
  if (patch.profiles && typeof patch.profiles === 'object') {
    for (const [key, value] of Object.entries(patch.profiles)) {
      if (!value || typeof value !== 'object') continue;
      if (key === 'scalping' || key === 'daytrading') continue;
      profileOverrides[key] = deepMergeOverrides(profileOverrides[key] || {}, value);
    }
  }
  rebuildDefaultRegistry();
  return getStrategyAdminConfig();
}

async function persistStrategyConfig({ updatedBy } = {}) {
  if (mongoose.connection.readyState !== 1) {
    return null;
  }
  const { getMarketRegimeOverrides } = require('./marketRegimeConfig');
  const StrategyRuntimeConfig = require('../models/StrategyRuntimeConfig');
  const doc = await StrategyRuntimeConfig.findOneAndUpdate(
    { key: DOC_KEY },
    {
      $set: {
        scalping: scalpingOverrides,
        daytrading: daytradingOverrides,
        profiles: profileOverrides,
        activeStrategy,
        marketRegime: getMarketRegimeOverrides(),
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
    profileOverrides =
      doc.profiles && typeof doc.profiles === 'object' ? { ...doc.profiles } : {};
    activeStrategy = normalizeActiveStrategy(doc.activeStrategy, 'daytrading');
    try {
      const { loadMarketRegimeOverrides } = require('./marketRegimeConfig');
      loadMarketRegimeOverrides(
        doc.marketRegime && typeof doc.marketRegime === 'object' ? doc.marketRegime : {}
      );
    } catch (_) {
      /* market regime optional at boot */
    }
  }
  rebuildDefaultRegistry();
  return getStrategyAdminConfig();
}

/** Test helper — reset in-memory overrides without touching Mongo. */
function resetStrategyRuntimeConfigForTests() {
  scalpingOverrides = {};
  daytradingOverrides = {};
  profileOverrides = {};
  activeStrategy = 'daytrading';
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
  TP_SCORE_WEIGHT_KEYS,
  DEFAULT_TP_SCORE_WEIGHTS,
  SCALPING_TP_SCORE_WEIGHTS,
  DAYTRADING_TP_SCORE_WEIGHTS,
  ACTIVE_STRATEGY_VALUES,
  normalizeActiveStrategy,
  getActiveStrategy,
  setActiveStrategy,
  getRegistryOptions,
  getResolvedScalpingConfig,
  getResolvedDaytradingConfig,
  getStrategyAdminConfig,
  getStrategyCatalog,
  applyStrategyConfig,
  persistStrategyConfig,
  loadPersistedStrategyConfig,
  initStrategyRuntimeConfig,
  rebuildDefaultRegistry,
  resetStrategyRuntimeConfigForTests,
  getTpProfile
};
