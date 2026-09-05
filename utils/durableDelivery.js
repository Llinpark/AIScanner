/**
 * Durable delivery state machine (one authority).
 *
 * PENDING → PROCESSING → SENDING → PROVIDER_ACCEPTED → DELIVERED
 *                         ↘ RETRY_PENDING → FAILED_TERMINAL
 * Outcomes: BLOCKED_WAITING_FOR_ENTRY until ENTRY is COMMITTED.
 *
 * Identity (stable, never random on retry):
 *   eventId + canonicalTradeId + subscriberId + channel + eventType
 *
 * Mongo is the durable record that work exists.
 * Redis coordinates leases / duplicate suppression / optional job cache.
 * Redis is NOT the only long-term record. Redis TTL expiry must not lose work.
 *
 * EVENT CLAIMED ≠ EVENT DELIVERED. Job existing ≠ DELIVERED.
 * ENTRY ACCEPTED ≠ ENTRY DELIVERED.
 *
 * Success is terminal ONLY after provider success AND durable COMMITTED.
 * Crash before PROVIDER_ACCEPTED = at-least-once resend possible.
 * Crash after PROVIDER_ACCEPTED before COMMITTED = finish commit, do not resend.
 * Telegram Bot API has no sendMessage idempotency key — not exactly-once.
 */

const os = require('os');
const TradeEventStore = require('./tradeEventStore');
const { hashIdentity, resolveCanonicalTradeId, eventSequenceRank } = require('./tradeEventIdentity');
const { isEntryAlert } = require('./signalOutcome');
const { logPipeline, extractPipelineMeta } = require('./pipelineLog');
const {
  attachCorrelation,
  mergeCorrelation,
  compactCorrelation,
  buildDurableRefs,
  correlationFromJob
} = require('./signalCorrelation');

const STATES = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  SENDING: 'sending',
  RETRY_PENDING: 'retry_pending',
  PROVIDER_ACCEPTED: 'provider_accepted',
  DELIVERED: 'delivered',
  FAILED_TERMINAL: 'failed_terminal',
  BLOCKED_WAITING_FOR_ENTRY: 'blocked_waiting_for_entry',
  SKIPPED: 'skipped',
  NOT_ELIGIBLE: 'not_eligible'
});

const UNFINISHED_STATES = Object.freeze([
  STATES.PENDING,
  STATES.PROCESSING,
  STATES.SENDING,
  STATES.RETRY_PENDING,
  STATES.PROVIDER_ACCEPTED,
  STATES.BLOCKED_WAITING_FOR_ENTRY
]);

const FANOUT_SUBSCRIBER = '_event';
const FANOUT_CHANNEL = '_fanout';

const KEY_PREFIX = 'kaching:trade';
const JOB_TTL_SEC = 7 * 24 * 3600;

const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_RETRY_MAX_MS = 60000;
const DEFAULT_LEASE_MS = 120000;
/**
 * Background crash recovery interval.
 *
 * Live TradingView → Telegram/email/MT5 is event-driven (webhook accept + fan-out).
 * This worker only reclaims expired leases, retries failed sends, and finishes
 * PROVIDER_ACCEPTED commits. It is not on the live signal path.
 *
 * 15s default (was 2000ms): lease TTL is 120s, so reclaim margin stays large.
 * Immediate outcome unblock uses onEntryCommitted, not this poll.
 * Failed-send retryDelayMs already backs off 500ms–60s; a 15s scan sits inside
 * that curve. Override with DELIVERY_RECOVERY_INTERVAL_MS. Floor:
 * DELIVERY_RECOVERY_MIN_INTERVAL_MS (default 5000) prevents 1ms command loops.
 */
const DEFAULT_RECOVERY_INTERVAL_MS = 15000;
const MIN_RECOVERY_INTERVAL_MS = 5000;

/**
 * Recovery memory bounds for 512MB Node / ~256MB V8 heap.
 * Redis index walking is OFF by default (Mongo is the durable due-job query).
 * When DELIVERY_RECOVERY_REDIS_SCAN=1, 32 × 3.2KB ≈ 102KB JSON per tick.
 */
const HSCAN_COUNT = 100;
const HYDRATE_BATCH = 32;
const PROCESS_BUDGET = 8;
const PROVIDER_CONCURRENCY = 2;
const MAX_SCAN_STEPS_PER_TICK = 8;
const MAX_MEM_JOBS = 256;
const MAX_DURABLE_DOCS = 256;
const DEFAULT_MAX_REDIS_OPS_PER_TICK = 48;
const DEFAULT_REDIS_FAIL_THRESHOLD = 5;
const DEFAULT_REDIS_FAIL_COOLDOWN_MS = 30000;
const DEFAULT_CLEANUP_BATCH_SIZE = 100;
const DEFAULT_CLEANUP_MAX_HDEL = 50;
const METRICS_LOG_EVERY_MS = 60000;

const RECOVERY_BOUNDS = Object.freeze({
  HSCAN_COUNT,
  HYDRATE_BATCH,
  PROCESS_BUDGET,
  PROVIDER_CONCURRENCY,
  MAX_SCAN_STEPS_PER_TICK,
  MAX_MEM_JOBS,
  MAX_DURABLE_DOCS,
  DEFAULT_RECOVERY_INTERVAL_MS,
  MIN_RECOVERY_INTERVAL_MS,
  DEFAULT_MAX_REDIS_OPS_PER_TICK,
  DEFAULT_CLEANUP_BATCH_SIZE,
  DEFAULT_CLEANUP_MAX_HDEL,
  REDIS_INDEX_SCAN_DEFAULT: false
});

/** Process cache of Redis job JSON. Not the durable store. Bounded — see maybeEvictCaches. */
const memJobs = new Map();
/** Process cache of Redis leases. */
const memLeases = new Map();
/**
 * Durable job documents (Mongo stand-in in tests; mirrored from Mongo in prod).
 * Survives simulateRedisRestartForTests. Source of truth for recovery discovery.
 * Bounded — cannot grow with Redis index cardinality.
 */
const durableDocs = new Map();

let frozenNow = null;
let recoveryTimer = null;
let processHandler = null;
let workerIo = null;
let workerSignals = null;
let recoveryScanCursor = '0';
let recoveryPendingIds = [];
let recoveryGetCount = 0;
let recoveryParseCount = 0;
let recoveryHydrateCount = 0;
let recoveryHGetAllCount = 0;
let recoveryHScanCount = 0;
let recoveryTicks = 0;
let recoveryJobsDiscovered = 0;
let recoveryJobsRequired = 0;
let recoveryJobsTerminalSkipped = 0;
let recoveryIndexRemoved = 0;
let recoveryOverlapSkips = 0;
let recoveryRedisFailures = 0;
let recoveryLastDurationMs = 0;
let recoveryDurationTotalMs = 0;
let lastTickGets = 0;
let lastTickHydrations = 0;
let lastTickParses = 0;
let lastTickRedisOps = 0;
let lastTickHscans = 0;
let concurrentHydrations = 0;
let maxConcurrentHydrations = 0;
let redisFailStreak = 0;
let redisCircuitOpenUntil = 0;
let lastMetricsLogAt = 0;
let lastWorkerError = null;
let lastWorkerTickAt = 0;
let workerTickInFlight = false;
let contextLoaders = {
  loadSignal: null,
  loadSubscriber: null
};

function now() {
  return frozenNow != null ? frozenNow : Date.now();
}

function setNowForTests(ms) {
  frozenNow = Number(ms);
}

function advanceNowForTests(ms) {
  frozenNow = now() + Number(ms);
}

