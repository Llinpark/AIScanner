/**
 * Lightweight pipeline diagnostics store (in-memory + optional Redis).
 * Updated by log hooks only — no strategy behaviour changes.
 *
 * Production Redis isolation:
 * - Self-test / NODE_ENV=test / STEST* / selftest_* telemetry updates local memory only.
 * - Those events must NOT write kaching:pipeline:* on shared Upstash Redis.
 * - Opt-in escape hatch: ALLOW_PIPELINE_TEST_REDIS=true
 */

const { getRedisClient, getRedisDiagnostics } = require('../utils/redisClient');
const { withTimeout } = require('../utils/boundedWait');
const activeSignalRegistry = require('../utils/activeSignalRegistry');
const {
  buildPipelineTimeline,
  summarizeLatencies,
  percent,
  evaluateWebhookAge,
  getWebhookAgeThresholdsMs
} = require('../utils/pipelineObservability');

const REDIS_KEY = 'kaching:pipeline:status';
const REDIS_EVENTS_KEY = 'kaching:pipeline:events';
const REDIS_KEY_PREFIX = 'kaching:pipeline:';
const REDIS_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const RING_MAX = 100;

const EMPTY = () => ({
  lastAlertEvaluated: null,
  lastAlertFired: null,
  lastWebhookReceived: null,
  lastAuthPassed: null,
  lastAuthFailed: null,
  lastValidation: null,
  lastMongoSave: null,
  lastAccepted: null,
  lastPublished: null,
  lastTelegramDelivery: null,
  lastMT5Delivery: null,
  lastSocketDelivery: null,
  lastEmailDelivery: null,
  lastDurableDelivery: null,
  durableDeliveryState: null,
  lastFailureStage: null,
  lastFailureReason: null,
  currentPipelineStage: null,
  webhookFailures: 0,
  deliveryFailures: 0,
  authFailures: 0,
  validationFailures: 0,
  pipelineLatenciesMs: [],
  webhookToMongoMs: [],
  webhookToAcceptedMs: [],
  mongoToTelegramMs: [],
  updatedAt: null
});

let memory = EMPTY();
/** @type {Array<object>} */
let ring = [];
let lastRedisAccessError = null;

/** Per in-flight signalUuid timing anchors (diagnostics only). */
const inflight = new Map();

function nowIso() {
  return new Date().toISOString();
}

/**
 * True when pipeline telemetry must stay off shared production Redis.
 * Local/unit/self-test may still update in-process memory for assertions.
 */
function isNonProductionPipelineTelemetry(meta = {}) {
  if (allowPipelineTestRedis()) {
    return false;
  }
  if (process.env.NODE_ENV === 'test') return true;
  if (String(process.env.PIPELINE_SELF_TEST_ACTIVE || '').trim() === 'true') return true;
  if (meta.selfTest === true || meta.self_test === true) return true;
  const symbol = String(meta.symbol || '').trim().toUpperCase();
  if (symbol.startsWith('STEST')) return true;
  const uuid = String(meta.signalUuid || meta.signalId || meta.uuid || '').trim();
  if (/^selftest_/i.test(uuid)) return true;
  return false;
}

function isInMemoryFallbackStamp(entry) {
  return /in_memory_fallback/i.test(String(entry?.reason || ''));
}

function isSelfTestStamp(entry) {
  if (!entry) return false;
  if (entry.selfTest === true || entry.telemetrySource === 'non_production') return true;
  const symbol = String(entry.symbol || '').toUpperCase();
  if (symbol.startsWith('STEST')) return true;
  const uuid = String(entry.signalUuid || '').trim();
  return /^selftest_/i.test(uuid);
}

function isDurableMongoSaveStamp(entry) {
  if (!entry) return false;
  if (isSelfTestStamp(entry)) return false;
  if (isInMemoryFallbackStamp(entry)) return false;
  return true;
}

