/**
 * StrategyRegistry — DI container for pluggable IStrategy runners.
 * Instances are created from Strategy Profiles (engine); no hardcoded strategy list.
 */

const { assertStrategy } = require('./interfaces/IStrategy');

class StrategyRegistry {
  constructor() {
    /** @type {Map<string, import('./interfaces/IStrategy').IStrategy>} */
    this._strategies = new Map();
  }

  register(strategy) {
    assertStrategy(strategy);
    this._strategies.set(strategy.id, strategy);
    return this;
  }

  get(id) {
    return this._strategies.get(id) || null;
  }

  list() {
    return [...this._strategies.values()];
  }

  listEnabled() {
    return this.list().filter(s => s.enabled !== false);
  }

  /**
   * @param {import('./types').StrategyContext} context
   * @param {{ prefer?: string, mode?: 'first_hit'|'all' }} [options]
   */
  analyzeAll(context, options = {}) {
    const mode = options.mode || 'first_hit';
    const enabled = this.listEnabled();

    const ordered = options.prefer
      ? [
          ...enabled.filter(s => s.id === options.prefer),
          ...enabled.filter(s => s.id !== options.prefer)
        ]
      : enabled;

    /** @type {Object[]} */
    const results = [];

    for (const strategy of ordered) {
      const result = strategy.analyze(context);
      results.push({ strategyId: strategy.id, strategyName: strategy.name, ...result });

      if (mode === 'first_hit' && result.signal && result.entry) {
        return {
          signal: true,
          stage: 'entry',
          entry: result.entry,
          strategyId: strategy.id,
          results
        };
      }
    }

    const pendingHit = results.find(r => r.stage === 'pending_retrace' && r.pending);
    if (pendingHit) {
      return {
        signal: false,
        stage: 'pending_retrace',
        pending: pendingHit.pending,
        strategyId: pendingHit.strategyId,
        results
      };
    }

    return { signal: false, stage: 'none', results };
  }

  clear() {
    this._strategies.clear();
  }
}

/**
 * Build IStrategy registry from Strategy Profile catalog.
 * Config options keep BC keys: scalpingConfig / daytradingConfig.
 * @param {Object} [options]
 */
function createDefaultRegistry(options = {}) {
  const {
    bootstrapStrategyProfiles,
    getProfileRegistry,
    bindScannerEngineToStrategyRegistry,
    resetScannerEngine
  } = require('./engine');

  bootstrapStrategyProfiles(undefined, { force: true, includeStubs: true });
  const profiles = getProfileRegistry().listExecutable();

  const registry = new StrategyRegistry();
  for (const profile of profiles) {
    // BC: options.scalpingConfig / options.daytradingConfig
    const configKey = `${profile.key}Config`;
    const config =
      options[configKey] !== undefined
        ? options[configKey]
        : options.configs?.[profile.key] !== undefined
          ? options.configs[profile.key]
          : typeof profile.resolveConfig === 'function'
            ? profile.resolveConfig(options.overrides?.[profile.key] || {})
            : {};

    // Respect runtime enabled flag from resolved config
    const instance = profile.createInstance(config);
    registry.register(instance);
  }

  // Keep ScannerEngine bound to the fresh IStrategy registry
  try {
    resetScannerEngine();
    bindScannerEngineToStrategyRegistry(registry);
  } catch (_) {
    /* engine optional at boot */
  }

  return registry;
}

let _defaultRegistry = null;

function getDefaultRegistry() {
  if (!_defaultRegistry) {
    let options = {};
    try {
      options = require('../utils/strategyRuntimeConfig').getRegistryOptions();
    } catch (_) {
      options = {};
    }
    _defaultRegistry = createDefaultRegistry(options);
  }
  return _defaultRegistry;
}

function resetDefaultRegistry() {
  _defaultRegistry = null;
  try {
    require('./engine').resetScannerEngine();
  } catch (_) {
    /* ignore */
  }
}

function setDefaultRegistry(registry) {
  _defaultRegistry = registry || null;
  try {
    if (_defaultRegistry) {
      require('./engine').bindScannerEngineToStrategyRegistry(_defaultRegistry);
    } else {
      require('./engine').resetScannerEngine();
    }
  } catch (_) {
    /* ignore */
  }
  return _defaultRegistry;
}

module.exports = {
  StrategyRegistry,
  createDefaultRegistry,
  getDefaultRegistry,
  resetDefaultRegistry,
  setDefaultRegistry
};
