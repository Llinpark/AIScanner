/**
 * Distributed trade-lifecycle coordination.
 *
 * Redis is the production authority:
 *   - SET NX lock per canonical trade id
 *   - HASH of pending orphan outcomes (TTL)
 *   - SET NX claims for eventId / lifecycle / fan-out / delivery
 *   - HASH of per-subscriber/channel delivery sequence commits (ENTRY-first)
 *
 * Process-local Maps are a cache plus NODE_ENV=test (or explicit allow) fallback.
 * Production NEVER silently falls through Redis failure to process-local claims —
 * that is how two Fly machines double-deliver. Mongo Signal remains the durable
 * trade document. Fast-ack HTTP path must not sleep on this store beyond a short
 * lock wait.
 */

const crypto = require('crypto');
const { getRedisClient } = require('./redisClient');
const { eventSequenceRank } = require('./tradeEventIdentity');

const KEY_PREFIX = 'kaching:trade';
const DEFAULT_LOCK_TTL_SEC = 20;
const DEFAULT_LOCK_WAIT_MS = 800;
/** Durable enough for delayed TradingView ENTRY retries; not a 15s drop window. */
const DEFAULT_ORPHAN_TTL_SEC = 86400;
const DEFAULT_CLAIM_TTL_SEC = 86400;

const UNLOCK_LUA =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

const REDIS_UNAVAILABLE = 'REDIS_UNAVAILABLE';

/**
 * Memory fallback is tests / explicit override only.
 * Production (and TRADE_EVENT_REQUIRE_REDIS=1) must use Redis SET NX.
 */
function allowMemoryFallback() {
  const flag = String(process.env.TRADE_EVENT_ALLOW_MEMORY || '')
    .trim()
    .toLowerCase();
  if (flag === 'true' || flag === '1' || flag === 'yes') return true;
  if (String(process.env.TRADE_EVENT_REQUIRE_REDIS || '').trim() === '1') return false;
  return String(process.env.NODE_ENV || '').toLowerCase() !== 'production';
}

function redisUnavailableError(op) {
  const err = new Error(`Redis unavailable for ${op}; refusing process-local fallback`);
  err.code = REDIS_UNAVAILABLE;
  err.reason = 'redis_unavailable';
  err.op = op;
  return err;
}

function logRedisAuthorityFail(op, detail) {
  console.error(
    `[TradeEventStore] REDIS AUTHORITY FAIL | op=${op} | ${detail} | refusing process-local fallback (Redis is required for cross-machine SET NX)`
  );
}

/** @type {Map<string, { token: string, expiresAt: number }>} */
const memLocks = new Map();
/** @type {Map<string, Map<string, object>>} */
const memOrphans = new Map();
/** @type {Set<string>} */
const memClaims = new Set();
/** @type {Set<string>} */
const memEntryReady = new Set();
/** @type {Map<string, Set<string>>} */
const memSeqDone = new Map();
/** @type {Map<string, Map<string, object>>} */
const memSeqBuf = new Map();

const ACCEPTED_SEQ_TYPES = Object.freeze([
  'entry',
  'take_profit_1',
  'take_profit_2',
  'take_profit_3',
  'stop_loss',
  'expired',
  'cancelled'
]);

function seqPart(value) {
  return String(value || 'broadcast')
    .trim()
    .replace(/[:\s]/g, '_')
    .slice(0, 120) || 'broadcast';
}

function keySeqDone(canonicalId, subscriberId, channel) {
  return `${KEY_PREFIX}:seqdone:${normalizeId(canonicalId)}:${seqPart(subscriberId)}:${seqPart(channel)}`;
}

function keySeqBuf(canonicalId, subscriberId, channel) {
  return `${KEY_PREFIX}:seqbuf:${normalizeId(canonicalId)}:${seqPart(subscriberId)}:${seqPart(channel)}`;
}

/** Injected client for tests (shared fake Redis across "machines"). */
let injectedClient = null;
let injectedUnavailable = false;