function stamp(meta = {}) {
  const nonProd = isNonProductionPipelineTelemetry(meta);
  return {
    at: nowIso(),
    symbol: meta.symbol || null,
    timeframe: meta.timeframe || meta.tf || null,
    signalUuid: meta.signalUuid || meta.signalId || meta.uuid || null,
    reason: meta.reason || meta.message || null,
    userId: meta.userId || meta.subscriberId || null,
    latencyMs: meta.latencyMs != null ? Number(meta.latencyMs) : null,
    requestId: meta.requestId || null,
    tokenVersion: meta.tokenVersion || null,
    tokenEnvironment: meta.tokenEnvironment || null,
    scriptGenerationId: meta.scriptGenerationId || null,
    alertType: meta.alertType || null,
    selfTest: Boolean(meta.selfTest || meta.self_test || nonProd),
    telemetrySource: nonProd ? 'non_production' : 'production',
    detectedPineVersion: meta.detectedPineVersion || meta.pineClientVersion || null,
    compatibilityAdapter: meta.compatibilityAdapter || null,
    compatibilityMode: meta.compatibilityMode || null,
    compatibilityLabel: meta.compatibilityLabel || null,
    legacy: meta.legacy === true,
    eventId: meta.eventId || null,
    canonicalTradeId: meta.canonicalTradeId || null,
    eventType: meta.eventType || null,
    eventSequence: meta.eventSequence != null ? meta.eventSequence : null,
    isRealtimeState: meta.isRealtimeState || null,
    staleDecision: meta.staleDecision || null,
    duplicateDecision: meta.duplicateDecision || null,
    deliveryJobState: meta.deliveryJobState || null
  };
}

function pushLatency(bucket, value, max = 200) {
  if (!Number.isFinite(value) || value < 0) return;
  bucket.push(value);
  if (bucket.length > max) bucket.splice(0, bucket.length - max);
}

function pushEvent(event, { persist = true } = {}) {
  ring.push(event);
  if (ring.length > RING_MAX) {
    ring.splice(0, ring.length - RING_MAX);
  }
  if (persist) {
    void persistEventsRedis();
  }
}

function productionRingEvents() {
  return ring.filter(e => !isSelfTestStamp(e) && e?.telemetrySource !== 'non_production');
}

function allowPipelineTestRedis() {
  return String(process.env.ALLOW_PIPELINE_TEST_REDIS || '').trim().toLowerCase() === 'true';
}

const PIPELINE_REDIS_TIMEOUT_MS = 1500;

async function persistRedis() {
  try {
    const redis = await withTimeout(getRedisClient(), PIPELINE_REDIS_TIMEOUT_MS, 'pipeline_persist_client');
    if (!redis) return;
    // Never clobber shared Redis with self-test / in-memory-fallback snapshots
    // unless explicitly opted in via ALLOW_PIPELINE_TEST_REDIS.
    if (!allowPipelineTestRedis()) {
      if (
        isSelfTestStamp(memory.lastWebhookReceived) ||
        isSelfTestStamp(memory.lastMongoSave) ||
        isInMemoryFallbackStamp(memory.lastMongoSave)
      ) {
        return;
      }
    }
    await withTimeout(
      redis.setEx(REDIS_KEY, REDIS_TTL_SECONDS, JSON.stringify(memory)),
      PIPELINE_REDIS_TIMEOUT_MS,
      'pipeline_persist_set'
    );
    lastRedisAccessError = null;
  } catch (err) {
    lastRedisAccessError = err;
    // Diagnostics must never break the webhook path.
  }
}

async function persistEventsRedis() {
  try {
    const redis = await withTimeout(getRedisClient(), PIPELINE_REDIS_TIMEOUT_MS, 'pipeline_events_client');
    if (!redis) return;
    const durable = allowPipelineTestRedis()
      ? ring.slice(-RING_MAX)
      : productionRingEvents().slice(-RING_MAX);
    await withTimeout(
      redis.setEx(REDIS_EVENTS_KEY, REDIS_TTL_SECONDS, JSON.stringify(durable)),
      PIPELINE_REDIS_TIMEOUT_MS,
      'pipeline_events_set'
    );
  } catch {
    // ignore
  }
}

