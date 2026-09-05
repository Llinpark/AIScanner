const crypto = require('crypto');
const { getRedisClient, isRedisEnabled } = require('../utils/redisClient');
const Mt5TradeCopierService = require('./Mt5TradeCopierService');
const { PUBLIC_BACKEND_URL } = require('../config/appUrls');

/**
 * Pair codes live in Redis with TTL (never permanently in Mongo).
 * Memory fallback is ONLY for automated tests (NODE_ENV=test) or an explicit
 * MT5_PAIRING_ALLOW_MEMORY=true flag. Production never uses memory silently.
 */

const PAIR_TTL_MS = 10 * 60 * 1000;
const PAIR_TTL_SECONDS = 600;
const MAX_FAILED_ATTEMPTS = 5;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const HEARTBEAT_OFFLINE_MS = 90 * 1000;

/** Ambiguous-char-free alphabet (no O,0,I,1,L). Example: K7P4X9Q2 */
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIR_CODE_LEN = 8;
const PAIR_CODE_RE = new RegExp(`^[${PAIR_ALPHABET}]{${PAIR_CODE_LEN}}$`);

const REDIS_CODE_PREFIX = 'kaching:mt5:pair:code:';
const REDIS_USER_PREFIX = 'kaching:mt5:pair:user:';
const REDIS_FAIL_IP_PREFIX = 'kaching:mt5:pair:fail:ip:';
const REDIS_FAIL_CODE_PREFIX = 'kaching:mt5:pair:fail:code:';

const PAIRING_UNAVAILABLE_MESSAGE = 'MT5 Pairing is temporarily unavailable.';

/** Atomic GET+DEL for Redis < 6.2 that lack GETDEL. */
const GETDEL_LUA = `
local v = redis.call('GET', KEYS[1])
if v then redis.call('DEL', KEYS[1]) end
return v
`;

const memoryByCode = new Map();
const memoryByUser = new Map();
const memoryFailIp = new Map();
const memoryFailCode = new Map();

function memoryFallbackAllowed() {
  const flag = String(process.env.MT5_PAIRING_ALLOW_MEMORY || '')
    .trim()
    .toLowerCase();
  if (flag === 'true' || flag === '1' || flag === 'yes') return true;
  return process.env.NODE_ENV === 'test';
}

function isProductionRuntime() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

function pairingUnavailableError(detail) {
  const err = new Error(PAIRING_UNAVAILABLE_MESSAGE);
  err.code = 'PAIRING_UNAVAILABLE';
  err.reason = 'pairing_unavailable';
  if (detail) err.detail = detail;
  return err;
}

function redisCodeKey(code) {
  return `${REDIS_CODE_PREFIX}${code}`;
}

function redisUserKey(userId) {
  return `${REDIS_USER_PREFIX}${String(userId)}`;
}

function generatePairCode() {
  let out = '';
  for (let i = 0; i < PAIR_CODE_LEN; i++) {
    out += PAIR_ALPHABET[crypto.randomInt(0, PAIR_ALPHABET.length)];
  }
  return out;
}

function normalizePairCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function purgeExpiredMemory() {
  const now = Date.now();
  for (const [code, entry] of memoryByCode.entries()) {
    if (!entry?.expiresAt || new Date(entry.expiresAt).getTime() < now) {
      memoryByCode.delete(code);
      if (entry?.subscriberId && memoryByUser.get(String(entry.subscriberId)) === code) {
        memoryByUser.delete(String(entry.subscriberId));
      }
    }
  }
  for (const [key, bucket] of memoryFailIp.entries()) {
    if (now - bucket.start >= FAIL_WINDOW_MS) memoryFailIp.delete(key);
  }
  for (const [key, bucket] of memoryFailCode.entries()) {
    if (now - bucket.start >= FAIL_WINDOW_MS) memoryFailCode.delete(key);
  }
}

/**
 * Resolve Redis for pairing. Throws PAIRING_UNAVAILABLE when Redis is required
 * but unavailable (production / non-test without allow-memory flag).
 */