function clearNowForTests() {
  frozenNow = null;
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getMaxAttempts() {
  return envInt('DELIVERY_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS);
}

function getRetryBaseDelayMs() {
  return envInt('DELIVERY_RETRY_BASE_DELAY_MS', DEFAULT_RETRY_BASE_MS);
}

function getRetryMaxDelayMs() {
  return envInt('DELIVERY_RETRY_MAX_DELAY_MS', DEFAULT_RETRY_MAX_MS);
}

function getLeaseMs() {
  return envInt('DELIVERY_PROCESSING_LEASE_MS', DEFAULT_LEASE_MS);
}

function envFlag(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultValue;
  const s = String(raw).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return defaultValue;
}

function clampInt(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

function getMinRecoveryIntervalMs() {
  return envInt('DELIVERY_RECOVERY_MIN_INTERVAL_MS', MIN_RECOVERY_INTERVAL_MS);
}

function getRecoveryIntervalMs() {
  const requested = envInt('DELIVERY_RECOVERY_INTERVAL_MS', DEFAULT_RECOVERY_INTERVAL_MS);
  return Math.max(getMinRecoveryIntervalMs(), requested);
}

function redisIndexScanEnabled() {
  return envFlag('DELIVERY_RECOVERY_REDIS_SCAN', false);
}

function getProcessBudget() {
  return clampInt(envInt('DELIVERY_RECOVERY_PROCESS_BUDGET', PROCESS_BUDGET), 1, 32, PROCESS_BUDGET);
}

function getHydrateBatch() {
  return clampInt(envInt('DELIVERY_RECOVERY_HYDRATE_BATCH', HYDRATE_BATCH), 1, 64, HYDRATE_BATCH);
}

function getScanStepsPerTick() {
  return clampInt(
    envInt('DELIVERY_RECOVERY_SCAN_STEPS', MAX_SCAN_STEPS_PER_TICK),
    1,
    16,
    MAX_SCAN_STEPS_PER_TICK
  );
}

function getHscanCount() {
  return clampInt(envInt('DELIVERY_RECOVERY_HSCAN_COUNT', HSCAN_COUNT), 10, 200, HSCAN_COUNT);
}

function getMaxRedisOpsPerTick() {
  return clampInt(
    envInt('DELIVERY_RECOVERY_MAX_REDIS_OPS', DEFAULT_MAX_REDIS_OPS_PER_TICK),
    1,
    128,
    DEFAULT_MAX_REDIS_OPS_PER_TICK
  );
}

function getRedisFailThreshold() {
  return clampInt(
    envInt('DELIVERY_RECOVERY_REDIS_FAIL_THRESHOLD', DEFAULT_REDIS_FAIL_THRESHOLD),
    1,
    50,
    DEFAULT_REDIS_FAIL_THRESHOLD
  );
}

function getRedisFailCooldownMs() {
  return envInt('DELIVERY_RECOVERY_REDIS_COOLDOWN_MS', DEFAULT_REDIS_FAIL_COOLDOWN_MS);
}

function getCleanupBatchSize() {
  return clampInt(
    envInt('DELIVERY_CLEANUP_BATCH_SIZE', DEFAULT_CLEANUP_BATCH_SIZE),
    1,
    200,
    DEFAULT_CLEANUP_BATCH_SIZE
  );
}

function getCleanupMaxHdel() {
  return clampInt(
    envInt('DELIVERY_CLEANUP_MAX_HDEL', DEFAULT_CLEANUP_MAX_HDEL),
    1,
    100,
    DEFAULT_CLEANUP_MAX_HDEL
  );
}

function isRedisCircuitOpen() {
  return now() < redisCircuitOpenUntil;
}

function noteRedisSuccess() {
  redisFailStreak = 0;
}

function noteRedisFailure(reason) {
  recoveryRedisFailures += 1;
  redisFailStreak += 1;
  lastWorkerError = reason || lastWorkerError;
  if (redisFailStreak >= getRedisFailThreshold()) {
    redisCircuitOpenUntil = now() + getRedisFailCooldownMs();
    redisFailStreak = 0;
    console.warn(
      `[DurableDelivery] redis circuit open for ${getRedisFailCooldownMs()}ms ` +
        `(threshold=${getRedisFailThreshold()}); Mongo recovery continues`
    );
  }
}

function defaultOwner() {
  return String(
    process.env.FLY_MACHINE_ID ||
      process.env.FLY_ALLOC_ID ||
      `${os.hostname()}:${process.pid}`
  );
}

function stablePart(value, fallback = 'unknown') {
  return (
    String(value || fallback)
      .trim()
      .replace(/[:\s]/g, '_')
      .slice(0, 180) || fallback
  );
}

function jobIdFor({ eventId, canonicalTradeId, subscriberId, channel, eventType }) {
  const eid = stablePart(eventId || canonicalTradeId, 'missing-event');
  const cid = stablePart(canonicalTradeId || eventId, 'missing-trade');
  const sub = stablePart(subscriberId, 'broadcast');
  const ch = stablePart(channel, 'unknown');
  const ev = stablePart(eventType, 'entry');
  return `${eid}::${cid}::${sub}::${ch}::${ev}`;
}

function fanoutJobId(eventId, canonicalTradeId, eventType) {
  return jobIdFor({
    eventId,
    canonicalTradeId,
    subscriberId: FANOUT_SUBSCRIBER,
    channel: FANOUT_CHANNEL,
    eventType: eventType || 'entry'
  });
}

function keyJob(id) {
  return `${KEY_PREFIX}:djob:${id}`;
}

function keyLease(id) {
  return `${KEY_PREFIX}:dlease:${id}`;
}

function keyIndex() {
  return `${KEY_PREFIX}:djobidx`;
}

function retryDelayMs(sendAttempts) {
  const base = getRetryBaseDelayMs();
  const max = getRetryMaxDelayMs();
  const exp = Math.min(max, base * 2 ** Math.max(0, Number(sendAttempts || 0)));
  return Math.max(base, exp);
}

function isDupKeyError(err) {
  if (!err) return false;
  const code = err.code || err.codeName;
  return code === 11000 || code === 'E11000' || /duplicate key/i.test(String(err.message || ''));
}

function isRedisUnavailable(err) {
  if (!err) return false;
  return (
    err.code === (TradeEventStore.REDIS_UNAVAILABLE || 'REDIS_UNAVAILABLE') ||
    err.reason === 'redis_unavailable' ||
    /redis unavailable/i.test(String(err.message || ''))
  );
}

function redisUnavailableError(message) {
  const err = new Error(message || 'Redis unavailable for durableDelivery; refusing process-local fallback');
  err.code = TradeEventStore.REDIS_UNAVAILABLE || 'REDIS_UNAVAILABLE';
  err.reason = 'redis_unavailable';
  return err;
}

function mongoUnavailableError(message) {
  const err = new Error(message || 'Mongo unavailable for durableDelivery');
  err.code = 'MONGO_UNAVAILABLE';
  err.reason = 'mongo_unavailable';
  return err;
}

function isTestEnv() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'test';
}

function requireRealMongo() {
  if (isTestEnv()) return false;
  if (TradeEventStore.allowMemoryFallback()) return false;
  return true;
}

function useRealMongo() {
  if (isTestEnv()) return false;
  try {
    const mongoose = require('mongoose');
    return mongoose.connection.readyState === 1;
  } catch {
    return false;
  }
}

function logDurable(event, job = {}, extra = {}) {
  const ch = job.channel || extra.channel || '-';
  const state = job.state || extra.state || '-';
  const reason = extra.reason || job.lastError || event;
  const ownerHash = job.owner ? hashIdentity(job.owner) : extra.owner ? hashIdentity(extra.owner) : '-';
  const meta = {
    ...extractPipelineMeta(job.payload?.signal || job.payload?.signalData || extra.signal || {}),
    signalUuid: extra.signalUuid || job.signalUuid || job.payload?.signalUuid,
    requestId:
      extra.requestId ||
      job.correlation?.requestId ||
      job.refs?.requestId ||
      job.payload?.acceptResult?.requestId ||
      job.payload?.signal?.pipelineRequestId ||
      job.payload?.signalData?.pipelineRequestId ||
      job.payload?.signal?.correlation?.requestId,
    eventId: extra.eventId || job.eventId,
    canonicalTradeId: extra.canonicalTradeId || job.canonicalTradeId,
    eventType: extra.eventType || job.eventType,
    eventSequence: extra.eventSequence != null ? extra.eventSequence : job.eventSequence,
    userId: extra.subscriberHash || (job.subscriberId ? hashIdentity(job.subscriberId) : null),
    subscriberId: job.subscriberId ? hashIdentity(job.subscriberId) : extra.subscriberId,
    channel: ch,
    deliveryJobId: hashIdentity(job.jobId || extra.jobId || ''),
    attemptCount: job.attemptCount || 0,
    sendAttempts: job.sendAttempts || 0,
    leaseOwner: ownerHash,
    leaseUntil: job.leaseUntil || 0,
    deliveryJobState: state,
    reason:
      `${event}; jobId=${hashIdentity(job.jobId || '')}; channel=${ch}; state=${state}; ` +
      `attempts=${job.sendAttempts || 0}/${getMaxAttempts()}; attemptCount=${job.attemptCount || 0}; ` +
      `leaseUntil=${job.leaseUntil || 0}; ownerHash=${ownerHash}; ${reason}`
  };
  const status =
    event === 'FAILED_TERMINAL' || event === 'FAILED TERMINAL' || event === 'ENTRY FAILED'
      ? 'FAIL'
      : event === 'BLOCKED_WAITING_FOR_ENTRY' || event === 'RETRY_SCHEDULED' || event === 'RETRY SCHEDULED'
        ? 'PENDING'
        : event === 'DUPLICATE SUPPRESSED' || event === 'LEASE_BUSY'
          ? 'DUPLICATE'
          : event === 'COMMITTED' ||
              event === 'MARKED DELIVERED' ||
              event === 'ENTRY SUCCESS' ||
              event === 'OUTCOME UNBLOCKED' ||
              event === 'PROVIDER_ACCEPTED'
            ? 'PASS'
            : 'PASS';
  logPipeline('DurableDelivery', status, meta);
  console.log(
    `[DURABLE DELIVERY] ${event} | channel=${ch} | state=${state} | ` +
      `eventIdHash=${hashIdentity(job.eventId || extra.eventId || '')} | ` +
      `canonicalHash=${hashIdentity(job.canonicalTradeId || extra.canonicalTradeId || '')} | ` +
      `subHash=${hashIdentity(job.subscriberId || extra.subscriberId || '')} | ` +
      `deliveryJobId=${hashIdentity(job.jobId || '')} | ` +
      `attemptCount=${job.attemptCount || 0} | attempts=${job.sendAttempts || 0} | ` +
      `leaseUntil=${job.leaseUntil || 0} | ownerHash=${ownerHash}`
  );
}

async function redisClient() {
  const inj = TradeEventStore.getInjectedClient();
  if (inj.unavailable) return null;
  if (inj.client) return inj.client;
  try {
    const { getRedisClient } = require('./redisClient');
    return await getRedisClient();
  } catch {
    return null;
  }
}

function cloneJob(job) {
  if (!job) return null;
  return { ...job, payload: job.payload && typeof job.payload === 'object' ? { ...job.payload } : job.payload };
}

const TERMINAL_STATES = Object.freeze([
  STATES.DELIVERED,
  STATES.FAILED_TERMINAL,
  STATES.SKIPPED,
  STATES.NOT_ELIGIBLE
]);

function isTerminalState(state) {
  return (
    state === STATES.DELIVERED ||
    state === STATES.FAILED_TERMINAL ||
    state === STATES.SKIPPED ||
    state === STATES.NOT_ELIGIBLE
  );
}

function isLeaseProtected(job, ts) {
  if (!job) return false;
  const t = ts != null ? ts : now();
  if (job.state === STATES.PROCESSING || job.state === STATES.SENDING) {
    return Number(job.leaseUntil || 0) > t;
  }
  return false;
}

function evictCacheMap(map, max, ts) {
  if (!map || map.size <= max) return;
  const entries = [...map.entries()];
  entries.sort((a, b) => {
    const ja = a[1];
    const jb = b[1];
    const rank = job => {
      if (isLeaseProtected(job, ts)) return 2;
      if (isTerminalState(job?.state)) return 0;
      return 1;
    };
    const ra = rank(ja);
    const rb = rank(jb);
    if (ra !== rb) return ra - rb;
    return Number(ja?.updatedAt || 0) - Number(jb?.updatedAt || 0);
  });
  for (const [id, job] of entries) {
    if (map.size <= max) break;
    if (isLeaseProtected(job, ts)) continue;
    map.delete(id);
  }
}

function maybeEvictCaches() {
  const ts = now();
  evictCacheMap(memJobs, MAX_MEM_JOBS, ts);
  evictCacheMap(durableDocs, MAX_DURABLE_DOCS, ts);
}

function rememberJob(map, jobId, job, { allowTerminal = true } = {}) {
  if (!job || !jobId) return;
  if (!allowTerminal && isTerminalState(job.state)) return;
  map.set(jobId, job);
  maybeEvictCaches();
}

function snapshotRecoveryMetrics() {
  return {
    getCount: recoveryGetCount,
    parseCount: recoveryParseCount,
    hydrateCount: recoveryHydrateCount,
    hGetAllCount: recoveryHGetAllCount,
    hScanCount: recoveryHScanCount,
    ticks: recoveryTicks,
    jobsDiscovered: recoveryJobsDiscovered,
    jobsRequired: recoveryJobsRequired,
    jobsTerminalSkipped: recoveryJobsTerminalSkipped,
    indexRemoved: recoveryIndexRemoved,
    overlapSkips: recoveryOverlapSkips,
    redisFailures: recoveryRedisFailures,
    lastDurationMs: recoveryLastDurationMs,
    durationTotalMs: recoveryDurationTotalMs,
    concurrentHydrations,
    maxConcurrentHydrations,
    lastTickGets,
    lastTickHydrations,
    lastTickParses,
    lastTickRedisOps,
    lastTickHscans,
    memJobs: memJobs.size,
    durableDocs: durableDocs.size,
    scanCursor: recoveryScanCursor,
    pendingIds: recoveryPendingIds.length,
    redisIndexScanEnabled: redisIndexScanEnabled(),
    redisCircuitOpen: isRedisCircuitOpen(),
    redisCircuitOpenUntil,
    recoveryIntervalMs: getRecoveryIntervalMs(),
    processBudget: getProcessBudget()
  };
}

function getRecoveryMetricsForTests() {
  return snapshotRecoveryMetrics();
}

function resetRecoveryMetricsForTests() {
  recoveryGetCount = 0;
  recoveryParseCount = 0;
  recoveryHydrateCount = 0;
  recoveryHGetAllCount = 0;
  recoveryHScanCount = 0;
  recoveryTicks = 0;
  recoveryJobsDiscovered = 0;
  recoveryJobsRequired = 0;
  recoveryJobsTerminalSkipped = 0;
  recoveryIndexRemoved = 0;
  recoveryOverlapSkips = 0;
  recoveryRedisFailures = 0;
  recoveryLastDurationMs = 0;
  recoveryDurationTotalMs = 0;
  concurrentHydrations = 0;
  maxConcurrentHydrations = 0;
  lastTickGets = 0;
  lastTickHydrations = 0;
  lastTickParses = 0;
  lastTickRedisOps = 0;
  lastTickHscans = 0;
  redisFailStreak = 0;
  redisCircuitOpenUntil = 0;
  lastMetricsLogAt = 0;
  recoveryScanCursor = '0';
  recoveryPendingIds = [];
}

async function loadMongoJob(jobId) {
  if (!useRealMongo()) return durableDocs.get(jobId) ? cloneJob(durableDocs.get(jobId)) : null;
  try {
    const DeliveryJob = require('../models/DeliveryJob');
    const doc = await DeliveryJob.findOne({ jobId }).lean();
    if (!doc) return null;
    const copy = cloneJob(doc);
    rememberJob(durableDocs, jobId, copy, { allowTerminal: !isTerminalState(copy.state) });
    return copy;
  } catch (err) {
    console.warn('[DurableDelivery] mongo read failed:', err.message);
    return durableDocs.get(jobId) ? cloneJob(durableDocs.get(jobId)) : null;
  }
}

/**
 * Persist to durable storage (Mongo in prod, durableDocs always).
 * Duplicate-key is NOT swallowed: existing doc is loaded and returned.
 */
async function persistDurable(job, { ingest = false } = {}) {
  const copy = cloneJob(job);
  copy.updatedAt = now();
  rememberJob(durableDocs, copy.jobId, copy);

  if (!useRealMongo()) {
    if (ingest && requireRealMongo()) {
      throw mongoUnavailableError('Mongo unavailable for durableDelivery; refusing Redis-only record');
    }
    if (requireRealMongo()) {
      console.warn('[DurableDelivery] mongo not connected; worker write kept in durableDocs only');
    }
    return { created: true, job: copy };
  }

  try {
    const DeliveryJob = require('../models/DeliveryJob');
    try {
      await DeliveryJob.updateOne(
        { jobId: copy.jobId },
        { $set: { ...copy, updatedAt: new Date(now()) } },
        { upsert: true }
      );
      return { created: true, job: copy };
    } catch (err) {
      if (!isDupKeyError(err)) throw err;
      const existing = await DeliveryJob.findOne({ jobId: copy.jobId }).lean();
      if (!existing) throw err;
      const existingCopy = cloneJob(existing);
      rememberJob(durableDocs, copy.jobId, existingCopy);
      logDurable('DUPLICATE SUPPRESSED', existingCopy, {
        reason: existingCopy.state === STATES.DELIVERED ? 'duplicate_key_already_delivered' : 'duplicate_key_already_exists'
      });
      return {
        created: false,
        job: existingCopy,
        delivered: existingCopy.state === STATES.DELIVERED
      };
    }
  } catch (err) {
    if (isDupKeyError(err)) throw err;
    if (ingest && requireRealMongo()) {
      throw mongoUnavailableError(`Mongo persist failed: ${err.message}`);
    }
    console.warn('[DurableDelivery] mongo persist failed:', err.message);
    if (ingest && requireRealMongo()) throw err;
    return { created: true, job: copy, mongoWarn: err.message };
  }
}

async function writeJob(job, { ingest = false } = {}) {
  // Mongo (or durableDocs) is committed first. Redis cache/index is best-effort after.
  const persisted = await persistDurable(job, { ingest });
  const copy = persisted.job || { ...job, updatedAt: now() };
  rememberJob(memJobs, copy.jobId, copy);

  let closedRetried = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const r = await redisClient();
    if (r) {
      try {
        await r.set(keyJob(copy.jobId), JSON.stringify(copy), { EX: JOB_TTL_SEC });
        if (!isTerminalState(copy.state) && typeof r.hSet === 'function') {
          await r.hSet(keyIndex(), copy.jobId, '1');
          if (typeof r.expire === 'function') await r.expire(keyIndex(), JOB_TTL_SEC);
        }
        break;
      } catch (err) {
        const { isClosedError, invalidateRedisClient } = require('./redisClient');
        if (isClosedError(err)) invalidateRedisClient(err);
        if (!closedRetried && isClosedError(err)) {
          closedRetried = true;
          continue;
        }
        if (ingest && !TradeEventStore.allowMemoryFallback()) {
          throw redisUnavailableError(`Redis unavailable for durableDelivery; ${err.message}`);
        }
        lastWorkerError = err.message;
        console.warn('[DurableDelivery] redis job cache write failed (durable Mongo record kept):', err.message);
        break;
      }
    } else if (!TradeEventStore.allowMemoryFallback()) {
      if (ingest) throw redisUnavailableError();
      lastWorkerError = 'redis_unavailable';
      console.warn('[DurableDelivery] redis unavailable for job cache; durable Mongo record kept');
      break;
    } else {
      break;
    }
  }

  if (isTerminalState(copy.state)) {
    // Only after durable Mongo/durableDocs commit. HDEL failure must not resurrect the job.
    await removeIndexMemberBestEffort(copy.jobId);
  }
  return copy;
}

async function removeIndexMemberBestEffort(jobId) {
  const id = String(jobId || '');
  if (!id) return false;
  const r = await redisClient();
  if (!r || typeof r.hDel !== 'function') return false;
  try {
    const n = await r.hDel(keyIndex(), id);
    if (Number(n) > 0) recoveryIndexRemoved += 1;
    return true;
  } catch (err) {
    lastWorkerError = err.message;
    console.warn(
      '[DurableDelivery] redis HDEL of terminal index member failed (Mongo terminal state kept):',
      err.message
    );
    return false;
  }
}

async function readJob(jobId, opts = {}) {
  const id = String(jobId || '');
  if (!id) return null;
  const recovery = opts.cachePolicy === 'recovery';
  const r = await redisClient();
  if (r) {
    try {
      const raw = await r.get(keyJob(id));
      if (raw) {
        if (recovery) {
          recoveryGetCount += 1;
          lastTickGets += 1;
          lastTickRedisOps += 1;
        }
        let parsed = raw;
        if (typeof raw === 'string') {
          if (recovery) {
            recoveryParseCount += 1;
            lastTickParses += 1;
          }
          parsed = JSON.parse(raw);
        }
        if (recovery && isTerminalState(parsed.state)) {
          return parsed;
        }
        rememberJob(memJobs, id, parsed, { allowTerminal: !recovery });
        return parsed;
      }
    } catch (err) {
      lastWorkerError = err.message;
      const { isClosedError, invalidateRedisClient } = require('./redisClient');
      if (isClosedError(err)) invalidateRedisClient(err);
      console.warn('[DurableDelivery] redis job read failed; falling back to Mongo:', err.message);
    }
  } else if (!TradeEventStore.allowMemoryFallback()) {
    /* Redis down: still read Mongo. Ingest callers that require Redis throw at write/lease. */
  }
  const durable = await loadMongoJob(id);
  if (durable) {
    if (recovery && isTerminalState(durable.state)) {
      return durable;
    }
    rememberJob(memJobs, id, durable, { allowTerminal: !recovery });
    return durable;
  }
  if (TradeEventStore.allowMemoryFallback()) {
    return memJobs.get(id) || null;
  }
  return memJobs.get(id) || null;
}

async function listJobIdsFromMongo() {
  const ids = new Set(durableDocs.keys());
  if (!useRealMongo()) return ids;
  try {
    const DeliveryJob = require('../models/DeliveryJob');
    const t = now();
    const docs = await DeliveryJob.find({
      $or: [
        { state: { $in: [STATES.PENDING, STATES.RETRY_PENDING, STATES.BLOCKED_WAITING_FOR_ENTRY] } },
        { state: STATES.PROVIDER_ACCEPTED },
        { state: { $in: [STATES.PROCESSING, STATES.SENDING] }, leaseUntil: { $lte: t } }
      ]
    })
      .select('jobId')
      .lean();
    for (const d of docs || []) {
      if (d.jobId) ids.add(d.jobId);
    }
  } catch (err) {
    lastWorkerError = err.message;
    console.warn('[DurableDelivery] mongo unfinished scan failed:', err.message);
  }
  return ids;
}

async function listJobIds() {
  const ids = await listJobIdsFromMongo();
  for (const id of memJobs.keys()) ids.add(id);
  // Recovery and getCounts must never HGETALL this index. ID listing for tests
  // uses in-process maps only. Redis index walking is opt-in via DELIVERY_RECOVERY_REDIS_SCAN.
  return [...ids];
}

/**
 * Bounded Redis index page. Never HGETALL. Never hydrates.
 * Fake clients used in tests should implement hScan({ cursor, COUNT }).
 */
async function scanIndexPage(cursor, count) {
  const r = await redisClient();
  if (!r) return { cursor: '0', ids: [] };
  const countOpt = Math.max(1, Number(count) || getHscanCount());
  try {
    if (typeof r.hScan === 'function') {
      recoveryHScanCount += 1;
      lastTickHscans += 1;
      lastTickRedisOps += 1;
      const curNum = Number(cursor);
      const reply = await r.hScan(keyIndex(), Number.isFinite(curNum) ? curNum : cursor || '0', {
        COUNT: countOpt
      });
      noteRedisSuccess();
      const ids = [];
      if (Array.isArray(reply?.tuples)) {
        for (const t of reply.tuples) {
          const field = t && (t.field != null ? t.field : t.key);
          if (field) ids.push(String(field));
        }
      } else if (Array.isArray(reply?.keys)) {
        for (const k of reply.keys) {
          if (k) ids.push(String(k));
        }
      } else if (reply && typeof reply === 'object') {
        const entries = reply.entries || reply.data;
        if (Array.isArray(entries)) {
          for (const e of entries) {
            if (e && e[0]) ids.push(String(e[0]));
          }
        }
      }
      return { cursor: String(reply?.cursor ?? 0), ids };
    }
    if (typeof r.hScanNoValues === 'function') {
      recoveryHScanCount += 1;
      lastTickHscans += 1;
      lastTickRedisOps += 1;
      const curNum = Number(cursor);
      const reply = await r.hScanNoValues(keyIndex(), Number.isFinite(curNum) ? curNum : cursor || '0', {
        COUNT: countOpt
      });
      noteRedisSuccess();
      const keys = Array.isArray(reply?.keys) ? reply.keys : [];
      return { cursor: String(reply?.cursor ?? 0), ids: keys.map(String).filter(Boolean) };
    }
  } catch (err) {
    lastWorkerError = err.message;
    noteRedisFailure(err.message);
    const { isClosedError, invalidateRedisClient } = require('./redisClient');
    if (typeof isClosedError === 'function' && isClosedError(err)) invalidateRedisClient(err);
    console.warn('[DurableDelivery] redis HSCAN failed:', err.message);
  }
  return { cursor: '0', ids: [] };
}

async function hydrateJobForRecovery(jobId) {
  concurrentHydrations += 1;
  if (concurrentHydrations > maxConcurrentHydrations) {
    maxConcurrentHydrations = concurrentHydrations;
  }
  recoveryHydrateCount += 1;
  lastTickHydrations += 1;
  try {
    return await readJob(jobId, { cachePolicy: 'recovery' });
  } finally {
    concurrentHydrations -= 1;
  }
}

async function collectDueJobsBounded(ts) {
  lastTickGets = 0;
  lastTickHydrations = 0;
  lastTickParses = 0;
  lastTickRedisOps = 0;
  lastTickHscans = 0;
  const t = ts != null ? ts : now();
  const budget = getProcessBudget();
  const hydrateBudget = getHydrateBatch();
  const maxRedisOps = getMaxRedisOpsPerTick();
  const due = [];
  const seen = new Set();

  // 1. Process-local durable cache (Mongo stand-in in tests; recent prod docs).
  for (const job of durableDocs.values()) {
    if (!job || seen.has(job.jobId)) continue;
    if (isDue(job, t)) {
      seen.add(job.jobId);
      due.push(job);
      if (due.length >= budget) return due.slice(0, budget);
    }
  }
  for (const job of memJobs.values()) {
    if (!job || seen.has(job.jobId)) continue;
    if (isDue(job, t)) {
      seen.add(job.jobId);
      due.push(job);
      if (due.length >= budget) return due.slice(0, budget);
    }
  }

  // 2. PRIMARY recovery query: Mongo unfinished+due only. Indexed {state, nextAttemptAt}
  //    and {state, leaseUntil}. Never scans historical delivered jobs.
  if (useRealMongo() && due.length < budget) {
    try {
      const DeliveryJob = require('../models/DeliveryJob');
      const docs = await DeliveryJob.find({
        $or: [
          {
            state: {
              $in: [STATES.PENDING, STATES.RETRY_PENDING, STATES.BLOCKED_WAITING_FOR_ENTRY]
            },
            nextAttemptAt: { $lte: t }
          },
          { state: STATES.PROVIDER_ACCEPTED },
          {
            state: { $in: [STATES.PROCESSING, STATES.SENDING] },
            leaseUntil: { $lte: t }
          }
        ]
      })
        .sort({ nextAttemptAt: 1 })
        .limit(budget - due.length)
        .lean();
      for (const d of docs || []) {
        if (!d?.jobId || seen.has(d.jobId)) continue;
        seen.add(d.jobId);
        const copy = cloneJob(d);
        rememberJob(durableDocs, d.jobId, copy, { allowTerminal: false });
        if (isDue(copy, t)) due.push(copy);
      }
    } catch (err) {
      lastWorkerError = err.message;
      console.warn('[DurableDelivery] mongo due scan failed:', err.message);
    }
  }

  // 3. OPTIONAL Redis index walk. Default OFF — the ~41k historical djobidx
  //    members must not be HSCAN+GET'd every recovery tick. Enable only with
  //    DELIVERY_RECOVERY_REDIS_SCAN=1 (bounded fallback / tests).
  const canScanRedis =
    redisIndexScanEnabled() &&
    !isRedisCircuitOpen() &&
    due.length < budget &&
    lastTickRedisOps < maxRedisOps;

  if (!canScanRedis) {
    return due.slice(0, budget);
  }

  let steps = 0;
  const maxSteps = getScanStepsPerTick();
  while (
    due.length < budget &&
    lastTickHydrations < hydrateBudget &&
    lastTickRedisOps < maxRedisOps &&
    steps < maxSteps &&
    !isRedisCircuitOpen()
  ) {
    if (!recoveryPendingIds.length) {
      const page = await scanIndexPage(recoveryScanCursor, getHscanCount());
      recoveryScanCursor = page.cursor || '0';
      recoveryPendingIds = (page.ids || []).filter(id => id && !seen.has(id));
      steps += 1;
      if (!recoveryPendingIds.length) {
        if (recoveryScanCursor === '0' || recoveryScanCursor === '00') break;
        continue;
      }
    }
    const room = Math.min(
      hydrateBudget - lastTickHydrations,
      maxRedisOps - lastTickRedisOps,
      recoveryPendingIds.length
    );
    if (room <= 0) break;
    const batch = recoveryPendingIds.splice(0, room);
    let consumed = 0;
    for (; consumed < batch.length; consumed += 1) {
      if (due.length >= budget) break;
      if (lastTickHydrations >= hydrateBudget) break;
      if (lastTickRedisOps >= maxRedisOps) break;
      const id = batch[consumed];
      seen.add(id);
      const job = await hydrateJobForRecovery(id);
      if (!job) continue;
      if (isTerminalState(job.state)) {
        recoveryJobsTerminalSkipped += 1;
        continue;
      }
      if (isDue(job, t)) due.push(job);
    }
    if (consumed < batch.length) {
      recoveryPendingIds = batch.slice(consumed).concat(recoveryPendingIds);
      break;
    }
  }

  return due.slice(0, budget);
}

async function setLease(jobId, owner) {
  if (memLeases.has(jobId) && memLeases.get(jobId) !== owner) return false;
  memLeases.set(jobId, owner);
  let closedRetried = false;
  while (true) {
    const r = await redisClient();
    if (!r) {
      if (!TradeEventStore.allowMemoryFallback()) {
        memLeases.delete(jobId);
        throw redisUnavailableError('Redis unavailable for durableDelivery lease');
      }
      return true;
    }
    try {
      const ok = await r.set(keyLease(jobId), owner, { NX: true, PX: getLeaseMs() });
      if (!ok) {
        const cur = await r.get(keyLease(jobId));
        if (cur && cur !== owner) {
          memLeases.delete(jobId);
          return false;
        }
      }
      return true;
    } catch (err) {
      const { isClosedError, invalidateRedisClient } = require('./redisClient');
      if (!closedRetried && isClosedError(err)) {
        invalidateRedisClient(err);
        closedRetried = true;
        continue;
      }
      if (!TradeEventStore.allowMemoryFallback()) {
        memLeases.delete(jobId);
        err.code = err.code || TradeEventStore.REDIS_UNAVAILABLE;
        err.reason = 'redis_unavailable';
        throw err;
      }
      return true;
    }
  }
}

async function getLease(jobId) {
  const r = await redisClient();
  if (r) {
    try {
      const v = await r.get(keyLease(jobId));
      if (v) return String(v);
    } catch {
      /* memory */
    }
  }
  return memLeases.get(jobId) || null;
}

async function delLease(jobId) {
  memLeases.delete(jobId);
  const r = await redisClient();
  if (r) {
    try {
      await r.del(keyLease(jobId));
    } catch {
      /* ignore */
    }
  }
}

function isDue(job, ts) {
  if (!job) return false;
  const t = ts != null ? ts : now();
  if (isTerminalState(job.state)) {
    return false;
  }
  if (job.state === STATES.PROVIDER_ACCEPTED) return true;
  if (job.state === STATES.PROCESSING || job.state === STATES.SENDING) {
    return Number(job.leaseUntil || 0) <= t;
  }
  if (job.state === STATES.RETRY_PENDING || job.state === STATES.BLOCKED_WAITING_FOR_ENTRY) {
    return Number(job.nextAttemptAt || 0) <= t;
  }
  if (job.state === STATES.PENDING) return Number(job.nextAttemptAt || 0) <= t;
  return false;
}

function newJob(spec) {
  const eventId = String(spec.eventId || spec.canonicalTradeId || '').trim();
  const canonicalTradeId = String(spec.canonicalTradeId || spec.eventId || '').trim();
  const subscriberId = String(spec.subscriberId || 'broadcast');
  const channel = String(spec.channel || 'unknown');
  const eventType = String(spec.eventType || spec.alertType || 'entry').toLowerCase();
  const id = spec.jobId || jobIdFor({ eventId, canonicalTradeId, subscriberId, channel, eventType });
  const ts = now();
  return {
    jobId: id,
    eventId,
    canonicalTradeId,
    subscriberId,
    channel,
    eventType,
    eventSequence:
      spec.eventSequence != null ? spec.eventSequence : eventSequenceRank(eventType),
    signalUuid: spec.signalUuid || spec.payload?.signalUuid || canonicalTradeId,
    requestId:
      spec.requestId ||
      spec.correlation?.requestId ||
      spec.payload?.correlation?.requestId ||
      spec.payload?.signal?.pipelineRequestId ||
      spec.payload?.signal?.correlation?.requestId ||
      null,
    outcomeStatus: spec.outcomeStatus || 'pending',
    outcomeReason: spec.outcomeReason || null,
    state: STATES.PENDING,
    owner: null,
    leaseUntil: 0,
    attemptCount: 0,
    sendAttempts: 0,
    lastAttemptAt: 0,
    nextAttemptAt: ts,
    lastError: null,
    createdAt: ts,
    updatedAt: ts,
    deliveredAt: 0,
    payload: spec.payload || {},
    correlation: compactCorrelation(
      mergeCorrelation(spec.correlation, spec, spec.payload, spec.payload?.signal, spec.payload?.signalData)
    ),
    refs: spec.refs || buildDurableRefs(spec),
    deliveryReason: spec.deliveryReason || null,
    predecessorEvent: spec.predecessorEvent || null,
    deliverySequenceKey: spec.deliverySequenceKey || null,
    waitMs: spec.waitMs != null ? spec.waitMs : null,
    retryScheduled: spec.retryScheduled != null ? Boolean(spec.retryScheduled) : null,
    channelDeliveryState: spec.channelDeliveryState || STATES.PENDING
  };
}

async function ensureJob(spec, opts = {}) {
  const job = newJob(spec);
  const existing = await readJob(job.jobId);
  if (existing) {
    if (
      existing.state === STATES.DELIVERED ||
      existing.state === STATES.FAILED_TERMINAL ||
      existing.state === STATES.SKIPPED ||
      existing.state === STATES.NOT_ELIGIBLE
    ) {
      return existing;
    }
    if (spec.payload || spec.correlation || spec.refs) {
      existing.payload = { ...(existing.payload || {}), ...(spec.payload || {}) };
      existing.correlation = compactCorrelation(mergeCorrelation(existing.correlation, spec.correlation, spec));
      existing.refs = { ...(existing.refs || {}), ...(spec.refs || buildDurableRefs(spec)) };
      if (spec.predecessorEvent) existing.predecessorEvent = spec.predecessorEvent;
      if (spec.deliverySequenceKey) existing.deliverySequenceKey = spec.deliverySequenceKey;
      if (spec.waitMs != null) existing.waitMs = spec.waitMs;
      if (spec.retryScheduled != null) existing.retryScheduled = spec.retryScheduled;
      if (spec.deliveryReason) existing.deliveryReason = spec.deliveryReason;
      return writeJob(existing, { ingest: Boolean(opts.ingest) });
    }
    return existing;
  }
  try {
    const created = await writeJob(job, { ingest: opts.ingest !== false });
    logDurable('DELIVERY_JOB_CREATED', created);
    return created;
  } catch (err) {
    if (!isDupKeyError(err)) throw err;
    const again = await readJob(job.jobId);
    if (!again) throw err;
    logDurable('DUPLICATE SUPPRESSED', again, {
      reason: again.state === STATES.DELIVERED ? 'duplicate_key_already_delivered' : 'duplicate_key_already_exists'
    });
    return again;
  }
}

function snapshotSubscriber(subscriber) {
  if (!subscriber || typeof subscriber !== 'object') return null;
  return {
    id: subscriber.id || subscriber._id,
    email: subscriber.email,
    displayName: subscriber.displayName,
    role: subscriber.role,
    subscription: subscriber.subscription,
    telegram: subscriber.telegram
      ? {
          chatId: subscriber.telegram.chatId,
          enabled: subscriber.telegram.enabled,
          telegramMode: subscriber.telegram.telegramMode
        }
      : undefined,
    mt5: subscriber.mt5,
    preferences: subscriber.preferences
  };
}

function snapshotSignal(signalDoc) {
  if (!signalDoc) return null;
  const plain = signalDoc.toObject ? signalDoc.toObject() : { ...signalDoc };
  return plain;
}

function hasPersistedSignalId(saved) {
  if (!saved || typeof saved !== 'object') return false;
  const id = saved._id != null ? saved._id : saved.id;
  if (id == null || id === '') return false;
  const s = String(id);
  return s !== 'undefined' && s !== 'null';
}

async function ensureFanoutWork(acceptResult) {
  const signalData = acceptResult?.signalData || {};
  const saved = acceptResult?.saved || {};
  if (!hasPersistedSignalId(saved)) {
    logDurable('FANOUT SKIPPED', {}, {
      reason: 'missing_persisted_signal_id; refusing synthetic fan-out without Mongo Signal'
    });
    return null;
  }
  const canonicalTradeId =
    resolveCanonicalTradeId(signalData) ||
    resolveCanonicalTradeId(saved) ||
    String(acceptResult?.signalUuid || saved?.signalUuid || saved?.signalId || '').trim();
  const eventId = String(signalData.eventId || canonicalTradeId || '').trim();
  const eventType = String(signalData.alertType || saved?.alertType || 'entry').toLowerCase();
  if (!eventId && !canonicalTradeId) return null;
  const job = await ensureJob({
    eventId,
    canonicalTradeId,
    subscriberId: FANOUT_SUBSCRIBER,
    channel: FANOUT_CHANNEL,
    eventType,
    eventSequence: signalData.eventSequence,
    signalUuid: acceptResult?.signalUuid || saved?.signalUuid || canonicalTradeId,
    payload: {
      kind: 'fanout',
      acceptResult: {
        accepted: true,
        duplicate: false,
        skippedFanout: false,
        saved,
        signalData,
        signalUuid: acceptResult?.signalUuid || saved?.signalUuid || canonicalTradeId,
        broadcastSaved: acceptResult?.broadcastSaved,
        outcomeLinked: acceptResult?.outcomeLinked,
        timings: acceptResult?.timings || {},
        requestId: signalData.pipelineRequestId || signalData.correlation?.requestId || acceptResult?.requestId
      },
      signalUuid: acceptResult?.signalUuid || saved?.signalUuid,
      alertType: eventType,
      correlation: compactCorrelation(
        mergeCorrelation(signalData, saved, {
          requestId: signalData.pipelineRequestId || acceptResult?.requestId,
          fanoutJobId: fanoutJobId(eventId, canonicalTradeId, eventType)
        })
      )
    },
    correlation: compactCorrelation(
      mergeCorrelation(signalData, saved, {
        requestId: signalData.pipelineRequestId || acceptResult?.requestId,
        fanoutJobId: fanoutJobId(eventId, canonicalTradeId, eventType)
      })
    ),
    refs: buildDurableRefs({
      eventId,
      canonicalTradeId,
      subscriberId: FANOUT_SUBSCRIBER,
      channel: FANOUT_CHANNEL,
      eventType,
      signalUuid: acceptResult?.signalUuid || saved?.signalUuid || canonicalTradeId,
      signalId: saved?._id || saved?.id,
      payload: { signalData, saved }
    })
  });
  return job;
}

function hasFanoutWorkSync(eventId, canonicalTradeId, eventType) {
  const id = fanoutJobId(eventId || canonicalTradeId, canonicalTradeId || eventId, eventType);
  return durableDocs.has(id) || memJobs.has(id);
}

async function hasFanoutWork(eventId, canonicalTradeId, eventType) {
  const id = fanoutJobId(eventId || canonicalTradeId, canonicalTradeId || eventId, eventType);
  const job = await readJob(id);
  return Boolean(job);
}

async function getJob(jobId) {
  return readJob(jobId);
}

async function getJobBySpec(spec) {
  return readJob(jobIdFor(spec));
}

/**
 * Acquire PROCESSING lease. Reclaims expired leases. A live lease is busy
 * (no same-owner re-entry). Does not mark DELIVERED.
 * PROVIDER_ACCEPTED: do not resend; caller must finish COMMITTED.
 */
async function beginAttempt(spec, opts = {}) {
  const owner = String(opts.owner || defaultOwner());
  let job = spec.jobId
    ? await readJob(spec.jobId)
    : await ensureJob(
        {
          ...spec,
          payload: {
            ...(spec.payload || {}),
            subscriber: spec.subscriber ? snapshotSubscriber(spec.subscriber) : spec.payload?.subscriber,
            signal: spec.signalDoc ? snapshotSignal(spec.signalDoc) : spec.payload?.signal,
            telegramOptions: spec.telegramOptions || spec.payload?.telegramOptions
          }
        },
        { ingest: false }
      );
  if (!job) return { status: 'not_found' };

  if (spec.subscriber || spec.signalDoc || spec.telegramOptions || spec.correlation || spec.refs) {
    job.payload = {
      ...(job.payload || {}),
      subscriber: spec.subscriber ? snapshotSubscriber(spec.subscriber) : job.payload?.subscriber,
      signal: spec.signalDoc ? snapshotSignal(spec.signalDoc) : job.payload?.signal,
      telegramOptions: spec.telegramOptions || job.payload?.telegramOptions,
      correlation: compactCorrelation(mergeCorrelation(job.payload?.correlation, spec.correlation, spec.signalDoc))
    };
    job.correlation = compactCorrelation(mergeCorrelation(job.correlation, spec.correlation, spec.signalDoc, spec));
    job.refs = { ...(job.refs || {}), ...(spec.refs || buildDurableRefs(spec)) };
  }

  if (job.state === STATES.DELIVERED) {
    logDurable('DUPLICATE SUPPRESSED', job);
    return { status: 'delivered', job };
  }
  if (job.state === STATES.PROVIDER_ACCEPTED) {
    logDurable('PROVIDER_ACCEPTED', job, { reason: 'finish_commit_no_resend' });
    return { status: 'provider_accepted', job };
  }
  if (job.state === STATES.FAILED_TERMINAL && !opts.allowTerminalRetry) {
    return { status: 'failed_terminal', job };
  }
  if (job.state === STATES.SKIPPED || job.state === STATES.NOT_ELIGIBLE) {
    return { status: job.state, job };
  }

  const ts = now();
  const leaseHeld = await getLease(job.jobId);
  const leaseValid =
    Number(job.leaseUntil || 0) > ts &&
    (job.state === STATES.PROCESSING || job.state === STATES.SENDING);

  if (leaseValid) {
    logDurable('LEASE_BUSY', job, { reason: 'live_lease' });
    return { status: 'busy', job };
  }
  if (leaseHeld && leaseValid) {
    logDurable('LEASE_BUSY', job, { reason: 'live_lease_held' });
    return { status: 'busy', job };
  }

  if (job.state === STATES.RETRY_PENDING || job.state === STATES.BLOCKED_WAITING_FOR_ENTRY) {
    if (Number(job.nextAttemptAt || 0) > ts) {
      return { status: 'not_due', job };
    }
  }

  const expiredProcessing =
    (job.state === STATES.PROCESSING || job.state === STATES.SENDING) &&
    Number(job.leaseUntil || 0) <= ts;
  if (expiredProcessing) {
    logDurable('LEASE EXPIRED', job);
    await delLease(job.jobId);
  }

  const got = await setLease(job.jobId, owner);
  if (!got) {
    const cur = await getLease(job.jobId);
    if (cur && cur !== owner) {
      logDurable('LEASE_BUSY', job, { reason: 'lease_lost' });
      return { status: 'busy', job };
    }
  }

  const recovered = expiredProcessing || job.state === STATES.RETRY_PENDING;
  job.state = STATES.PROCESSING;
  job.owner = owner;
  job.leaseUntil = ts + getLeaseMs();
  job.attemptCount = Number(job.attemptCount || 0) + (leaseValid && job.owner === owner ? 0 : 1);
  job.lastAttemptAt = ts;
  await writeJob(job);
  logDurable(recovered ? 'RECOVERED' : 'LEASE_ACQUIRED', job, {
    reason: recovered ? 'lease_reclaimed' : 'lease_acquired'
  });
  return { status: 'acquired', job };
}

async function beginFanoutAttempt(eventId, alertType, opts = {}) {
  const canonicalTradeId = String(opts.canonicalTradeId || eventId || '').trim();
  const eid = String(eventId || canonicalTradeId).trim();
  return beginAttempt(
    {
      eventId: eid,
      canonicalTradeId,
      subscriberId: FANOUT_SUBSCRIBER,
      channel: FANOUT_CHANNEL,
      eventType: alertType || 'entry',
      signalUuid: opts.signalUuid || canonicalTradeId,
      payload: opts.payload
    },
    opts
  );
}

async function markSending(jobId) {
  const job = await readJob(jobId);
  if (!job) return { status: 'not_found' };
  if (job.state === STATES.DELIVERED) return { status: 'delivered', job };
  if (job.state === STATES.PROVIDER_ACCEPTED) return { status: 'provider_accepted', job };
  if (job.state === STATES.FAILED_TERMINAL) return { status: 'failed_terminal', job };
  job.state = STATES.SENDING;
  await writeJob(job);
  logDurable('PROVIDER_SEND_STARTED', job);
  return { status: 'sending', job };
}

async function markSendingBySpec(spec) {
  return markSending(jobIdFor(spec));
}

async function markProviderAccepted(jobId, extra = {}) {
  const job = await readJob(jobId);
  if (!job) return { status: 'not_found' };
  if (job.state === STATES.DELIVERED) return { status: 'delivered', job };
  job.state = STATES.PROVIDER_ACCEPTED;
  job.lastError = extra.reason || null;
  await writeJob(job);
  logDurable('PROVIDER_ACCEPTED', job, { reason: extra.reason || 'provider_http_ok' });
  return { status: 'provider_accepted', job };
}

async function markProviderAcceptedBySpec(spec, extra) {
  return markProviderAccepted(jobIdFor(spec), extra);
}

async function commitDelivered(jobId, extra = {}) {
  const job = await readJob(jobId);
  if (!job) return { status: 'not_found' };
  if (job.state === STATES.DELIVERED) {
    await delLease(jobId);
    return { status: 'delivered', job };
  }
  if (job.state === STATES.FAILED_TERMINAL) {
    await delLease(jobId);
    return { status: 'failed_terminal', job };
  }
  if (job.state === STATES.SKIPPED || job.state === STATES.NOT_ELIGIBLE) {
    await delLease(jobId);
    return { status: job.state, job };
  }
  job.state = STATES.DELIVERED;
  job.outcomeStatus = 'success';
  job.outcomeReason = extra.reason || null;
  job.channelDeliveryState = 'success';
  job.deliveredAt = now();
  job.lastError = extra.reason || null;
  job.leaseUntil = 0;
  await writeJob(job);
  await delLease(jobId);
  const ev = String(job.eventType || '').toLowerCase();
  if (job.channel !== FANOUT_CHANNEL && (ev === 'entry' || isEntryAlert(ev))) {
    logDurable('ENTRY SUCCESS', job);
    logDurable('COMMITTED', job);
  } else {
    logDurable('COMMITTED', job);
  }
  return { status: 'delivered', job };
}

async function commitDeliveredBySpec(spec, extra) {
  return commitDelivered(jobIdFor(spec), extra);
}

/**
 * Immediate terminal failure. Does not schedule retry.
 * Used when work must not be sent and must not be recorded as delivered
 * (e.g. stale ENTRY claimed for fan-out before any provider send).
 * Does not overwrite DELIVERED or PROVIDER_ACCEPTED.
 */
async function commitFailedTerminal(jobId, extra = {}) {
  const job = await readJob(jobId);
  if (!job) return { status: 'not_found' };
  if (job.state === STATES.DELIVERED) {
    await delLease(jobId);
    return { status: 'delivered', job };
  }
  if (job.state === STATES.PROVIDER_ACCEPTED) {
    return { status: 'provider_accepted', job };
  }
  if (job.state === STATES.FAILED_TERMINAL) {
    await delLease(jobId);
    return { status: 'failed_terminal', job };
  }
  if (job.state === STATES.SKIPPED || job.state === STATES.NOT_ELIGIBLE) {
    await delLease(jobId);
    return { status: job.state, job };
  }
  job.state = STATES.FAILED_TERMINAL;
  job.outcomeStatus = 'failed';
  job.outcomeReason = extra.reason || 'failed_terminal';
  job.channelDeliveryState = 'failed';
  job.lastError = extra.reason || 'failed_terminal';
  job.leaseUntil = 0;
  job.nextAttemptAt = 0;
  await writeJob(job);
  await delLease(jobId);
  const ev = String(job.eventType || '').toLowerCase();
  if (ev === 'entry' || isEntryAlert(ev)) {
    logDurable('ENTRY FAILED', job, { reason: job.lastError });
  }
  logDurable('FAILED_TERMINAL', job, { reason: job.lastError });
  return { status: 'failed_terminal', job };
}

async function commitFailedTerminalBySpec(spec, extra) {
  return commitFailedTerminal(jobIdFor(spec), extra);
}

async function scheduleRetry(jobId, { reason, blockedWaitingForEntry = false } = {}) {
  const job = await readJob(jobId);
  if (!job) return { status: 'not_found' };
  if (job.state === STATES.DELIVERED) return { status: 'delivered', job };
  if (String(reason || '') === 'delivery_context_unrecoverable') {
    return commitFailedTerminal(jobId, { reason: 'delivery_context_unrecoverable' });
  }
  if (job.state === STATES.PROVIDER_ACCEPTED) {
    return commitDelivered(jobId, { reason: reason || 'provider_accepted_retry_commit' });
  }

  const ts = now();
  if (blockedWaitingForEntry) {
    job.state = STATES.BLOCKED_WAITING_FOR_ENTRY;
    job.lastError = reason || 'blocked_waiting_for_entry';
    job.deliveryReason = job.lastError;
    job.channelDeliveryState = 'blocked';
    job.retryScheduled = true;
    job.nextAttemptAt = ts + Math.min(getRetryBaseDelayMs(), 1000);
    job.leaseUntil = 0;
    await writeJob(job);
    await delLease(jobId);
    logDurable('BLOCKED_WAITING_FOR_ENTRY', job, { reason: job.lastError });
    try {
      const { emitTvDeliver } = require('./tvStageLog');
      emitTvDeliver({
        ...correlationFromJob(job),
        channel: job.channel,
        subscriberId: job.subscriberId,
        deliveryJobId: job.jobId,
        state: 'blocked',
        reason: job.lastError,
        predecessorEvent: job.predecessorEvent,
        deliverySequenceKey: job.deliverySequenceKey,
        waitMs: job.waitMs,
        retryScheduled: true
      });
    } catch {
      /* diagnostics */
    }
    return { status: 'blocked_waiting_for_entry', job };
  }

  job.sendAttempts = Number(job.sendAttempts || 0) + 1;
  job.lastError = reason || 'delivery_failed';
  if (job.sendAttempts >= getMaxAttempts()) {
    job.state = STATES.FAILED_TERMINAL;
    job.leaseUntil = 0;
    job.nextAttemptAt = 0;
    await writeJob(job);
    await delLease(jobId);
    logDurable('FAILED_TERMINAL', job, { reason: job.lastError });
    return { status: 'failed_terminal', job };
  }

  const delay = retryDelayMs(job.sendAttempts);
  job.state = STATES.RETRY_PENDING;
  job.nextAttemptAt = ts + delay;
  job.leaseUntil = 0;
  await writeJob(job);
  await delLease(jobId);
  const ev = String(job.eventType || '').toLowerCase();
  if (ev === 'entry' || isEntryAlert(ev)) {
    logDurable('ENTRY FAILED', job, { reason: job.lastError });
  }
  logDurable('RETRY_SCHEDULED', job, { reason: `delayMs=${delay}; ${job.lastError}` });
  return { status: 'retry_pending', job, delayMs: delay };
}

async function scheduleRetryBySpec(spec, opts) {
  return scheduleRetry(jobIdFor(spec), opts);
}

async function retryFailedTerminal(jobId, opts = {}) {
  const job = await readJob(jobId);
  if (!job) return { status: 'not_found' };
  if (job.state !== STATES.FAILED_TERMINAL && !opts.force) {
    return { status: job.state, job };
  }
  job.state = STATES.RETRY_PENDING;
  job.nextAttemptAt = now();
  job.lastError = opts.reason || 'admin_retry';
  await writeJob(job);
  logDurable('RETRY_SCHEDULED', job, { reason: 'failed_terminal_requeued' });
  return { status: 'retry_pending', job };
}

async function isDelivered(spec) {
  const job = await readJob(typeof spec === 'string' ? spec : jobIdFor(spec));
  return job?.state === STATES.DELIVERED;
}

async function listJobsForSignal(signalUuid, { limit = 400 } = {}) {
  const uuid = String(signalUuid || '').trim();
  if (!uuid) return [];
  const cap = Math.max(1, Math.min(500, Number(limit) || 400));
  if (useRealMongo()) {
    try {
      const DeliveryJob = require('../models/DeliveryJob');
      return await DeliveryJob.find({
        signalUuid: uuid,
        channel: { $ne: FANOUT_CHANNEL }
      })
        .select('jobId channel subscriberId state outcomeStatus outcomeReason lastError signalUuid eventType requestId createdAt')
        .sort({ createdAt: -1 })
        .limit(cap)
        .lean();
    } catch (err) {
      console.warn('[DurableDelivery] listJobsForSignal failed:', err.message);
    }
  }
  const out = [];
  for (const job of durableDocs.values()) {
    if (!job) continue;
    if (job.channel === FANOUT_CHANNEL) continue;
    if (String(job.signalUuid || '') !== uuid) continue;
    out.push(job);
    if (out.length >= cap) break;
  }
  return out;
}

async function listJobs() {
  // Test/admin inspection of the process-local set only. Never HGETALL+GET the Redis index.
  return listMemoryJobs();
}

/** Process-local jobs only (tests / Mongo-unavailable). Not a Redis/Mongo full scan. */
function listMemoryJobs() {
  const map = new Map();
  for (const [id, job] of durableDocs) {
    if (job) map.set(id, job);
  }
  for (const [id, job] of memJobs) {
    if (job) map.set(id, job);
  }
  return [...map.values()];
}

function emptyCounts() {
  return {
    pending: 0,
    processing: 0,
    sending: 0,
    retry_pending: 0,
    provider_accepted: 0,
    delivered: 0,
    failed_terminal: 0,
    blocked_waiting_for_entry: 0,
    skipped: 0,
    not_eligible: 0
  };
}

function countStates(jobs) {
  const counts = emptyCounts();
  for (const job of jobs) {
    if (counts[job.state] != null) counts[job.state] += 1;
  }
  return counts;
}

async function computeCountsBounded() {
  const counts = emptyCounts();
  let approximate = false;
  let total = 0;

  if (useRealMongo()) {
    try {
      const DeliveryJob = require('../models/DeliveryJob');
      const rows = await DeliveryJob.aggregate([{ $group: { _id: '$state', n: { $sum: 1 } } }]);
      for (const row of rows || []) {
        const key = row && row._id;
        const n = Number(row && row.n) || 0;
        if (key && counts[key] != null) counts[key] = n;
        total += n;
      }
    } catch (err) {
      approximate = true;
      lastWorkerError = err.message;
      console.warn('[DurableDelivery] getCounts mongo aggregate failed:', err.message);
    }
  }

  if (!useRealMongo() || approximate) {
    const mem = countStates(listMemoryJobs());
    Object.assign(counts, mem);
    total = 0;
    for (const k of Object.keys(emptyCounts())) total += counts[k] || 0;
  }

  const r = await redisClient();
  if (r && typeof r.hLen === 'function') {
    try {
      const hlen = Number(await r.hLen(keyIndex()));
      if (Number.isFinite(hlen)) {
        counts.redisIndexSize = hlen;
        if (hlen > total) {
          approximate = true;
        }
      }
    } catch {
      /* HLEN is optional diagnostics */
    }
  }

  counts.total = total;
  counts.approximate = approximate;
  return counts;
}

async function getCounts() {
  const { withTimeout } = require('./boundedWait');
  try {
    return await withTimeout(computeCountsBounded(), 2500, 'durable_getCounts');
  } catch (err) {
    lastWorkerError = err?.message || 'getCounts_timeout';
    return { ...emptyCounts(), total: 0, approximate: true };
  }
}

async function listDueJobs(ts) {
  const t = ts != null ? ts : now();
  return listMemoryJobs().filter(j => isDue(j, t));
}

async function onEntryCommitted({ canonicalTradeId, subscriberId, channel }) {
  const cid = String(canonicalTradeId || '').trim();
  if (!cid) return 0;
  const sub = String(subscriberId);
  const ch = String(channel);
  const matches = [];
  const seen = new Set();
  for (const job of listMemoryJobs()) {
    if (!job || seen.has(job.jobId)) continue;
    if (job.canonicalTradeId !== cid) continue;
    if (String(job.subscriberId) !== sub) continue;
    if (String(job.channel) !== ch) continue;
    if (job.channel === FANOUT_CHANNEL) continue;
    const ev = String(job.eventType || '').toLowerCase();
    if (ev === 'entry' || isEntryAlert(ev)) continue;
    if (job.state !== STATES.BLOCKED_WAITING_FOR_ENTRY && job.state !== STATES.RETRY_PENDING) {
      continue;
    }
    seen.add(job.jobId);
    matches.push(job);
  }
  if (useRealMongo()) {
    try {
      const DeliveryJob = require('../models/DeliveryJob');
      const docs = await DeliveryJob.find({
        canonicalTradeId: cid,
        subscriberId: sub,
        channel: ch,
        state: { $in: [STATES.BLOCKED_WAITING_FOR_ENTRY, STATES.RETRY_PENDING] }
      })
        .limit(64)
        .lean();
      for (const d of docs || []) {
        if (!d?.jobId || seen.has(d.jobId)) continue;
        if (d.channel === FANOUT_CHANNEL) continue;
        const ev = String(d.eventType || '').toLowerCase();
        if (ev === 'entry' || isEntryAlert(ev)) continue;
        seen.add(d.jobId);
        matches.push(cloneJob(d));
      }
    } catch (err) {
      lastWorkerError = err.message;
      console.warn('[DurableDelivery] onEntryCommitted mongo scan failed:', err.message);
    }
  }
  let n = 0;
  for (const job of matches) {
    job.state = STATES.RETRY_PENDING;
    job.nextAttemptAt = now();
    job.lastError = 'outcome_unblocked';
    await writeJob(job);
    logDurable('OUTCOME UNBLOCKED', job);
    n += 1;
  }
  return n;
}

/**
 * Simulate process crash: lease gone, job left PROCESSING with expired lease.
 */
async function simulateCrashForTests(jobId) {
  const job = await readJob(jobId);
  if (!job) return null;
  job.state = STATES.PROCESSING;
  job.leaseUntil = now() - 1;
  await writeJob(job);
  await delLease(jobId);
  return job;
}

/**
 * Redis restart: process cache + leases gone. Durable Mongo/durableDocs remains.
 */
function simulateRedisRestartForTests() {
  memJobs.clear();
  memLeases.clear();
}

async function markDueForTests(jobId) {
  const job = await readJob(jobId);
  if (!job) return null;
  job.nextAttemptAt = now() - 1;
  job.leaseUntil = now() - 1;
  await writeJob(job);
  await delLease(jobId);
  return job;
}

function registerProcessHandler(fn) {
  processHandler = fn;
}

function setWorkerContext({ io, inMemorySignals } = {}) {
  if (io !== undefined) workerIo = io;
  if (inMemorySignals !== undefined) workerSignals = inMemorySignals;
}

function getWorkerHealth() {
  const metrics = snapshotRecoveryMetrics();
  return {
    lastError: lastWorkerError,
    lastTickAt: lastWorkerTickAt,
    tickInFlight: workerTickInFlight,
    redisCircuitOpen: metrics.redisCircuitOpen,
    recoveryIntervalMs: metrics.recoveryIntervalMs,
    ticks: metrics.ticks,
    overlapSkips: metrics.overlapSkips,
    lastDurationMs: metrics.lastDurationMs,
    indexRemoved: metrics.indexRemoved,
    redisFailures: metrics.redisFailures,
    hScanCount: metrics.hScanCount,
    hydrateCount: metrics.hydrateCount
  };
}

function maybeLogRecoveryMetrics() {
  if (isTestEnv()) return;
  const t = now();
  if (lastMetricsLogAt && t - lastMetricsLogAt < METRICS_LOG_EVERY_MS) return;
  lastMetricsLogAt = t;
  const m = snapshotRecoveryMetrics();
  console.log(
    `[DurableDelivery] recovery metrics | ticks=${m.ticks} overlapSkips=${m.overlapSkips} ` +
      `hscan=${m.hScanCount} hydrates=${m.hydrateCount} gets=${m.getCount} ` +
      `discovered=${m.jobsDiscovered} recovered=${m.jobsRequired} ` +
      `terminalSkipped=${m.jobsTerminalSkipped} indexRemoved=${m.indexRemoved} ` +
      `lastDurationMs=${m.lastDurationMs} redisFails=${m.redisFailures} ` +
      `circuit=${m.redisCircuitOpen ? 'open' : 'closed'} redisScan=${m.redisIndexScanEnabled ? 'on' : 'off'} ` +
      `intervalMs=${m.recoveryIntervalMs}`
  );
}

async function runWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= items.length) return;
      results[i] = await mapper(items[i], i);
    }
  }
  const n = Math.min(Math.max(1, concurrency), Math.max(items.length, 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

async function processDueJobs(opts = {}) {
  lastWorkerTickAt = now();
  const started = lastWorkerTickAt;
  recoveryTicks += 1;
  const handler = opts.handler || processHandler;
  let due = [];
  try {
    try {
      due = await collectDueJobsBounded(opts.now);
    } catch (err) {
      lastWorkerError = err.message;
      noteRedisFailure(err.message);
      logDurable('WORKER_REDIS_ERROR', {}, { reason: err.message || 'list_due_failed' });
      console.warn('[DurableDelivery] recovery scan failed (API process continues):', err.message);
      return [{ error: err.message, isolated: true }];
    }
    recoveryJobsDiscovered += due.length;
    const work = due.slice(0, getProcessBudget());
    recoveryJobsRequired += work.length;
    const mapped = await runWithConcurrency(work, PROVIDER_CONCURRENCY, async job => {
      if (!handler) {
        return { jobId: job.jobId, status: 'no_handler' };
      }
      try {
        const result = await handler(job, {
          io: opts.io || workerIo,
          inMemorySignals: opts.inMemorySignals || workerSignals,
          owner: opts.owner || defaultOwner(),
          waitMode: 'check_once'
        });
        return { jobId: job.jobId, result };
      } catch (err) {
        lastWorkerError = err.message;
        if (isRedisUnavailable(err)) {
          noteRedisFailure(err.message);
          logDurable('WORKER_REDIS_ERROR', job, { reason: err.message });
          console.warn('[DurableDelivery] recovery tick redis error (process continues):', err.message);
          return { jobId: job.jobId, error: err.message, isolated: true };
        }
        await scheduleRetry(job.jobId, { reason: err.message || 'process_due_failed' });
        return { jobId: job.jobId, error: err.message };
      }
    });
    return mapped;
  } finally {
    recoveryLastDurationMs = Math.max(0, now() - started);
    recoveryDurationTotalMs += recoveryLastDurationMs;
    maybeLogRecoveryMetrics();
  }
}

function startRecoveryWorker({ io, inMemorySignals, handler, intervalMs } = {}) {
  if (recoveryTimer) return;
  if (isTestEnv() && !handler && process.env.DELIVERY_RECOVERY_WORKER_IN_TEST !== '1') {
    return;
  }
  if (handler) processHandler = handler;
  setWorkerContext({ io, inMemorySignals });
  const tickMs = intervalMs != null ? Number(intervalMs) : getRecoveryIntervalMs();
  const tick = () => {
    if (workerTickInFlight) {
      recoveryOverlapSkips += 1;
      return;
    }
    workerTickInFlight = true;
    processDueJobs({ io, inMemorySignals })
      .catch(err => {
        lastWorkerError = err.message;
        console.warn('[DurableDelivery] recovery tick failed (API process continues):', err.message);
      })
      .finally(() => {
        workerTickInFlight = false;
      });
  };
  tick();
  recoveryTimer = setInterval(tick, tickMs);
  if (typeof recoveryTimer.unref === 'function') recoveryTimer.unref();
  console.log(
    `[DurableDelivery] recovery worker started intervalMs=${tickMs} ` +
      `redisIndexScan=${redisIndexScanEnabled() ? 'on' : 'off'} processBudget=${getProcessBudget()}`
  );
}

function stopRecoveryWorker() {
  if (recoveryTimer) {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
  }
  workerTickInFlight = false;
}

function setContextLoadersForTests(loaders = {}) {
  contextLoaders = {
    loadSignal: typeof loaders.loadSignal === 'function' ? loaders.loadSignal : null,
    loadSubscriber: typeof loaders.loadSubscriber === 'function' ? loaders.loadSubscriber : null
  };
}

function userToSubscriber(doc) {
  if (!doc) return null;
  const id = doc.id || doc._id;
  return snapshotSubscriber({
    id: id != null ? String(id) : undefined,
    email: doc.email,
    displayName: doc.displayName,
    role: doc.role,
    subscription: doc.subscription,
    telegram: doc.telegram,
    mt5: doc.mt5,
    preferences: doc.preferences
  });
}

async function defaultLoadSignal(refs = {}) {
  if (contextLoaders.loadSignal) return contextLoaders.loadSignal(refs);
  const uuid = refs.signalUuid || refs.canonicalTradeId;
  const id = refs.signalId;
  try {
    const Signal = require('../models/Signal');
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) return null;
    if (id && !String(id).startsWith('mem_')) {
      const byId = await Signal.findById(id).lean();
      if (byId) return byId;
    }
    if (uuid) {
      const byUuid = await Signal.findOne({ signalUuid: uuid }).lean();
      if (byUuid) return byUuid;
    }
  } catch (err) {
    const e = new Error(`signal_rehydrate_failed:${err.message}`);
    e.retryable = true;
    throw e;
  }
  return null;
}

async function defaultLoadSubscriber(subscriberId) {
  if (contextLoaders.loadSubscriber) return contextLoaders.loadSubscriber(subscriberId);
  if (!subscriberId || subscriberId === 'broadcast' || subscriberId === FANOUT_SUBSCRIBER) {
    return null;
  }
  try {
    const UserConfig = require('../models/User');
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
      const e = new Error('mongo_unavailable_for_subscriber_rehydrate');
      e.retryable = true;
      throw e;
    }
    const doc = await UserConfig.findById(subscriberId).lean();
    return userToSubscriber(doc);
  } catch (err) {
    if (err.retryable) throw err;
    const e = new Error(`subscriber_rehydrate_failed:${err.message}`);
    e.retryable = true;
    throw e;
  }
}

