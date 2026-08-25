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

const STATES = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  SENDING: 'sending',
  RETRY_PENDING: 'retry_pending',
  PROVIDER_ACCEPTED: 'provider_accepted',
  DELIVERED: 'delivered',
  FAILED_TERMINAL: 'failed_terminal',
  BLOCKED_WAITING_FOR_ENTRY: 'blocked_waiting_for_entry'
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
const DEFAULT_RECOVERY_INTERVAL_MS = 2000;

/** Process cache of Redis job JSON. Not the durable store. */
const memJobs = new Map();
/** Process cache of Redis leases. */
const memLeases = new Map();
/**
 * Durable job documents (Mongo stand-in in tests; mirrored from Mongo in prod).
 * Survives simulateRedisRestartForTests. Source of truth for recovery discovery.
 */
const durableDocs = new Map();

let frozenNow = null;
let recoveryTimer = null;
let processHandler = null;
let workerIo = null;
let workerSignals = null;
let lastWorkerError = null;
let lastWorkerTickAt = 0;
let workerTickInFlight = false;

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

function getRecoveryIntervalMs() {
  return envInt('DELIVERY_RECOVERY_INTERVAL_MS', DEFAULT_RECOVERY_INTERVAL_MS);
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
      job.payload?.acceptResult?.requestId ||
      job.payload?.signal?.pipelineRequestId ||
      job.payload?.signalData?.pipelineRequestId,
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

async function loadMongoJob(jobId) {
  if (!useRealMongo()) return durableDocs.get(jobId) ? cloneJob(durableDocs.get(jobId)) : null;
  try {
    const DeliveryJob = require('../models/DeliveryJob');
    const doc = await DeliveryJob.findOne({ jobId }).lean();
    if (!doc) return null;
    const copy = cloneJob(doc);
    durableDocs.set(jobId, copy);
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
  durableDocs.set(copy.jobId, copy);

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
      durableDocs.set(copy.jobId, existingCopy);
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
  const persisted = await persistDurable(job, { ingest });
  const copy = persisted.job || { ...job, updatedAt: now() };
  memJobs.set(copy.jobId, copy);

  const r = await redisClient();
  if (r) {
    try {
      await r.set(keyJob(copy.jobId), JSON.stringify(copy), { EX: JOB_TTL_SEC });
      if (typeof r.hSet === 'function') {
        await r.hSet(keyIndex(), copy.jobId, '1');
        if (typeof r.expire === 'function') await r.expire(keyIndex(), JOB_TTL_SEC);
      }
    } catch (err) {
      if (ingest && !TradeEventStore.allowMemoryFallback()) {
        throw redisUnavailableError(`Redis unavailable for durableDelivery; ${err.message}`);
      }
      lastWorkerError = err.message;
      console.warn('[DurableDelivery] redis job cache write failed (durable Mongo record kept):', err.message);
    }
  } else if (!TradeEventStore.allowMemoryFallback()) {
    if (ingest) throw redisUnavailableError();
    lastWorkerError = 'redis_unavailable';
    console.warn('[DurableDelivery] redis unavailable for job cache; durable Mongo record kept');
  }
  return copy;
}

async function readJob(jobId) {
  const id = String(jobId || '');
  if (!id) return null;
  const r = await redisClient();
  if (r) {
    try {
      const raw = await r.get(keyJob(id));
      if (raw) {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        memJobs.set(id, parsed);
        return parsed;
      }
    } catch (err) {
      if (!TradeEventStore.allowMemoryFallback()) {
        lastWorkerError = err.message;
        console.warn('[DurableDelivery] redis job read failed; falling back to Mongo:', err.message);
      }
    }
  } else if (!TradeEventStore.allowMemoryFallback()) {
    /* Redis down: still read Mongo. Ingest callers that require Redis throw at write/lease. */
  }
  const durable = await loadMongoJob(id);
  if (durable) {
    memJobs.set(id, durable);
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
  const r = await redisClient();
  if (r && typeof r.hGetAll === 'function') {
    try {
      const raw = await r.hGetAll(keyIndex());
      for (const id of Object.keys(raw || {})) {
        if (id) ids.add(id);
      }
    } catch (err) {
      lastWorkerError = err.message;
      console.warn('[DurableDelivery] redis job index read failed; using Mongo:', err.message);
    }
  }
  return [...ids];
}

async function setLease(jobId, owner) {
  if (memLeases.has(jobId) && memLeases.get(jobId) !== owner) return false;
  memLeases.set(jobId, owner);
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
    if (!TradeEventStore.allowMemoryFallback()) {
      memLeases.delete(jobId);
      err.code = err.code || TradeEventStore.REDIS_UNAVAILABLE;
      err.reason = 'redis_unavailable';
      throw err;
    }
    return true;
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
  if (job.state === STATES.DELIVERED || job.state === STATES.FAILED_TERMINAL) return false;
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
    payload: spec.payload || {}
  };
}

async function ensureJob(spec, opts = {}) {
  const job = newJob(spec);
  const existing = await readJob(job.jobId);
  if (existing) {
    if (existing.state === STATES.DELIVERED || existing.state === STATES.FAILED_TERMINAL) {
      return existing;
    }
    if (spec.payload) {
      existing.payload = { ...(existing.payload || {}), ...spec.payload };
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

async function ensureFanoutWork(acceptResult) {
  const signalData = acceptResult?.signalData || {};
  const saved = acceptResult?.saved || {};
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
        requestId: signalData.pipelineRequestId || acceptResult?.requestId
      },
      signalUuid: acceptResult?.signalUuid || saved?.signalUuid,
      alertType: eventType
    }
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

  if (spec.subscriber || spec.signalDoc || spec.telegramOptions) {
    job.payload = {
      ...(job.payload || {}),
      subscriber: spec.subscriber ? snapshotSubscriber(spec.subscriber) : job.payload?.subscriber,
      signal: spec.signalDoc ? snapshotSignal(spec.signalDoc) : job.payload?.signal,
      telegramOptions: spec.telegramOptions || job.payload?.telegramOptions
    };
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
  job.state = STATES.DELIVERED;
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

async function scheduleRetry(jobId, { reason, blockedWaitingForEntry = false } = {}) {
  const job = await readJob(jobId);
  if (!job) return { status: 'not_found' };
  if (job.state === STATES.DELIVERED) return { status: 'delivered', job };
  if (job.state === STATES.PROVIDER_ACCEPTED) {
    return commitDelivered(jobId, { reason: reason || 'provider_accepted_retry_commit' });
  }

  const ts = now();
  if (blockedWaitingForEntry) {
    job.state = STATES.BLOCKED_WAITING_FOR_ENTRY;
    job.lastError = reason || 'blocked_waiting_for_entry';
    job.nextAttemptAt = ts + Math.min(getRetryBaseDelayMs(), 1000);
    job.leaseUntil = 0;
    await writeJob(job);
    await delLease(jobId);
    logDurable('BLOCKED_WAITING_FOR_ENTRY', job, { reason: job.lastError });
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

async function listJobs() {
  const ids = await listJobIds();
  const out = [];
  for (const id of ids) {
    const job = await readJob(id);
    if (job) out.push(job);
  }
  return out;
}

function countStates(jobs) {
  const counts = {
    pending: 0,
    processing: 0,
    sending: 0,
    retry_pending: 0,
    provider_accepted: 0,
    delivered: 0,
    failed_terminal: 0,
    blocked_waiting_for_entry: 0
  };
  for (const job of jobs) {
    if (counts[job.state] != null) counts[job.state] += 1;
  }
  return counts;
}

async function getCounts() {
  return countStates(await listJobs());
}

async function listDueJobs(ts) {
  const t = ts != null ? ts : now();
  const jobs = await listJobs();
  return jobs.filter(j => isDue(j, t));
}

async function onEntryCommitted({ canonicalTradeId, subscriberId, channel }) {
  const cid = String(canonicalTradeId || '').trim();
  if (!cid) return 0;
  const jobs = await listJobs();
  let n = 0;
  for (const job of jobs) {
    if (job.canonicalTradeId !== cid) continue;
    if (String(job.subscriberId) !== String(subscriberId)) continue;
    if (String(job.channel) !== String(channel)) continue;
    if (job.channel === FANOUT_CHANNEL) continue;
    const ev = String(job.eventType || '').toLowerCase();
    if (ev === 'entry' || isEntryAlert(ev)) continue;
    if (job.state !== STATES.BLOCKED_WAITING_FOR_ENTRY && job.state !== STATES.RETRY_PENDING) {
      continue;
    }
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
  return {
    lastError: lastWorkerError,
    lastTickAt: lastWorkerTickAt,
    tickInFlight: workerTickInFlight
  };
}

async function processDueJobs(opts = {}) {
  lastWorkerTickAt = now();
  const handler = opts.handler || processHandler;
  let due;
  try {
    due = await listDueJobs(opts.now);
  } catch (err) {
    lastWorkerError = err.message;
    logDurable('WORKER_REDIS_ERROR', {}, { reason: err.message || 'list_due_failed' });
    console.warn('[DurableDelivery] recovery scan failed (API process continues):', err.message);
    return [{ error: err.message, isolated: true }];
  }
  const results = [];
  for (const job of due) {
    if (!handler) {
      results.push({ jobId: job.jobId, status: 'no_handler' });
      continue;
    }
    try {
      const result = await handler(job, {
        io: opts.io || workerIo,
        inMemorySignals: opts.inMemorySignals || workerSignals,
        owner: opts.owner || defaultOwner()
      });
      results.push({ jobId: job.jobId, result });
    } catch (err) {
      lastWorkerError = err.message;
      if (isRedisUnavailable(err)) {
        logDurable('WORKER_REDIS_ERROR', job, { reason: err.message });
        console.warn('[DurableDelivery] recovery tick redis error (process continues):', err.message);
        results.push({ jobId: job.jobId, error: err.message, isolated: true });
        continue;
      }
      await scheduleRetry(job.jobId, { reason: err.message || 'process_due_failed' });
      results.push({ jobId: job.jobId, error: err.message });
    }
  }
  return results;
}

function startRecoveryWorker({ io, inMemorySignals, handler, intervalMs } = {}) {
  if (recoveryTimer) return;
  if (isTestEnv() && !handler && process.env.DELIVERY_RECOVERY_WORKER_IN_TEST !== '1') {
    return;
  }
  if (handler) processHandler = handler;
  setWorkerContext({ io, inMemorySignals });
  const tickMs = intervalMs != null ? intervalMs : getRecoveryIntervalMs();
  const tick = () => {
    if (workerTickInFlight) return;
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
}

function stopRecoveryWorker() {
  if (recoveryTimer) {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
  }
  workerTickInFlight = false;
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
  defaultOwner,
  now,
  setNowForTests,
  advanceNowForTests,
  clearNowForTests,
  ensureJob,
  ensureFanoutWork,
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
  scheduleRetry,
  scheduleRetryBySpec,
  retryFailedTerminal,
  isDelivered,
  listJobs,
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
  isDupKeyError
};