async function requirePairingRedis() {
  if (!isRedisEnabled()) {
    if (memoryFallbackAllowed()) return null;
    throw pairingUnavailableError('REDIS_ENABLED is false');
  }

  const redis = await getRedisClient();
  if (redis) return redis;

  if (memoryFallbackAllowed()) return null;
  throw pairingUnavailableError('Redis client unavailable');
}

async function atomicGetDel(redis, key) {
  if (typeof redis.getDel === 'function') {
    try {
      return await redis.getDel(key);
    } catch {
      // Fall through to Lua (older server / client mismatch).
    }
  }
  return redis.eval(GETDEL_LUA, { keys: [key] });
}

async function deleteCodeEverywhere(code, subscriberId) {
  const normalized = normalizePairCode(code);
  if (normalized) {
    memoryByCode.delete(normalized);
    try {
      const redis = await getRedisClient();
      if (redis) {
        await redis.del(redisCodeKey(normalized));
        await redis.del(`${REDIS_FAIL_CODE_PREFIX}${normalized}`);
      }
    } catch {
      // ignore
    }
  }
  if (subscriberId != null) {
    const uid = String(subscriberId);
    if (memoryByUser.get(uid) === normalized) memoryByUser.delete(uid);
    try {
      const redis = await getRedisClient();
      if (redis) {
        const current = await redis.get(redisUserKey(uid));
        if (current === normalized) await redis.del(redisUserKey(uid));
      }
    } catch {
      // ignore
    }
  }
}

async function invalidatePendingForUser(userId) {
  const uid = String(userId);
  let existingCode = memoryByUser.get(uid) || null;
  try {
    const redis = await requirePairingRedis();
    if (redis) {
      const fromRedis = await redis.get(redisUserKey(uid));
      if (fromRedis) existingCode = fromRedis;
    }
  } catch (err) {
    if (err.code === 'PAIRING_UNAVAILABLE') throw err;
  }
  if (existingCode) await deleteCodeEverywhere(existingCode, uid);
}

async function storePairSession(session) {
  const { pairCode, subscriberId, expiresAt, status } = session;
  const payload = {
    pairCode,
    subscriberId: String(subscriberId),
    expiresAt: new Date(expiresAt).toISOString(),
    status: status || 'pending',
    createdAt: new Date().toISOString()
  };

  const redis = await requirePairingRedis();
  if (redis) {
    await redis.setEx(redisCodeKey(pairCode), PAIR_TTL_SECONDS, JSON.stringify(payload));
    await redis.setEx(redisUserKey(subscriberId), PAIR_TTL_SECONDS, pairCode);
    return { ...payload, storage: 'redis' };
  }

  // Test / explicit memory-only path.
  memoryByCode.set(pairCode, { ...payload, expiresAt: new Date(expiresAt) });
  memoryByUser.set(String(subscriberId), pairCode);
  return { ...payload, storage: 'memory' };
}

async function loadPairSession(pairCode, { allowExpired = false } = {}) {
  const normalized = normalizePairCode(pairCode);
  if (!PAIR_CODE_RE.test(normalized)) return null;

  if (!allowExpired) purgeExpiredMemory();

  let parsed = null;
  try {
    const redis = await requirePairingRedis();
    if (redis) {
      const raw = await redis.get(redisCodeKey(normalized));
      if (raw) parsed = JSON.parse(raw);
    }
  } catch (err) {
    if (err.code === 'PAIRING_UNAVAILABLE') throw err;
  }

  if (!parsed && memoryFallbackAllowed()) {
    const mem = memoryByCode.get(normalized);
    if (mem) {
      parsed = {
        pairCode: normalized,
        subscriberId: String(mem.subscriberId),
        expiresAt: new Date(mem.expiresAt).toISOString(),
        status: mem.status || 'pending',
        createdAt: mem.createdAt || null
      };
    }
  }

  if (!parsed) return null;

  const expired = parsed?.expiresAt && new Date(parsed.expiresAt).getTime() < Date.now();
  if (expired && !allowExpired) {
    await deleteCodeEverywhere(normalized, parsed.subscriberId);
    return null;
  }
  if (expired) return { ...parsed, pairCode: normalized, expired: true };
  return { ...parsed, pairCode: normalized, expired: false };
}