function payloadMissing(job) {
  if (!job) return true;
  if (job.channel === FANOUT_CHANNEL) return !job.payload?.acceptResult;
  return !job.payload?.subscriber || !job.payload?.signal;
}

async function rehydrateJobContext(job) {
  if (!job) return { ok: false, retryable: false, reason: 'delivery_context_unrecoverable' };
  if (!payloadMissing(job)) {
    return {
      ok: true,
      job,
      signal: job.payload?.signal,
      subscriber: job.payload?.subscriber,
      acceptResult: job.payload?.acceptResult
    };
  }
  const refs = { ...(job.refs || {}), signalUuid: job.signalUuid, subscriberId: job.subscriberId };
  try {
    if (job.channel === FANOUT_CHANNEL) {
      const signal = await defaultLoadSignal(refs);
      if (!signal) {
        return { ok: false, retryable: false, reason: 'delivery_context_unrecoverable' };
      }
      const acceptResult = {
        accepted: true,
        duplicate: false,
        skippedFanout: false,
        saved: signal,
        signalData: signal,
        signalUuid: signal.signalUuid || job.signalUuid,
        requestId: signal.pipelineRequestId || signal.correlation?.requestId || job.correlation?.requestId
      };
      job.payload = { ...(job.payload || {}), acceptResult, signal, kind: 'fanout' };
      job.correlation = compactCorrelation(mergeCorrelation(job.correlation, signal, acceptResult));
      await writeJob(job);
      return { ok: true, job, signal, acceptResult };
    }
    const needsSubscriber = job.channel !== FANOUT_CHANNEL;
    const [signal, subscriber] = await Promise.all([
      defaultLoadSignal(refs),
      needsSubscriber ? defaultLoadSubscriber(refs.subscriberId || job.subscriberId) : null
    ]);
    if (!signal || (needsSubscriber && !subscriber)) {
      return { ok: false, retryable: false, reason: 'delivery_context_unrecoverable' };
    }
    job.payload = {
      ...(job.payload || {}),
      signal: snapshotSignal(signal),
      subscriber: snapshotSubscriber(subscriber)
    };
    job.correlation = compactCorrelation(mergeCorrelation(job.correlation, signal, { subscriberId: job.subscriberId }));
    attachCorrelation(job.payload.signal, job.correlation);
    await writeJob(job);
    return { ok: true, job, signal: job.payload.signal, subscriber: job.payload.subscriber };
  } catch (err) {
    return {
      ok: false,
      retryable: err.retryable !== false,
      reason: err.retryable === false ? 'delivery_context_unrecoverable' : 'rehydrate_error',
      error: err.message
    };
  }
}

