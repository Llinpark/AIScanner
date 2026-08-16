/**
 * Pine client versioning + capability negotiation.
 *
 * Additive metadata only. Missing / unparseable version ⇒ Legacy Mode.
 * Never rejects old Pine clients. Unknown capabilities are ignored.
 *
 * Compatibility modes (major-family contract):
 * - LEGACY  — missing / unparseable / older major than PINE_CLIENT_VERSION
 * - CURRENT — same major as PINE_CLIENT_VERSION (e.g. 1.0.0–1.2.0 when stamp is 1.2.0)
 * - FUTURE  — higher major than stamp (accepted; new gates stay off until flagged)
 *
 * CURRENT clients still use the Pine-authoritative decision path today
 * (backend does not rescore / rewrite / filter while feature flags are OFF).
 */

'use strict';

/** Semver stamped into newly generated Pine + webhook payloads. */
const PINE_CLIENT_VERSION = '1.2.1';

/**
 * Capabilities actually supported by CURRENT generated Pine today.
 * Do NOT advertise future caps (factors_v1, atr_context, …) until Pine emits them.
 */
const CURRENT_PINE_CAPABILITIES = Object.freeze([
  'v1_payload',
  'sl_risk_v1',
  'replace_active_v1',
  'json_esc_v1',
  'canonical_tf_v1',
  'event_bridge_v1'
]);

/** Known capability tokens the backend understands (future negotiation). */
const KNOWN_CAPABILITIES = Object.freeze([
  'v1_payload',
  'sl_risk_v1',
  'replace_active_v1',
  'json_esc_v1',
  'canonical_tf_v1',
  'event_bridge_v1',
  'factors_v1',
  'adaptive_tf',
  'dynamic_tp',
  'smart_score',
  'liquidity_targets',
  'trend_bias',
  'atr_context',
  'context_atr',
  'provisional_tps'
]);

const COMPAT_MODE = Object.freeze({
  LEGACY: 'legacy',
  CURRENT: 'current',
  FUTURE: 'future'
});

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function parseCapabilities(value) {
  if (value == null || value === '') return [];

  let raw = value;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        raw = JSON.parse(trimmed);
      } catch {
        raw = trimmed.split(/[,\s]+/);
      }
    } else {
      raw = trimmed.split(/[,\s]+/);
    }
  }

  if (!Array.isArray(raw)) {
    if (typeof raw === 'object') {
      raw = Object.keys(raw).filter((k) => raw[k]);
    } else {
      raw = [raw];
    }
  }

  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const cap = String(item || '')
      .trim()
      .toLowerCase();
    if (!cap || seen.has(cap)) continue;
    seen.add(cap);
    out.push(cap);
  }
  return out;
}

/**
 * Keep only capabilities the backend knows about; unknown are ignored (not rejected).
 * @param {unknown} value
 * @returns {string[]}
 */
function negotiateCapabilities(value) {
  const parsed = parseCapabilities(value);
  return parsed.filter((cap) => KNOWN_CAPABILITIES.includes(cap));
}

/**
 * @param {unknown} version
 * @returns {string|null} normalized semver-ish string or null if missing/invalid
 */
function normalizePineClientVersion(version) {
  if (version == null || version === '') return null;
  const s = String(version).trim();
  if (!s) return null;
  // Accept "1", "1.0", "1.0.0", "1.0.0-prep", "v1.0.0"
  const cleaned = s.replace(/^v/i, '');
  if (!/^\d+(\.\d+){0,2}(-[A-Za-z0-9.-]+)?$/.test(cleaned)) return null;
  return cleaned;
}

/**
 * Compare major.minor.patch numerically (prerelease suffix ignored for ranking).
 * @param {string} a
 * @param {string} b
 * @returns {number} -1 | 0 | 1
 */
function compareVersions(a, b) {
  const parse = (v) => {
    const core = String(v).split('-')[0];
    const parts = core.split('.').map((n) => parseInt(n, 10) || 0);
    while (parts.length < 3) parts.push(0);
    return parts;
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

/**
 * Resolve compatibility mode from payload version.
 * Missing / unparseable ⇒ LEGACY (never reject).
 * Same major as stamp ⇒ CURRENT (includes older minors/patches in that major, e.g. 1.0.0 when stamp is 1.1.0).
 * Greater major ⇒ FUTURE (still accepted; new gates stay off until flagged).
 * Older major ⇒ LEGACY (still accepted).
 *
 * Mode is diagnostic / future negotiation only — never blocks auth, persist, or delivery.
 *
 * @param {unknown} version
 * @returns {{ mode: string, pineClientVersion: string|null, isLegacy: boolean }}
 */
function resolveCompatibilityMode(version) {
  const normalized = normalizePineClientVersion(version);
  if (!normalized) {
    return {
      mode: COMPAT_MODE.LEGACY,
      pineClientVersion: null,
      isLegacy: true
    };
  }

  const currentMajor = parseInt(String(PINE_CLIENT_VERSION).split('.')[0], 10) || 1;
  const clientMajor = parseInt(String(normalized).split('.')[0], 10) || 0;

  if (clientMajor > currentMajor) {
    return {
      mode: COMPAT_MODE.FUTURE,
      pineClientVersion: normalized,
      isLegacy: false
    };
  }

  if (clientMajor < currentMajor) {
    return {
      mode: COMPAT_MODE.LEGACY,
      pineClientVersion: normalized,
      isLegacy: true
    };
  }

  // Same major family as the generator stamp (1.x while stamp is 1.2.0).
  return {
    mode: COMPAT_MODE.CURRENT,
    pineClientVersion: normalized,
    isLegacy: false
  };
}

/**
 * Extract version + capabilities from a webhook body (additive; never required).
 * @param {object} body
 */
function extractPineClientMeta(body = {}) {
  const version =
    body.pineClientVersion ??
    body.pine_client_version ??
    body.clientVersion ??
    body.client_version ??
    null;
  const capabilitiesRaw =
    body.capabilities ?? body.caps ?? body.pineCapabilities ?? body.pine_capabilities ?? null;
  const scriptGenerationId =
    body.scriptGenerationId ??
    body.script_generation_id ??
    body.generationId ??
    body.generation_id ??
    null;
  const generatedAt = body.generatedAt ?? body.generated_at ?? null;

  const compat = resolveCompatibilityMode(version);
  const capabilities = negotiateCapabilities(capabilitiesRaw);
  const allCapabilities = parseCapabilities(capabilitiesRaw);

  return {
    pineClientVersion: compat.pineClientVersion,
    mode: compat.mode,
    isLegacy: compat.isLegacy,
    capabilities,
    unknownCapabilities: allCapabilities.filter((c) => !KNOWN_CAPABILITIES.includes(c)),
    scriptGenerationId: scriptGenerationId != null ? String(scriptGenerationId) : null,
    generatedAt: generatedAt != null ? String(generatedAt) : null
  };
}

/**
 * JSON array literal for Pine template injection (no surrounding quotes).
 * @param {string[]} [caps]
 */
function capabilitiesJsonLiteral(caps = CURRENT_PINE_CAPABILITIES) {
  return JSON.stringify(Array.isArray(caps) ? caps : CURRENT_PINE_CAPABILITIES);
}

module.exports = {
  PINE_CLIENT_VERSION,
  CURRENT_PINE_CAPABILITIES,
  KNOWN_CAPABILITIES,
  COMPAT_MODE,
  parseCapabilities,
  negotiateCapabilities,
  normalizePineClientVersion,
  compareVersions,
  resolveCompatibilityMode,
  extractPineClientMeta,
  capabilitiesJsonLiteral
};