async function hydrateFromRedis() {
  try {
    const redis = await withTimeout(getRedisClient(), PIPELINE_REDIS_TIMEOUT_MS, 'pipeline_hydrate_client');
    if (!redis) {
      lastRedisAccessError = lastRedisAccessError || new Error('redis_unavailable');
      return;
    }
    const raw = await withTimeout(redis.get(REDIS_KEY), PIPELINE_REDIS_TIMEOUT_MS, 'pipeline_hydrate_get');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        memory = { ...EMPTY(), ...parsed };
        if (!Array.isArray(memory.pipelineLatenciesMs)) memory.pipelineLatenciesMs = [];
        if (!Array.isArray(memory.webhookToMongoMs)) memory.webhookToMongoMs = [];
        if (!Array.isArray(memory.webhookToAcceptedMs)) memory.webhookToAcceptedMs = [];
        if (!Array.isArray(memory.mongoToTelegramMs)) memory.mongoToTelegramMs = [];
      }
    }
    const eventsRaw = await withTimeout(
      redis.get(REDIS_EVENTS_KEY),
      PIPELINE_REDIS_TIMEOUT_MS,
      'pipeline_hydrate_events'
    );
    if (eventsRaw) {
      const parsedEvents = JSON.parse(eventsRaw);
      if (Array.isArray(parsedEvents)) {
        ring = parsedEvents.filter(e => !isSelfTestStamp(e)).slice(-RING_MAX);
      }
    }
    lastRedisAccessError = null;
  } catch (err) {
    lastRedisAccessError = err;
    // keep memory
  }
}

let hydrated = false;
async function ensureHydrated() {
  if (hydrated) return;
  hydrated = true;
  await hydrateFromRedis();
}

function trackInflight(stage, ok, entry) {
  const uuid = entry.signalUuid || `${entry.symbol || 'unk'}:${entry.at}`;
  let row = inflight.get(uuid);
  if (!row) {
    row = { startedAt: Date.now(), webhookAt: null, mongoAt: null, acceptedAt: null, telegramAt: null };
    inflight.set(uuid, row);
  }
  if (/^WebhookReceived$/i.test(stage) && ok) {
    row.webhookAt = Date.now();
    row.startedAt = row.webhookAt;
  }
  if (/^MongoSave$/i.test(stage) && ok) {
    row.mongoAt = Date.now();
    if (row.webhookAt) {
      pushLatency(memory.webhookToMongoMs, row.mongoAt - row.webhookAt);
    }
  }
  if (/^Accepted$/i.test(stage) && ok) {
    row.acceptedAt = Date.now();
    if (entry.latencyMs != null && Number.isFinite(Number(entry.latencyMs))) {
      pushLatency(memory.webhookToAcceptedMs, Number(entry.latencyMs));
      pushLatency(memory.pipelineLatenciesMs, Number(entry.latencyMs));
    } else if (row.webhookAt) {
      const ms = row.acceptedAt - row.webhookAt;
      pushLatency(memory.webhookToAcceptedMs, ms);
      pushLatency(memory.pipelineLatenciesMs, ms);
    }
  }
  if (/^DeliveryTelegram$/i.test(stage) && ok) {
    row.telegramAt = Date.now();
    if (row.mongoAt) {
      pushLatency(memory.mongoToTelegramMs, row.telegramAt - row.mongoAt);
    }
  }
  // Pipeline HTTP latency comes from Accepted.latencyMs / webhookToAccepted.
  // Do not attribute Telegram / sequence-wait duration to pipeline cards.
  // Bound inflight map
  if (inflight.size > 500) {
    const oldest = inflight.keys().next().value;
    inflight.delete(oldest);
  }
}

/**
 * Map pipelineLog stage names → status fields + ring buffer.
 * @param {string} stage
 * @param {string} status PASS|FAIL|...
 * @param {object} [meta]
 */