async function recordChannelSkip(spec, { reason, notEligible = false } = {}) {
  const job = await ensureJob({
    ...spec,
    refs: spec.refs || buildDurableRefs(spec),
    correlation: spec.correlation,
    payload: spec.payload || {
      signal: spec.signalDoc ? snapshotSignal(spec.signalDoc) : undefined,
      subscriber: spec.subscriber ? snapshotSubscriber(spec.subscriber) : undefined
    }
  });
  if (job.state === STATES.DELIVERED || job.state === STATES.FAILED_TERMINAL) return job;
  if (job.state === STATES.SKIPPED || job.state === STATES.NOT_ELIGIBLE) return job;
  job.state = notEligible ? STATES.NOT_ELIGIBLE : STATES.SKIPPED;
  job.outcomeStatus = notEligible ? 'not_eligible' : 'skipped';
  job.outcomeReason = reason || (notEligible ? 'not_eligible' : 'skipped');
  job.lastError = job.outcomeReason;
  job.deliveryReason = job.lastError;
  job.channelDeliveryState = job.outcomeStatus;
  job.nextAttemptAt = 0;
  job.leaseUntil = 0;
  job.retryScheduled = false;
  await writeJob(job);
  logDurable(notEligible ? 'NOT_ELIGIBLE' : 'SKIPPED', job, { reason: job.lastError });
  return job;
}

