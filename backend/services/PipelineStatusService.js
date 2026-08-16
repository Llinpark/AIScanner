/**
 * Lightweight pipeline diagnostics store (in-memory + optional Redis).
 * Updated by log hooks only — no strategy behaviour changes.
 */

const { getRedisClient } = require('../utils/redisClient');
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
const REDIS_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const RING_MAX = 100;

const EMPTY = () => ({
  lastAlertEvaluated: null,
  lastAlertFired: null,
  lastWebhookReceived: null,
  lastAuthPassed: null,
  lastValidation: null,
  lastMongoSave: null,
  lastPublished: null,
  lastTelegramDelivery: null,
  lastMT5Delivery: null,
  lastSocketDelivery: null,
  lastEmailDelivery: null,
  lastFailureStage: null,
  lastFailureReason: null,
  currentPipelineStage: null,
  webhookFailures: 0,
  deliveryFailures: 0,
  authFailures: 0,
  validationFailures: 0,
  pipelineLatenciesMs: [],
  webhookToMongoMs: [],
  mongoToTelegramMs: [],
  updatedAt: null
});

let memory = EMPTY();
/** @type {Array<object>} */
let ring = [];

/** Per in-flight signalUuid timing anchors (diagnostics only). */
const inflight = new Map();

function nowIso() {
  return new Date().toISOString();
}

function stamp(meta = {}) {
  return {
    at: nowIso(),
    symbol: meta.symbol || null,
    timeframe: meta.timeframe || meta.tf || null,
    signalUuid: meta.signalUuid || meta.signalId || meta.uuid || null,
    reason: meta.reason || meta.message || null,
    userId: meta.userId || meta.subscriberId || null,
    latencyMs: meta.latencyMs != null ? Number(meta.latencyMs) : null
  };
}

function pushLatency(bucket, value, max = 200) {
  if (!Number.isFinite(value) || value < 0) return;
  bucket.push(value);
  if (bucket.length > max) bucket.splice(0, bucket.length - max);
}

function pushEvent(event) {
  ring.push(event);
  if (ring.length > RING_MAX) {
    ring.splice(0, ring.length - RING_MAX);
  }
  void persistEventsRedis();
}

async function persistRedis() {
  try {
    const redis = await getRedisClient();
    if (!redis) return;
    await redis.setEx(REDIS_KEY, REDIS_TTL_SECONDS, JSON.stringify(memory));
  } catch {
    // Diagnostics must never break the webhook path.
  }
}

async function persistEventsRedis() {
  try {
    const redis = await getRedisClient();
    if (!redis) return;
    await redis.setEx(REDIS_EVENTS_KEY, REDIS_TTL_SECONDS, JSON.stringify(ring.slice(-RING_MAX)));
  } catch {
    // ignore
  }
}

