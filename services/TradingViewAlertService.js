const mongoose = require('mongoose');
const Signal = require('../models/Signal');
const UserConfig = require('../models/User');
const {
  userCanAccessLiveAlerts,
  getEffectiveSubscription,
  isTradingViewSymbolAllowed,
  isTradingViewTimeframeAllowed
} = require('../utils/subscriptionAccess');
const devUserStore = require('../utils/devUserStore');
const {
  KACHING_ALERT_NAMES,
  normalizeSignalLevels,
  validateKachingEntrySignal,
  formatKachingAlertMessage
} = require('../utils/kachingSignalLevels');
const SignalEnrichmentService = require('../services/SignalEnrichmentService');
const TradeDeliveryService = require('../services/TradeDeliveryService');
const TradeLifecycleService = require('../services/TradeLifecycleService');
const { normalizeSymbol } = require('../config/symbols');
const { logPipeline, extractPipelineMeta } = require('../utils/pipelineLog');
const { extractPineClientMeta } = require('../utils/PineClientVersion');
const { attachOptionalContext } = require('../utils/PineWebhookContext');
const PineClientDecisionFramework = require('./PineClientDecisionFramework');
const PineCompatibilityService = require('./PineCompatibilityService');
const SubscriberSignalFormatter = require('./SubscriberSignalFormatter');
const {
  resolveCanonicalTradeId,
  resolveLogicalEventId,
  resolveEventTypeToken,
  hashIdentity,
  parseEventTimestamp,
  parseBridgeEventIndex,
  evaluateEntryFreshness,
  evaluateRealtimeFlag,
  evaluateUnknownRealtimeFreshness,
  mapOutcomeIgnoreReason
} = require('../utils/tradeEventIdentity');
const TradeEventDispatcher = require('../utils/tradeEventDispatcher');
const TradeEventStore = require('../utils/tradeEventStore');
const DurableDelivery = require('../utils/durableDelivery');
const { overlayFanoutAcceptResult } = require('../utils/deliveryJobSignalOverlay');
const { attachCorrelation, compactCorrelation, mergeCorrelation } = require('../utils/signalCorrelation');
const { mergeDeliveryStatusOps } = require('../utils/deliveryOutcomes');
const { emitTvAccept, emitTvPersist, emitTvFanout } = require('../utils/tvStageLog');
const { isEntryAlert, isOutcomeAlert, isTerminalEntry } = require('../utils/signalOutcome');
const { classifyRedisError } = require('../utils/redisClient');

function redisErrorCodeOf(err) {
  return err?.redisErrorCode || classifyRedisError(err);
}

function isDbConnected() {
  return mongoose.connection.readyState === 1;
}

function useDevUserStore() {
  return !isDbConnected();
}

function isDuplicateKeyError(error) {
  return (
    error?.code === 11000 ||
    /E11000|duplicate key/i.test(String(error?.message || ''))
  );
}

/** In-process fan-out lock replaced by TradeEventDispatcher (per-canonical ordered queue). */

/** Test-only subscriber injection (NODE_ENV=test). Never used in production. */
const testFanoutState = { subscribers: null, persistError: null, fanoutError: null };

function setTestFanoutHooks(hooks = {}) {
  if (Object.prototype.hasOwnProperty.call(hooks, 'subscribers')) {
    testFanoutState.subscribers = hooks.subscribers;
  }
  if (Object.prototype.hasOwnProperty.call(hooks, 'persistError')) {
    testFanoutState.persistError = hooks.persistError;
  }
  if (Object.prototype.hasOwnProperty.call(hooks, 'fanoutError')) {
    testFanoutState.fanoutError = hooks.fanoutError;
  }
}

function resetTestFanoutHooks() {
  testFanoutState.subscribers = null;
  testFanoutState.persistError = null;
  testFanoutState.fanoutError = null;
}

function rejectedWebhookHttpStatus(reason) {
  if (reason === 'forbidden_reset_payload') return 403;
  if (
    reason === 'duplicate_webhook_replay' ||
    reason === 'duplicate_lifecycle_event' ||
    reason === 'stale_entry' ||
    reason === 'orphaned_outcome' ||
    reason === 'already_terminal' ||
    reason === 'non_realtime_event' ||
    reason === 'expired_trade_event' ||
    reason === 'terminal_before_entry_delivery' ||
    reason === 'stale_outcome'
  ) {
    return 202;
  }
  if (reason === 'canonical_lock_busy' || reason === 'redis_unavailable') return 503;
  return 409;
}

async function findExistingByUuid(signalUuid, inMemorySignals = []) {
  const id = String(signalUuid || '').trim();
  if (!id) return null;
  if (Array.isArray(inMemorySignals)) {
    const hit = inMemorySignals.find(
      s => String(s.signalUuid || s.signalId || s.signalGroupId || '') === id
    );
    if (hit) return hit;
  }
  if (!isDbConnected()) return null;
  try {
    return await Signal.findOne({
      $or: [{ signalUuid: id }, { signalId: id }, { signalGroupId: id }]
    });
  } catch {
    return null;
  }
}

const ALERT_TYPES = new Set([
  'entry',
  'stop_loss',
  'take_profit_1',
  'take_profit_2',
  'take_profit_3',
  'expired',
  'cancelled',
  'signal'
]);

function normalizeAlertType(value) {
  const raw = String(value || 'signal').trim().toLowerCase();
  if (raw === 'sl' || raw === 'stoploss') return 'stop_loss';
  if (raw === 'tp' || raw === 'tp1') return 'take_profit_1';
  if (raw === 'tp2') return 'take_profit_2';
  if (raw === 'tp3') return 'take_profit_3';
  if (raw === 'expire' || raw === 'expiry' || raw === 'candle_expiry') return 'expired';
  if (raw === 'cancel' || raw === 'canceled') return 'cancelled';
  return ALERT_TYPES.has(raw) ? raw : 'signal';
}

const isForbiddenResetPayload = TradeLifecycleService.isForbiddenResetPayload;
const logSignalEvent = TradeLifecycleService.logLifecycleEvent;

function normalizeTradingViewUsername(value) {
  return String(value || '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase();
}

function parseWebhookBody(body) {
  if (typeof body === 'string') {
    const raw = String(body || '').replace(/^\uFEFF/, '').trim();
    if (!raw) {
      return { __parseError: true, __rawPreview: '', __parseReason: 'empty_body' };
    }
    try {
      return JSON.parse(raw);
    } catch {
      return {
        __parseError: true,
        __rawPreview: raw.slice(0, 80),
        __parseReason: 'invalid_json'
      };
    }
  }

  if (!body || typeof body !== 'object') {
    return { __parseError: true, __rawPreview: '', __parseReason: 'empty_body' };
  }

  if (body.__parseError) {
    return body;
  }

  if (typeof body.message === 'string') {
    const msg = body.message.trim();
    // Only merge nested message when it is itself a JSON object/array.
    // Human-readable alert text must never be treated as a second payload.
    if (msg.startsWith('{') || msg.startsWith('[')) {
      try {
        const parsed = JSON.parse(msg);
        if (parsed && typeof parsed === 'object') {
          return { ...body, ...parsed };
        }
      } catch {
        return body;
      }
    }
  }

  return body;
}

function formatLiveAlertMessage(signal) {
  return formatKachingAlertMessage(signal);
}

/** @deprecated Prefer TradeDeliveryService.toLiveAlertPayload */
function toLiveAlertPayload(signalDoc) {
  return TradeDeliveryService.toLiveAlertPayload(signalDoc);
}

/** TV webhook distribution: any sanitized instrument for entitled subscribers (chart = source of truth). */
function subscriberAllowsSignal(subscriber, signalData) {
  if (!subscriber?.subscription) return false;
  if (!isTradingViewSymbolAllowed(signalData.symbol, subscriber.subscription)) return false;
  if (
    signalData.timeframe &&
    !isTradingViewTimeframeAllowed(signalData.timeframe, subscriber.subscription)
  ) {
    return false;
  }
  return true;
}

function toSubscriberRecord(user) {
  if (!user || !userCanAccessLiveAlerts(user)) return null;
  return {
    id: user._id?.toString() || user.id,
    email: user.email,
    displayName: user.displayName,
    // Keep role so userHasTierFeature / getEffectiveSubscription still see admin bypass.
    role: user.role || null,
    subscription: getEffectiveSubscription(user),
    telegram: user.telegram || null,
    mt5: user.mt5 || null,
    preferences: user.preferences || {}
  };
}

async function findActiveSubscribers() {
  if (useDevUserStore()) {
    return devUserStore
      .listActiveSubscribers()
      .map(toSubscriberRecord)
      .filter(Boolean);
  }

  try {
    const now = new Date();
    // Avoid UserConfig.find({}) — only admins + active (non-expired) subscribers.
    const users = await UserConfig.find({
      $or: [
        { role: { $in: ['admin', 'super_admin'] } },
        {
          'subscription.status': 'active',
          $or: [
            { 'subscription.current_period_end': null },
            { 'subscription.current_period_end': { $exists: false } },
            { 'subscription.current_period_end': { $gt: now } }
          ]
        }
      ]
    })
      .select('email displayName subscription telegram mt5 preferences role')
      .lean();
    return users.map(toSubscriberRecord).filter(Boolean);
  } catch (error) {
    console.warn('[Alerts] findActiveSubscribers fallback:', error.message);
    return devUserStore
      .listActiveSubscribers()
      .map(toSubscriberRecord)
      .filter(Boolean);
  }
}

function getFanoutConcurrency() {
  return Math.max(1, Math.min(32, Number(process.env.TV_FANOUT_CONCURRENCY || 8)));
}

/** Recent lifecycle cache only — never grows with Redis job count / 41k index. */
const MAX_IN_MEMORY_SIGNALS = 400;

function signalLooksCompleted(s) {
  if (!s || typeof s !== 'object') return false;
  if (s.closedAt || s.completedAt) return true;
  const stage = String(s.lifecycleStage || s.tradeStatus || '').toLowerCase();
  if (/closed|completed|expired|cancelled/.test(stage)) return true;
  const alert = String(s.alertType || '').toLowerCase();
  return alert === 'take_profit_3' || alert === 'stop_loss' || alert === 'expired' || alert === 'cancelled';
}

function capInMemorySignals(arr) {
  if (!Array.isArray(arr) || arr.length <= MAX_IN_MEMORY_SIGNALS) return arr;
  for (let i = arr.length - 1; i >= 0 && arr.length > MAX_IN_MEMORY_SIGNALS; i -= 1) {
    if (signalLooksCompleted(arr[i])) arr.splice(i, 1);
  }
  while (arr.length > MAX_IN_MEMORY_SIGNALS) {
    arr.pop();
  }
  return arr;
}

/** Bounded parallel fan-out — delivery channels are independent per subscriber. */
async function mapWithConcurrency(items, concurrency, mapper) {
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

  const workers = Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () =>
    worker()
  );
  await Promise.all(workers);
  return results;
}

