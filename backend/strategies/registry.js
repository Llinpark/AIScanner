/**
 * StrategyRegistry — DI container for pluggable strategies.
 * Registers: Sweep+FVG Day Trading, Sweep+FVG Scalping, legacy SMC pipeline.
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

function createDefaultRegistry(options = {}) {
  const { DayTradingStrategy } = require('./DayTradingStrategy');
  const { ScalpingStrategy } = require('./ScalpingStrategy');
  const { LegacySmcPipelineStrategy } = require('./LegacySmcPipelineStrategy');

  const registry = new StrategyRegistry();
  // New Sweep+FVG daytrading first (preferred for 15m/5m contexts)
  registry.register(new DayTradingStrategy({ config: options.daytradingConfig }));
  registry.register(new ScalpingStrategy({ config: options.scalpingConfig }));
  // Legacy SMC pipeline kept for diagnostics / backward compatibility
  registry.register(
    new LegacySmcPipelineStrategy({
      config: options.legacySmcConfig,
      enabled: options.enableLegacySmc !== false
    })
  );
  return registry;
}

let _defaultRegistry = null;

function getDefaultRegistry() {
  if (!_defaultRegistry) {
    let options = {};
    try {
      // Prefer live admin/runtime overrides when available
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
}

function setDefaultRegistry(registry) {
  _defaultRegistry = registry || null;
  return _defaultRegistry;
}

module.exports = {
  StrategyRegistry,
  createDefaultRegistry,
  getDefaultRegistry,
  resetDefaultRegistry,
  setDefaultRegistry
};