async function hydrateFromRedis() {
  try {
    const redis = await getRedisClient();
    if (!redis) return;
    const raw = await redis.get(REDIS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        memory = { ...EMPTY(), ...parsed };
        if (!Array.isArray(memory.pipelineLatenciesMs)) memory.pipelineLatenciesMs = [];
        if (!Array.isArray(memory.webhookToMongoMs)) memory.webhookToMongoMs = [];
        if (!Array.isArray(memory.mongoToTelegramMs)) memory.mongoToTelegramMs = [];
      }
    }
    const eventsRaw = await redis.get(REDIS_EVENTS_KEY);
    if (eventsRaw) {
      const parsedEvents = JSON.parse(eventsRaw);
      if (Array.isArray(parsedEvents)) {
        ring = parsedEvents.slice(-RING_MAX);
      }
    }
  } catch {
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
    row = { startedAt: Date.now(), webhookAt: null, mongoAt: null, telegramAt: null };
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
  if (/^DeliveryTelegram$/i.test(stage) && ok) {
    row.telegramAt = Date.now();
    if (row.mongoAt) {
      pushLatency(memory.mongoToTelegramMs, row.telegramAt - row.mongoAt);
    }
  }
  if (/^Publish$/i.test(stage) || /^DeliverySocket$/i.test(stage) || /^DeliveryMT5$/i.test(stage)) {
    if (ok && row.startedAt && entry.latencyMs == null) {
      const elapsed = Date.now() - row.startedAt;
      pushLatency(memory.pipelineLatenciesMs, elapsed);
    }
  }
  if (entry.latencyMs != null && Number.isFinite(entry.latencyMs)) {
    pushLatency(memory.pipelineLatenciesMs, entry.latencyMs);
  }
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
  // Expected channel skips (e.g. MT5 not linked while Telegram-only is valid).
  // Must not pollute lastFailure* / deliveryFailures / intake classification.
  const skip = statusUpper === 'SKIP' || statusUpper === 'N/A';
  const entry = stamp(meta);
  memory.updatedAt = entry.at;
  memory.currentPipelineStage = s || memory.currentPipelineStage;

  pushEvent({
    type: s,
    status: ok ? 'PASS' : skip ? statusUpper : statusUpper || 'FAIL',
    at: entry.at,
    symbol: entry.symbol,
    timeframe: entry.timeframe,
    signalUuid: entry.signalUuid,
    userId: entry.userId,
    reason: entry.reason,
    latencyMs: entry.latencyMs
  });

  trackInflight(s, ok, entry);

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
      memory.authFailures += 1;
      memory.webhookFailures += 1;
    }
  } else if (/^Validation$/i.test(s)) {
    memory.lastValidation = entry;
    if (!ok && !skip) memory.validationFailures += 1;
  } else if (/^MongoSave$/i.test(s)) {
    if (ok) memory.lastMongoSave = entry;
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
  } else if (/^DeliveryEmail$/i.test(s) && ok) {
    memory.lastEmailDelivery = entry;
  } else if (/^AlertEvaluated$/i.test(s)) {
    memory.lastAlertEvaluated = entry;
  } else if (/^AlertFired$/i.test(s) && ok) {
    memory.lastAlertFired = entry;
  }

  if (!ok && !skip) {
    memory.lastFailureStage = s || 'unknown';
    memory.lastFailureReason = entry.reason || 'failed';
  }

  void persistRedis();
  return memory;
}

function resetForTests() {
  memory = EMPTY();
  ring = [];
  inflight.clear();
  hydrated = false;
}

function getLiveEvents(limit = RING_MAX) {
  const n = Math.max(1, Math.min(RING_MAX, Number(limit) || RING_MAX));
  return ring.slice(-n).reverse();
}

function computeAveragePipelineLatency() {
  return summarizeLatencies(memory.pipelineLatenciesMs).avgMs;
}

function getLatencySummary() {
  return {
    pipeline: summarizeLatencies(memory.pipelineLatenciesMs),
    webhookToMongo: summarizeLatencies(memory.webhookToMongoMs),
    mongoToTelegram: summarizeLatencies(memory.mongoToTelegramMs)
  };
}

function isPipelineHealthy(memoryState, opts = {}) {
  const lastFailAt = memoryState.lastFailureStage ? memoryState.updatedAt : null;
  const lastOk =
    memoryState.lastMongoSave?.at ||
    memoryState.lastWebhookReceived?.at ||
    memoryState.lastAuthPassed?.at;
  if (memoryState.lastFailureStage && lastFailAt && lastOk) {
    // Unhealthy only if last update was a failure and no later success fields are newer — simplified:
    // if current stage failed recently without a subsequent mongo/webhook success.
  }
  if (opts.forceUnhealthy) return false;
  // Soft health: no recent auth storm / no last failure without later webhook success.
  if (!memoryState.lastFailureStage) return true;
  const failStage = memoryState.lastFailureStage;
  const webhookAt = memoryState.lastWebhookReceived?.at
    ? new Date(memoryState.lastWebhookReceived.at).getTime()
    : 0;
  const failIsAuthOrValidation = /auth|validation|webhook/i.test(failStage);
  if (!failIsAuthOrValidation) {
    // Delivery failures do not mark whole pipeline unhealthy.
    return Boolean(memoryState.lastWebhookReceived);
  }
  // If we have a webhook after the failure timestamp, recover.
  const updated = memoryState.updatedAt ? new Date(memoryState.updatedAt).getTime() : 0;
  if (webhookAt && webhookAt >= updated - 1000) return true;
  // Stale failure without activity → still "healthy" for waiting TV (yellow UI elsewhere).
  return true;
}

