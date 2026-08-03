/**
 * Live Strategy Profiles wrapping existing Scalping + Day Trading runners.
 * Behaviour is unchanged — profiles are adapters over existing IStrategy classes.
 */

const {
  STRATEGY_ID: SCALPING_ID,
  STRATEGY_NAME: SCALPING_NAME,
  STRATEGY_KEY: SCALPING_KEY,
  DEFAULT_SCALPING_CONFIG,
  resolveScalpingConfig
} = require('../config/scalpingConfig');
const {
  STRATEGY_ID: DAYTRADING_ID,
  STRATEGY_NAME: DAYTRADING_NAME,
  STRATEGY_KEY: DAYTRADING_KEY,
  DEFAULT_DAYTRADING_CONFIG,
  resolveDayTradingConfig
} = require('../config/dayTradingConfig');

function createScalpingProfile() {
  const cfg = DEFAULT_SCALPING_CONFIG;
  return {
    id: SCALPING_ID,
    key: SCALPING_KEY,
    name: SCALPING_NAME,
    description:
      'Liquidity Sweep + Fair Value Gap scalping. HTF context on 15m; entries on 3m / 5m.',
    enabled: cfg.enabled !== false,
    priority: 20,
    version: 1,
    status: 'live',
    entryTimeframes: [...(cfg.entryTimeframes || [])],
    higherTimeframes: [...(cfg.htfTimeframes || [cfg.htfTimeframe || '15m'])],
    defaultEntryTimeframe: cfg.defaultEntryTimeframe || '3m',
    entryModel: cfg.entry?.model || 'ce',
    stopLossModel: cfg.stop?.model || 'sweep',
    tpModel: cfg.takeProfit?.model || 'smart_scoring',
    atrCaps: [...(cfg.takeProfit?.atrCaps || [])],
    maximumTPDistance: cfg.takeProfit?.maxTpDistancePips ?? null,
    minimumScore: cfg.takeProfit?.minScore ?? 0,
    rrMultiples: [...(cfg.takeProfit?.rrMultiples || [])],
    liquidityWeights: { ...(cfg.takeProfit?.scoreWeights || {}) },
    confirmationWeights: { ...(cfg.confidence?.weights || {}) },
    newsRules: {
      rejectOnMajorNews: Boolean(cfg.filters?.rejectOnMajorNews)
    },
    spreadRules: {
      maxSpreadPipsByClass: { ...(cfg.filters?.maxSpreadPipsByClass || {}) },
      maxSpreadPipsBySymbol: { ...(cfg.filters?.maxSpreadPipsBySymbol || {}) },
      maxSpreadPips: cfg.filters?.maxSpreadPips
    },
    riskSettings: {
      stopModel: cfg.stop?.model,
      bufferAtrRatio: cfg.stop?.bufferAtrRatio
    },
    marketFilters: { ...(cfg.filters || {}) },
    executionRules: {},
    dataRequirements: {
      htfContextKey: 'scalpingHtfCandles',
      fallbackHtfKeys: ['htfCandles'],
      defaultTimeframe: cfg.defaultEntryTimeframe || '3m',
      htfTimeframeField: 'htfTimeframe'
    },
    adminPanel: 'scalping',
    resolveConfig: (overrides = {}) => resolveScalpingConfig(overrides),
    createInstance: (config, deps) => {
      const { ScalpingStrategy } = require('../ScalpingStrategy');
      return new ScalpingStrategy({ config, deps });
    }
  };
}

function createDayTradingProfile() {
  const cfg = DEFAULT_DAYTRADING_CONFIG;
  return {
    id: DAYTRADING_ID,
    key: DAYTRADING_KEY,
    name: DAYTRADING_NAME,
    description:
      'Liquidity Sweep + Fair Value Gap day trading. HTF bias on 1H / 4H; entries on 5m / 15m.',
    enabled: cfg.enabled !== false,
    priority: 10,
    version: 1,
    status: 'live',
    entryTimeframes: [...(cfg.entryTimeframes || [])],
    higherTimeframes: [
      ...(cfg.htfTimeframes || [cfg.htfTimeframe || '1h', cfg.refineHtfTimeframe || '1h'].filter(Boolean))
    ],
    defaultEntryTimeframe: cfg.defaultEntryTimeframe || '15m',
    entryModel: cfg.entry?.model || 'ce',
    stopLossModel: cfg.stop?.model || 'sweep',
    tpModel: cfg.takeProfit?.model || 'smart_scoring',
    atrCaps: [...(cfg.takeProfit?.atrCaps || [])],
    maximumTPDistance: cfg.takeProfit?.maxTpDistancePips ?? null,
    minimumScore: cfg.takeProfit?.minScore ?? 0,
    rrMultiples: [...(cfg.takeProfit?.rrMultiples || [])],
    liquidityWeights: { ...(cfg.takeProfit?.scoreWeights || {}) },
    confirmationWeights: { ...(cfg.confidence?.weights || {}) },
    newsRules: {
      rejectOnMajorNews: Boolean(cfg.filters?.rejectOnMajorNews),
      newsWindowMinutes: cfg.filters?.newsWindowMinutes
    },
    spreadRules: {
      maxSpreadPipsByClass: { ...(cfg.filters?.maxSpreadPipsByClass || {}) },
      maxSpreadPipsBySymbol: { ...(cfg.filters?.maxSpreadPipsBySymbol || {}) },
      maxSpreadPips: cfg.filters?.maxSpreadPips
    },
    riskSettings: {
      stopModel: cfg.stop?.model,
      bufferAtrRatio: cfg.stop?.bufferAtrRatio,
      maxStopAtrMult: cfg.stop?.maxStopAtrMult,
      minRr: cfg.takeProfit?.minRr
    },
    marketFilters: { ...(cfg.filters || {}) },
    executionRules: {},
    dataRequirements: {
      htfContextKey: 'htfCandles',
      fallbackHtfKeys: ['daytradingHtfCandles', 'htf4hCandles'],
      defaultTimeframe: cfg.defaultEntryTimeframe || '15m',
      htfTimeframeField: 'htfTimeframe'
    },
    adminPanel: 'daytrading',
    resolveConfig: (overrides = {}) => resolveDayTradingConfig(overrides),
    createInstance: (config, deps) => {
      const { DayTradingStrategy } = require('../DayTradingStrategy');
      return new DayTradingStrategy({ config, deps });
    }
  };
}

module.exports = {
  createScalpingProfile,
  createDayTradingProfile
};
