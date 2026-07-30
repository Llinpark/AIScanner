/**
 * Stub IStrategy — disabled placeholder for future Strategy Profiles.
 * analyze() always returns no-signal; never produces entries.
 */

const { IStrategy } = require('../interfaces/IStrategy');

class StubStrategy extends IStrategy {
  /**
   * @param {Object} profileMeta
   * @param {Object} [config]
   */
  constructor(profileMeta, config = {}) {
    super();
    this._id = profileMeta.id;
    this._name = profileMeta.name;
    this.config = {
      id: profileMeta.id,
      name: profileMeta.name,
      enabled: false,
      ...config,
      enabled: false
    };
  }

  get id() {
    return this._id;
  }

  get name() {
    return this._name;
  }

  get enabled() {
    return false;
  }

  analyze() {
    return {
      signal: false,
      stage: 'stub',
      reason: 'strategy_not_implemented'
    };
  }
}

/**
 * @param {Object} meta - id, key, name, description, ...
 * @returns {import('./StrategyProfile').StrategyProfile}
 */
function createStubProfile(meta) {
  const {
    id,
    key,
    name,
    description = 'Coming soon — not yet implemented.',
    priority = 200,
    version = 1,
    entryTimeframes = [],
    higherTimeframes = [],
    defaultEntryTimeframe = '15m',
    dataRequirements = {
      htfContextKey: 'htfCandles',
      fallbackHtfKeys: [],
      defaultTimeframe: defaultEntryTimeframe || '15m'
    }
  } = meta;

  return {
    id,
    key,
    name,
    description,
    enabled: false,
    priority,
    version,
    status: 'stub',
    entryTimeframes,
    higherTimeframes,
    defaultEntryTimeframe,
    entryModel: null,
    stopLossModel: null,
    tpModel: null,
    atrCaps: [],
    maximumTPDistance: null,
    minimumScore: 0,
    rrMultiples: [],
    liquidityWeights: {},
    confirmationWeights: {},
    newsRules: {},
    spreadRules: {},
    riskSettings: {},
    marketFilters: {},
    executionRules: {},
    dataRequirements,
    adminPanel: 'stub',
    resolveConfig: (overrides = {}) => ({
      id,
      name,
      enabled: false,
      ...overrides,
      enabled: false
    }),
    createInstance: (config) => new StubStrategy({ id, name }, config)
  };
}

module.exports = {
  StubStrategy,
  createStubProfile
};