async function getStatus(extra = {}) {
  await ensureHydrated();
  const openFromRegistry = activeSignalRegistry.listActive() || [];
  const latency = getLatencySummary();
  const globalAge = evaluateWebhookAge(memory.lastWebhookReceived?.at, {
    strategy: extra.activeStrategy || process.env.PINE_DEFAULT_STRATEGY || 'daytrading'
  });

  const timeline = buildPipelineTimeline({
    pineGeneratedAt: extra.pineGeneratedAt || null,
    lastWebhookAt: memory.lastWebhookReceived?.at || null,
    lastAlertFiredAt: memory.lastAlertFired?.at || null,
    lastAuthAt: memory.lastAuthPassed?.at || null,
    lastAuthFail: memory.lastFailureStage === 'Auth',
    lastAuthFailReason:
      memory.lastFailureStage === 'Auth' ? memory.lastFailureReason : null,
    lastValidationAt: memory.lastValidation?.at || null,
    lastValidationFail: memory.lastFailureStage === 'Validation',
    lastValidationFailReason:
      memory.lastFailureStage === 'Validation' ? memory.lastFailureReason : null,
    lastMongoSaveAt: memory.lastMongoSave?.at || null,
    lastMongoFail: memory.lastFailureStage === 'MongoSave',
    lastPublishedAt: memory.lastPublished?.at || null,
    lastPublishFail: memory.lastFailureStage === 'Publish',
    lastSocketAt: memory.lastSocketDelivery?.at || null,
    lastSocketFail: memory.lastFailureStage === 'DeliverySocket',
    lastTelegramAt: memory.lastTelegramDelivery?.at || null,
    lastTelegramFail: memory.lastFailureStage === 'DeliveryTelegram',
    lastMT5At: memory.lastMT5Delivery?.at || null,
    lastMT5Fail: memory.lastFailureStage === 'DeliveryMT5',
    lastWebhookFail: false
  });

  const pipelineHealthy = isPipelineHealthy(memory);
  let intakeState = 'NO_WEBHOOK_RECEIVED';
  try {
    const { resolveIntakeState } = require('../utils/webhookPipelineDiag');
    intakeState = resolveIntakeState(memory);
  } catch {
    intakeState = memory.lastWebhookReceived ? 'PIPELINE_ACTIVE' : 'NO_WEBHOOK_RECEIVED';
  }

  return {
    intakeState,
    ...memory,
    // Keep arrays out of default JSON if huge — expose summaries instead.
    pipelineLatenciesMs: undefined,
    webhookToMongoMs: undefined,
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
    // Extended admin fields (task 7)
    pipelineHealthy,
    lastWebhook: memory.lastWebhookReceived,
    lastPublishedSignal: memory.lastPublished || memory.lastMongoSave,
    lastMongoSave: memory.lastMongoSave,
    lastTelegram: memory.lastTelegramDelivery,
    lastSocket: memory.lastSocketDelivery,
    lastMT5: memory.lastMT5Delivery,
    averagePipelineLatency: latency.pipeline.avgMs,
    latency,
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
  await ensureHydrated();
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

module.exports = {
  record,
  getStatus,
  getLivePipeline,
  getLiveEvents,
  getLatencySummary,
  computeAveragePipelineLatency,
  resetForTests,
  REDIS_KEY,
  RING_MAX,
  percent
};