function emptyCleanupReport() {
  return {
    mode: 'DRY_RUN',
    scanned: 0,
    active: 0,
    pending: 0,
    recoverable: 0,
    terminal: 0,
    missingFromMongo: 0,
    missingFromRedis: 0,
    wouldDelete: 0,
    deleted: 0,
    preserved: 0,
    hdelFailures: 0,
    cursor: '0',
    done: false,
    mongoAvailable: false,
    executeAllowed: false
  };
}

function classifyJobRecord(job, ts) {
  if (!job) return 'missing';
  if (isTerminalState(job.state)) return 'terminal';
  if (isLeaseProtected(job, ts)) return 'active';
  if (isDue(job, ts)) return 'recoverable';
  return 'pending';
}

async function loadMongoJobsByIds(ids) {
  const map = new Map();
  for (const id of ids || []) {
    if (durableDocs.has(id)) map.set(id, cloneJob(durableDocs.get(id)));
  }
  if (!useRealMongo()) {
    return { map, mongoAvailable: isTestEnv() || TradeEventStore.allowMemoryFallback() };
  }
  const missing = (ids || []).filter(id => id && !map.has(id));
  if (!missing.length) return { map, mongoAvailable: true };
  try {
    const DeliveryJob = require('../models/DeliveryJob');
    const docs = await DeliveryJob.find({ jobId: { $in: missing } })
      .select('jobId state leaseUntil nextAttemptAt')
      .lean();
    for (const d of docs || []) {
      if (d?.jobId) map.set(d.jobId, cloneJob(d));
    }
    return { map, mongoAvailable: true };
  } catch (err) {
    lastWorkerError = err.message;
    console.warn('[DurableDelivery] cleanup mongo batch read failed:', err.message);
    return { map, mongoAvailable: false };
  }
}