function record(stage, status, meta = {}) {
  const s = String(stage || '');
  const statusUpper = String(status || 'FAIL').toUpperCase();
  const ok = statusUpper === 'PASS';
  // Expected skips / non-failures: must not pollute lastFailure* counters.
  const skip = ['SKIP', 'N/A', 'ORPHANED', 'DUPLICATE', 'PENDING'].includes(statusUpper);
  const nonProd = isNonProductionPipelineTelemetry(meta);
  const entry = stamp(meta);
  memory.updatedAt = entry.at;
  memory.currentPipelineStage = s || memory.currentPipelineStage;

  pushEvent(
    {
      type: s,
      status: ok ? 'PASS' : skip ? statusUpper : statusUpper || 'FAIL',
      at: entry.at,
      symbol: entry.symbol,
      timeframe: entry.timeframe,
      signalUuid: entry.signalUuid,
      userId: entry.userId,
      reason: entry.reason,
      latencyMs: entry.latencyMs,
      requestId: entry.requestId,
      tokenVersion: entry.tokenVersion,
      tokenEnvironment: entry.tokenEnvironment,
      scriptGenerationId: entry.scriptGenerationId,
      alertType: entry.alertType,
      selfTest: entry.selfTest,
      telemetrySource: entry.telemetrySource,
      detectedPineVersion: entry.detectedPineVersion,
      compatibilityAdapter: entry.compatibilityAdapter,
      compatibilityMode: entry.compatibilityMode,
      compatibilityLabel: entry.compatibilityLabel,
      legacy: entry.legacy,
      eventId: entry.eventId,
      canonicalTradeId: entry.canonicalTradeId,
      eventType: entry.eventType,
      eventSequence: entry.eventSequence,
      isRealtimeState: entry.isRealtimeState,
      staleDecision: entry.staleDecision,
      duplicateDecision: entry.duplicateDecision
    },
    { persist: !nonProd }
  );

  if (!nonProd) {
    trackInflight(stage, ok, entry);
  }

  if (/^WebhookReceived$/i.test(s)) {
    memory.lastWebhookReceived = entry;
    if (ok) memory.lastAlertFired = entry;
    else if (!skip) memory.webhookFailures += 1;
  } else if (/^WebhookRateLimited$/i.test(s) || /^WebhookParseError$/i.test(s)) {
    // Pre-route rejects (429 / bad JSON) — never reach [TV WEBHOOK RECEIVED].
    memory.webhookFailures += 1;
  } else if (/^Auth$/i.test(s)) {
    if (ok) memory.lastAuthPassed = entry;
    else if (!skip) {
      memory.lastAuthFailed = entry;
      memory.authFailures += 1;
      memory.webhookFailures += 1;
    }
  } else if (/^Validation$/i.test(s)) {
    memory.lastValidation = entry;
    if (!ok && !skip) memory.validationFailures += 1;
  } else if (/^MongoSave$/i.test(s)) {
    if (ok) memory.lastMongoSave = entry;
  } else if (/^Accepted$/i.test(s)) {
    if (ok) memory.lastAccepted = entry;
  } else if (/^Publish$/i.test(s)) {
    if (ok) memory.lastPublished = entry;
  } else if (/^DeliveryTelegram$/i.test(s)) {
    if (ok) memory.lastTelegramDelivery = entry;
    else if (!skip) memory.deliveryFailures += 1;
  } else if (/^DeliveryMT5$/i.test(s)) {
    if (ok) memory.lastMT5Delivery = entry;
    else if (!skip) memory.deliveryFailures += 1;
  } else if (/^DeliverySocket$/i.test(s)) {
    if (ok) memory.lastSocketDelivery = entry;
    else if (!skip) memory.deliveryFailures += 1;
  } else if (/^DeliveryEmail$/i.test(s)) {
    if (ok) memory.lastEmailDelivery = entry;
    else if (!skip) memory.deliveryFailures += 1;
  } else if (/^EntryOrdered$/i.test(s) && ok) {
    memory.lastPublished = memory.lastPublished || entry;
  } else if (/^OutcomeOrdered$/i.test(s) && ok) {
    memory.lastPublished = memory.lastPublished || entry;
  } else if (/^DeliverySequence$/i.test(s)) {
    // ENTRY-first wait/release — PENDING must not count as delivery failure.
  } else if (/^DurableDelivery$/i.test(s)) {
    memory.lastDurableDelivery = entry;
    const fromMeta = entry.deliveryJobState || meta.deliveryJobState;
    const fromReason = String(entry.reason || '').match(/state=([a-z_]+)/);
    memory.durableDeliveryState = fromMeta || (fromReason ? fromReason[1] : memory.durableDeliveryState);
    // Overlay diagnostics — do not steal lastFailureStage from Broadcast/Delivery*.
  } else if (/^AlertEvaluated$/i.test(s)) {
    memory.lastAlertEvaluated = entry;
  } else if (/^AlertFired$/i.test(s) && ok) {
    memory.lastAlertFired = entry;
  }

  if (!ok && !skip && !/^DurableDelivery$/i.test(s) && !/^DeliverySequence$/i.test(s)) {
    memory.lastFailureStage = s || 'unknown';
    memory.lastFailureReason = entry.reason || 'failed';
  }

  if (!nonProd) {
    void persistRedis();
  }
  return memory;
}