/**
 * Atomically claim a pending pair code (GETDEL / memory delete).
 * On registration failure, call restore() so the code remains usable until TTL.
 */
async function claimPairSession(pairCode) {
  const normalized = normalizePairCode(pairCode);
  if (!PAIR_CODE_RE.test(normalized)) return null;

  const redis = await requirePairingRedis();

  if (redis) {
    const raw = await atomicGetDel(redis, redisCodeKey(normalized));
    if (!raw) return null;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    const uid = String(parsed.subscriberId || '');
    try {
      const current = await redis.get(redisUserKey(uid));
      if (current === normalized) await redis.del(redisUserKey(uid));
    } catch {
      // ignore
    }

    const expiresAtMs = new Date(parsed.expiresAt).getTime();
    const remainingMs = Math.max(0, expiresAtMs - Date.now());
    const expired = remainingMs <= 0;
    const session = {
      ...parsed,
      pairCode: normalized,
      expired,
      subscriberId: uid
    };

    return {
      session,
      restore: async () => {
        if (expired || remainingMs <= 0) return;
        const ttlSec = Math.max(1, Math.ceil(remainingMs / 1000));
        const payload = {
          ...parsed,
          pairCode: normalized,
          status: 'pending'
        };
        await redis.setEx(redisCodeKey(normalized), ttlSec, JSON.stringify(payload));
        if (uid) await redis.setEx(redisUserKey(uid), ttlSec, normalized);
      }
    };
  }

  // Memory path (tests only)
  purgeExpiredMemory();
  const mem = memoryByCode.get(normalized);
  if (!mem) return null;
  memoryByCode.delete(normalized);
  const uid = String(mem.subscriberId);
  if (memoryByUser.get(uid) === normalized) memoryByUser.delete(uid);

  const expiresAtMs = new Date(mem.expiresAt).getTime();
  const remainingMs = Math.max(0, expiresAtMs - Date.now());
  const expired = remainingMs <= 0;
  const session = {
    pairCode: normalized,
    subscriberId: uid,
    expiresAt: new Date(mem.expiresAt).toISOString(),
    status: mem.status || 'pending',
    createdAt: mem.createdAt || null,
    expired
  };

  return {
    session,
    restore: async () => {
      if (expired || remainingMs <= 0) return;
      memoryByCode.set(normalized, { ...mem, status: 'pending', expiresAt: new Date(mem.expiresAt) });
      memoryByUser.set(uid, normalized);
    }
  };
}

async function getFailCount(prefix, key) {
  const full = `${prefix}${key}`;
  try {
    const redis = await requirePairingRedis();
    if (redis) {
      const n = await redis.get(full);
      return Number(n) || 0;
    }
  } catch (err) {
    if (err.code === 'PAIRING_UNAVAILABLE') throw err;
  }
  if (!memoryFallbackAllowed()) return 0;
  const map = prefix.includes(':ip:') ? memoryFailIp : memoryFailCode;
  const bucket = map.get(key);
  if (!bucket || Date.now() - bucket.start >= FAIL_WINDOW_MS) return 0;
  return bucket.count;
}