async function readRedisJobOnly(jobId) {
  const r = await redisClient();
  if (!r) return { job: null, redisAvailable: false };
  try {
    const raw = await r.get(keyJob(jobId));
    if (!raw) return { job: null, redisAvailable: true };
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { job: parsed, redisAvailable: true };
  } catch (err) {
    lastWorkerError = err.message;
    return { job: null, redisAvailable: false };
  }
}

async function hDelIndexMembers(ids) {
  const fields = (ids || []).map(String).filter(Boolean);
  if (!fields.length) return { deleted: 0, failures: 0 };
  const r = await redisClient();
  if (!r || typeof r.hDel !== 'function') return { deleted: 0, failures: fields.length };
  let deleted = 0;
  let failures = 0;
  const chunkSize = Math.min(getCleanupMaxHdel(), fields.length);
  for (let i = 0; i < fields.length; i += chunkSize) {
    const chunk = fields.slice(i, i + chunkSize);
    try {
      const n = await r.hDel(keyIndex(), chunk.length === 1 ? chunk[0] : chunk);
      const count = Number(n);
      if (Number.isFinite(count) && count >= 0) deleted += count;
      else deleted += chunk.length;
    } catch {
      for (const field of chunk) {
        try {
          const n = await r.hDel(keyIndex(), field);
          if (Number(n) > 0) deleted += 1;
        } catch {
          failures += 1;
        }
      }
    }
  }
  recoveryIndexRemoved += deleted;
  return { deleted, failures };
}