function resetForTests() {
  memory = EMPTY();
  ring = [];
  inflight.clear();
  hydrated = false;
  lastRedisAccessError = null;
}

function getLiveEvents(limit = RING_MAX) {
  const n = Math.max(1, Math.min(RING_MAX, Number(limit) || RING_MAX));
  return ring.slice(-n).reverse();
}

function computeAveragePipelineLatency() {
  const summary = getLatencySummary();
  return summary.pipeline.operationalAvgMs != null
    ? summary.pipeline.operationalAvgMs
    : summary.pipeline.avgMs;
}

function getLatencySummary() {
  const webhookToAccepted = summarizeLatencies(memory.webhookToAcceptedMs);
  const pipeline = summarizeLatencies(memory.pipelineLatenciesMs);
  const webhookToMongo = summarizeLatencies(memory.webhookToMongoMs);
  const mongoToTelegram = summarizeLatencies(memory.mongoToTelegramMs);
  const operationalAvgMs =
    webhookToAccepted.avgMs != null ? webhookToAccepted.avgMs : pipeline.avgMs;
  return {
    pipeline: {
      ...pipeline,
      operationalAvgMs
    },
    webhookToMongo,
    webhookToAccepted,
    mongoToTelegram,
    source: 'webhook_to_accepted_and_explicit_accepted_latencyMs',
    note:
      'operationalAvgMs is the unclamped mean of webhook→accepted samples only; sequencer/Telegram waits are not mixed in.'
  };
}

function isPipelineHealthy(memoryState, opts = {}) {
  const lastFailAt = memoryState.lastFailureStage ? memoryState.updatedAt : null;
  const lastOk =
    memoryState.lastMongoSave?.at ||
    memoryState.lastWebhookReceived?.at ||
    memoryState.lastAuthPassed?.at;
  if (memoryState.lastFailureStage && lastFailAt && lastOk) {
    // simplified health heuristic retained
  }
  if (opts.forceUnhealthy) return false;
  if (!memoryState.lastFailureStage) return true;
  const failStage = memoryState.lastFailureStage;
  const webhookAt = memoryState.lastWebhookReceived?.at
    ? new Date(memoryState.lastWebhookReceived.at).getTime()
    : 0;
  const failIsAuthOrValidation = /auth|validation|webhook/i.test(failStage);
  if (!failIsAuthOrValidation) {
    return Boolean(memoryState.lastWebhookReceived);
  }
  const updated = memoryState.updatedAt ? new Date(memoryState.updatedAt).getTime() : 0;
  if (webhookAt && webhookAt >= updated - 1000) return true;
  return true;
}