async function bumpFailCount(prefix, key) {
  const full = `${prefix}${key}`;
  try {
    const redis = await requirePairingRedis();
    if (redis) {
      const n = await redis.incr(full);
      if (n === 1) await redis.pExpire(full, FAIL_WINDOW_MS);
      return n;
    }
  } catch (err) {
    if (err.code === 'PAIRING_UNAVAILABLE') throw err;
  }
  if (!memoryFallbackAllowed()) return 0;
  const map = prefix.includes(':ip:') ? memoryFailIp : memoryFailCode;
  const now = Date.now();
  let bucket = map.get(key);
  if (!bucket || now - bucket.start >= FAIL_WINDOW_MS) {
    bucket = { start: now, count: 0 };
    map.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count;
}

function logFailedAttempt({ pairCode, reason, ip, message }) {
  const codeHint = pairCode ? `${String(pairCode).slice(0, 2)}******` : '(none)';
  console.warn(
    `[Mt5Pairing] Failed pair attempt ip=${ip || 'unknown'} code=${codeHint} reason=${reason} msg=${message || ''}`
  );
}

function logAudit(event, details = {}) {
  console.info(`[Mt5Pairing] audit event=${event}`, {
    ...details,
    at: new Date().toISOString()
  });
}

/**
 * Dashboard: issue one-time 8-char PairCode (10 min TTL). Never returns permanent tokens.
 */
async function startPairing(userId) {
  await invalidatePendingForUser(userId);

  let pairCode = null;
  for (let i = 0; i < 16; i++) {
    const candidate = generatePairCode();
    const existing = await loadPairSession(candidate);
    if (!existing) {
      pairCode = candidate;
      break;
    }
  }
  if (!pairCode) throw new Error('Unable to allocate a unique pairing code');

  const expiresAt = new Date(Date.now() + PAIR_TTL_MS);
  const session = await storePairSession({
    pairCode,
    subscriberId: userId,
    expiresAt,
    status: 'pending'
  });

  logAudit('pair_start', {
    userId: String(userId),
    codeHint: `${pairCode.slice(0, 2)}******`,
    storage: session.storage
  });

  return {
    pairCode: session.pairCode,
    expiresAt: new Date(session.expiresAt),
    status: 'pending',
    storage: session.storage
  };
}

async function rejectComplete({ pairCode, reason, message, ip, burnCode, subscriberId }) {
  logFailedAttempt({ pairCode, reason, ip, message });

  if (ip) {
    const ipFails = await bumpFailCount(REDIS_FAIL_IP_PREFIX, ip);
    if (ipFails >= MAX_FAILED_ATTEMPTS) {
      return {
        ok: false,
        reason: 'rate_limited',
        message: 'Too many pairing attempts. Wait and try a new Pair Code from the dashboard.'
      };
    }
  }

  if (pairCode && PAIR_CODE_RE.test(normalizePairCode(pairCode))) {
    const codeFails = await bumpFailCount(REDIS_FAIL_CODE_PREFIX, normalizePairCode(pairCode));
    if (codeFails >= MAX_FAILED_ATTEMPTS || burnCode) {
      await deleteCodeEverywhere(pairCode, subscriberId);
      return {
        ok: false,
        reason: reason === 'expired' ? 'expired' : 'rate_limited',
        message:
          reason === 'expired'
            ? 'Pair Code Expired'
            : 'Too many pairing attempts. Generate a new Pair Code.'
      };
    }
  }

  return { ok: false, reason, message };
}

/**
 * EA: exchange PairCode for device-scoped access + refresh tokens (multi-device safe).
 * Order: validate → atomic claim → register device → persist tokens → commit (code already removed).
 * If registration fails, the claimed code is restored until original expiry.
 */
async function completePairing(payload = {}, meta = {}) {
  const ip = meta.ip || null;
  const pairCode = normalizePairCode(payload.pairCode || payload.pair_code);
  const terminalId = payload.terminalId || payload.terminal_id || null;
  const accountNumber = payload.accountNumber ?? payload.account_number ?? null;
  const broker = payload.broker != null ? String(payload.broker) : null;
  const terminalBuild =
    payload.terminalBuild ?? payload.build ?? payload.terminal_build ?? null;
  const eaVersion = payload.eaVersion || payload.ea_version || null;
  const machineFingerprint =
    payload.machineFingerprint || payload.machine_fingerprint || null;
  const platform = payload.platform || 'Windows';
  const friendlyName =
    payload.friendlyName ||
    payload.friendly_name ||
    payload.label ||
    payload.deviceLabel ||
    [broker || 'MT5', accountNumber ? `#${accountNumber}` : null].filter(Boolean).join(' ') ||
    'MT5 Terminal';

  try {
    if (!PAIR_CODE_RE.test(pairCode)) {
      return rejectComplete({
        pairCode,
        reason: 'invalid_code',
        message: 'Invalid Pair Code',
        ip
      });
    }

    const ipFails = await getFailCount(REDIS_FAIL_IP_PREFIX, ip || '');
    if (ip && ipFails >= MAX_FAILED_ATTEMPTS) {
      return rejectComplete({
        pairCode,
        reason: 'rate_limited',
        message: 'Too many pairing attempts. Wait and try a new Pair Code from the dashboard.',
        ip
      });
    }

    const codeFails = await getFailCount(REDIS_FAIL_CODE_PREFIX, pairCode);
    if (codeFails >= MAX_FAILED_ATTEMPTS) {
      return rejectComplete({
        pairCode,
        reason: 'rate_limited',
        message: 'Too many pairing attempts. Generate a new Pair Code.',
        ip,
        burnCode: true
      });
    }

    // Peek for clearer expired/invalid messages before claim (non-authoritative).
    const peek = await loadPairSession(pairCode, { allowExpired: true });
    if (!peek) {
      return rejectComplete({
        pairCode,
        reason: 'invalid_or_expired',
        message: 'Invalid Pair Code',
        ip
      });
    }
    if (peek.expired || new Date(peek.expiresAt).getTime() < Date.now()) {
      await deleteCodeEverywhere(pairCode, peek.subscriberId);
      return rejectComplete({
        pairCode,
        reason: 'expired',
        message: 'Pair Code Expired',
        ip,
        subscriberId: peek.subscriberId
      });
    }

    // Atomic single-consumer claim (GETDEL / memory delete).
    const claimed = await claimPairSession(pairCode);
    if (!claimed?.session) {
      return rejectComplete({
        pairCode,
        reason: 'already_used',
        message: 'Invalid Pair Code',
        ip,
        subscriberId: peek.subscriberId
      });
    }

    const { session, restore } = claimed;
    if (session.expired || new Date(session.expiresAt).getTime() < Date.now()) {
      return rejectComplete({
        pairCode,
        reason: 'expired',
        message: 'Pair Code Expired',
        ip,
        subscriberId: session.subscriberId
      });
    }

    if (session.status && session.status !== 'pending') {
      return rejectComplete({
        pairCode,
        reason: 'already_used',
        message: 'Invalid Pair Code',
        ip,
        subscriberId: session.subscriberId
      });
    }

    const userId = session.subscriberId;
    let device;
    try {
      device = await Mt5TradeCopierService.registerPairedDevice(userId, {
        terminalId,
        accountNumber,
        broker,
        terminalBuild,
        eaVersion,
        machineFingerprint,
        platform,
        friendlyName,
        label: friendlyName,
        lastSeenIP: ip
      });
    } catch (regErr) {
      console.error('[Mt5Pairing] Device registration failed — restoring PairCode:', regErr.message);
      try {
        await restore();
      } catch (restoreErr) {
        console.error('[Mt5Pairing] Failed to restore PairCode after registration error:', restoreErr.message);
      }
      logAudit('pair_complete_failed', {
        userId: String(userId),
        codeHint: `${pairCode.slice(0, 2)}******`,
        reason: 'register_failed'
      });
      return {
        ok: false,
        reason: 'register_failed',
        message: 'Unable to complete MT5 pairing. Retry with the same Pair Code.'
      };
    }

    logAudit('pair_complete', {
      userId: String(userId),
      deviceId: device.deviceId,
      codeHint: `${pairCode.slice(0, 2)}******`,
      ip: ip || null
    });

    return {
      ok: true,
      backendUrl: String(PUBLIC_BACKEND_URL || '').replace(/\/$/, ''),
      accessToken: device.accessToken,
      refreshToken: device.refreshToken,
      accessExpiresAt: device.accessExpiresAt,
      refreshExpiresAt: device.refreshExpiresAt,
      deviceId: device.deviceId,
      subscriberId: String(userId),
      token: device.accessToken
    };
  } catch (err) {
    if (err.code === 'PAIRING_UNAVAILABLE') {
      return {
        ok: false,
        reason: 'pairing_unavailable',
        message: PAIRING_UNAVAILABLE_MESSAGE
      };
    }
    throw err;
  }
}

async function refreshAccessToken(payload = {}) {
  const refreshToken = String(payload.refreshToken || payload.refresh_token || '').trim();
  const deviceId = payload.deviceId || payload.device_id || null;
  if (!refreshToken) {
    return { ok: false, reason: 'invalid_refresh', message: 'Connection Lost — Please Pair Again' };
  }

  const result = await Mt5TradeCopierService.refreshDeviceAccess(refreshToken, deviceId);
  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason || 'invalid_refresh',
      message: 'Connection Lost — Please Pair Again'
    };
  }

  logAudit('token_refresh', { deviceId: result.deviceId });

  return {
    ok: true,
    accessToken: result.accessToken,
    accessExpiresAt: result.accessExpiresAt,
    deviceId: result.deviceId,
    token: result.accessToken
  };
}