/**
 * One bounded HSCAN page of kaching:trade:djobidx.
 * Never materializes the whole hash. Never enumerates all Redis keys.
 * Never flushes the Redis database. DRY-RUN by default.
 */
async function runIndexCleanupBatch(opts = {}) {
  const execute = Boolean(opts.execute);
  const count = clampInt(opts.count, 1, 200, getCleanupBatchSize());
  const maxHdel = clampInt(opts.maxHdel, 1, 100, getCleanupMaxHdel());
  const report = emptyCleanupReport();
  report.mode = execute ? 'EXECUTE' : 'DRY_RUN';
  report.cursor = String(opts.cursor || '0');

  const page = await scanIndexPage(report.cursor, count);
  report.cursor = page.cursor || '0';
  const ids = page.ids || [];
  report.scanned = ids.length;
  report.done = report.cursor === '0' || report.cursor === '00';

  const { map: mongoById, mongoAvailable } = await loadMongoJobsByIds(ids);
  report.mongoAvailable = mongoAvailable;
  report.executeAllowed = execute && mongoAvailable;

  if (execute && !mongoAvailable) {
    console.warn(
      '[DurableDelivery] cleanup EXECUTE refused: Mongo/durable store unavailable; would not delete'
    );
    report.preserved = ids.length;
    return report;
  }

  const ts = now();
  const toDelete = [];
  for (const id of ids) {
    const mongoJob = mongoById.get(id) || null;
    let bucket;
    if (mongoJob) {
      bucket = classifyJobRecord(mongoJob, ts);
    } else {
      report.missingFromMongo += 1;
      const redisRead = await readRedisJobOnly(id);
      if (!redisRead.job) {
        report.missingFromRedis += 1;
        bucket = 'orphan';
      } else {
        bucket = classifyJobRecord(redisRead.job, ts);
      }
    }

    if (bucket === 'active') {
      report.active += 1;
      report.preserved += 1;
    } else if (bucket === 'pending') {
      report.pending += 1;
      report.preserved += 1;
    } else if (bucket === 'recoverable') {
      report.recoverable += 1;
      report.preserved += 1;
    } else if (bucket === 'terminal') {
      report.terminal += 1;
      report.wouldDelete += 1;
      toDelete.push(id);
    } else {
      // orphan: missing Mongo + missing/unreadable Redis job JSON
      report.wouldDelete += 1;
      toDelete.push(id);
    }
  }

  if (!execute || !toDelete.length) {
    return report;
  }

  const limited = toDelete.slice(0, maxHdel);
  const result = await hDelIndexMembers(limited);
  report.deleted = result.deleted;
  report.hdelFailures = result.failures;
  return report;
}

