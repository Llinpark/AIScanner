/**
 * StrategyProfileRegistry — plugin registry for Strategy Profiles.
 * Scanner Engine loads enabled profiles from here; never hardcodes strategy lists.
 */

const { assertStrategyProfile, normalizeStrategyProfile, toCatalogEntry } = require('./StrategyProfile');

class StrategyProfileRegistry {
  constructor() {
    /** @type {Map<string, import('./StrategyProfile').StrategyProfile>} */
    this._byId = new Map();
    /** @type {Map<string, string>} key → id */
    this._keyToId = new Map();
  }

  /**
   * @param {import('./StrategyProfile').StrategyProfile|Object} profile
   */
  registerStrategy(profile) {
    const normalized = normalizeStrategyProfile(profile);
    assertStrategyProfile(normalized);
    this._byId.set(normalized.id, normalized);
    this._keyToId.set(normalized.key, normalized.id);
    return this;
  }

  /** Alias matching target architecture naming. */
  register(profile) {
    return this.registerStrategy(profile);
  }

  getById(id) {
    return this._byId.get(id) || null;
  }

  getByKey(key) {
    const id = this._keyToId.get(key);
    return id ? this.getById(id) : null;
  }

  /**
   * Resolve prefer target: accepts short key or full id.
   * @param {string} prefer
   * @returns {string|null} full strategy id
   */
  resolveId(prefer) {
    if (!prefer) return null;
    const raw = String(prefer).trim();
    if (this._byId.has(raw)) return raw;
    const byKey = this._keyToId.get(raw);
    if (byKey) return byKey;
    const lower = raw.toLowerCase();
    if (this._byId.has(lower)) return lower;
    const byKeyLower = this._keyToId.get(lower);
    return byKeyLower || null;
  }

  list() {
    return [...this._byId.values()].sort((a, b) => (a.priority || 100) - (b.priority || 100));
  }

  listLive() {
    return this.list().filter(p => p.status === 'live');
  }

  listEnabled() {
    return this.list().filter(p => p.enabled !== false && p.status === 'live');
  }

  /** Profiles that can be instantiated into IStrategy runners. */
  listExecutable() {
    return this.listLive().filter(p => typeof p.createInstance === 'function');
  }

  catalog(runtimeByKey = {}) {
    return this.list().map(p => toCatalogEntry(p, runtimeByKey[p.key]));
  }

  clear() {
    this._byId.clear();
    this._keyToId.clear();
  }
}

/** @type {StrategyProfileRegistry|null} */
let _defaultProfileRegistry = null;

function getProfileRegistry() {
  if (!_defaultProfileRegistry) {
    _defaultProfileRegistry = new StrategyProfileRegistry();
  }
  return _defaultProfileRegistry;
}

function setProfileRegistry(registry) {
  _defaultProfileRegistry = registry || null;
  return _defaultProfileRegistry;
}

function resetProfileRegistry() {
  _defaultProfileRegistry = null;
}

module.exports = {
  StrategyProfileRegistry,
  getProfileRegistry,
  setProfileRegistry,
  resetProfileRegistry
};
