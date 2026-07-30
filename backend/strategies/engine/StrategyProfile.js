/**
 * StrategyProfile — declarative contract for a pluggable trading strategy.
 *
 * Profiles describe *what* a strategy needs (timeframes, models, filters) and
 * how to instantiate its IStrategy runner. The Scanner Engine never branches
 * on strategy name; it only reads profile fields.
 *
 * @typedef {'live'|'stub'} StrategyProfileStatus
 *
 * @typedef {Object} StrategyDataRequirements
 * @property {string} htfContextKey - Context field holding primary HTF candles
 * @property {string[]} [fallbackHtfKeys] - Alternate context keys if primary empty
 * @property {string} defaultTimeframe - Default LTF when caller omits timeframe
 * @property {string} [htfTimeframeField] - Config field for HTF TF (default htfTimeframe)
 *
 * @typedef {Object} StrategyProfile
 * @property {string} id - Stable full id (e.g. liquidity_sweep_fvg_scalp)
 * @property {string} key - Admin / runtime short key (e.g. scalping)
 * @property {string} name
 * @property {string} [description]
 * @property {boolean} enabled
 * @property {number} [priority] - Lower runs first when no prefer (default 100)
 * @property {number} [version]
 * @property {StrategyProfileStatus} status
 * @property {string[]} [entryTimeframes]
 * @property {string[]} [higherTimeframes]
 * @property {string} [defaultEntryTimeframe]
 * @property {string} [entryModel]
 * @property {string} [stopLossModel]
 * @property {string} [tpModel]
 * @property {number[]} [atrCaps]
 * @property {number|null} [maximumTPDistance]
 * @property {number} [minimumScore]
 * @property {number[]} [rrMultiples]
 * @property {Object} [liquidityWeights]
 * @property {Object} [confirmationWeights]
 * @property {Object} [newsRules]
 * @property {Object} [spreadRules]
 * @property {Object} [riskSettings]
 * @property {Object} [marketFilters]
 * @property {Object} [executionRules]
 * @property {StrategyDataRequirements} dataRequirements
 * @property {function(Object=): Object} [resolveConfig]
 * @property {function(Object=, Object=): import('../interfaces/IStrategy').IStrategy} [createInstance]
 * @property {string} [adminPanel] - Which settings panel to render (scalping|daytrading|stub)
 */

/**
 * @param {Partial<StrategyProfile>} profile
 * @returns {StrategyProfile}
 */
function assertStrategyProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    throw new Error('StrategyProfile must be an object');
  }
  if (!profile.id || !profile.key || !profile.name) {
    throw new Error('StrategyProfile requires id, key, and name');
  }
  if (!profile.dataRequirements || !profile.dataRequirements.htfContextKey) {
    throw new Error(`StrategyProfile ${profile.id} requires dataRequirements.htfContextKey`);
  }
  if (!profile.dataRequirements.defaultTimeframe) {
    throw new Error(`StrategyProfile ${profile.id} requires dataRequirements.defaultTimeframe`);
  }
  const status = profile.status || 'live';
  if (status === 'live' && typeof profile.createInstance !== 'function') {
    throw new Error(`Live StrategyProfile ${profile.id} requires createInstance()`);
  }
  return /** @type {StrategyProfile} */ (profile);
}

/**
 * Normalize optional fields with safe defaults (does not mutate input).
 * @param {Partial<StrategyProfile>} raw
 * @returns {StrategyProfile}
 */
function normalizeStrategyProfile(raw) {
  const profile = assertStrategyProfile(raw);
  return {
    ...profile,
    description: profile.description || '',
    enabled: profile.enabled !== false,
    priority: Number.isFinite(profile.priority) ? profile.priority : 100,
    version: Number.isFinite(profile.version) ? profile.version : 1,
    status: profile.status === 'stub' ? 'stub' : 'live',
    entryTimeframes: [...(profile.entryTimeframes || [])],
    higherTimeframes: [...(profile.higherTimeframes || [])],
    dataRequirements: {
      htfContextKey: profile.dataRequirements.htfContextKey,
      fallbackHtfKeys: [...(profile.dataRequirements.fallbackHtfKeys || [])],
      defaultTimeframe: profile.dataRequirements.defaultTimeframe,
      htfTimeframeField: profile.dataRequirements.htfTimeframeField || 'htfTimeframe'
    },
    adminPanel: profile.adminPanel || (profile.status === 'stub' ? 'stub' : profile.key)
  };
}

/**
 * Snapshot profile fields commonly shown in admin / API catalogs.
 * @param {StrategyProfile} profile
 * @param {Object} [runtime] - resolved enabled + config highlights
 */
function toCatalogEntry(profile, runtime = {}) {
  return {
    id: profile.id,
    key: profile.key,
    name: profile.name,
    description: profile.description || '',
    enabled: runtime.enabled !== undefined ? Boolean(runtime.enabled) : profile.enabled !== false,
    priority: profile.priority,
    version: profile.version,
    status: profile.status,
    entryTimeframes: [...(runtime.entryTimeframes || profile.entryTimeframes || [])],
    higherTimeframes: [...(runtime.higherTimeframes || profile.higherTimeframes || [])],
    defaultEntryTimeframe:
      runtime.defaultEntryTimeframe || profile.defaultEntryTimeframe || null,
    adminPanel: profile.adminPanel || profile.key,
    configurable: profile.status === 'live'
  };
}

module.exports = {
  assertStrategyProfile,
  normalizeStrategyProfile,
  toCatalogEntry
};