async function runIndexCleanupPass(opts = {}) {
  const maxBatches = clampInt(opts.maxBatches, 1, 500, 10);
  const totals = emptyCleanupReport();
  totals.mode = opts.execute ? 'EXECUTE' : 'DRY_RUN';
  let cursor = String(opts.cursor || '0');
  let batches = 0;
  do {
    const batch = await runIndexCleanupBatch({
      cursor,
      count: opts.count,
      execute: opts.execute,
      maxHdel: opts.maxHdel
    });
    batches += 1;
    cursor = batch.cursor;
    totals.cursor = cursor;
    totals.done = batch.done;
    totals.mongoAvailable = batch.mongoAvailable;
    totals.executeAllowed = batch.executeAllowed;
    totals.mode = batch.mode;
    for (const key of [
      'scanned',
      'active',
      'pending',
      'recoverable',
      'terminal',
      'missingFromMongo',
      'missingFromRedis',
      'wouldDelete',
      'deleted',
      'preserved',
      'hdelFailures'
    ]) {
      totals[key] += batch[key] || 0;
    }
    if (opts.onBatch) opts.onBatch(batch, { batches, totals });
    if (batch.done) break;
    if (!batch.mongoAvailable && opts.execute) break;
  } while (batches < maxBatches);
  totals.batches = batches;
  return totals;
}

function dropJobForTests(jobId) {
  const id = String(jobId || '');
  durableDocs.delete(id);
  memJobs.delete(id);
  memLeases.delete(id);
}

function resetForTests() {
  memJobs.clear();
  memLeases.clear();
  durableDocs.clear();
  frozenNow = null;
  lastWorkerError = null;
  lastWorkerTickAt = 0;
  stopRecoveryWorker();
  workerIo = null;
  workerSignals = null;
  contextLoaders = { loadSignal: null, loadSubscriber: null };
  resetRecoveryMetricsForTests();
}

module.exports = {
  STATES,
  UNFINISHED_STATES,
  FANOUT_SUBSCRIBER,
  FANOUT_CHANNEL,
  jobIdFor,
  fanoutJobId,
  retryDelayMs,
  getMaxAttempts,
  getRetryBaseDelayMs,
  getRetryMaxDelayMs,
  getLeaseMs,
  getRecoveryIntervalMs,
  redisIndexScanEnabled,
  defaultOwner,
  now,
  setNowForTests,
  advanceNowForTests,
  clearNowForTests,
  ensureJob,
  ensureFanoutWork,
  hasPersistedSignalId,
  hasFanoutWork,
  hasFanoutWorkSync,
  getJob,
  getJobBySpec,
  beginAttempt,
  beginFanoutAttempt,
  markSending,
  markSendingBySpec,
  markProviderAccepted,
  markProviderAcceptedBySpec,
  commitDelivered,
  commitDeliveredBySpec,
  commitFailedTerminal,
  commitFailedTerminalBySpec,
  scheduleRetry,
  scheduleRetryBySpec,
  retryFailedTerminal,
  isDelivered,
  listJobs,
  listMemoryJobs,
  listJobsForSignal,
  listDueJobs,
  getCounts,
  onEntryCommitted,
  simulateCrashForTests,
  simulateRedisRestartForTests,
  dropJobForTests,
  markDueForTests,
  processDueJobs,
  registerProcessHandler,
  setWorkerContext,
  startRecoveryWorker,
  stopRecoveryWorker,
  getWorkerHealth,
  resetForTests,
  snapshotSubscriber,
  snapshotSignal,
  isDupKeyError,
  rehydrateJobContext,
  recordChannelSkip,
  setContextLoadersForTests,
  payloadMissing,
  UNRECOVERABLE_REASON: 'delivery_context_unrecoverable',
  RECOVERY_BOUNDS,
  TERMINAL_STATES,
  isTerminalState,
  getRecoveryMetricsForTests,
  resetRecoveryMetricsForTests,
  maybeEvictCaches,
  collectDueJobsBounded,
  isDue,
  runIndexCleanupBatch,
  runIndexCleanupPass,
  emptyCleanupReport,
  scanIndexPage,
  keyIndex
};