async function getStatus(extra = {}) {
  try {
    await withTimeout(ensureHydrated(), 2000, 'pipeline_ensure_hydrated');
  } catch {
    /* memory-only snapshot */
  }
  const openFromRegistry = activeSignalRegistry.listActive() || [];
  const latency = getLatencySummary();
  const globalAge = evaluateWebhookAge(memory.lastWebhookReceived?.at, {
    strategy: extra.activeStrategy || process.env.PINE_DEFAULT_STRATEGY || 'daytrading'
  });

  const authFailIsLatest =
    Boolean(memory.lastAuthFailed?.at) &&
    (!memory.lastAuthPassed?.at ||
      new Date(memory.lastAuthFailed.at).getTime() >= new Date(memory.lastAuthPassed.at).getTime());

  const timeline = buildPipelineTimeline({
    pineGeneratedAt: extra.pineGeneratedAt || null,
    lastWebhookAt: memory.lastWebhookReceived?.at || null,
    lastAlertFiredAt: memory.lastAlertFired?.at || null,
    lastAuthAt: authFailIsLatest ? memory.lastAuthFailed?.at : memory.lastAuthPassed?.at || null,
    lastAuthFail: authFailIsLatest || memory.lastFailureStage === 'Auth',
    lastAuthFailReason: authFailIsLatest
      ? memory.lastAuthFailed?.reason || memory.lastFailureReason
      : memory.lastFailureStage === 'Auth'
        ? memory.lastFailureReason
        : null,
    lastValidationAt: memory.lastValidation?.at || null,
    lastValidationFail: memory.lastFailureStage === 'Validation',
    lastValidationFailReason:
      memory.lastFailureStage === 'Validation' ? memory.lastFailureReason : null,
    lastMongoSaveAt: memory.lastMongoSave?.at || null,
    lastMongoFail: memory.lastFailureStage === 'MongoSave',
    lastAcceptedAt: memory.lastAccepted?.at || null,
    lastPublishedAt: memory.lastPublished?.at || null,
    lastPublishFail: memory.lastFailureStage === 'Publish',
    lastSocketAt: memory.lastSocketDelivery?.at || null,
    lastSocketFail: memory.lastFailureStage === 'DeliverySocket',
    lastTelegramAt: memory.lastTelegramDelivery?.at || null,
    lastTelegramFail: memory.lastFailureStage === 'DeliveryTelegram',
    lastEmailAt: memory.lastEmailDelivery?.at || null,
    lastEmailFail: memory.lastFailureStage === 'DeliveryEmail',
    lastMT5At: memory.lastMT5Delivery?.at || null,
    lastMT5Fail: memory.lastFailureStage === 'DeliveryMT5',
    lastWebhookFail: false
  });

  let durableDeliveryCounts = null;
  let durableDeliveryWorker = null;
  try {
    const DurableDelivery = require('../utils/durableDelivery');
    durableDeliveryCounts = await withTimeout(
      DurableDelivery.getCounts(),
      2000,
      'pipeline_durable_counts'
    );
    const worker = DurableDelivery.getWorkerHealth();
    durableDeliveryWorker = {
      lastError: worker.lastError,
      lastTickAt: worker.lastTickAt
    };
  } catch (err) {
    durableDeliveryCounts = null;
    durableDeliveryWorker = {
      lastError: err?.message || 'timeout_or_unavailable',
      lastTickAt: null
    };
  }
  const redisDiag = typeof getRedisDiagnostics === 'function' ? getRedisDiagnostics() : {};
  const redisCommandDegraded = Boolean(lastRedisAccessError);
  const redisDown = Boolean(
    redisDiag.redisConfigured && (!redisDiag.redisConnected || redisCommandDegraded)
  );
  const pipelineHealthy = isPipelineHealthy(memory) && !redisDown;
  let intakeState = 'NO_WEBHOOK_RECEIVED';
  try {
    const { resolveIntakeState } = require('../utils/webhookPipelineDiag');
    intakeState = resolveIntakeState(memory);
  } catch {
    intakeState = memory.lastWebhookReceived ? 'PIPELINE_ACTIVE' : 'NO_WEBHOOK_RECEIVED';
  }

  const mongoDurable = isDurableMongoSaveStamp(memory.lastMongoSave);
  const webhookIsSelfTest = isSelfTestStamp(memory.lastWebhookReceived);

  return {
    status: redisDown ? 'degraded' : 'ok',
    redis: {
      status: redisDiag.redisConnected && !redisCommandDegraded
        ? 'ok'
        : redisDiag.redisConfigured
          ? 'unavailable'
          : 'not_configured',
      error:
        (lastRedisAccessError && lastRedisAccessError.message) ||
        redisDiag.redisLastError ||
        redisDiag.lastRedisError ||
        null,
      errorCode: redisDiag.lastRedisErrorCode || null,
      lastErrorAt: redisDiag.lastRedisErrorAt || null,
      lastSuccessfulRedisOperation: redisDiag.lastSuccessfulRedisOperation || null,
      lastSuccessfulRedisAt: redisDiag.lastSuccessfulRedisAt || null,
      redisLatencyMs: redisDiag.redisLatencyMs,
      redisScheme: redisDiag.redisScheme,
      hostFingerprint: redisDiag.hostFingerprint,
      machineId: redisDiag.machineId,
      redisConfigured: Boolean(redisDiag.redisConfigured),
      redisClientOpen: Boolean(redisDiag.redisClientOpen),
      redisClientReady: Boolean(redisDiag.redisClientReady),
      redisConnectionState: redisDiag.redisConnectionState || null,
      redisLastError: redisDiag.redisLastError || redisDiag.lastRedisError || null,
      redisReconnectInProgress: Boolean(redisDiag.redisReconnectInProgress)
    },
    mongo: extra.mongoStatus || null,
    intakeState,
    ...memory,
    pipelineLatenciesMs: undefined,
    webhookToMongoMs: undefined,
    webhookToAcceptedMs: undefined,
    mongoToTelegramMs: undefined,
    lastAlertEvaluatedNote:
      'Pine-only: enable DEBUG_MODE and check Pine Logs for [PIPELINE] ALERT NOT FIRED / DEBUG STATE. Server cannot observe chart evaluation.',
    currentOpenTrades: openFromRegistry.map(t => ({
      symbol: t.symbol || null,
      timeframe: t.timeframe || null,
      strategy: t.strategy || null,
      signalUuid: t.signalUuid || t.signalId || null,
      direction: t.direction || null,
      registeredAt: t.registeredAt || t.createdAt || null
    })),
    currentOpenTradesCount: openFromRegistry.length,
    pipelineHealthy,
    lastWebhook: memory.lastWebhookReceived,
    lastAuthFailed: memory.lastAuthFailed,
    lastAuthDiagnostics: (authFailIsLatest ? memory.lastAuthFailed : memory.lastAuthPassed)
      ? {
          requestId: (authFailIsLatest ? memory.lastAuthFailed : memory.lastAuthPassed).requestId || null,
          tokenVersion:
            (authFailIsLatest ? memory.lastAuthFailed : memory.lastAuthPassed).tokenVersion || null,
          tokenEnvironment:
            (authFailIsLatest ? memory.lastAuthFailed : memory.lastAuthPassed).tokenEnvironment ||
            null,
          scriptGenerationId:
            (authFailIsLatest ? memory.lastAuthFailed : memory.lastAuthPassed).scriptGenerationId ||
            null,
          symbol: (authFailIsLatest ? memory.lastAuthFailed : memory.lastAuthPassed).symbol || null,
          alertType: (authFailIsLatest ? memory.lastAuthFailed : memory.lastAuthPassed).alertType || null,
          timestamp: (authFailIsLatest ? memory.lastAuthFailed : memory.lastAuthPassed).at || null
        }
      : null,
    lastPublishedSignal: memory.lastPublished || memory.lastMongoSave,
    lastMongoSave: memory.lastMongoSave,
    lastAccepted: memory.lastAccepted,
    lastMongoSaveDurable: mongoDurable,
    lastMongoSaveIsSelfTest: isSelfTestStamp(memory.lastMongoSave),
    lastMongoSaveIsInMemoryFallback: isInMemoryFallbackStamp(memory.lastMongoSave),
    lastWebhookIsSelfTest: webhookIsSelfTest,
    pineCompatibility: {
      pineVersion:
        memory.lastWebhookReceived?.detectedPineVersion ||
        memory.lastAccepted?.detectedPineVersion ||
        null,
      compatibilityAdapter:
        memory.lastWebhookReceived?.compatibilityAdapter ||
        memory.lastAccepted?.compatibilityAdapter ||
        null,
      compatibilityLabel:
        memory.lastWebhookReceived?.compatibilityLabel ||
        memory.lastAccepted?.compatibilityLabel ||
        null,
      eventId: memory.lastWebhookReceived?.eventId || memory.lastAccepted?.eventId || null,
      canonicalTradeId:
        memory.lastWebhookReceived?.canonicalTradeId ||
        memory.lastAccepted?.canonicalTradeId ||
        null,
      eventType: memory.lastWebhookReceived?.eventType || memory.lastAccepted?.eventType || null,
      isRealtimeState:
        memory.lastWebhookReceived?.isRealtimeState ||
        memory.lastAccepted?.isRealtimeState ||
        null
    },
    lastMongoSaveNote: !memory.lastMongoSave
      ? null
      : mongoDurable
        ? 'Durable Mongo Signal persist'
        : isSelfTestStamp(memory.lastMongoSave)
          ? 'Non-production self-test telemetry — not a real TradingView Mongo Signal'
          : isInMemoryFallbackStamp(memory.lastMongoSave)
            ? 'In-memory fallback — not a durable Mongo Signal document'
            : 'Non-durable pipeline telemetry',
    lastTelegram: memory.lastTelegramDelivery,
    lastSocket: memory.lastSocketDelivery,
    lastMT5: memory.lastMT5Delivery,
    lastDurableDelivery: memory.lastDurableDelivery,
    durableDeliveryState: memory.durableDeliveryState,
    durableDeliveryCounts,
    durableDeliveryWorker,
    averagePipelineLatency: latency.pipeline.operationalAvgMs != null
      ? latency.pipeline.operationalAvgMs
      : latency.pipeline.avgMs,
    averagePipelineLatencyRaw: latency.pipeline.avgMs,
    latency,
    latencyNote: latency.note,
    webhookAge: globalAge,
    webhookAgeThresholdsMs: getWebhookAgeThresholdsMs(),
    activeSubscribers: extra.activeSubscribers != null ? extra.activeSubscribers : null,
    waitingSubscribers: extra.waitingSubscribers != null ? extra.waitingSubscribers : null,
    webhookFailures: memory.webhookFailures,
    deliveryFailures: memory.deliveryFailures,
    currentPipelineStage: memory.currentPipelineStage,
    timeline,
    liveEventCount: ring.length
  };
}

