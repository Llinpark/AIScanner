/**
 * Canonical license-token signer/verifier.
 *
 * Contract: kls_v2.<base64url(payload)>.<base64url(HMAC-SHA256)>
 * Legacy verify-only: kls_v1.<payload>.<signature> (no env claim).
 *
 * Payload contains only non-secret metadata. Secrets never go in the token.
 * Algorithm is implicit HMAC-SHA256 — a token-supplied alg is allowlisted only.
 *
 * This module must not import Mongo, Redis, PipelineStatus, Telegram, Email, or MT5.
 */

const crypto = require('crypto');

const TOKEN_PREFIX_V2 = 'kls_v2';
const TOKEN_PREFIX_V1 = 'kls_v1';
const ALLOWED_PREFIXES = new Set([TOKEN_PREFIX_V2, TOKEN_PREFIX_V1]);
const TOKEN_PAYLOAD_VERSION = 2;
const ALGORITHM = 'sha256';
const ALLOWED_ALGORITHMS = new Set(['sha256', 'HS256', 'hmac-sha256']);
const ISSUER = 'kaching-license';
const ALLOWED_ENVS = new Set(['production', 'development', 'test']);
const NON_PRODUCTION_ENVS = new Set(['development', 'test', 'local', 'smoke']);
const CRYPTO_PROBE_UID = 'internal-crypto-probe';
const CRYPTO_PROBE_TVU = 'internal_crypto_probe';

let lastCryptoSelfCheck = null;