function keyLock(id) {
  return `${KEY_PREFIX}:lock:${id}`;
}
function keyOrphans(id) {
  return `${KEY_PREFIX}:orphans:${id}`;
}
function keyEvent(id, alertType) {
  return `${KEY_PREFIX}:event:${id}:${String(alertType || '').toLowerCase()}`;
}
function keyFanout(id, alertType) {
  return `${KEY_PREFIX}:fanout:${id}:${String(alertType || '').toLowerCase()}`;
}
function keyEntry(id) {
  return `${KEY_PREFIX}:entry:${id}`;
}
function keyEventId(eventId) {
  return `${KEY_PREFIX}:eid:${normalizeId(eventId)}`;
}
function keyDelivery(id, deliveryKey) {
  return `${KEY_PREFIX}:deliv:${id}:${deliveryKey}`;
}

function normalizeSeqEvent(alertType) {
  const t = String(alertType || 'entry').trim().toLowerCase();
  return t === 'signal' ? 'entry' : t;
}

function getOrphanTtlSec() {
  const raw = process.env.ORPHAN_OUTCOME_TTL_SEC;
  if (raw == null || raw === '') return DEFAULT_ORPHAN_TTL_SEC;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ORPHAN_TTL_SEC;
}

function getLockTtlSec() {
  const raw = process.env.TRADE_LOCK_TTL_SEC;
  if (raw == null || raw === '') return DEFAULT_LOCK_TTL_SEC;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LOCK_TTL_SEC;
}

function getLockWaitMs() {
  const raw = process.env.TRADE_LOCK_WAIT_MS;
  if (raw == null || raw === '') return DEFAULT_LOCK_WAIT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LOCK_WAIT_MS;
}

function normalizeId(canonicalId) {
  return String(canonicalId || '').trim();
}

async function redis() {
  if (injectedUnavailable) return null;
  if (injectedClient) return injectedClient;
  try {
    return await getRedisClient();
  } catch {
    return null;
  }
}

function memLockExpired(row) {
  return !row || row.expiresAt <= Date.now();
}

async function acquireLock(canonicalId, opts = {}) {
  const id = normalizeId(canonicalId);
  if (!id) return { ok: true, token: 'none', backend: 'none' };
  const ttlSec = opts.ttlSec != null ? opts.ttlSec : getLockTtlSec();
  const waitMs = opts.waitMs != null ? opts.waitMs : getLockWaitMs();
  const token = crypto.randomBytes(16).toString('hex');
  const deadline = Date.now() + waitMs;
  const r = await redis();

  while (true) {
    if (r) {
      try {
        const ok = await r.set(keyLock(id), token, { NX: true, EX: ttlSec });
        if (ok) return { ok: true, token, backend: 'redis' };
      } catch (err) {
        logRedisAuthorityFail('acquireLock', err.message);
        if (!allowMemoryFallback()) {
          return { ok: false, reason: 'redis_unavailable', backend: 'none' };
        }
        console.warn('[TradeEventStore] lock redis error, memory fallback (non-production):', err.message);
        break;
      }
    } else {
      if (!allowMemoryFallback()) {
        logRedisAuthorityFail('acquireLock', 'redis client unavailable');
        return { ok: false, reason: 'redis_unavailable', backend: 'none' };
      }
      const cur = memLocks.get(id);
      if (!cur || memLockExpired(cur)) {
        memLocks.set(id, { token, expiresAt: Date.now() + ttlSec * 1000 });
        return { ok: true, token, backend: 'memory' };
      }
    }
    if (Date.now() >= deadline) {
      return { ok: false, reason: r ? 'timeout' : 'busy', backend: r ? 'redis' : 'memory' };
    }
    await new Promise(res => setTimeout(res, 25));
  }

  if (!allowMemoryFallback()) {
    return { ok: false, reason: 'redis_unavailable', backend: 'none' };
  }
  const cur = memLocks.get(id);
  if (!cur || memLockExpired(cur)) {
    memLocks.set(id, { token, expiresAt: Date.now() + ttlSec * 1000 });
    return { ok: true, token, backend: 'memory' };
  }
  return { ok: false, reason: 'busy', backend: 'memory' };
}

async function releaseLock(canonicalId, token) {
  const id = normalizeId(canonicalId);
  if (!id || !token || token === 'none') return;
  const r = await redis();
  if (r) {
    try {
      await r.eval(UNLOCK_LUA, { keys: [keyLock(id)], arguments: [String(token)] });
    } catch {
      try {
        const cur = await r.get(keyLock(id));
        if (cur === token) await r.del(keyLock(id));
      } catch {
        /* ignore */
      }
    }
  }
  const row = memLocks.get(id);
  if (row && row.token === token) memLocks.delete(id);
}