/**
 * Production boot: Redis must be reachable for MT5 pairing.
 * Exits process when NODE_ENV=production and Redis is down.
 */
async function assertProductionRedisReady() {
  if (!isProductionRuntime()) return { ok: true, skipped: true };
  if (memoryFallbackAllowed()) {
    console.warn(
      '[Mt5Pairing] MT5_PAIRING_ALLOW_MEMORY is set in production — Redis is still preferred.'
    );
  }
  if (!isRedisEnabled()) {
    console.error('[Mt5Pairing] REDIS_ENABLED is false in production — MT5 pairing requires Redis.');
    throw pairingUnavailableError('REDIS_ENABLED is false in production');
  }
  const redis = await getRedisClient();
  if (!redis) {
    console.error('[Mt5Pairing] Redis unavailable at startup — refusing to boot without MT5 pairing store.');
    throw pairingUnavailableError('Redis unavailable at production startup');
  }
  try {
    await redis.ping();
  } catch (err) {
    throw pairingUnavailableError(`Redis ping failed: ${err.message}`);
  }
  console.log('[Mt5Pairing] Redis ready for PairCode storage');
  return { ok: true };
}

function _clearMemory() {
  memoryByCode.clear();
  memoryByUser.clear();
  memoryFailIp.clear();
  memoryFailCode.clear();
}

