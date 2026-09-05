/**
 * Bootstrap — register all Strategy Profiles into the default profile registry.
 * Idempotent: safe to call on every registry rebuild.
 */

const {
  StrategyProfileRegistry,
  getProfileRegistry,
  setProfileRegistry
} = require('./StrategyProfileRegistry');
const { createScalpingProfile, createDayTradingProfile } = require('./liveProfiles');
const { createStubProfiles } = require('./stubProfiles');

let _bootstrapped = false;

/**
 * @param {StrategyProfileRegistry} [registry]
 * @param {{ includeStubs?: boolean, force?: boolean }} [options]
 */
function bootstrapStrategyProfiles(registry, options = {}) {
  const target = registry || getProfileRegistry();
  const includeStubs = options.includeStubs !== false;

  if (_bootstrapped && !options.force && !registry) {
    return target;
  }

  // Clear only when forcing a rebuild of the default registry
  if (options.force || !_bootstrapped) {
    if (!registry) target.clear();
  }

  target.registerStrategy(createScalpingProfile());
  target.registerStrategy(createDayTradingProfile());

  if (includeStubs) {
    for (const stub of createStubProfiles()) {
      target.registerStrategy(stub);
    }
  }

  if (!registry) {
    setProfileRegistry(target);
    _bootstrapped = true;
  }
  return target;
}

function resetBootstrapFlag() {
  _bootstrapped = false;
}

/**
 * Map admin activeStrategy short key → full strategy id via profile registry.
 * Falls back to scalping id for unknown/stub prefer keys.
 */
function resolvePreferStrategyId(preferKey, fallbackId = 'liquidity_sweep_fvg_scalp') {
  bootstrapStrategyProfiles();
  const registry = getProfileRegistry();
  const resolved = registry.resolveId(preferKey);
  if (!resolved) return fallbackId;
  const profile = registry.getById(resolved);
  // Prefer must be a live executable strategy for analyzeAll
  if (!profile || profile.status === 'stub') return fallbackId;
  return resolved;
}

/** Live short keys that can be activeStrategy for analyze prefer. */
function getLiveStrategyKeys() {
  bootstrapStrategyProfiles();
  return getProfileRegistry()
    .listLive()
    .map(p => p.key);
}

module.exports = {
  bootstrapStrategyProfiles,
  resetBootstrapFlag,
  resolvePreferStrategyId,
  getLiveStrategyKeys
};