async function markEntryReady(canonicalId) {
  const id = normalizeId(canonicalId);
  if (!id) return;
  memEntryReady.add(id);
  const r = await redis();
  if (!r) return;
  try {
    await r.set(keyEntry(id), '1', { EX: DEFAULT_CLAIM_TTL_SEC });
  } catch (err) {
    console.warn('[TradeEventStore] markEntryReady failed:', err.message);
  }
}

async function isEntryReady(canonicalId) {
  const id = normalizeId(canonicalId);
  if (!id) return false;
  if (memEntryReady.has(id)) return true;
  const r = await redis();
  if (!r) return false;
  try {
    return Boolean(await r.get(keyEntry(id)));
  } catch {
    return false;
  }
}

function sortOrphans(list) {
  return [...list].sort((a, b) => {
    const ra = eventSequenceRank(a.alertType) - eventSequenceRank(b.alertType);
    if (ra !== 0) return ra;
    const ta = Number(a.eventTimestamp || 0) - Number(b.eventTimestamp || 0);
    if (ta !== 0) return ta;
    return Number(a.bridgeEventIndex || 0) - Number(b.bridgeEventIndex || 0);
  });
}

async function putOrphan(canonicalId, payload) {
  const id = normalizeId(canonicalId);
  if (!id || !payload) return false;
  const alertType = String(payload.alertType || 'outcome').toLowerCase();
  const record = {
    ...payload,
    alertType,
    storedAt: Date.now()
  };
  if (!memOrphans.has(id)) memOrphans.set(id, new Map());
  memOrphans.get(id).set(alertType, record);

  const r = await redis();
  const ttl = getOrphanTtlSec();
  if (r) {
    try {
      await r.hSet(keyOrphans(id), alertType, JSON.stringify(record));
      await r.expire(keyOrphans(id), ttl);
      return true;
    } catch (err) {
      console.warn('[TradeEventStore] putOrphan redis failed:', err.message);
    }
  }
  return true;
}