function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function normalizeTradingViewUsername(value) {
  return String(value || '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase();
}

function isSmokeOrDevSigningSecret(secret) {
  return /smoke-test-license|smoke-optiona|localhost-dev-signing/i.test(String(secret || ''));
}

function isSmokeOrDevIdentity(userId, tradingviewUsername) {
  const uid = String(userId || '');
  const tvu = String(tradingviewUsername || '');
  return /smoke|optiona-local|localhost/i.test(uid) || /smoke_optiona|localhost/i.test(tvu);
}

function isInternalProbeIdentity(userId, tradingviewUsername) {
  return (
    String(userId || '') === CRYPTO_PROBE_UID ||
    normalizeTradingViewUsername(tradingviewUsername) === CRYPTO_PROBE_TVU
  );
}

function resolveTokenEnvironment(explicit) {
  if (explicit && ALLOWED_ENVS.has(explicit)) return explicit;
  if (process.env.NODE_ENV === 'production') return 'production';
  if (process.env.NODE_ENV === 'test') return 'test';
  return 'development';
}

function isProductionRuntime(runtimeEnv) {
  return String(runtimeEnv || process.env.NODE_ENV) === 'production';
}

/**
 * License tokens use WEBHOOK_SIGNING_SECRET only.
 * No silent fallback to TRADINGVIEW_WEBHOOK_SECRET or JWT_SECRET.
 */
function getLicenseSigningSecret() {
  return process.env.WEBHOOK_SIGNING_SECRET || '';
}

function maskTvu(value) {
  const s = String(value || '');
  if (!s) return null;
  if (s.length <= 4) return `${s.slice(0, 1)}***`;
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

function emptyDiagnostics() {
  return {
    present: false,
    length: 0,
    parts: 0,
    prefix: '',
    prefixOk: false,
    tokenVersion: null,
    tokenEnvironment: null,
    scriptGenerationId: null,
    hasCR: false,
    hasLF: false,
    hasSpace: false,
    reason: null,
    hmacMatch: 'none',
    decodeOk: false,
    payloadVersion: null,
    uidLen: null,
    tvuMasked: null,
    iat: null,
    issuer: null
  };
}

function safeDiagnostics(info) {
  return {
    present: Boolean(info.present),
    length: info.length || 0,
    parts: info.parts || 0,
    prefix: info.prefix || '',
    prefixOk: Boolean(info.prefixOk),
    tokenVersion: info.tokenVersion || info.prefix || null,
    tokenEnvironment: info.tokenEnvironment || null,
    scriptGenerationId: info.scriptGenerationId || null,
    hasCR: Boolean(info.hasCR),
    hasLF: Boolean(info.hasLF),
    hasSpace: Boolean(info.hasSpace),
    reason: info.reason || null,
    hmacMatch: info.hmacMatch || 'none',
    decodeOk: Boolean(info.decodeOk),
    payloadVersion: info.payloadVersion ?? null,
    uidLen: info.uidLen ?? null,
    tvuMasked: info.tvuMasked || null,
    iat: info.iat ?? null,
    issuer: info.issuer || null
  };
}

function hmacFor(encoded, secret) {
  return crypto.createHmac(ALGORITHM, secret).update(encoded).digest('base64url');
}

function decodePayload(encoded) {
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
}

/**
 * Transport-only token cleanup: outer whitespace / CR / LF / BOM.
 * Does not mutate token contents internally (no inner character rewrite).
 */
function normalizeLicenseTokenTransport(token) {
  if (token == null) return '';
  return String(token).replace(/^\uFEFF/, '').replace(/^[\s\r\n]+|[\s\r\n]+$/g, '');
}

function inspectToken(token) {
  const original = String(token || '');
  const raw = normalizeLicenseTokenTransport(token);
  const parts = raw.split('.');
  const info = {
    ...emptyDiagnostics(),
    present: Boolean(raw),
    length: raw.length,
    parts: raw ? parts.length : 0,
    prefix: parts[0] ? String(parts[0]).slice(0, 16) : '',
    prefixOk: ALLOWED_PREFIXES.has(parts[0]),
    tokenVersion: parts[0] || null,
    hasCR: /\r/.test(original),
    hasLF: /\n/.test(original),
    hasSpace: /\s/.test(original),
    payload: null
  };

  if (!raw) {
    info.reason = 'missing_token';
    return info;
  }
  if (parts.length !== 3) {
    info.reason = 'malformed_part_count';
    return info;
  }
  if (!ALLOWED_PREFIXES.has(parts[0])) {
    info.reason = 'wrong_prefix';
    return info;
  }

  const [, encoded, signature] = parts;
  try {
    const payload = decodePayload(encoded);
    info.decodeOk = true;
    info.payload = payload && typeof payload === 'object' ? payload : null;
    info.payloadVersion = payload?.v ?? null;
    info.tokenEnvironment = payload?.env != null ? String(payload.env) : null;
    info.scriptGenerationId =
      payload?.scriptGenerationId != null ? String(payload.scriptGenerationId) : null;
    info.uidLen = payload?.uid != null ? String(payload.uid).length : null;
    info.tvuMasked = maskTvu(payload?.tvu);
    info.iat = Number.isFinite(payload?.iat) ? payload.iat : null;
    info.issuer = payload?.issuer != null ? String(payload.issuer) : null;
  } catch {
    info.reason = 'decode_fail';
  }

  const candidates = [
    ['webhook_signing_secret', process.env.WEBHOOK_SIGNING_SECRET],
    ['tradingview_webhook_secret', process.env.TRADINGVIEW_WEBHOOK_SECRET],
    ['jwt_secret', process.env.JWT_SECRET]
  ];
  for (const [name, secret] of candidates) {
    if (!secret) continue;
    const expected = hmacFor(encoded, secret);
    if (timingSafeEqualString(signature, expected)) {
      info.hmacMatch = name;
      break;
    }
  }

  if (info.hmacMatch === 'none' && !info.reason) {
    info.reason = 'hmac_mismatch';
  } else if (info.hmacMatch !== 'none' && info.hmacMatch !== 'webhook_signing_secret') {
    info.reason = info.reason || `hmac_wrong_secret:${info.hmacMatch}`;
  }

  return info;
}

function isNonProductionPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const env = String(payload.env || '').toLowerCase();
  if (NON_PRODUCTION_ENVS.has(env)) return true;
  if (isSmokeOrDevIdentity(payload.uid, payload.tvu)) return true;
  return false;
}

function normalizeClaims(payload) {
  const claims = { ...payload };
  if (claims.tvu) claims.tvu = normalizeTradingViewUsername(claims.tvu);
  return claims;
}

/**
 * Safe metadata for a license token. Never returns the token or any secret.
 * Does not grant auth — HMAC matches against named env secrets are diagnostic only.
 */
function diagnoseLicenseToken(token) {
  const info = inspectToken(token);
  if (!getLicenseSigningSecret() && info.present && !info.reason) {
    info.reason = 'missing_signing_secret';
  }
  return safeDiagnostics(info);
}

function failVerify(reason, info) {
  return {
    ok: false,
    claims: null,
    reason,
    diagnostics: safeDiagnostics({ ...info, reason })
  };
}

/**
 * @param {string} token
 * @param {{ runtimeEnv?: string }} [options]
 */
function verifyLicenseTokenDetailed(token, options = {}) {
  const runtimeEnv = options.runtimeEnv || process.env.NODE_ENV || 'development';
  const productionRuntime = isProductionRuntime(runtimeEnv);
  const normalized = normalizeLicenseTokenTransport(token);
  const info = inspectToken(token);

  if (!token || !normalized) return failVerify('licenseToken_absent', info);
  if (!getLicenseSigningSecret()) return failVerify('missing_signing_secret', info);
  if (!info.present) return failVerify('licenseToken_absent', info);
  if (info.parts !== 3 || !info.prefixOk || info.reason === 'decode_fail') {
    return failVerify('invalid_license_token', info);
  }

  if (productionRuntime && isNonProductionPayload(info.payload)) {
    return failVerify('non_production_license_token', info);
  }

  const signingSecret = getLicenseSigningSecret();
  const parts = normalized.split('.');
  const encoded = parts[1];
  const signature = parts[2];
  const expected = hmacFor(encoded, signingSecret);
  if (!timingSafeEqualString(signature, expected)) {
    return failVerify('invalid_license_token', info);
  }

  const payload = info.payload;
  if (!payload?.uid) {
    return failVerify('invalid_license_token', { ...info, reason: 'missing_uid' });
  }
  if (payload.alg != null && !ALLOWED_ALGORITHMS.has(String(payload.alg))) {
    return failVerify('invalid_license_token', { ...info, reason: 'algorithm_not_allowed' });
  }
  if (info.prefix === TOKEN_PREFIX_V2) {
    if (!payload.env) {
      return failVerify('invalid_license_token', { ...info, reason: 'missing_token_environment' });
    }
    if (!ALLOWED_ENVS.has(String(payload.env))) {
      return failVerify('non_production_license_token', info);
    }
    if (productionRuntime && payload.env !== 'production') {
      return failVerify('non_production_license_token', info);
    }
  } else if (productionRuntime && payload.env && payload.env !== 'production') {
    return failVerify('non_production_license_token', info);
  }

  return {
    ok: true,
    claims: normalizeClaims(payload),
    reason: null,
    diagnostics: safeDiagnostics({ ...info, reason: null, hmacMatch: 'webhook_signing_secret' })
  };
}

/**
 * Compatibility wrapper: claims or null.
 */
function verifyLicenseToken(token, options) {
  const result = verifyLicenseTokenDetailed(token, options);
  return result.ok ? result.claims : null;
}

/**
 * @param {string} userId
 * @param {string} tradingviewUsername
 * @param {{ env?: string, scriptGenerationId?: string, issuer?: string, allowNonProduction?: boolean }} [options]
 */
function generateLicenseToken(userId, tradingviewUsername, options = {}) {
  const signingSecret = getLicenseSigningSecret();
  const tvu = normalizeTradingViewUsername(tradingviewUsername);
  if (!signingSecret || !userId) {
    throw new Error('Cannot generate license token without signing secret and user id');
  }
  if (!tvu) {
    throw new Error('Cannot generate license token without TradingView username');
  }

  const productionRuntime = isProductionRuntime();
  if (productionRuntime && isSmokeOrDevIdentity(userId, tvu)) {
    const err = new Error('Refusing to mint production license token for a smoke/dev identity');
    err.code = 'unsafe_pine_generation';
    throw err;
  }
  if (productionRuntime && isSmokeOrDevSigningSecret(signingSecret)) {
    const err = new Error('Refusing to mint production license token with a smoke/dev signing secret');
    err.code = 'unsafe_pine_generation';
    throw err;
  }
  if (productionRuntime && isInternalProbeIdentity(userId, tvu) && options.issuer !== 'kaching-license-crypto-check') {
    const err = new Error('Refusing to mint production Pine for an internal probe identity');
    err.code = 'unsafe_pine_generation';
    throw err;
  }

  let env = resolveTokenEnvironment();
  if (options.env && options.env !== env) {
    const testOnly = process.env.LICENSE_TOKEN_TEST_ONLY === 'true';
    if (productionRuntime && !testOnly && !options.allowNonProduction) {
      const err = new Error('Refusing to mint a non-production license token in production');
      err.code = 'unsafe_pine_generation';
      throw err;
    }
    if (!productionRuntime || testOnly || options.allowNonProduction) {
      env = resolveTokenEnvironment(options.env);
    }
  }
  if (productionRuntime && !options.allowNonProduction && process.env.LICENSE_TOKEN_TEST_ONLY !== 'true') {
    env = 'production';
  }

  const payload = {
    v: TOKEN_PAYLOAD_VERSION,
    env,
    uid: String(userId),
    tvu,
    iat: Math.floor(Date.now() / 1000),
    issuer: options.issuer || ISSUER
  };
  if (options.scriptGenerationId) {
    payload.scriptGenerationId = String(options.scriptGenerationId);
  }

  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = hmacFor(encoded, signingSecret);
  const token = `${TOKEN_PREFIX_V2}.${encoded}.${signature}`;
  if (!token.startsWith(`${TOKEN_PREFIX_V2}.`)) {
    const err = new Error('Minted license token must be kls_v2.');
    err.code = 'unsafe_pine_generation';
    throw err;
  }
  return token;
}

function assertGeneratedToken(token, expected = {}) {
  if (!String(token || '').startsWith(`${TOKEN_PREFIX_V2}.`)) {
    const err = new Error('Generated license token must use kls_v2.');
    err.code = 'license_token_self_check_failed';
    err.reason = 'stale_kls_v1_mint';
    throw err;
  }
  const result = verifyLicenseTokenDetailed(token);
  if (!result.ok) {
    const err = new Error(
      `Generated license token failed verification (${result.reason || 'invalid_license_token'}).`
    );
    err.code = 'license_token_self_check_failed';
    err.reason = result.reason;
    throw err;
  }
  const claims = result.claims;
  if (expected.userId != null && String(claims.uid) !== String(expected.userId)) {
    const err = new Error('Generated license token uid does not match the requested user.');
    err.code = 'license_token_self_check_failed';
    err.reason = 'license_user_mismatch';
    throw err;
  }
  if (expected.tradingviewUsername != null) {
    const expectedTvu = normalizeTradingViewUsername(expected.tradingviewUsername);
    if (claims.tvu !== expectedTvu) {
      const err = new Error('Generated license token TradingView username does not match.');
      err.code = 'license_token_self_check_failed';
      err.reason = 'license_tv_username_mismatch';
      throw err;
    }
  }
  const expectedEnv = expected.env || (isProductionRuntime() ? 'production' : null);
  if (expectedEnv && claims.env !== expectedEnv) {
    const err = new Error('Generated license token environment claim failed the mint self-check.');
    err.code = 'license_token_self_check_failed';
    err.reason = 'non_production_license_token';
    throw err;
  }
  if (isProductionRuntime() && claims.env !== 'production') {
    const err = new Error('Generated production token must carry env=production.');
    err.code = 'license_token_self_check_failed';
    err.reason = 'non_production_license_token';
    throw err;
  }
  return claims;
}

/**
 * In-memory configuration probe. Must never persist, notify, or write telemetry.
 */
function runCryptoSelfCheck() {
  const result = {
    ok: false,
    reason: null,
    tokenVersion: TOKEN_PREFIX_V2,
    tokenEnvironment: null,
    isolated: true
  };

  try {
    const secret = getLicenseSigningSecret();
    if (!secret) {
      result.reason = 'missing_signing_secret';
      lastCryptoSelfCheck = result;
      return result;
    }
    if (isProductionRuntime() && isSmokeOrDevSigningSecret(secret)) {
      result.reason = 'smoke_or_dev_signing_secret';
      lastCryptoSelfCheck = result;
      return result;
    }

    const token = generateLicenseToken(CRYPTO_PROBE_UID, CRYPTO_PROBE_TVU, {
      scriptGenerationId: 'startup-crypto-probe',
      issuer: 'kaching-license-crypto-check',
      allowNonProduction: !isProductionRuntime()
    });
    const verified = verifyLicenseTokenDetailed(token);
    if (!verified.ok) {
      result.reason = verified.reason || 'crypto_self_check_failed';
      lastCryptoSelfCheck = result;
      return result;
    }
    if (String(verified.claims.uid) !== CRYPTO_PROBE_UID) {
      result.reason = 'crypto_self_check_uid_mismatch';
      lastCryptoSelfCheck = result;
      return result;
    }
    if (isProductionRuntime() && verified.claims.env !== 'production') {
      result.reason = 'non_production_license_token';
      lastCryptoSelfCheck = result;
      return result;
    }

    result.ok = true;
    result.tokenEnvironment = verified.claims.env || null;
    lastCryptoSelfCheck = result;
    return result;
  } catch (err) {
    result.reason = err.code || 'crypto_self_check_failed';
    lastCryptoSelfCheck = result;
    return result;
  }
}

function getCryptoSelfCheckResult() {
  return lastCryptoSelfCheck;
}

function resetCryptoSelfCheckForTests() {
  lastCryptoSelfCheck = null;
}

module.exports = {
  TOKEN_PREFIX_V1,
  TOKEN_PREFIX_V2,
  TOKEN_PAYLOAD_VERSION,
  ALGORITHM,
  ISSUER,
  ALLOWED_ENVS,
  CRYPTO_PROBE_UID,
  generateLicenseToken,
  verifyLicenseToken,
  verifyLicenseTokenDetailed,
  diagnoseLicenseToken,
  assertGeneratedToken,
  getLicenseSigningSecret,
  getSigningSecret: getLicenseSigningSecret,
  isSmokeOrDevSigningSecret,
  isSmokeOrDevIdentity,
  isInternalProbeIdentity,
  normalizeTradingViewUsername,
  normalizeLicenseTokenTransport,
  resolveTokenEnvironment,
  runCryptoSelfCheck,
  getCryptoSelfCheckResult,
  resetCryptoSelfCheckForTests,
  timingSafeEqualString
};
