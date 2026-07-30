/**
 * ScannerEngine — generic profile-driven scanning loop.
 *
 * Flow per enabled strategy:
 *   Load profile → build context → run detection (via IStrategy.analyze) → result
 *
 * No `if (strategy === 'scalping')` in the core loop; context/HTF/TF come from profile.
 */

const { buildStrategyContext, resolveHtfCandles } = require('./contextBuilder');
const { getProfileRegistry } = require('./StrategyProfileRegistry');

class ScannerEngine {
  /**
   * @param {Object} [options]
   * @param {import('./StrategyProfileRegistry').StrategyProfileRegistry} [options.profileRegistry]
   * @param {import('../registry').StrategyRegistry} [options.strategyRegistry]
   */
  constructor(options = {}) {
    this.profileRegistry = options.profileRegistry || getProfileRegistry();
    this.strategyRegistry = options.strategyRegistry || null;
  }

  /**
   * Resolve an IStrategy runner for a profile (from DI registry or factory).
   * @param {import('./StrategyProfile').StrategyProfile} profile
   * @param {Object} [config]
   */
  resolveRunner(profile, config) {
    if (this.strategyRegistry) {
      const existing = this.strategyRegistry.get(profile.id);
      if (existing) return existing;
    }
    if (typeof profile.createInstance === 'function') {
      return profile.createInstance(config || {});
    }
    return null;
  }

  /**
   * Run a single strategy profile against market data.
   * @param {string|import('./StrategyProfile').StrategyProfile} profileOrId
   * @param {Object} market
   * @param {Object} [options]
   */
  run(profileOrId, market = {}, options = {}) {
    const profile =
      typeof profileOrId === 'string'
        ? this.profileRegistry.getById(profileOrId) ||
          this.profileRegistry.getByKey(profileOrId)
        : profileOrId;

    if (!profile) {
      return { signal: false, stage: 'none', reason: 'unknown_profile' };
    }
    if (profile.status === 'stub') {
      return {
        signal: false,
        stage: 'stub',
        reason: 'strategy_not_implemented',
        strategyId: profile.id,
        strategyName: profile.name
      };
    }
    if (profile.enabled === false && options.ignoreEnabled !== true) {
      return {
        signal: false,
        stage: 'disabled',
        reason: 'strategy_disabled',
        strategyId: profile.id,
        strategyName: profile.name
      };
    }

    const runner = this.resolveRunner(profile, options.config);
    if (!runner || typeof runner.analyze !== 'function') {
      return {
        signal: false,
        stage: 'none',
        reason: 'no_runner',
        strategyId: profile.id,
        strategyName: profile.name
      };
    }

    const context = buildStrategyContext(profile, market, options.contextOverrides || {});
    const result = runner.analyze(context);
    return {
      strategyId: profile.id,
      strategyName: profile.name,
      strategyKey: profile.key,
      strategyVersion: profile.version,
      ...result
    };
  }

  /**
   * Iterate enabled live profiles generically (first_hit | all).
   * @param {Object} market
   * @param {{ prefer?: string, mode?: 'first_hit'|'all', configs?: Object }} [options]
   */
  runEnabled(market = {}, options = {}) {
    const mode = options.mode || 'first_hit';
    let enabled = this.profileRegistry.listEnabled();

    // Prefer short key or full id without hardcoding strategy names
    const preferId = this.profileRegistry.resolveId(options.prefer);
    if (preferId) {
      enabled = [
        ...enabled.filter(p => p.id === preferId),
        ...enabled.filter(p => p.id !== preferId)
      ];
    }

    const results = [];
    for (const profile of enabled) {
      const config = options.configs?.[profile.key];
      const result = this.run(profile, market, { config, ignoreEnabled: true });
      results.push(result);

      if (mode === 'first_hit' && result.signal && result.entry) {
        return {
          signal: true,
          stage: 'entry',
          entry: result.entry,
          strategyId: profile.id,
          strategyName: profile.name,
          strategyKey: profile.key,
          strategyVersion: profile.version,
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
        strategyName: pendingHit.strategyName,
        strategyKey: pendingHit.strategyKey,
        strategyVersion: pendingHit.strategyVersion,
        results
      };
    }

    return { signal: false, stage: 'none', results };
  }

  /**
   * Continue a pending setup using the profile that created it (no name branching).
   * @param {string} strategyId
   * @param {Object[]} candles
   * @param {Object} pending
   * @param {Object} market
   * @param {Object} [options]
   */
  continuePending(strategyId, candles, pending, market = {}, options = {}) {
    const profile =
      this.profileRegistry.getById(strategyId) || this.profileRegistry.getByKey(strategyId);
    if (!profile || profile.status === 'stub') {
      return { stage: 'rejected', reason: 'unknown_or_stub_strategy' };
    }

    const runner = this.resolveRunner(profile, options.config);
    if (!runner || typeof runner.continuePending !== 'function') {
      return { stage: 'rejected', reason: 'no_continue_pending' };
    }

    const context = buildStrategyContext(profile, market, {
      ...(options.contextOverrides || {}),
      candles
    });
    const result = runner.continuePending(candles, pending, context);
    return {
      strategyId: profile.id,
      strategyName: profile.name,
      strategyKey: profile.key,
      strategyVersion: profile.version,
      ...result
    };
  }

  /** Expose HTF resolution for MarketScannerService candle fetches. */
  resolveHtfCandles(profileOrId, market) {
    const profile =
      typeof profileOrId === 'string'
        ? this.profileRegistry.getById(profileOrId) ||
          this.profileRegistry.getByKey(profileOrId)
        : profileOrId;
    if (!profile) return [];
    return resolveHtfCandles(profile, market);
  }

  getDefaultTimeframe(profileOrId) {
    const profile =
      typeof profileOrId === 'string'
        ? this.profileRegistry.getById(profileOrId) ||
          this.profileRegistry.getByKey(profileOrId)
        : profileOrId;
    return profile?.dataRequirements?.defaultTimeframe || null;
  }
}

/** Shared engine bound to default registries (lazy). */
let _defaultEngine = null;

function getScannerEngine(options = {}) {
  if (options.profileRegistry || options.strategyRegistry) {
    return new ScannerEngine(options);
  }
  if (!_defaultEngine) {
    let strategyRegistry = null;
    try {
      strategyRegistry = require('../registry').getDefaultRegistry();
    } catch (_) {
      strategyRegistry = null;
    }
    _defaultEngine = new ScannerEngine({
      profileRegistry: getProfileRegistry(),
      strategyRegistry
    });
  } else if (options.refreshStrategyRegistry) {
    try {
      _defaultEngine.strategyRegistry = require('../registry').getDefaultRegistry();
    } catch (_) {
      /* keep */
    }
  }
  return _defaultEngine;
}

function resetScannerEngine() {
  _defaultEngine = null;
}

function bindScannerEngineToStrategyRegistry(strategyRegistry) {
  const engine = getScannerEngine();
  engine.strategyRegistry = strategyRegistry;
  return engine;
}

module.exports = {
  ScannerEngine,
  getScannerEngine,
  resetScannerEngine,
  bindScannerEngineToStrategyRegistry
};
