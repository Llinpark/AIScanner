/**
 * Backend feature flags for future Pine-stable-client decisions.
 *
 * ALL FLAGS DEFAULT OFF — no production behaviour change when unset.
 * Flags must never gate auth, webhook ingest, or delivery while OFF.
 *
 * Activation is explicit env only (or test overrides). Not set by pine-gen,
 * registry, webhook payloads, or admin UI. Not present in .env.example.
 *
 * Env (optional, case-insensitive true/1/yes/on):
 *   ENABLE_ADAPTIVE_TF
 *   ENABLE_DYNAMIC_TP
 *   ENABLE_SMART_SCORE
 *   ENABLE_TREND_BIAS
 *   ENABLE_LIQUIDITY_RANKING
 *   ENABLE_ATR_TARGETS
 */

'use strict';

const FLAG_KEYS = Object.freeze([
  'enableAdaptiveTF',
  'enableDynamicTP',
  'enableSmartScore',
  'enableTrendBias',
  'enableLiquidityRanking',
  'enableATRTargets'
]);

const ENV_MAP = Object.freeze({
  enableAdaptiveTF: 'ENABLE_ADAPTIVE_TF',
  enableDynamicTP: 'ENABLE_DYNAMIC_TP',
  enableSmartScore: 'ENABLE_SMART_SCORE',
  enableTrendBias: 'ENABLE_TREND_BIAS',
  enableLiquidityRanking: 'ENABLE_LIQUIDITY_RANKING',
  enableATRTargets: 'ENABLE_ATR_TARGETS'
});

/** @type {Record<string, boolean>|null} */
let overrideFlags = null;

function parseBool(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return defaultValue;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, boolean>}
 */
function readFlagsFromEnv(env = process.env) {
  const flags = {};
  for (const key of FLAG_KEYS) {
    flags[key] = parseBool(env[ENV_MAP[key]], false);
  }
  return flags;
}

/**
 * Snapshot of current flags (defaults all false unless env/override set).
 * @returns {Readonly<Record<string, boolean>>}
 */
function getFeatureFlags() {
  const base = readFlagsFromEnv();
  if (overrideFlags) {
    return Object.freeze({ ...base, ...overrideFlags });
  }
  return Object.freeze(base);
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isFeatureEnabled(name) {
  const flags = getFeatureFlags();
  if (!(name in flags)) return false;
  return Boolean(flags[name]);
}

/**
 * Test-only override. Pass null to clear.
 * @param {Partial<Record<string, boolean>>|null} partial
 */
function setFeatureFlagOverrides(partial) {
  if (partial == null) {
    overrideFlags = null;
    return;
  }
  const next = {};
  for (const key of FLAG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(partial, key)) {
      next[key] = Boolean(partial[key]);
    }
  }
  overrideFlags = next;
}

function resetFeatureFlagsForTests() {
  overrideFlags = null;
}

module.exports = {
  FLAG_KEYS,
  ENV_MAP,
  getFeatureFlags,
  isFeatureEnabled,
  setFeatureFlagOverrides,
  resetFeatureFlagsForTests,
  readFlagsFromEnv
};