async function takeOrphans(canonicalId) {
  const id = normalizeId(canonicalId);
  if (!id) return [];
  const local = memOrphans.get(id);
  const fromMem = local ? [...local.values()] : [];
  memOrphans.delete(id);

  const r = await redis();
  if (r) {
    try {
      const raw = await r.hGetAll(keyOrphans(id));
      await r.del(keyOrphans(id));
      const fromRedis = Object.values(raw || {})
        .map(s => {
          try {
            return JSON.parse(s);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const byType = new Map();
      for (const item of [...fromMem, ...fromRedis]) {
        byType.set(String(item.alertType || 'outcome'), item);
      }
      return sortOrphans([...byType.values()]);
    } catch (err) {
      console.warn('[TradeEventStore] takeOrphans redis failed:', err.message);
    }
  }
  return sortOrphans(fromMem);
}

async function peekOrphans(canonicalId) {
  const id = normalizeId(canonicalId);
  if (!id) return [];
  const local = memOrphans.get(id);
  const fromMem = local ? [...local.values()] : [];
  const r = await redis();
  if (r) {
    try {
      const raw = await r.hGetAll(keyOrphans(id));
      const fromRedis = Object.values(raw || {})
        .map(s => {
          try {
            return JSON.parse(s);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const byType = new Map();
      for (const item of [...fromMem, ...fromRedis]) {
        byType.set(String(item.alertType || 'outcome'), item);
      }
      return sortOrphans([...byType.values()]);
    } catch {
      /* memory */
    }
  }
  return sortOrphans(fromMem);
}

/**
 * Redis SET NX claim. Production refuses process-local ownership when Redis is down.
 */
async function claimNx(memKey, redisKey, op) {
  if (memClaims.has(memKey)) return false;
  const r = await redis();
  if (r) {
    try {
      const ok = await r.set(redisKey, '1', { NX: true, EX: DEFAULT_CLAIM_TTL_SEC });
      if (!ok) return false;
      memClaims.add(memKey);
      return true;
    } catch (err) {
      logRedisAuthorityFail(op, err.message);
      if (!allowMemoryFallback()) throw redisUnavailableError(op);
      console.warn(`[TradeEventStore] ${op} redis failed, memory fallback (non-production):`, err.message);
    }
  } else if (!allowMemoryFallback()) {
    logRedisAuthorityFail(op, 'redis client unavailable');
    throw redisUnavailableError(op);
  }
  memClaims.add(memKey);
  return true;
}

/**
 * Claim a unique lifecycle event (ENTRY / TP1 / TP2 / TP3 / SL) for this trade.
 * Returns true if this caller owns the event.
 */
async function claimLifecycleEvent(canonicalId, alertType) {
  const id = normalizeId(canonicalId);
  const ev = String(alertType || '').toLowerCase() || 'entry';
  if (!id) return true;
  const k = keyEvent(id, ev);
  return claimNx(k, k, 'claimLifecycleEvent');
}

async function hasLifecycleEvent(canonicalId, alertType) {
  const id = normalizeId(canonicalId);
  const ev = String(alertType || '').toLowerCase() || 'entry';
  if (!id) return false;
  const k = keyEvent(id, ev);
  if (memClaims.has(k)) return true;
  const r = await redis();
  if (!r) return false;
  try {
    return Boolean(await r.get(k));
  } catch {
    return false;
  }
}

/**
 * Fan-out processing claim. This is a LEASE, not a permanent delivered flag.
 * EVENT CLAIMED ≠ EVENT DELIVERED. Expired leases are reclaimable.
 */
async function claimFanout(canonicalId, alertType) {
  const id = normalizeId(canonicalId);
  const ev = String(alertType || '').toLowerCase() || 'entry';
  if (!id) return true;
  const DurableDelivery = require('./durableDelivery');
  const acquired = await DurableDelivery.beginFanoutAttempt(id, ev, { canonicalTradeId: id });
  return acquired.status === 'acquired';
}

/**
 * Claim a unique logical eventId (Pine symbol|tf|canonicalTradeId|EVENTTYPE).
 * Returns true if this caller owns the event. HTTP retries and cross-chart
 * copies of the same eventId must return false.
 * Production: Redis SET NX is required; Redis down throws REDIS_UNAVAILABLE
 * (HTTP 503 retry) instead of a process-local claim.
 */
async function claimEventId(eventId) {
  const id = normalizeId(eventId);
  if (!id) {
    const err = new Error('missing_event_identity; refusing empty eventId allow-bypass');
    err.code = 'MISSING_EVENT_IDENTITY';
    err.reason = 'missing_event_identity';
    throw err;
  }
  const k = keyEventId(id);
  return claimNx(k, k, 'claimEventId');
}

async function hasEventId(eventId) {
  const id = normalizeId(eventId);
  if (!id) return false;
  const k = keyEventId(id);
  if (memClaims.has(k)) return true;
  const r = await redis();
  if (!r) return false;
  try {
    return Boolean(await r.get(k));
  } catch {
    return false;
  }
}

async function claimDeliverySlot(signalId, deliveryKey) {
  const id = String(signalId || '').trim();
  const dk = String(deliveryKey || '').trim();
  if (!id || !dk) return true;
  const k = keyDelivery(id, dk);
  return claimNx(k, k, 'claimDeliverySlot');
}

async function listAcceptedAlertTypes(canonicalId) {
  const id = normalizeId(canonicalId);
  const found = [];
  if (!id) return found;
  for (const t of ACCEPTED_SEQ_TYPES) {
    if (await hasLifecycleEvent(id, t)) found.push(t);
  }
  if ((await isEntryReady(id)) && !found.includes('entry')) found.push('entry');
  return found;
}

async function markDeliveryCommitted(canonicalId, subscriberId, channel, alertType) {
  const id = normalizeId(canonicalId);
  const ev = normalizeSeqEvent(alertType);
  if (!id || !ev) return false;
  const k = keySeqDone(id, subscriberId, channel);
  if (!memSeqDone.has(k)) memSeqDone.set(k, new Set());
  memSeqDone.get(k).add(ev);
  const r = await redis();
  if (r) {
    try {
      await r.hSet(k, ev, '1');
      await r.expire(k, DEFAULT_CLAIM_TTL_SEC);
    } catch (err) {
      console.warn('[TradeEventStore] markDeliveryCommitted failed:', err.message);
    }
  }
  return true;
}

async function getCommittedDeliveries(canonicalId, subscriberId, channel) {
  const id = normalizeId(canonicalId);
  const out = new Set();
  if (!id) return out;
  const k = keySeqDone(id, subscriberId, channel);
  const local = memSeqDone.get(k);
  if (local) {
    for (const ev of local) out.add(ev);
  }
  const r = await redis();
  if (r) {
    try {
      const raw = await r.hGetAll(k);
      for (const ev of Object.keys(raw || {})) {
        if (ev) out.add(normalizeSeqEvent(ev));
      }
    } catch {
      /* memory */
    }
  }
  return out;
}

async function isDeliveryCommitted(canonicalId, subscriberId, channel, alertType) {
  const committed = await getCommittedDeliveries(canonicalId, subscriberId, channel);
  return committed.has(normalizeSeqEvent(alertType));
}

async function bufferDeliverySequence(canonicalId, subscriberId, channel, payload) {
  const id = normalizeId(canonicalId);
  if (!id || !payload) return false;
  const ev = normalizeSeqEvent(payload.alertType);
  const k = keySeqBuf(id, subscriberId, channel);
  const record = { ...payload, alertType: ev, storedAt: Date.now() };
  if (!memSeqBuf.has(k)) memSeqBuf.set(k, new Map());
  memSeqBuf.get(k).set(ev, record);
  const r = await redis();
  if (r) {
    try {
      await r.hSet(k, ev, JSON.stringify(record));
      await r.expire(k, DEFAULT_CLAIM_TTL_SEC);
    } catch (err) {
      console.warn('[TradeEventStore] bufferDeliverySequence failed:', err.message);
    }
  }
  return true;
}

async function takeBufferedDeliveries(canonicalId, subscriberId, channel) {
  const id = normalizeId(canonicalId);
  if (!id) return [];
  const k = keySeqBuf(id, subscriberId, channel);
  const local = memSeqBuf.get(k);
  const fromMem = local ? [...local.values()] : [];
  memSeqBuf.delete(k);
  const r = await redis();
  if (r) {
    try {
      const raw = await r.hGetAll(k);
      await r.del(k);
      const fromRedis = Object.values(raw || {})
        .map(s => {
          try {
            return typeof s === 'string' ? JSON.parse(s) : s;
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const byType = new Map();
      for (const item of [...fromMem, ...fromRedis]) {
        byType.set(normalizeSeqEvent(item.alertType), item);
      }
      return [...byType.values()];
    } catch (err) {
      console.warn('[TradeEventStore] takeBufferedDeliveries failed:', err.message);
    }
  }
  return fromMem;
}

function setClientForTests(client, { unavailable = false } = {}) {
  injectedClient = client || null;
  injectedUnavailable = Boolean(unavailable);
}

function getInjectedClient() {
  return { client: injectedClient, unavailable: injectedUnavailable };
}

function resetForTests() {
  memLocks.clear();
  memOrphans.clear();
  memClaims.clear();
  memEntryReady.clear();
  memSeqDone.clear();
  memSeqBuf.clear();
  injectedClient = null;
  injectedUnavailable = false;
  try {
    require('./durableDelivery').resetForTests();
  } catch {
    /* circular-safe */
  }
}

module.exports = {
  DEFAULT_LOCK_TTL_SEC,
  DEFAULT_ORPHAN_TTL_SEC,
  REDIS_UNAVAILABLE,
  allowMemoryFallback,
  getOrphanTtlSec,
  acquireLock,
  releaseLock,
  markEntryReady,
  isEntryReady,
  putOrphan,
  takeOrphans,
  peekOrphans,
  claimLifecycleEvent,
  hasLifecycleEvent,
  listAcceptedAlertTypes,
  markDeliveryCommitted,
  getCommittedDeliveries,
  isDeliveryCommitted,
  bufferDeliverySequence,
  takeBufferedDeliveries,
  claimFanout,
  claimEventId,
  hasEventId,
  claimDeliverySlot,
  setClientForTests,
  getInjectedClient,
  resetForTests
};