async function _forceExpireForTests(pairCode) {
  const normalized = normalizePairCode(pairCode);
  let touched = false;
  const mem = memoryByCode.get(normalized);
  if (mem) {
    mem.expiresAt = new Date(Date.now() - 1000);
    memoryByCode.set(normalized, mem);
    touched = true;
  }
  try {
    const redis = await getRedisClient();
    if (redis) {
      const key = redisCodeKey(normalized);
      const raw = await redis.get(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        parsed.expiresAt = new Date(Date.now() - 1000).toISOString();
        const ttl = await redis.ttl(key);
        if (ttl > 0) {
          await redis.setEx(key, ttl, JSON.stringify(parsed));
        } else {
          await redis.set(key, JSON.stringify(parsed));
        }
        touched = true;
      }
    }
  } catch {
    // ignore
  }
  return touched;
}

module.exports = {
  PAIR_TTL_MS,
  PAIR_ALPHABET,
  PAIR_CODE_LEN,
  PAIR_CODE_RE,
  MAX_FAILED_ATTEMPTS,
  ACCESS_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  HEARTBEAT_OFFLINE_MS,
  PAIRING_UNAVAILABLE_MESSAGE,
  memoryFallbackAllowed,
  startPairing,
  completePairing,
  refreshAccessToken,
  loadPairSession,
  claimPairSession,
  deleteCodeEverywhere,
  normalizePairCode,
  generatePairCode,
  assertProductionRedisReady,
  _clearMemory,
  _forceExpireForTests
};