async function saveSignal(signalData, inMemorySignals) {
  const meta = extractPipelineMeta(signalData);
  const requestId = signalData.pipelineRequestId || 'n/a';
  // Diagnostics only — START does not mark MongoSave PASS in PipelineStatus.
  console.log(
    `[SIGNAL CREATE START] requestId=${requestId} symbol=${meta.symbol || 'n/a'} ` +
      `timeframe=${meta.timeframe || 'n/a'} signalUuid=${meta.signalUuid || 'n/a'}`
  );
  console.log(
    `[SIGNAL PERSIST START] requestId=${requestId} symbol=${meta.symbol || 'n/a'} ` +
      `signalUuid=${meta.signalUuid || 'n/a'}`
  );

  if (!isDbConnected()) {
    if (process.env.NODE_ENV === 'production') {
      const err = new Error('Mongo unavailable; Signal persist refused');
      err.code = 'MONGO_UNAVAILABLE';
      logPipeline('MongoSave', 'FAIL', {
        ...meta,
        reason: err.message
      });
      throw err;
    }
    const saved = {
      ...signalData,
      createdAt: new Date(),
      _id: signalData._id || `mem_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    };
    if (Array.isArray(inMemorySignals)) {
      inMemorySignals.unshift(saved);
      capInMemorySignals(inMemorySignals);
    }
    console.log(
      `[SIGNAL CREATE SUCCESS] requestId=${requestId} mode=in_memory id=${saved._id} ` +
        `signalUuid=${saved.signalUuid || meta.signalUuid || 'n/a'}`
    );
    console.log(
      `[SIGNAL PERSIST SUCCESS] requestId=${requestId} mode=in_memory id=${saved._id} ` +
        `signalUuid=${saved.signalUuid || meta.signalUuid || 'n/a'}`
    );
    logPipeline('MongoSave', 'PASS', {
      ...meta,
      reason: `Success; in_memory_fallback; id=${saved._id}`
    });
    if (signalData.userId) {
      try {
        const PipelineSubscriberStatsService = require('./PipelineSubscriberStatsService');
        void PipelineSubscriberStatsService.recordMongoSave(signalData.userId, meta);
      } catch {
        /* diagnostics */
      }
    }
    return saved;
  }

  try {
    attachCorrelation(signalData, { requestId: signalData.pipelineRequestId || requestId });
    const signal = new Signal(signalData);
    // Must await — otherwise ValidationError rejects escape the try/catch.
    const saved = await signal.save();
    if (Array.isArray(inMemorySignals)) {
      inMemorySignals.unshift(saved.toObject ? saved.toObject() : saved);
      capInMemorySignals(inMemorySignals);
    }
    console.log(
      `[SIGNAL CREATE SUCCESS] requestId=${requestId} id=${saved._id} ` +
        `signalUuid=${saved.signalUuid || saved.signalId || meta.signalUuid || 'n/a'}`
    );
    console.log(
      `[SIGNAL PERSIST SUCCESS] requestId=${requestId} id=${saved._id} ` +
        `signalUuid=${saved.signalUuid || saved.signalId || meta.signalUuid || 'n/a'}`
    );
    emitTvPersist({
      ...(saved.toObject ? saved.toObject() : saved),
      requestId,
      persisted: true,
      accepted: true,
      state: 'pending',
      reason: 'mongo_save'
    });
    logPipeline('MongoSave', 'PASS', {
      ...meta,
      signalUuid: saved.signalUuid || saved.signalId || meta.signalUuid,
      reason: `Success; id=${saved._id}`
    });
    if (signalData.userId || saved.userId) {
      try {
        const PipelineSubscriberStatsService = require('./PipelineSubscriberStatsService');
        void PipelineSubscriberStatsService.recordMongoSave(signalData.userId || saved.userId, {
          ...meta,
          signalUuid: saved.signalUuid || saved.signalId || meta.signalUuid
        });
      } catch {
        /* diagnostics */
      }
    }
    return saved;
  } catch (error) {
    const details =
      error?.errors
        ? Object.entries(error.errors)
            .map(([k, v]) => `${k}:${v?.message || v}`)
            .join(', ')
        : error.message;
    console.error(
      `[SIGNAL PERSIST FAILED] requestId=${requestId} symbol=${meta.symbol || 'n/a'} ` +
        `signalUuid=${meta.signalUuid || 'n/a'} reason=${details || 'mongo_save_failed'}`
    );
    console.error(`[WEBHOOK FAIL:MONGO] ${details || 'mongo_save_failed'}`);
    console.error('[Alerts] saveSignal failed:', details);
    logPipeline('MongoSave', 'FAIL', {
      ...meta,
      reason: details || 'mongo_save_failed'
    });
    throw error;
  }
}

/**
 * Publish a saved Signal through TradeDeliveryService (Socket.IO, email, Telegram, MT5).
 * TradingViewAlertService no longer drives Telegram or MT5 directly.
 */
async function deliverLiveAlert(io, signalDoc, subscriber = null, options = {}) {
  return TradeDeliveryService.deliverToSubscriber(io, signalDoc, subscriber, options);
}

async function deliverBroadcastToSubscribers(io, savedSignal, subscribers) {
  const results = [];
  const signalData = savedSignal.toObject ? savedSignal.toObject() : savedSignal;
  const eligible = subscribers.filter(sub => subscriberAllowsSignal(sub, signalData));

  if (eligible.length === 0) {
    if (subscribers.length === 0) {
      await deliverLiveAlert(io, savedSignal);
    }
    return { delivered: 0, subscribers: [], skippedByEntitlement: subscribers.length };
  }

  const settled = await mapWithConcurrency(eligible, getFanoutConcurrency(), async subscriber => {
    await deliverLiveAlert(io, savedSignal, subscriber, { releaseAfterCriticalProviders: true });
    return { userId: subscriber.id, email: subscriber.email };
  });
  results.push(...settled.filter(Boolean));
  await TradeDeliveryService.waitForPostSlotSocketIdle();

  return {
    delivered: results.length,
    subscribers: results,
    skippedByEntitlement: subscribers.length - eligible.length
  };
}

/**
 * One Pine signal → ONE Mongo Signal document → fan-out delivery.
 * Never clones Signal docs per subscriber.
 */
function explainSubscriberSkip(subscriber, signalData) {
  if (!subscriber?.subscription) return 'subscription_inactive';
  if (!isTradingViewSymbolAllowed(signalData.symbol, subscriber.subscription)) {
    return 'symbol_mismatch';
  }
  if (
    signalData.timeframe &&
    !isTradingViewTimeframeAllowed(signalData.timeframe, subscriber.subscription)
  ) {
    return 'timeframe_mismatch';
  }
  return 'user_not_eligible';
}

async function persistAcceptedSignal(signalData, inMemorySignals = [], options = {}) {
  if (process.env.NODE_ENV === 'test' && testFanoutState.persistError) {
    const err = testFanoutState.persistError;
    testFanoutState.persistError = null;
    throw err;
  }

  if (options.existingSaved) {
    return { saved: options.existingSaved, broadcastSaved: false };
  }

  if (isOutcomeAlert(signalData.alertType)) {
    logPipeline('Lifecycle', 'SKIP', {
      ...extractPipelineMeta(signalData),
      reason: `orphaned_outcome_no_persist; identityHash=${hashIdentity(resolveCanonicalTradeId(signalData))}`
    });
    return { saved: null, broadcastSaved: false, orphaned: true };
  }

  const uuid = signalData.signalUuid || signalData.signalId || signalData.signalGroupId;
  if (uuid) {
    const existing = await findExistingByUuid(uuid, inMemorySignals);
    if (existing) {
      return { saved: existing, broadcastSaved: false, duplicate: true };
    }
  }

  const enriched = await SignalEnrichmentService.enrichFromTradingViewWebhook(
    { ...signalData, isBroadcast: true },
    {
      fromTradingViewWebhook: true,
      skipMarketData: true,
      timeframe: signalData.timeframe || '1h',
      ...options
    }
  );

  try {
    const saved = await saveSignal(enriched, inMemorySignals);
    return { saved, broadcastSaved: true };
  } catch (error) {
    if (isDuplicateKeyError(error) && uuid) {
      const existing = await findExistingByUuid(uuid, inMemorySignals);
      if (existing) {
        logPipeline('MongoSave', 'PASS', {
          ...extractPipelineMeta(signalData),
          signalUuid: uuid,
          reason: `idempotent_duplicate_key; id=${existing._id || 'n/a'}`
        });
        return { saved: existing, broadcastSaved: false, duplicate: true };
      }
    }
    throw error;
  }
}

async function resolveFanoutSubscribers(options = {}) {
  if (Array.isArray(options.subscribers)) return options.subscribers;
  if (process.env.NODE_ENV === 'test' && Array.isArray(testFanoutState.subscribers)) {
    return testFanoutState.subscribers;
  }
  return findActiveSubscribers();
}

/**
 * Socket.IO / Telegram / Email / MT5 fan-out. Must not run on the TradingView HTTP path.
 */
function plainSignal(doc) {
  if (!doc) return {};
  return doc.toObject ? doc.toObject() : { ...doc };
}

function buildFanoutPayload(saved, signalData, requestId) {
  const base = plainSignal(saved);
  const overlay = signalData && typeof signalData === 'object' ? signalData : {};
  const alertType = overlay.alertType || base.alertType || 'entry';
  return {
    ...base,
    ...overlay,
    alertType,
    pipelineRequestId: requestId || overlay.pipelineRequestId || base.pipelineRequestId || 'n/a'
  };
}

async function hydrateLatestSaved(saved, signalData, inMemorySignals = []) {
  const uuid =
    resolveCanonicalTradeId(signalData || saved || {}) || saved?.signalUuid || saved?.signalId;
  const id = saved?._id || saved?.id;
  if (isDbConnected() && id && !String(id).startsWith('mem_')) {
    try {
      const fresh = await Signal.findById(id).lean();
      if (fresh) return fresh;
    } catch {
      /* keep snapshot */
    }
  }
  if (uuid) {
    const existing = await findExistingByUuid(uuid, inMemorySignals);
    if (existing) return existing;
  }
  return saved;
}

async function fanOutAcceptedSignal(io, saved, signalData, inMemorySignals = [], options = {}) {
  const meta = extractPipelineMeta(signalData);
  const requestId = signalData.pipelineRequestId || options.requestId || 'n/a';

  if (process.env.NODE_ENV === 'test' && testFanoutState.fanoutError) {
    const err = testFanoutState.fanoutError;
    testFanoutState.fanoutError = null;
    throw err;
  }

  const subscribers = await resolveFanoutSubscribers(options);
  const timings = options.timings || signalData.pipelineTimings || {};
  let telegramConfigured = false;
  try {
    telegramConfigured = Boolean(require('./TelegramService').isConfigured());
  } catch {
    telegramConfigured = false;
  }
  const emailTradeAlerts = String(process.env.EMAIL_TRADE_ALERTS_ENABLED || 'true').toLowerCase();

  console.log(
    `[BROADCAST START] requestId=${requestId} signalUuid=${meta.signalUuid || 'n/a'} ` +
      `symbol=${meta.symbol || 'n/a'} timeframe=${meta.timeframe || 'n/a'} ` +
      `alertType=${signalData.alertType || saved?.alertType || 'n/a'} ` +
      `activeSubscribers=${subscribers.length} telegramConfigured=${telegramConfigured} ` +
      `emailTradeAlerts=${emailTradeAlerts}`
  );
  try {
    emitTvFanout({
      ...signalData,
      requestId,
      accepted: true,
      persisted: true,
      deferredFanout: true,
      skippedFanout: false,
      state: 'attempted',
      reason: 'fanout_scheduled'
    });
  } catch {
    /* diagnostics */
  }

  const eligible = [];
  const skipped = [];
  for (const sub of subscribers) {
    if (subscriberAllowsSignal(sub, signalData)) {
      eligible.push(sub);
    } else {
      const reason = explainSubscriberSkip(sub, signalData);
      skipped.push({ userId: sub.id, email: sub.email, reason });
      console.log(
        `[BROADCAST SKIPPED] requestId=${requestId} signalUuid=${meta.signalUuid || 'n/a'} ` +
          `symbol=${meta.symbol || 'n/a'} userId=${sub.id || 'n/a'} reason=${reason}`
      );
    }
  }

  console.log(
    `[BROADCAST ELIGIBLE] requestId=${requestId} signalUuid=${meta.signalUuid || 'n/a'} ` +
      `count=${eligible.length}`
  );

  await emitLifecycleSocket(io, saved, signalData.alertType, { waitMode: options.waitMode });

  if (eligible.length === 0) {
    if (subscribers.length === 0) {
      console.warn(
        `[BROADCAST SKIPPED] requestId=${requestId} signalUuid=${meta.signalUuid || 'n/a'} ` +
          `reason=ZERO_ACTIVE_SUBSCRIBERS socket_only`
      );
      logPipeline('Broadcast', 'SKIP', {
        ...meta,
        signalUuid: saved.signalUuid || saved.signalId || meta.signalUuid,
        reason: `ZERO_ACTIVE_SUBSCRIBERS; requestId=${requestId}`
      });
      await deliverLiveAlert(io, saved, null, { waitMode: options.waitMode });
    } else {
      logPipeline('Broadcast', 'FAIL', {
        ...meta,
        signalUuid: saved.signalUuid || saved.signalId || meta.signalUuid,
        reason: `NO_ELIGIBLE_SUBSCRIBERS; active=${subscribers.length}; skipped=${skipped.length}`
      });
    }
    timings.broadcastCompletedAt = Date.now();
    return {
      delivered: 0,
      subscribers: [],
      broadcastSaved: Boolean(options.broadcastSaved),
      skippedByEntitlement: subscribers.length,
      skipped,
      signalUuid: saved.signalUuid || saved.signalId,
      timings
    };
  }

  const settled = await mapWithConcurrency(eligible, getFanoutConcurrency(), async subscriber => {
    console.log(
      `[BROADCAST DELIVERY START] signalUuid=${saved.signalUuid || meta.signalUuid || 'n/a'} ` +
        `symbol=${meta.symbol || 'n/a'} userId=${subscriber.id || 'n/a'}`
    );
    await deliverLiveAlert(
      io,
      buildFanoutPayload(saved, signalData, requestId),
      subscriber,
      { waitMode: options.waitMode, releaseAfterCriticalProviders: true }
    );
    return { userId: subscriber.id, email: subscriber.email };
  });
  const results = settled.filter(Boolean);
  await TradeDeliveryService.waitForPostSlotSocketIdle();
  timings.broadcastCompletedAt = Date.now();
  timings.telegramCompletedAt = timings.broadcastCompletedAt;
  timings.emailCompletedAt = timings.broadcastCompletedAt;
  timings.mt5CompletedAt = timings.broadcastCompletedAt;

  logPipeline('Broadcast', 'PASS', {
    ...meta,
    signalUuid: saved.signalUuid || saved.signalId || meta.signalUuid,
    reason: `delivered=${results.length}; skipped=${subscribers.length - eligible.length}; requestId=${requestId}`
  });

  return {
    delivered: results.length,
    subscribers: results,
    broadcastSaved: Boolean(options.broadcastSaved),
    skippedByEntitlement: subscribers.length - eligible.length,
    skipped,
    signalUuid: saved.signalUuid || saved.signalId,
    timings
  };
}

/**
 * Publish a saved Signal through TradeDeliveryService (Socket.IO, email, Telegram, MT5).
 * One Pine signal → ONE Mongo Signal document → fan-out delivery.
 */
async function broadcastToSubscribers(io, signalData, inMemorySignals = [], options = {}) {
  const persisted = await persistAcceptedSignal(signalData, inMemorySignals, options);
  if (persisted.duplicate) {
    return {
      delivered: 0,
      subscribers: [],
      broadcastSaved: false,
      skippedByEntitlement: 0,
      skipped: [],
      signalUuid: persisted.saved?.signalUuid || persisted.saved?.signalId || signalData.signalUuid,
      duplicate: true
    };
  }
  return fanOutAcceptedSignal(io, persisted.saved, signalData, inMemorySignals, {
    ...options,
    broadcastSaved: persisted.broadcastSaved
  });
}

async function emitLifecycleSocket(io, signalDoc, alertType, options = {}) {
  if (!io || !signalDoc) return;
  const payload = { ...(signalDoc.toObject ? signalDoc.toObject() : signalDoc) };
  payload.notes = SubscriberSignalFormatter.sanitizeSubscriberNotes(payload.notes);
  if (
    typeof payload.message === 'string' &&
    SubscriberSignalFormatter.looksLikeRawPayload(payload.message)
  ) {
    payload.message = payload.notes;
  }
  const type = String(alertType || payload.alertType || '').toLowerCase();
  const TradeLifecycle = require('./TradeLifecycleService');
  const DeliverySequencer = require('../utils/deliverySequencer');

  await DeliverySequencer.withChannelSequence({
    signalDoc: { ...payload, alertType: type || payload.alertType || 'entry' },
    subscriberId: '_broadcast',
    channel: 'socket_lifecycle',
    alertType: type || 'entry',
    waitMode: options.waitMode,
    send: async () => {
      if (TradeLifecycle.isEntryAlert(type)) {
        io.emit('signal_created', payload);
        io.emit('signal:update', payload); // legacy alias
        return { ok: true };
      }
      if (TradeLifecycle.isTerminalAlert(type)) {
        io.emit('signal_closed', payload);
        io.emit('signal:outcome', payload); // legacy alias
        return { ok: true };
      }
      if (TradeLifecycle.isOutcomeAlert(type) || TradeLifecycle.isPartialAlert(type)) {
        io.emit('signal_updated', payload);
        io.emit('signal:outcome', payload); // legacy alias
      }
      return { ok: true };
    }
  });
}

function buildSignalData(body) {
  const canonical = PineCompatibilityService.normalizeIncomingPineEvent(body || {}, {
    receivedAt: Date.now(),
    userId: body?.userId || body?.user_id
  });
  body = PineCompatibilityService.applyCanonicalToRawBody(body || {}, canonical);

  const direction = String(body.direction || body.action || 'neutral').toLowerCase();
  const levels = normalizeSignalLevels(body, direction);
  const strategyName =
    body.strategyName ||
    body.strategy_name ||
    body.strategy ||
    body.patternLabel ||
    body.pattern_label ||
    null;
  const timeframe = TradeLifecycleService.normalizeTradeTimeframe(
    body.timeframe || body.interval || body.tf || '1h'
  );
  const permanentId =
    body.signalUuid || body.signalId || body.signal_id || body.signalGroupId || undefined;
  const expiryBars = Number.isFinite(Number(body.expiryBars ?? body.expiry_bars))
    ? Math.floor(Number(body.expiryBars ?? body.expiry_bars))
    : undefined;
  const enableTradeExpiry =
    body.enableTradeExpiry === false ||
    body.enableTradeExpiry === 'false' ||
    body.enable_trade_expiry === false ||
    body.enable_trade_expiry === 'false'
      ? false
      : body.enableTradeExpiry != null || body.enable_trade_expiry != null
        ? true
        : undefined;

  const signalData = {
    symbol: normalizeSymbol(body.symbol || body.ticker || 'UNKNOWN'),
    direction,
    ...levels,
    confidence: Math.min(Math.max(parseFloat(body.confidence || 0) || 0, 0), 1),
    notes: SubscriberSignalFormatter.sanitizeSubscriberNotes(
      body.message || body.note || body.notes || KACHING_ALERT_NAMES.signal
    ),
    alertType: normalizeAlertType(body.alertType || body.alert_type || body.type),
    pattern: body.pattern || null,
    patternLabel: body.patternLabel || body.pattern_label || null,
    gapTop: parseFloat(body.gapTop || body.gap_top || 0) || undefined,
    gapBottom: parseFloat(body.gapBottom || body.gap_bottom || 0) || undefined,
    strategy: strategyName,
    strategyName,
    timeframe,
    signalUuid: permanentId,
    signalId: permanentId,
    expiryBars,
    enableTradeExpiry,
    expiresAt: body.expiresAt || body.expires_at || undefined,
    closedReason: body.closedReason || body.closed_reason || undefined,
    signalSource: 'tradingview',
    source: 'tradingview',
    origin: 'tradingview_webhook',
    deliveryStatus: 'pending',
    executionStatus: 'pending',
    telegramSent: false,
    mt5Sent: false,
    emailSent: false,
    chartSnapshot: body.chartSnapshot || body.chart_snapshot || undefined,
    eventTimestamp: parseEventTimestamp(body) || undefined,
    bridgeEventIndex: parseBridgeEventIndex(body),
    isRealtime: body.isRealtime ?? body.is_realtime ?? undefined,
    eventId: body.eventId || body.event_id || undefined,
    canonicalTradeId: body.canonicalTradeId || body.canonical_trade_id || undefined,
    eventType: body.eventType || body.event_type || undefined,
    eventSequence:
      body.eventSequence != null || body.event_sequence != null
        ? Number(body.eventSequence ?? body.event_sequence)
        : undefined,
    barTime: body.barTime || body.bar_time || undefined,
    // Dev self-test marker — never set by TradingView Pine; suppresses external fan-out.
    selfTest: body.selfTest === true || body.self_test === true || undefined
  };

  // Additive Pine client metadata (optional). Old payloads without these fields stay valid.
  const pineMeta = extractPineClientMeta(body);
  if (pineMeta.pineClientVersion) signalData.pineClientVersion = pineMeta.pineClientVersion;
  if (pineMeta.scriptGenerationId) signalData.scriptGenerationId = pineMeta.scriptGenerationId;
  if (pineMeta.generatedAt) signalData.pineGeneratedAt = pineMeta.generatedAt;
  if (pineMeta.capabilities.length) signalData.pineCapabilities = pineMeta.capabilities;
  signalData.pineCompatMode = pineMeta.mode;

  // Correlation: persist on Signal.correlation + pipelineRequestId (schema fields).
  if (body.pipelineRequestId) {
    signalData.pipelineRequestId = String(body.pipelineRequestId);
  }
  if (body.requestId && !signalData.pipelineRequestId) {
    signalData.pipelineRequestId = String(body.requestId);
  }
  attachCorrelation(signalData, {
    requestId: signalData.pipelineRequestId,
    eventId: signalData.eventId,
    signalUuid: signalData.signalUuid || signalData.signalId,
    canonicalTradeId: signalData.canonicalTradeId || signalData.canonicalSignalKey,
    signalId: signalData.signalId,
    symbolRaw: signalData.symbol,
    symbolNormalized: undefined
  });

  // Option A additive identity/display fields (never required; never gate auth/delivery).
  const chartTf = body.chartTf || body.chart_tf || body.chartTimeframe || null;
  const canonicalSignalTf =
    body.canonicalSignalTf || body.canonical_signal_tf || body.canonicalTimeframe || null;
  const canonicalSignalKey =
    body.canonicalSignalKey || body.canonical_signal_key || permanentId || null;
  if (chartTf) signalData.chartTf = String(chartTf);
  if (canonicalSignalTf) signalData.canonicalSignalTf = String(canonicalSignalTf);
  if (canonicalSignalKey) signalData.canonicalSignalKey = String(canonicalSignalKey);
  if (!signalData.canonicalTradeId) {
    signalData.canonicalTradeId = resolveCanonicalTradeId(signalData) || undefined;
  }
  if (!signalData.eventType) {
    signalData.eventType = resolveEventTypeToken(signalData.alertType);
  }
  if (!signalData.eventId) {
    const derivedEventId = resolveLogicalEventId(signalData);
    if (derivedEventId) signalData.eventId = derivedEventId;
  }

  // Optional future context fields — accepted if present, ignored if absent.
  attachOptionalContext(signalData, body);

  // Decision framework stub: observability / future wiring only.
  // Result is intentionally discarded — never filters, rescores, or rewrites delivery.
  try {
    const decision = PineClientDecisionFramework.evaluateEntryDecision(body, signalData);
    void decision;
  } catch {
    // Never fail webhook on decision-framework prep errors.
  }

  PineCompatibilityService.attachCanonicalMetadata(signalData, canonical);

  if (signalData.pattern === 'perfect_fvg' && !signalData.patternLabel) {
    signalData.patternLabel = 'Pattern A: Perfect Fair Value Gap';
  }
  if (signalData.pattern === 'breakaway_gap' && !signalData.patternLabel) {
    signalData.patternLabel = 'Pattern B: Breakaway Gap';
  }

  // Outcome / expiry alerts carry levels for audit but may not need full entry validation.
  if (TradeLifecycleService.isEntryAlert(signalData.alertType)) {
    try {
      validateKachingEntrySignal(signalData);
      logPipeline('Validation', 'PASS', {
        ...extractPipelineMeta(signalData),
        reason: 'entry_levels_ok'
      });
    } catch (error) {
      const rejected = error.rejectedFields || [];
      logPipeline('Validation', 'FAIL', {
        ...extractPipelineMeta(signalData),
        reason:
          rejected.length > 0
            ? `rejected_fields=${rejected.join(',')}`
            : error.message || 'entry_validation_failed'
      });
      console.warn(
        `[TV WEBHOOK VALIDATION FAILED] fields=${rejected.join(',') || 'n/a'} ` +
          `symbol=${signalData.symbol} msg=${error.message}`
      );
      console.warn(
        `[WEBHOOK FAIL:VALIDATION] fields=${rejected.join(',') || 'n/a'} msg=${error.message}`
      );
      throw error;
    }
  }

  return signalData;
}

/**
 * TradingView webhook / inject path — validate, enrich, and publish a Signal.
 * Delivery (Socket.IO / email / Telegram / MT5) is owned by TradeDeliveryService.
 * Never fetches candles, never runs indicator / liquidity / FVG / SMC pipelines.
 * Never accepts No-Signal / active=false / delete resets that would wipe a live trade.
 */
/**
 * Parse → validate → lifecycle → durable Signal persist.
 * Does NOT fan-out Telegram/Email/Socket/MT5. HTTP may ack after this returns.
 */
async function acceptTradingViewWebhook(io, rawBody, inMemorySignals = [], options = {}) {
  const timings = options.timings || {};
  timings.acceptStartedAt = Date.now();
  const body = parseWebhookBody(rawBody);

  if (isForbiddenResetPayload(body)) {
    logSignalEvent('reject_reset', {
      symbol: body.symbol || body.ticker,
      timeframe: body.timeframe || body.interval || body.tf,
      alertType: body.alertType || body.type,
      reason: 'forbidden_no_signal_or_reset'
    });
    logPipeline('Lifecycle', 'FAIL', {
      ...extractPipelineMeta(body),
      reason: 'forbidden_reset_payload'
    });
    return {
      mode: 'rejected',
      publishOnly: true,
      rejected: true,
      accepted: false,
      reason: 'forbidden_reset_payload',
      httpStatus: 403,
      message:
        'No-Signal / active=false / delete resets are rejected. Active trades persist until TP3/SL/expiry/cancel.',
      timings
    };
  }

  const baseData = buildSignalData(body);
  timings.validationCompletedAt = Date.now();
  const canonicalId = resolveCanonicalTradeId(baseData);

  try {
    return await TradeEventDispatcher.withCanonicalLock(canonicalId, () =>
      acceptAfterValidation(io, baseData, inMemorySignals, options, timings, canonicalId)
    );
  } catch (err) {
    if (err && err.code === 'CANONICAL_LOCK_BUSY') {
      logPipeline('Lifecycle', 'PENDING', {
        ...extractPipelineMeta(baseData),
        reason: `canonical_lock_busy; requestId=${baseData.pipelineRequestId || 'n/a'}; identityHash=${hashIdentity(canonicalId)}`
      });
      return {
        mode: 'retry',
        publishOnly: true,
        accepted: false,
        rejected: true,
        skippedFanout: true,
        reason: 'canonical_lock_busy',
        httpStatus: 503,
        message: 'Canonical trade lock busy on another machine; TradingView should retry.',
        signalData: baseData,
        signalUuid: canonicalId,
        timings
      };
    }
    if (err && (err.code === 'REDIS_UNAVAILABLE' || err.reason === 'redis_unavailable')) {
      logPipeline('Lifecycle', 'FAIL', {
        ...extractPipelineMeta(baseData),
        reason: `redis_unavailable; Redis is authority — refusing process-local claim; requestId=${baseData.pipelineRequestId || 'n/a'}; identityHash=${hashIdentity(canonicalId)}`
      });
      return {
        mode: 'retry',
        publishOnly: true,
        accepted: false,
        rejected: true,
        skippedFanout: true,
        reason: 'redis_unavailable',
        redisErrorCode: redisErrorCodeOf(err),
        httpStatus: 503,
        message: 'Redis unavailable; event was not claimed. TradingView should retry.',
        signalData: baseData,
        signalUuid: canonicalId,
        timings
      };
    }
    throw err;
  }
}

function snapshotDoc(doc) {
  if (!doc) return doc;
  const plain = doc.toObject ? doc.toObject() : doc;
  return { ...plain };
}

function ackNoFanout(reason, baseData, timings, extra = {}) {
  const uuid = extra.signalUuid || resolveCanonicalTradeId(baseData);
  const pendingOutcome = Boolean(extra.pendingOutcome);
  const persisted = extra.persisted != null ? Boolean(extra.persisted) : false;
  const result = {
    mode: extra.mode || (pendingOutcome ? 'pending_outcome' : 'idempotent'),
    publishOnly: true,
    accepted: true,
    persisted,
    duplicate: Boolean(extra.duplicate),
    idempotent: Boolean(extra.duplicate || extra.idempotent),
    skippedFanout:
      extra.skippedFanout != null
        ? Boolean(extra.skippedFanout)
        : extra.pendingOutcome
          ? false
          : true,
    pendingOutcome,
    rejected: false,
    reason,
    message: extra.message,
    activeSignal: extra.activeSignal,
    saved: extra.saved || null,
    signalData: extra.signalData || baseData,
    signalUuid: uuid,
    timings,
    ...extra,
    persisted,
    pendingOutcome
  };
  try {
    emitTvAccept({
      ...(result.signalData || baseData),
      requestId: (result.signalData || baseData).pipelineRequestId,
      accepted: Boolean(result.accepted) && !result.skippedFanout && !result.duplicate,
      persisted: result.persisted,
      deferredFanout: false,
      skippedFanout: result.skippedFanout,
      reason,
      state: result.skippedFanout ? 'skipped' : 'pending'
    });
  } catch {
    /* diagnostics */
  }
  return result;
}

async function acceptAfterValidation(io, baseData, inMemorySignals, options, timings, canonicalId) {
  const realtime = evaluateRealtimeFlag(baseData);
  if (realtime.state) baseData.isRealtimeState = realtime.state;
  if (realtime.reject) {
    logPipeline('Lifecycle', 'SKIP', {
      ...extractPipelineMeta(baseData),
      staleDecision: 'non_realtime_event',
      reason: `non_realtime_event; requestId=${baseData.pipelineRequestId || 'n/a'}; identityHash=${hashIdentity(canonicalId)}`
    });
    return ackNoFanout('non_realtime_event', baseData, timings, {
      mode: 'rejected',
      message: 'Historical/non-realtime Pine event rejected; no subscriber delivery.',
      signalData: baseData
    });
  }
  if (realtime.state === 'unknown') {
    logPipeline('Compatibility', 'N/A', {
      ...extractPipelineMeta(baseData),
      isRealtimeState: 'unknown',
      reason: `legacy_realtime_unknown; adapter=${baseData.compatibilityAdapter || '-'}; requestId=${baseData.pipelineRequestId || 'n/a'}`
    });
    const unknownFresh = evaluateUnknownRealtimeFreshness(baseData, {
      receivedAt: timings.acceptStartedAt || Date.now()
    });
    if (unknownFresh.stale) {
      logPipeline('Lifecycle', 'SKIP', {
        ...extractPipelineMeta(baseData),
        staleDecision: unknownFresh.reason,
        isRealtimeState: 'unknown',
        reason: `${unknownFresh.reason}; legacy_realtime_unknown; ageMs=${unknownFresh.ageMs}; requestId=${baseData.pipelineRequestId || 'n/a'}`
      });
      return ackNoFanout(unknownFresh.reason, baseData, timings, {
        mode: 'rejected',
        message: 'Legacy event without isRealtime exceeded freshness window; no subscriber delivery.',
        signalData: baseData,
        freshness: unknownFresh
      });
    }
  }

  const eventId = String(baseData.eventId || '').trim() || resolveLogicalEventId(baseData);
  const eventType = baseData.eventType || resolveEventTypeToken(baseData.alertType);
  if (!eventId) {
    logPipeline('Lifecycle', 'FAIL', {
      ...extractPipelineMeta(baseData),
      reason: `missing_event_identity; requestId=${baseData.pipelineRequestId || 'n/a'}; adapter=${baseData.compatibilityAdapter || '-'}`
    });
    return {
      mode: 'rejected',
      publishOnly: true,
      accepted: false,
      rejected: true,
      skippedFanout: true,
      reason: 'missing_event_identity',
      httpStatus: 409,
      message: 'Event identity could not be derived; refusing empty eventId allow-bypass.',
      signalData: baseData,
      signalUuid: canonicalId,
      timings
    };
  }

  let claimedEvent;
  try {
    claimedEvent = await TradeEventStore.claimEventId(eventId);
  } catch (err) {
    if (err && (err.code === 'REDIS_UNAVAILABLE' || err.reason === 'redis_unavailable')) {
      logPipeline('Lifecycle', 'FAIL', {
        ...extractPipelineMeta(baseData),
        signalUuid: canonicalId,
        eventId,
        canonicalTradeId: canonicalId,
        eventType,
        pineClientVersion: baseData.pineClientVersion,
        reason: `redis_unavailable; eventId=${eventId}; eventType=${eventType}; canonicalTradeId=${canonicalId || '-'}; requestId=${baseData.pipelineRequestId || 'n/a'}; Redis is authority — refusing process-local claim`
      });
      return {
        mode: 'retry',
        publishOnly: true,
        accepted: false,
        rejected: true,
        skippedFanout: true,
        reason: 'redis_unavailable',
        redisErrorCode: redisErrorCodeOf(err),
        httpStatus: 503,
        message: 'Redis unavailable; event was not claimed. TradingView should retry.',
        signalData: baseData,
        signalUuid: canonicalId,
        timings
      };
    }
    if (err && (err.code === 'MISSING_EVENT_IDENTITY' || err.reason === 'missing_event_identity')) {
      logPipeline('Lifecycle', 'FAIL', {
        ...extractPipelineMeta(baseData),
        reason: `missing_event_identity; requestId=${baseData.pipelineRequestId || 'n/a'}`
      });
      return {
        mode: 'rejected',
        publishOnly: true,
        accepted: false,
        rejected: true,
        skippedFanout: true,
        reason: 'missing_event_identity',
        httpStatus: 409,
        message: 'Event identity could not be derived; refusing empty eventId allow-bypass.',
        signalData: baseData,
        signalUuid: canonicalId,
        timings
      };
    }
    throw err;
  }
  if (!claimedEvent) {
    const fanId = DurableDelivery.fanoutJobId(
      eventId,
      canonicalId,
      String(baseData.alertType || 'entry').toLowerCase()
    );
    let existingJob = null;
    try {
      existingJob = await DurableDelivery.getJob(fanId);
    } catch (err) {
      if (err && (err.code === 'REDIS_UNAVAILABLE' || err.reason === 'redis_unavailable')) {
        logPipeline('Lifecycle', 'FAIL', {
          ...extractPipelineMeta(baseData),
          signalUuid: canonicalId,
          eventId,
          reason: `redis_unavailable; duplicate recover; requestId=${baseData.pipelineRequestId || 'n/a'}`
        });
        return {
          mode: 'retry',
          publishOnly: true,
          accepted: false,
          rejected: true,
          skippedFanout: true,
          reason: 'redis_unavailable',
          redisErrorCode: redisErrorCodeOf(err),
          httpStatus: 503,
          message: 'Redis unavailable; event was not claimed. TradingView should retry.',
          signalData: baseData,
          signalUuid: canonicalId,
          timings
        };
      }
      throw err;
    }
    const existingSaved =
      (await findExistingByUuid(canonicalId, inMemorySignals)) ||
      (Array.isArray(inMemorySignals) &&
        inMemorySignals.find(
          s =>
            s &&
            (String(s.signalUuid || '') === String(canonicalId || '') ||
              String(s.canonicalTradeId || '') === String(canonicalId || '') ||
              String(s.eventId || '') === String(eventId || ''))
        )) ||
      null;

    if (isEntryAlert(baseData.alertType) && !existingSaved) {
      logPipeline('Lifecycle', 'PENDING', {
        ...extractPipelineMeta(baseData),
        eventId,
        reason: `claim_poison_unclaim; no Signal for claimed eventId; retry persist; requestId=${baseData.pipelineRequestId || 'n/a'}`
      });
      try {
        await TradeEventStore.releaseEventId(eventId);
      } catch (err) {
        console.warn('[Alerts] releaseEventId after claim-poison failed:', err.message);
      }
      claimedEvent = await TradeEventStore.claimEventId(eventId);
      if (!claimedEvent) {
        return {
          mode: 'retry',
          publishOnly: true,
          accepted: false,
          persisted: false,
          rejected: true,
          skippedFanout: true,
          reason: 'canonical_lock_busy',
          httpStatus: 503,
          message: 'Event claim busy after persist miss; TradingView should retry.',
          signalData: baseData,
          signalUuid: canonicalId,
          timings
        };
      }
    } else {
      if (!existingJob && existingSaved && DurableDelivery.hasPersistedSignalId(existingSaved)) {
        try {
          const created = await DurableDelivery.ensureFanoutWork({
            accepted: true,
            signalData: baseData,
            saved: existingSaved,
            signalUuid: canonicalId,
            requestId: baseData.pipelineRequestId
          });
          if (created) {
            logPipeline('DurableDelivery', 'PASS', {
              ...extractPipelineMeta(baseData),
              signalUuid: canonicalId,
              eventId,
              deliveryJobState: created.state,
              reason: `RECOVERED; duplicate_event_id missing fan-out job recreated from persisted Signal; state=${created.state}; requestId=${baseData.pipelineRequestId || 'n/a'}`
            });
          }
        } catch (err) {
          if (err && (err.code === 'REDIS_UNAVAILABLE' || err.reason === 'redis_unavailable')) {
            return {
              mode: 'retry',
              publishOnly: true,
              accepted: false,
              persisted: false,
              rejected: true,
              skippedFanout: true,
              reason: 'redis_unavailable',
              redisErrorCode: redisErrorCodeOf(err),
              httpStatus: 503,
              message: 'Redis unavailable; event was not claimed. TradingView should retry.',
              signalData: baseData,
              signalUuid: canonicalId,
              timings
            };
          }
          throw err;
        }
      }
      if (!existingSaved && isOutcomeAlert(baseData.alertType) && canonicalId) {
        await TradeEventStore.putOrphan(canonicalId, {
          alertType: baseData.alertType,
          eventTimestamp: baseData.eventTimestamp || 0,
          bridgeEventIndex: baseData.bridgeEventIndex || 0,
          requestId: baseData.pipelineRequestId || 'n/a',
          signalData: baseData
        });
        logPipeline('Lifecycle', 'ORPHANED', {
          ...extractPipelineMeta(baseData),
          eventId,
          reason: `duplicate_event_id orphan retry; no Signal; no synthetic fan-out; requestId=${baseData.pipelineRequestId || 'n/a'}`
        });
        return ackNoFanout('orphaned_outcome', baseData, timings, {
          mode: 'pending_outcome',
          pendingOutcome: true,
          persisted: false,
          skippedFanout: false,
          signalData: baseData,
          signalUuid: canonicalId
        });
      }
      logPipeline('Lifecycle', 'DUPLICATE', {
        ...extractPipelineMeta(baseData),
        signalUuid: canonicalId,
        eventId,
        canonicalTradeId: canonicalId,
        eventType,
        pineClientVersion: baseData.pineClientVersion,
        duplicateDecision: 'duplicate_event_id',
        barTime: baseData.barTime,
        reason: `duplicate_event_id; eventId=${eventId}; eventType=${eventType}; canonicalTradeId=${canonicalId || '-'}; requestId=${baseData.pipelineRequestId || 'n/a'}; pine=${baseData.pineClientVersion || '-'}`
      });
      return ackNoFanout('duplicate_event_id', baseData, timings, {
        duplicate: true,
        idempotent: true,
        persisted: Boolean(existingSaved && DurableDelivery.hasPersistedSignalId(existingSaved)),
        saved: existingSaved,
        signalData: baseData,
        signalUuid: canonicalId
      });
    }
  }
  if (canonicalId && eventType === 'TP3') {
    const slAlready = await TradeEventStore.hasLifecycleEvent(canonicalId, 'stop_loss');
    if (slAlready) {
      logPipeline('Lifecycle', 'DUPLICATE', {
        ...extractPipelineMeta(baseData),
        eventId,
        reason: `terminal_mutex_sl_already; eventId=${eventId || '-'}; canonicalTradeId=${canonicalId}; requestId=${baseData.pipelineRequestId || 'n/a'}`
      });
      return ackNoFanout('duplicate_lifecycle_event', baseData, timings, {
        duplicate: true,
        idempotent: true,
        signalData: baseData,
        signalUuid: canonicalId
      });
    }
  }
  if (canonicalId && eventType === 'SL') {
    const tp3Already = await TradeEventStore.hasLifecycleEvent(canonicalId, 'take_profit_3');
    if (tp3Already) {
      logPipeline('Lifecycle', 'DUPLICATE', {
        ...extractPipelineMeta(baseData),
        eventId,
        reason: `terminal_mutex_tp3_already; eventId=${eventId || '-'}; canonicalTradeId=${canonicalId}; requestId=${baseData.pipelineRequestId || 'n/a'}`
      });
      return ackNoFanout('duplicate_lifecycle_event', baseData, timings, {
        duplicate: true,
        idempotent: true,
        signalData: baseData,
        signalUuid: canonicalId
      });
    }
  }

  if (isEntryAlert(baseData.alertType) && canonicalId) {
    TradeEventDispatcher.noteEntryIntent(canonicalId);
  }

  const lifecycle = await TradeLifecycleService.processIncomingTradeAlert(
    baseData,
    inMemorySignals,
    { fromTradingViewWebhook: true, skipMarketData: true, ...options }
  );

  if (lifecycle.skipped) {
    const skipReason = mapOutcomeIgnoreReason(lifecycle.reason);
    logPipeline('Lifecycle', 'SKIP', {
      ...extractPipelineMeta(lifecycle.signalData || baseData),
      reason: `${skipReason}; requestId=${baseData.pipelineRequestId || 'n/a'}`
    });
    if (canonicalId) TradeEventDispatcher.resolveEntryIntent(canonicalId, lifecycle.updatedEntry);
    return ackNoFanout(skipReason, baseData, timings, {
      saved: lifecycle.updatedEntry,
      signalData: lifecycle.signalData,
      duplicate: true,
      idempotent: true
    });
  }

  if (lifecycle.rejected && lifecycle.reason === 'duplicate_webhook_replay') {
    const uuid =
      lifecycle.signalData?.signalUuid ||
      lifecycle.signalData?.signalId ||
      lifecycle.activeSignal?.signalUuid ||
      baseData.signalUuid ||
      baseData.signalId;
    const existing = await findExistingByUuid(uuid, inMemorySignals);
    timings.acceptedAt = Date.now();
    logPipeline('Accepted', 'PASS', {
      ...extractPipelineMeta(lifecycle.signalData || baseData),
      signalUuid: uuid,
      reason: `idempotent_replay; requestId=${baseData.pipelineRequestId || 'n/a'}`
    });
    if (canonicalId) TradeEventDispatcher.resolveEntryIntent(canonicalId, existing);
    return ackNoFanout('duplicate_webhook_replay', baseData, timings, {
      mode: 'idempotent',
      duplicate: true,
      idempotent: true,
      message: lifecycle.message,
      activeSignal: lifecycle.activeSignal,
      saved: existing || lifecycle.activeSignal || null,
      signalData: lifecycle.signalData || baseData,
      signalUuid: uuid
    });
  }

  if (lifecycle.rejected && lifecycle.reason === 'orphaned_outcome') {
    if (canonicalId) {
      await TradeEventStore.putOrphan(canonicalId, {
        alertType: baseData.alertType,
        eventTimestamp: baseData.eventTimestamp || 0,
        bridgeEventIndex: baseData.bridgeEventIndex || 0,
        requestId: baseData.pipelineRequestId || 'n/a',
        signalData: lifecycle.signalData || baseData
      });
    }
    logPipeline('Lifecycle', 'ORPHANED', {
      ...extractPipelineMeta(baseData),
      reason: `orphaned_outcome; requestId=${baseData.pipelineRequestId || 'n/a'}; identityHash=${hashIdentity(canonicalId)}`
    });
    return ackNoFanout('orphaned_outcome', baseData, timings, {
      mode: 'pending_outcome',
      pendingOutcome: true,
      persisted: false,
      skippedFanout: false,
      signalData: lifecycle.signalData || baseData,
      signalUuid: canonicalId
    });
  }

  if (
    lifecycle.rejected &&
    (lifecycle.reason === 'stale_entry' || lifecycle.reason === 'already_terminal')
  ) {
    logPipeline('Lifecycle', 'SKIP', {
      ...extractPipelineMeta(baseData),
      reason: `${lifecycle.reason}; requestId=${baseData.pipelineRequestId || 'n/a'}; identityHash=${hashIdentity(canonicalId)}`
    });
    if (canonicalId) TradeEventDispatcher.clearEntryIntent(canonicalId);
    return ackNoFanout(lifecycle.reason, baseData, timings, {
      mode: 'rejected',
      message: lifecycle.message,
      activeSignal: lifecycle.activeSignal,
      signalData: lifecycle.signalData || baseData,
      freshness: lifecycle.freshness
    });
  }

  if (lifecycle.rejected) {
    logPipeline('Lifecycle', 'FAIL', {
      ...extractPipelineMeta(baseData),
      reason: lifecycle.reason || 'lifecycle_rejected'
    });
    if (canonicalId) TradeEventDispatcher.clearEntryIntent(canonicalId);
    return {
      mode: 'rejected',
      publishOnly: true,
      rejected: true,
      accepted: false,
      reason: lifecycle.reason,
      httpStatus: rejectedWebhookHttpStatus(lifecycle.reason),
      activeSignal: lifecycle.activeSignal,
      message: lifecycle.message,
      timings
    };
  }

  const { signalData, updatedEntry } = lifecycle;
  if (baseData.pipelineRequestId && signalData && !signalData.pipelineRequestId) {
    signalData.pipelineRequestId = baseData.pipelineRequestId;
  }
  attachCorrelation(signalData, {
    requestId: signalData.pipelineRequestId || baseData.pipelineRequestId,
    eventId: signalData.eventId || baseData.eventId,
    canonicalTradeId: canonicalId
  });
  signalData.pipelineTimings = timings;
  if (isEntryAlert(signalData.alertType) && !signalData.entryAcceptedAt) {
    signalData.entryAcceptedAt = new Date();
  }

  logPipeline('Lifecycle', 'PASS', {
    ...extractPipelineMeta(signalData),
    reason: updatedEntry ? 'outcome_linked' : 'entry_accepted'
  });

  let persisted;
  try {
    persisted = await persistAcceptedSignal(
      updatedEntry
        ? {
            ...(updatedEntry.toObject ? updatedEntry.toObject() : updatedEntry),
            alertType: signalData.alertType,
            pipelineRequestId: signalData.pipelineRequestId || baseData.pipelineRequestId
          }
        : signalData,
      inMemorySignals,
      {
        fromTradingViewWebhook: true,
        skipMarketData: true,
        existingSaved: updatedEntry || undefined
      }
    );
  } catch (err) {
    if (canonicalId) TradeEventDispatcher.clearEntryIntent(canonicalId);
    try {
      const ActiveSignalRegistry = require('../utils/activeSignalRegistry');
      await ActiveSignalRegistry.clearActive(signalData || baseData, 'persist_failed');
    } catch (regErr) {
      console.warn('[Alerts] registry clear after persist fail:', regErr.message);
    }
    if (eventId) {
      try {
        await TradeEventStore.releaseEventId(eventId);
      } catch (releaseErr) {
        console.warn('[Alerts] releaseEventId after persist fail:', releaseErr.message);
      }
    }
    throw err;
  }
  timings.mongoCompletedAt = Date.now();

  if (persisted.orphaned) {
    if (canonicalId) {
      await TradeEventStore.putOrphan(canonicalId, {
        alertType: signalData.alertType || baseData.alertType,
        eventTimestamp: signalData.eventTimestamp || baseData.eventTimestamp || 0,
        bridgeEventIndex: signalData.bridgeEventIndex || baseData.bridgeEventIndex || 0,
        requestId: signalData.pipelineRequestId || baseData.pipelineRequestId || 'n/a',
        signalData
      });
    }
    logPipeline('Lifecycle', 'SKIP', {
      ...extractPipelineMeta(signalData),
      reason: `orphaned_outcome_no_persist; identityHash=${hashIdentity(canonicalId)}`
    });
    return ackNoFanout('orphaned_outcome', baseData, timings, {
      mode: 'pending_outcome',
      pendingOutcome: true,
      persisted: false,
      skippedFanout: false,
      signalData,
      signalUuid: canonicalId
    });
  }

  if (persisted.duplicate && !updatedEntry) {
    timings.acceptedAt = Date.now();
    const uuid =
      persisted.saved?.signalUuid ||
      persisted.saved?.signalId ||
      signalData.signalUuid ||
      signalData.signalId;
    logPipeline('Accepted', 'PASS', {
      ...extractPipelineMeta(signalData),
      signalUuid: uuid,
      reason: `idempotent_existing_signal; requestId=${signalData.pipelineRequestId || 'n/a'}`
    });
    if (canonicalId) TradeEventDispatcher.resolveEntryIntent(canonicalId, persisted.saved);
    return {
      mode: 'idempotent',
      publishOnly: true,
      accepted: true,
      duplicate: true,
      idempotent: true,
      skippedFanout: true,
      persisted: Boolean(persisted.saved && DurableDelivery.hasPersistedSignalId(persisted.saved)),
      saved: persisted.saved,
      signalData,
      updatedEntry: persisted.saved,
      signalUuid: uuid,
      broadcastSaved: false,
      outcomeLinked: Boolean(updatedEntry),
      timings
    };
  }

  timings.acceptedAt = Date.now();
  const uuid =
    persisted.saved?.signalUuid ||
    persisted.saved?.signalId ||
    signalData.signalUuid ||
    signalData.signalId ||
    signalData.signalGroupId;

  logPipeline('Accepted', 'PASS', {
    ...extractPipelineMeta(signalData),
    signalUuid: uuid,
    latencyMs:
      timings.webhookReceivedAt != null
        ? timings.acceptedAt - timings.webhookReceivedAt
        : timings.acceptedAt - timings.acceptStartedAt,
    reason: `durable_signal; id=${persisted.saved?._id || 'n/a'}; requestId=${signalData.pipelineRequestId || 'n/a'}`
  });

  if (canonicalId) TradeEventDispatcher.resolveEntryIntent(canonicalId, persisted.saved);

  let pendingOrphans = [];
  if (isEntryAlert(signalData.alertType) && canonicalId) {
    await TradeEventStore.markEntryReady(canonicalId);
    const claimed = await TradeEventStore.claimLifecycleEvent(canonicalId, 'entry');
    if (!claimed) {
      logPipeline('Lifecycle', 'DUPLICATE', {
        ...extractPipelineMeta(signalData),
        signalUuid: uuid,
        reason: `duplicate_lifecycle_event; requestId=${signalData.pipelineRequestId || 'n/a'}`
      });
      return ackNoFanout('duplicate_lifecycle_event', baseData, timings, {
        duplicate: true,
        idempotent: true,
        saved: persisted.saved,
        signalData,
        signalUuid: uuid
      });
    }
    pendingOrphans = await TradeEventStore.takeOrphans(canonicalId);
  } else if (canonicalId && signalData.alertType) {
    const claimed = await TradeEventStore.claimLifecycleEvent(canonicalId, signalData.alertType);
    if (!claimed) {
      logPipeline('Lifecycle', 'DUPLICATE', {
        ...extractPipelineMeta(signalData),
        signalUuid: uuid,
        reason: `duplicate_lifecycle_event; requestId=${signalData.pipelineRequestId || 'n/a'}`
      });
      return ackNoFanout('duplicate_lifecycle_event', baseData, timings, {
        duplicate: true,
        idempotent: true,
        saved: persisted.saved,
        signalData,
        signalUuid: uuid
      });
    }
  }

  const savedSnapshot = isEntryAlert(signalData.alertType)
    ? snapshotDoc(persisted.saved)
    : persisted.saved;
  const dataSnapshot = isEntryAlert(signalData.alertType) ? { ...signalData } : signalData;

  const acceptResult = {
    mode: 'broadcast',
    publishOnly: true,
    accepted: true,
    persisted: Boolean(savedSnapshot && DurableDelivery.hasPersistedSignalId(savedSnapshot)),
    duplicate: false,
    rejected: false,
    pendingOutcome: false,
    saved: savedSnapshot,
    signalData: dataSnapshot,
    updatedEntry: updatedEntry || null,
    broadcastSaved: persisted.broadcastSaved,
    outcomeLinked: Boolean(updatedEntry),
    signalUuid: uuid,
    pendingOrphans,
    timings
  };
  if (acceptResult.persisted) {
    await DurableDelivery.ensureFanoutWork(acceptResult);
  }
  try {
    emitTvAccept({
      ...dataSnapshot,
      requestId: dataSnapshot.pipelineRequestId,
      signalId: savedSnapshot?._id,
      fanoutJobId: DurableDelivery.fanoutJobId(
        dataSnapshot.eventId || uuid,
        canonicalId || uuid,
        dataSnapshot.alertType || 'entry'
      ),
      accepted: true,
      persisted: acceptResult.persisted,
      deferredFanout: Boolean(acceptResult.persisted),
      skippedFanout: false,
      state: 'pending',
      reason: 'accepted'
    });
  } catch {
    /* diagnostics */
  }
  return acceptResult;
}

async function markFanoutFailed(saved, error, meta = {}) {
  const reason = error?.message || 'async_fanout_failed';
  const id = saved?._id;
  const alreadySent = Boolean(saved?.telegramSent || saved?.emailSent || saved?.mt5Sent);
  const deliveryStatus = alreadySent ? 'partial' : 'failed';
  console.error(
    `[TV WEBHOOK ASYNC FAIL] requestId=${meta.requestId || saved?.pipelineRequestId || 'n/a'} ` +
      `signalUuid=${meta.signalUuid || saved?.signalUuid || 'n/a'} ` +
      `symbol=${meta.symbol || saved?.symbol || 'n/a'} reason=${reason}`
  );
  logPipeline('Broadcast', 'FAIL', {
    ...extractPipelineMeta(saved || meta),
    signalUuid: meta.signalUuid || saved?.signalUuid,
    reason: `${reason}; requestId=${meta.requestId || 'n/a'}`
  });
  if (!id) return;
  if (isDbConnected() && !String(id).startsWith('mem_')) {
    try {
      for (const op of mergeDeliveryStatusOps(deliveryStatus)) {
        await Signal.updateOne({ _id: id, ...op.filter }, { $set: op.set });
      }
    } catch (err) {
      console.warn('[Alerts] markFanoutFailed persist failed:', err.message);
    }
  } else if (saved && typeof saved === 'object') {
    saved.deliveryStatus = deliveryStatus;
  }
}

/**
 * Async downstream after a durable accept: Socket.IO, Telegram, Email, MT5.
 * Own try/catch — never an unhandled rejection.
 */
async function processAcceptedTradingViewSignal(
  io,
  acceptResult,
  inMemorySignals = [],
  options = {}
) {
  const signalData = acceptResult?.signalData;
  const saved = acceptResult?.saved;
  const meta = extractPipelineMeta(signalData || saved || {});
  const requestId =
    signalData?.pipelineRequestId || options.requestId || acceptResult?.requestId || 'n/a';
  const uuid = acceptResult?.signalUuid || meta.signalUuid;
  const timings = acceptResult?.timings || {};

  if (!acceptResult?.accepted || acceptResult.duplicate || acceptResult.skippedFanout) {
    return {
      skippedFanout: true,
      delivered: 0,
      signalUuid: uuid,
      mode: acceptResult?.mode || 'idempotent'
    };
  }

  if (!saved || !signalData) {
    const err = new Error('accepted_signal_missing_saved_document');
    await markFanoutFailed(saved, err, { ...meta, requestId, signalUuid: uuid });
    return { ok: false, asyncFailed: true, reason: err.message, signalUuid: uuid };
  }

  const deliveryAlertType = signalData.alertType || saved?.alertType || 'entry';
  const canonicalTradeId = resolveCanonicalTradeId(signalData) || uuid;
  const eventId = String(signalData.eventId || canonicalTradeId || '').trim();
  let claimedFanout;
  try {
    const acquired = await DurableDelivery.beginFanoutAttempt(eventId, deliveryAlertType, {
      canonicalTradeId,
      signalUuid: uuid
    });
    claimedFanout = acquired.status === 'acquired';
    if (acquired.status === 'provider_accepted') {
      await DurableDelivery.commitDeliveredBySpec(
        {
          eventId,
          canonicalTradeId,
          subscriberId: DurableDelivery.FANOUT_SUBSCRIBER,
          channel: DurableDelivery.FANOUT_CHANNEL,
          eventType: deliveryAlertType
        },
        { reason: 'provider_accepted_fanout' }
      );
      return { skippedFanout: true, reason: 'provider_accepted_commit', delivered: 0, signalUuid: uuid };
    }
    if (acquired.status === 'redis_unavailable' || acquired.status === 'not_found') {
      if (acquired.status === 'not_found') {
        await DurableDelivery.ensureFanoutWork(acceptResult);
        const retry = await DurableDelivery.beginFanoutAttempt(eventId, deliveryAlertType, {
          canonicalTradeId,
          signalUuid: uuid
        });
        claimedFanout = retry.status === 'acquired';
      }
    }
  } catch (err) {
    if (err && (err.code === 'REDIS_UNAVAILABLE' || err.reason === 'redis_unavailable')) {
      logPipeline('Broadcast', 'FAIL', {
        ...meta,
        signalUuid: uuid,
        reason: `redis_unavailable; Redis is authority — refusing process-local fan-out; requestId=${requestId}; redisErrorCode=${redisErrorCodeOf(err)}`
      });
      return { skippedFanout: true, reason: 'redis_unavailable', delivered: 0, signalUuid: uuid };
    }
    throw err;
  }
  if (!claimedFanout) {
    logPipeline('Broadcast', 'DUPLICATE', {
      ...meta,
      signalUuid: uuid,
      reason: `duplicate_fanout_claim; requestId=${requestId}`
    });
    return {
      skippedFanout: true,
      reason: 'duplicate_lifecycle_event',
      delivered: 0,
      signalUuid: uuid
    };
  }

  const fanoutSpec = {
    eventId,
    canonicalTradeId,
    subscriberId: DurableDelivery.FANOUT_SUBSCRIBER,
    channel: DurableDelivery.FANOUT_CHANNEL,
    eventType: deliveryAlertType
  };

  const freshness = evaluateEntryFreshness(signalData, {
    isDuplicate: Boolean(acceptResult.duplicate)
  });
  if (isEntryAlert(deliveryAlertType) && freshness.stale) {
    logPipeline('Broadcast', 'SKIP', {
      ...meta,
      signalUuid: uuid,
      reason: `stale_trade_before_delivery; requestId=${requestId}`
    });
    await DurableDelivery.commitFailedTerminalBySpec(fanoutSpec, {
      reason: 'stale_trade_before_delivery'
    });
    return {
      skippedFanout: true,
      reason: 'stale_trade_before_delivery',
      delivered: 0,
      signalUuid: uuid,
      durableState: 'failed_terminal'
    };
  }

  // Live Mongo may already be terminal (same-bar TP3). Do not skip this Entry
  // job — TradeEventDispatcher still owes subscribers BUY/SELL first.
  // Warn only; delivery uses the accept snapshot + webhook alertType.
  const latestSaved = await hydrateLatestSaved(saved, signalData, inMemorySignals);
  if (isEntryAlert(deliveryAlertType) && isTerminalEntry(latestSaved)) {
    console.warn(
      `[TV WEBHOOK ASYNC] requestId=${requestId} signalUuid=${uuid || 'n/a'} ` +
        `note=mongo_already_terminal_entry_job_still_runs stage=${latestSaved.lifecycleStage || latestSaved.tradeStatus || 'n/a'}`
    );
  }

  console.log(
    `[TV WEBHOOK ASYNC START] requestId=${requestId} signalUuid=${uuid || 'n/a'} ` +
      `symbol=${meta.symbol || 'n/a'} alertType=${deliveryAlertType}`
  );

  try {
    const delivery = await fanOutAcceptedSignal(
      io,
      saved,
      {
        ...plainSignal(saved),
        ...signalData,
        alertType: deliveryAlertType,
        pipelineRequestId: requestId
      },
      inMemorySignals,
      {
        ...options,
        timings,
        broadcastSaved: acceptResult.broadcastSaved,
        existingSaved: saved
      }
    );

    logSignalEvent('broadcast', {
      symbol: signalData.symbol,
      timeframe: signalData.timeframe,
      alertType: signalData.alertType,
      signalUuid: uuid,
      lifecycleStage: signalData.lifecycleStage,
      reason: `delivered=${delivery.delivered}`
    });

    logPipeline('Publish', 'PASS', {
      ...meta,
      signalUuid: uuid,
      reason: `async_fanout; delivered=${delivery.delivered ?? 0}; requestId=${requestId}`
    });

    console.log(
      `[TV WEBHOOK ASYNC COMPLETE] requestId=${requestId} signalUuid=${uuid || 'n/a'} ` +
        `delivered=${delivery.delivered ?? 0} skipped=${delivery.skippedByEntitlement || 0}`
    );
    console.log(
      `[TV Webhook] Published ${signalData.alertType} ${signalData.symbol} ` +
        `tf=${signalData.timeframe || '-'} uuid=${uuid || '-'} ` +
        `(publish-only, delivered=${delivery.delivered}, skipped=${delivery.skippedByEntitlement || 0}, no market-data fetch)`
    );

    await DurableDelivery.commitDeliveredBySpec(fanoutSpec, { reason: 'fanout_complete' });

    return {
      mode: 'broadcast',
      publishOnly: true,
      outcomeLinked: Boolean(acceptResult.outcomeLinked),
      signalUuid: uuid,
      ...delivery
    };
  } catch (error) {
    await markFanoutFailed(saved, error, { ...meta, requestId, signalUuid: uuid });
    await DurableDelivery.scheduleRetryBySpec(fanoutSpec, {
      reason: error.message || 'async_fanout_failed'
    });
    return {
      ok: false,
      asyncFailed: true,
      reason: error.message || 'async_fanout_failed',
      signalUuid: uuid,
      delivered: 0
    };
  }
}

async function runPendingOutcomeWaiter(io, acceptResult, inMemorySignals, options) {
  const signalData = acceptResult.signalData;
  const uuid = resolveCanonicalTradeId(signalData) || acceptResult.signalUuid;
  const meta = extractPipelineMeta(signalData || {});
  const requestId = signalData?.pipelineRequestId || 'n/a';

  const found = await TradeEventDispatcher.waitForEntry(uuid, async id => findExistingByUuid(id, inMemorySignals));
  if (!found) {
    const stillPending = await TradeEventStore.peekOrphans(uuid);
    if (stillPending.length) {
      logPipeline('Lifecycle', 'PENDING', {
        ...meta,
        signalUuid: uuid,
        reason: `orphaned_outcome_waiting_shared_store; requestId=${requestId}; identityHash=${hashIdentity(uuid)}; redisTtlSec=${TradeEventStore.getOrphanTtlSec()}`
      });
      // Redis HASH EXPIRE is the durable bound. Do not schedule a process-local
      // drop timer (TTL is hours; that would pin the event loop). ENTRY accept
      // drains via takeOrphans. Expired leftovers log when Redis key vanishes.
      return;
    }
    logPipeline('Lifecycle', 'SKIP', {
      ...meta,
      signalUuid: uuid,
      reason: `orphaned_outcome; requestId=${requestId}; identityHash=${hashIdentity(uuid)}`
    });
    return;
  }

  const linked = await TradeLifecycleService.processIncomingTradeAlert(signalData, inMemorySignals, {
    fromTradingViewWebhook: true,
    skipMarketData: true,
    ...options
  });
  if (linked.rejected || linked.skipped || !linked.updatedEntry) {
    logPipeline('Lifecycle', 'SKIP', {
      ...meta,
      signalUuid: uuid,
      reason: `${linked.reason || 'orphaned_outcome'}; requestId=${requestId}; identityHash=${hashIdentity(uuid)}`
    });
    return;
  }

  const acceptLinked = {
    ...acceptResult,
    accepted: true,
    duplicate: false,
    skippedFanout: false,
    pendingOutcome: false,
    saved: linked.updatedEntry,
    signalData: linked.signalData || signalData,
    updatedEntry: linked.updatedEntry,
    outcomeLinked: true,
    signalUuid: uuid
  };
  TradeEventDispatcher.enqueue(uuid, {
    kind: 'outcome',
    alertType: signalData.alertType,
    eventTimestamp: signalData.eventTimestamp || 0,
    bridgeEventIndex: signalData.bridgeEventIndex || 0,
    entryAlreadyDurable: true,
    run: () => processAcceptedTradingViewSignal(io, acceptLinked, inMemorySignals, options)
  });
}

function scheduleAcceptedTradingViewSignal(io, acceptResult, inMemorySignals = [], options = {}) {
  if (acceptResult?.pendingOutcome) {
    const uuid = resolveCanonicalTradeId(acceptResult.signalData) || acceptResult.signalUuid;
    TradeEventDispatcher.beginWaiter(uuid);
    setImmediate(() => {
      runPendingOutcomeWaiter(io, acceptResult, inMemorySignals, options)
        .catch(error => {
          console.error('[TV WEBHOOK PENDING OUTCOME]', error);
        })
        .finally(() => TradeEventDispatcher.endWaiter(uuid));
    });
    return;
  }

  if (!acceptResult?.accepted || acceptResult.duplicate || acceptResult.skippedFanout) {
    return;
  }

  const uuid =
    resolveCanonicalTradeId(acceptResult.signalData || acceptResult.saved) || acceptResult.signalUuid;
  const alertType = acceptResult.signalData?.alertType || 'entry';
  const orderedStage = isEntryAlert(alertType) ? 'EntryOrdered' : 'OutcomeOrdered';
  logPipeline(orderedStage, 'PASS', {
    ...extractPipelineMeta(acceptResult.signalData || acceptResult.saved || {}),
    signalUuid: uuid,
    reason: `queued; alertType=${alertType}; requestId=${acceptResult.signalData?.pipelineRequestId || 'n/a'}`
  });
  TradeEventDispatcher.enqueue(uuid, {
    kind: isEntryAlert(alertType) ? 'entry' : 'outcome',
    alertType,
    eventTimestamp: acceptResult.signalData?.eventTimestamp || 0,
    bridgeEventIndex: acceptResult.signalData?.bridgeEventIndex || 0,
    entryAlreadyDurable: Boolean(acceptResult.outcomeLinked && !isEntryAlert(alertType)),
    run: () =>
      processAcceptedTradingViewSignal(io, acceptResult, inMemorySignals, options).catch(error => {
        const meta = extractPipelineMeta(acceptResult.signalData || acceptResult.saved || {});
        console.error(
          `[TV WEBHOOK ASYNC UNHANDLED] requestId=${acceptResult.signalData?.pipelineRequestId || 'n/a'} ` +
            `signalUuid=${acceptResult.signalUuid || 'n/a'}`,
          error
        );
        logPipeline('Broadcast', 'FAIL', {
          ...meta,
          signalUuid: acceptResult.signalUuid,
          reason: `unhandled:${error.message || 'async_fanout_failed'}`
        });
      })
  });

  const orphans = Array.isArray(acceptResult.pendingOrphans) ? acceptResult.pendingOrphans : [];
  for (const orphan of orphans) {
    const orphanData = orphan.signalData || orphan;
    const orphanType = orphanData.alertType || orphan.alertType;
    logPipeline('OutcomeOrdered', 'PASS', {
      ...extractPipelineMeta(orphanData),
      signalUuid: uuid,
      reason: `drained_orphan; alertType=${orphanType}; requestId=${orphan.requestId || 'n/a'}`
    });
    TradeEventDispatcher.enqueue(uuid, {
      kind: 'outcome',
      alertType: orphanType,
      eventTimestamp: orphan.eventTimestamp || orphanData.eventTimestamp || 0,
      bridgeEventIndex: orphan.bridgeEventIndex || orphanData.bridgeEventIndex || 0,
      entryAlreadyDurable: true,
      run: async () => {
        const linked = await TradeLifecycleService.processIncomingTradeAlert(
          orphanData,
          inMemorySignals,
          { fromTradingViewWebhook: true, skipMarketData: true, ...options }
        );
        if (linked.rejected || linked.skipped || !linked.updatedEntry) {
          logPipeline('Lifecycle', 'SKIP', {
            ...extractPipelineMeta(orphanData),
            signalUuid: uuid,
            reason: `${linked.reason || 'orphaned_outcome'}; drained_orphan`
          });
          return;
        }
        const acceptLinked = {
          accepted: true,
          duplicate: false,
          skippedFanout: false,
          saved: linked.updatedEntry,
          signalData: linked.signalData || orphanData,
          updatedEntry: linked.updatedEntry,
          outcomeLinked: true,
          signalUuid: uuid,
          timings: acceptResult.timings || {}
        };
        return processAcceptedTradingViewSignal(io, acceptLinked, inMemorySignals, options);
      }
    });
  }
}

/**
 * TradingView webhook / inject path — validate, enrich, persist, then (sync) publish.
 * Delivery (Socket.IO / email / Telegram / MT5) is owned by TradeDeliveryService.
 * HTTP uses acceptTradingViewWebhook + scheduleAcceptedTradingViewSignal instead.
 */
async function processTradingViewWebhook(io, rawBody, inMemorySignals = []) {
  const accept = await acceptTradingViewWebhook(io, rawBody, inMemorySignals);
  if (accept.rejected) {
    return {
      mode: 'rejected',
      publishOnly: true,
      rejected: true,
      reason: accept.reason,
      activeSignal: accept.activeSignal,
      message: accept.message
    };
  }
  if (accept.duplicate || accept.skippedFanout) {
    return {
      mode: 'idempotent',
      publishOnly: true,
      accepted: true,
      duplicate: true,
      signalUuid: accept.signalUuid,
      delivered: 0,
      skippedByEntitlement: 0,
      subscribers: []
    };
  }
  if (accept.pendingOutcome) {
    scheduleAcceptedTradingViewSignal(io, accept, inMemorySignals);
    await TradeEventDispatcher.waitForIdle(accept.signalUuid);
    return {
      mode: 'pending_outcome',
      publishOnly: true,
      accepted: true,
      signalUuid: accept.signalUuid,
      delivered: 0,
      skippedByEntitlement: 0,
      subscribers: []
    };
  }
  const delivery = await processAcceptedTradingViewSignal(io, accept, inMemorySignals);
  return {
    mode: 'broadcast',
    publishOnly: true,
    outcomeLinked: Boolean(accept.outcomeLinked),
    signalUuid: accept.signalUuid,
    ...delivery
  };
}

async function publishTradingViewAlert(io, rawBody, inMemorySignals = []) {
  return processTradingViewWebhook(io, rawBody, inMemorySignals);
}

/** @deprecated Prefer processTradingViewWebhook / publishTradingViewAlert (publish-only). */
async function processIncomingWebhook(io, rawBody, inMemorySignals = []) {
  return processTradingViewWebhook(io, rawBody, inMemorySignals);
}

async function processDurableJob(job, { io, inMemorySignals, waitMode } = {}) {
  const recoveryWait = waitMode || 'check_once';
  if (!job) return { skipped: true, reason: 'missing_job' };
  if (job.channel === DurableDelivery.FANOUT_CHANNEL) {
    let acceptResult = job.payload?.acceptResult;
    if (!acceptResult) {
      const recovered = await DurableDelivery.rehydrateJobContext(job);
      if (recovered.ok) {
        acceptResult = recovered.acceptResult;
      } else if (recovered.retryable) {
        await DurableDelivery.scheduleRetry(job.jobId, { reason: recovered.reason || 'missing_fanout_payload' });
        return { ok: false, reason: recovered.reason || 'missing_fanout_payload' };
      } else {
        await DurableDelivery.commitFailedTerminal(job.jobId, {
          reason: 'delivery_context_unrecoverable'
        });
        return { ok: false, reason: 'delivery_context_unrecoverable' };
      }
    }
    return processAcceptedTradingViewSignal(
      io,
      overlayFanoutAcceptResult(acceptResult, job),
      inMemorySignals || [],
      {
        waitMode: recoveryWait
      }
    );
  }
  return TradeDeliveryService.deliverDurableJob(io, job, { waitMode: recoveryWait });
}

DurableDelivery.registerProcessHandler(async (job, ctx) => processDurableJob(job, ctx));

module.exports = {
  ALERT_TYPES,
  normalizeAlertType,
  normalizeTradingViewUsername,
  parseWebhookBody,
  formatLiveAlertMessage,
  toLiveAlertPayload,
  findActiveSubscribers,
  subscriberAllowsSignal,
  saveSignal,
  deliverLiveAlert,
  persistAcceptedSignal,
  fanOutAcceptedSignal,
  broadcastToSubscribers,
  acceptTradingViewWebhook,
  processAcceptedTradingViewSignal,
  processDurableJob,
  scheduleAcceptedTradingViewSignal,
  rejectedWebhookHttpStatus,
  setTestFanoutHooks,
  resetTestFanoutHooks,
  getFanoutConcurrency,
  processIncomingWebhook,
  processTradingViewWebhook,
  publishTradingViewAlert,
  buildSignalData,
  isForbiddenResetPayload,
  KACHING_ALERT_NAMES,
  findExistingByUuid,
  capInMemorySignals,
  MAX_IN_MEMORY_SIGNALS
};