async function getLivePipeline(limit = RING_MAX) {
  try {
    await withTimeout(ensureHydrated(), 2000, 'pipeline_live_hydrate');
  } catch {
    /* memory-only */
  }
  const events = getLiveEvents(limit);
  const latency = getLatencySummary();
  return {
    ok: true,
    events,
    count: events.length,
    max: RING_MAX,
    lastPipelineDurationMs: latency.pipeline.avgMs,
    latency,
    currentPipelineStage: memory.currentPipelineStage,
    updatedAt: memory.updatedAt
  };
}

/**
 * One-time maintenance helper: delete only PipelineStatus Redis keys.
 * Does not touch sessions, rate limits, auth, or unrelated caches.
 */
async function clearPipelineStatusRedisKeys() {
  const redis = await getRedisClient();
  if (!redis) {
    return { ok: false, reason: 'redis_unavailable', deleted: [] };
  }
  const keys = [REDIS_KEY, REDIS_EVENTS_KEY];
  const deleted = [];
  for (const key of keys) {
    const n = await redis.del(key);
    if (n) deleted.push(key);
  }
  resetForTests();
  return { ok: true, deleted, prefix: REDIS_KEY_PREFIX };
}

module.exports = {
  record,
  getStatus,
  getLivePipeline,
  getLiveEvents,
  getLatencySummary,
  computeAveragePipelineLatency,
  resetForTests,
  isNonProductionPipelineTelemetry,
  isDurableMongoSaveStamp,
  isSelfTestStamp,
  isInMemoryFallbackStamp,
  clearPipelineStatusRedisKeys,
  REDIS_KEY,
  REDIS_EVENTS_KEY,
  REDIS_KEY_PREFIX,
  RING_MAX,
  percent
};
