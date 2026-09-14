const mongoose = require('mongoose');
const Signal = require('../models/Signal');
const {
  sanitizeSignalForTier,
  userHasTierFeature,
  getEffectiveSubscription
} = require('../utils/subscriptionAccess');
const { isEntryAlert } = require('../utils/signalOutcome');
const mailer = require('../utils/mailer');
const TelegramService = require('./TelegramService');
const SubscriberSignalFormatter = require('./SubscriberSignalFormatter');
const Mt5TradeCopierService = require('./Mt5TradeCopierService');
const { logPipeline, extractPipelineMeta } = require('../utils/pipelineLog');
const { logDeliveryTimeline } = require('../utils/deliveryTimeline');
const {
  resolveConfirmSeconds,
  computeConfirmExpiresAt,
  isConfirmExpired,
  formatConfirmWindowLabel
} = require('../utils/mt5ManualConfirm');
const {
  resolveTelegramMode,
  isAlertsOnlyTelegram,
  TELEGRAM_MODES
} = require('../utils/telegramMode');
const {
  claimDelivery,
  commitDeliverySuccess,
  recordDeliveryFailure,
  specFrom
} = require('../utils/deliveryIdempotency');
const DurableDelivery = require('../utils/durableDelivery');
const DeliverySequencer = require('../utils/deliverySequencer');
const { overlayJobIdentityOnSignal } = require('../utils/deliveryJobSignalOverlay');
const {
  evaluateActionableEntryDelivery,
  mergeLiveLifecycleForEntryDelivery,
  isEntrySequenceSkipReason
} = require('../utils/entryDeliveryGuard');
const {
  resolveDeliveryStatus,
  resolveSignalDeliverySummary,
  mergeSignalDeliveryStatus,
  mergeDeliveryStatusOps
} = require('../utils/deliveryOutcomes');
const { attachCorrelation, compactCorrelation, mergeCorrelation, buildDurableRefs } = require('../utils/signalCorrelation');

function isDbConnected() {
  return mongoose.connection.readyState === 1;
}

/** MT5 outcomes that are not delivery failures when Telegram-only is valid. */
const MT5_EXPECTED_SKIP_REASONS = new Set([
  'mt5_not_linked',
  'mt5_disabled',
  'manual_mode',
  'subscription_required',
  'not_entry_signal',
  'self_test_skip',
  'missing_ids',
  'already_queued',
  'duplicate_milestone',
  'stale_trade_before_delivery',
  'terminal_before_entry_delivery',
  'stale_entry_delivery_age',
  'delivery_sequence_wait',
  'redis_unavailable'
]);

/** Telegram eligibility skips — not Bot API / network failures. */
const TELEGRAM_EXPECTED_SKIP_REASONS = new Set([
  'missing_chat_id',
  'insufficient_tier',
  'telegram_disabled',
  'self_test_skip',
  'stale_entry',
  'duplicate_milestone',
  'stale_trade_before_delivery',
  'terminal_before_entry_delivery',
  'stale_entry_delivery_age',
  'bot_not_configured',
  'delivery_sequence_wait',
  'redis_unavailable'
]);

/** Email skips that must not mark the pipeline as DeliveryEmail FAIL (auth mailer stays independent). */
const EMAIL_EXPECTED_SKIP_REASONS = new Set([
  'stale_entry',
  'duplicate_milestone',
  'stale_trade_before_delivery',
  'terminal_before_entry_delivery',
  'stale_entry_delivery_age',
  'trade_alerts_disabled',
  'opt_out',
  'insufficient_tier',
  'no_email',
  'quota_circuit_open',
  'self_test_skip',
  'delivery_sequence_wait',
  'redis_unavailable'
]);

function isExpectedMt5Skip(reason) {
  return MT5_EXPECTED_SKIP_REASONS.has(String(reason || ''));
}

function isExpectedTelegramSkip(reason, status) {
  if (TELEGRAM_EXPECTED_SKIP_REASONS.has(String(reason || ''))) return true;
  const s = String(status || '');
  return (
    s === TelegramService.TELEGRAM_STATUS.SKIPPED_NO_CHAT_ID ||
    s === TelegramService.TELEGRAM_STATUS.SKIPPED_TIER ||
    s === TelegramService.TELEGRAM_STATUS.SKIPPED_DISABLED ||
    s === TelegramService.TELEGRAM_STATUS.SKIPPED_SELF_TEST ||
    s === TelegramService.TELEGRAM_STATUS.SKIPPED_STALE ||
    s === TelegramService.TELEGRAM_STATUS.SKIPPED_NOT_CONFIGURED
  );
}

/**
 * Resolve Mongo deliveryStatus from independent channel outcomes.
 * See utils/deliveryOutcomes.js — skip+skip is skipped, never delivered.
 */

async function loadSignalById(signalId) {
  if (!signalId) return null;
  if (isDbConnected()) {
    try {
      return Signal.findById(signalId);
    } catch {
      return null;
    }
  }
  return null;
}

function logEntryDeliveryGuard(channel, subscriber, signal, guard) {
  if (!guard || (!guard.skip && guard.reason !== 'live_overlap_entry_owed')) return;
  const sid = subscriber?.id || subscriber?.email || 'broadcast';
  console.log(
    `[ENTRY_DELIVERY_GUARD] skip=${Boolean(guard.skip)} reason=${guard.reason || 'none'} ` +
      `channel=${channel} subscriberId=${sid} ` +
      `canonicalTradeId=${signal?.canonicalTradeId || '-'} eventId=${signal?.eventId || '-'} ` +
      `eventType=${signal?.eventType || signal?.alertType || '-'} ` +
      `signalUuid=${signal?.signalUuid || signal?.signalId || '-'} ` +
      `entryAcceptedAt=${signal?.entryAcceptedAt || '-'} ` +
      `lifecycleStage=${signal?.lifecycleStage || '-'} tradeStatus=${signal?.tradeStatus || '-'} ` +
      `outcome=${signal?.outcome || '-'}`
  );
}

/**
 * Delivery-time rehydrate: never trust an OPEN ENTRY snapshot once Mongo
 * has advanced the lifecycle. No-op without a live document (tests / mem ids).
 */
async function hydrateLiveEntryForDelivery(signalDoc) {
  if (!signalDoc) return signalDoc;
  const plain = signalDoc.toObject ? signalDoc.toObject() : signalDoc;
  if (!isEntryAlert(plain.alertType || 'entry')) return signalDoc;
  const liveId = plain._id || plain.id;
  if (!liveId) return signalDoc;
  const live = await loadSignalById(liveId);
  if (!live) return signalDoc;
  return mergeLiveLifecycleForEntryDelivery(plain, live);
}

/**
 * Mark a Pro Manual confirmation as Expired — never queues MT5.
 */
async function markManualConfirmExpired(signalDoc, reason = 'mt5_confirm_expired') {
  if (!signalDoc) return null;
  const id = signalDoc._id || signalDoc.id;
  const patch = {
    executionStatus: 'expired',
    mt5ConfirmStatus: 'expired',
    closedReason: reason,
    tradeStatus: 'expired',
    outcome: 'expired',
    closedAt: new Date()
  };

  if (isDbConnected() && id && !String(id).startsWith('mem_')) {
    return Signal.findByIdAndUpdate(id, patch, { new: true });
  }

  Object.assign(signalDoc, patch);
  return signalDoc;
}

/**
 * Mark Ignore Trade — discard, no MT5 queue.
 */
async function markManualConfirmIgnored(signalDoc) {
  if (!signalDoc) return null;
  const id = signalDoc._id || signalDoc.id;
  const patch = {
    executionStatus: 'ignored',
    mt5ConfirmStatus: 'ignored',
    closedReason: 'mt5_confirm_ignored',
    tradeStatus: 'cancelled',
    outcome: 'cancelled',
    closedAt: new Date()
  };

  if (isDbConnected() && id && !String(id).startsWith('mem_')) {
    return Signal.findByIdAndUpdate(id, patch, { new: true });
  }

  Object.assign(signalDoc, patch);
  return signalDoc;
}

/**
 * Sweeper: pending Pro confirmations past mt5ConfirmExpiresAt → Expired (no queue).
 */
async function expirePendingManualConfirmations({ limit = 50 } = {}) {
  if (!isDbConnected()) return { expired: 0 };
  const now = new Date();
  const due = await Signal.find({
    mt5ConfirmStatus: 'pending',
    mt5Sent: { $ne: true },
    mt5ConfirmExpiresAt: { $lte: now },
    executionStatus: { $in: ['pending', 'skipped'] }
  })
    .limit(limit)
    .lean();

  let expired = 0;
  for (const row of due) {
    await markManualConfirmExpired(row);
    expired += 1;
  }
  return { expired };
}

function formatLiveAlertMessage(signal) {
  const formatted = SubscriberSignalFormatter.formatDashboard(signal);
  if (formatted?.ok && formatted.dashboardText) return formatted.dashboardText;
  if (formatted?.stale) return '';
  return formatted?.fallbackText || SubscriberSignalFormatter.FORMATTING_FALLBACK;
}

function toLiveAlertPayload(signalDoc) {
  const signal = signalDoc.toObject ? signalDoc.toObject() : signalDoc;
  const presentation = SubscriberSignalFormatter.formatDashboard(signal);
  const safeNotes = SubscriberSignalFormatter.sanitizeSubscriberNotes(signal.notes);
  const dashboardMessage =
    presentation?.ok && presentation.dashboardText ? presentation.dashboardText : null;
  return {
    id: signal._id,
    _id: signal._id,
    alertType: signal.alertType || 'signal',
    symbol: signal.symbol,
    direction: signal.direction,
    entry: signal.entry,
    stop_loss: signal.stop_loss,
    stop_loss_1: signal.stop_loss_1 ?? signal.stop_loss,
    take_profit_1: signal.take_profit_1,
    take_profit_2: signal.take_profit_2,
    take_profit_3: signal.take_profit_3,
    confidence: signal.confidence,
    notes: safeNotes,
    tradeExplanation: signal.tradeExplanation,
    aiFactors: signal.aiFactors,
    riskMetrics: signal.riskMetrics,
    outcome: signal.outcome,
    tradeStatus: signal.tradeStatus,
    outcomeR: signal.outcomeR,
    signalSource: signal.signalSource || signal.source || 'tradingview',
    strategyName: signal.strategyName || signal.strategy || signal.patternLabel || null,
    timeframe: signal.timeframe || null,
    deliveryStatus: signal.deliveryStatus || 'pending',
    executionStatus: signal.executionStatus || 'pending',
    telegramSent: Boolean(signal.telegramSent),
    mt5Sent: Boolean(signal.mt5Sent),
    emailSent: Boolean(signal.emailSent),
    executionChannel: signal.executionChannel || 'none',
    telegramAlertSent: Boolean(signal.telegramAlertSent),
    telegramAlertDelivered: Boolean(signal.telegramAlertDelivered),
    telegramAlertRead: Boolean(signal.telegramAlertRead),
    userId: signal.userId,
    createdAt: signal.createdAt,
    pattern: signal.pattern || null,
    patternLabel: signal.patternLabel || signal.pattern_label || null,
    gapTop: signal.gapTop,
    gapBottom: signal.gapBottom,
    chartZones: signal.chartZones,
    orderBlockTop: signal.orderBlockTop,
    orderBlockBottom: signal.orderBlockBottom,
    orderBlockTimeStart: signal.orderBlockTimeStart,
    orderBlockTimeEnd: signal.orderBlockTimeEnd,
    liquidityZoneTop: signal.liquidityZoneTop,
    liquidityZoneBottom: signal.liquidityZoneBottom,
    liquidityTimeStart: signal.liquidityTimeStart,
    liquidityTimeEnd: signal.liquidityTimeEnd,
    newsImpact: signal.newsImpact,
    newsFilter: signal.newsFilter,
    tradeManagement: signal.tradeManagement,
    partialClose: signal.partialClose,
    breakEven: signal.breakEven,
    message:
      presentation?.ok && !SubscriberSignalFormatter.looksLikeRawPayload(dashboardMessage)
        ? dashboardMessage
        : presentation?.stale
          ? null
          : SubscriberSignalFormatter.FORMATTING_FALLBACK,
    presentation:
      presentation?.ok
        ? {
            kind: presentation.kind,
            subject: presentation.subject,
            text: presentation.dashboardText
          }
        : undefined
  };
}

function persistMergedDeliveryStatus(signalId, status) {
  if (!status) return;
  for (const op of mergeDeliveryStatusOps(status)) {
    Signal.updateOne({ _id: signalId, ...op.filter }, { $set: op.set }).catch(err =>
      console.warn('[TradeDelivery] deliveryStatus merge failed:', err.message)
    );
  }
}

async function persistDeliveryFlags(signalId, flags) {
  if (!isDbConnected() || !signalId || String(signalId).startsWith('mem_')) return;
  const $set = { ...flags };
  // Sticky success flags — concurrent fan-out must never overwrite true with false.
  for (const key of [
    'telegramSent',
    'telegramAttempted',
    'mt5Sent',
    'emailSent',
    'telegramAlertSent',
    'telegramAlertDelivered'
  ]) {
    if ($set[key] === false) delete $set[key];
  }
  const status = $set.deliveryStatus;
  delete $set.deliveryStatus;
  $set.deliveryAccounting = flags.deliveryAccounting || 'per_recipient';
  if (Object.keys($set).length > 0) {
    Signal.findByIdAndUpdate(signalId, { $set }).catch(err =>
      console.warn('[TradeDelivery] delivery status update failed:', err.message)
    );
  }
  persistMergedDeliveryStatus(signalId, status);
}

/** Bounded post-slot socket finalization — never grows with subscriber count. */
const POST_SLOT_TIMING_CAP = 32;
const postSlotTimings = [];
const postSlotQueue = [];
let postSlotWorkers = 0;
let postSlotPeak = 0;
let postSlotIdlePromise = null;
let postSlotIdleResolve = null;
let testBeforeSocket = null;

function getPostSlotSocketWorkers() {
  return Math.max(1, Math.min(16, Number(process.env.TV_POST_SLOT_SOCKET_INFLIGHT || 8)));
}

function getPostSlotSocketQueueCap() {
  return Math.max(0, Math.min(64, Number(process.env.TV_POST_SLOT_SOCKET_QUEUE || 64)));
}

function recordSlotTiming(row) {
  postSlotTimings.push({ ...row, at: Date.now() });
  if (postSlotTimings.length > POST_SLOT_TIMING_CAP) postSlotTimings.shift();
}

function notifyPostSlotIdle() {
  if (postSlotWorkers !== 0 || postSlotQueue.length !== 0) return;
  if (!postSlotIdleResolve) return;
  const resolve = postSlotIdleResolve;
  postSlotIdlePromise = null;
  postSlotIdleResolve = null;
  resolve();
}

function waitForPostSlotSocketIdle() {
  if (postSlotWorkers === 0 && postSlotQueue.length === 0) return Promise.resolve();
  if (!postSlotIdlePromise) {
    postSlotIdlePromise = new Promise(resolve => {
      postSlotIdleResolve = resolve;
    });
  }
  return postSlotIdlePromise;
}

function pumpPostSlotSocket() {
  const maxWorkers = getPostSlotSocketWorkers();
  while (postSlotWorkers < maxWorkers && postSlotQueue.length > 0) {
    const task = postSlotQueue.shift();
    postSlotWorkers += 1;
    if (postSlotWorkers + postSlotQueue.length > postSlotPeak) {
      postSlotPeak = postSlotWorkers + postSlotQueue.length;
    }
    setImmediate(() => {
      Promise.resolve()
        .then(task)
        .catch(err => {
          console.warn('[TradeDelivery] post-slot socket failed:', err?.message || err);
        })
        .finally(() => {
          postSlotWorkers -= 1;
          pumpPostSlotSocket();
          notifyPostSlotIdle();
        });
    });
  }
  notifyPostSlotIdle();
}

function enqueuePostSlotSocket(task) {
  const maxWorkers = getPostSlotSocketWorkers();
  const maxQueue = getPostSlotSocketQueueCap();
  if (postSlotWorkers + postSlotQueue.length >= maxWorkers + maxQueue) {
    return false;
  }
  postSlotQueue.push(task);
  pumpPostSlotSocket();
  return true;
}

function setTestBeforeSocket(fn) {
  testBeforeSocket = typeof fn === 'function' ? fn : null;
}

function resetPostSlotSocketForTests() {
  postSlotQueue.length = 0;
  postSlotWorkers = 0;
  postSlotPeak = 0;
  postSlotTimings.length = 0;
  testBeforeSocket = null;
  if (trackDetachedProvider._pending) trackDetachedProvider._pending.clear();
  notifyPostSlotIdle();
}

function getPostSlotSocketStatsForTests() {
  return {
    workers: postSlotWorkers,
    queued: postSlotQueue.length,
    peak: postSlotPeak,
    timings: postSlotTimings.slice(),
    maxWorkers: getPostSlotSocketWorkers(),
    maxQueue: getPostSlotSocketQueueCap()
  };
}

function isRedisUnavailableErr(err) {
  if (!err) return false;
  return (
    err.code === 'REDIS_UNAVAILABLE' ||
    err.reason === 'redis_unavailable' ||
    /redis unavailable/i.test(String(err.message || ''))
  );
}

async function ensureSocketJobOwned(signalDoc, subscriber) {
  const eventType = signalDoc?.alertType || 'entry';
  const spec = specFrom(signalDoc, eventType, 'socket', subscriber?.id || 'broadcast');
  await DurableDelivery.ensureJob({
    ...spec,
    payload: {
      subscriber: DurableDelivery.snapshotSubscriber(subscriber),
      signal: DurableDelivery.snapshotSignal(signalDoc)
    },
    correlation: compactCorrelation(
      mergeCorrelation(signalDoc, { subscriberId: subscriber?.id, channel: 'socket' })
    ),
    refs: buildDurableRefs({
      ...spec,
      signalDoc
    })
  });
}

function channelDeliveryKey(subscriberId, channel) {
  return `${String(subscriberId || 'broadcast').replace(/\./g, '_')}:${String(channel || 'unknown')}`;
}

async function persistChannelDelivery(signalId, subscriberId, channel, outcome = {}) {
  if (!signalId || String(signalId).startsWith('mem_')) return;
  const key = channelDeliveryKey(subscriberId, channel);
  const row = {
    subscriberId: subscriberId || 'broadcast',
    channel,
    state: outcome.state || 'pending',
    outcomeStatus: outcome.outcomeStatus || outcome.state || 'pending',
    reason: outcome.reason || null,
    attemptCount: outcome.attemptCount != null ? outcome.attemptCount : 1,
    at: new Date().toISOString()
  };
  if (!isDbConnected()) return;
  Signal.findByIdAndUpdate(signalId, { $set: { [`channelDeliveries.${key}`]: row } }).catch(() => {});
}

const MT5_NOT_ELIGIBLE_REASONS = new Set([
  'mt5_not_linked',
  'mt5_disabled',
  'manual_mode',
  'subscription_required',
  'missing_ids'
]);

const EMAIL_NOT_ELIGIBLE_REASONS = new Set([
  'no_email',
  'insufficient_tier',
  'opt_out',
  'trade_alerts_disabled'
]);

async function recordSkipOutcome(signalDoc, subscriber, channel, reason, { notEligible } = {}) {
  const autoEligible =
    notEligible != null
      ? Boolean(notEligible)
      : channel === 'mt5'
        ? MT5_NOT_ELIGIBLE_REASONS.has(String(reason))
        : channel === 'email'
          ? EMAIL_NOT_ELIGIBLE_REASONS.has(String(reason))
          : false;
  const eventType = signalDoc?.alertType || 'entry';
  try {
    await DurableDelivery.recordChannelSkip(
      specFrom(signalDoc, eventType, channel, subscriber?.id),
      { reason: reason || 'skipped', notEligible: autoEligible }
    );
  } catch {
    /* diagnostics */
  }
  void persistChannelDelivery(signalDoc?._id, subscriber?.id, channel, {
    state: autoEligible ? 'not_eligible' : 'skipped',
    outcomeStatus: autoEligible ? 'not_eligible' : 'skipped',
    reason: reason || 'skipped'
  });
}

/**
 * Evaluate Telegram trade-alert eligibility (independent of MT5).
 * Returns a structured status used by diagnostics and deliverTelegram.
 */
function evaluateTelegramEligibility(subscriber, signalDoc = {}) {
  const signal = signalDoc?.toObject ? signalDoc.toObject() : signalDoc || {};
  const telegram = subscriber?.telegram || {};
  const chatIdPresent = Boolean(telegram?.chatId);
  const telegramEnabled = telegram?.enabled !== false;
  const tier = getEffectiveSubscription(subscriber)?.tier || 'basic';

  if (signal?.selfTest || process.env.PIPELINE_SELF_TEST_ACTIVE === 'true') {
    return {
      eligible: false,
      status: TelegramService.TELEGRAM_STATUS.SKIPPED_SELF_TEST,
      reason: 'self_test_skip',
      tier,
      telegramEnabled,
      chatIdPresent
    };
  }
  if (!subscriber || !userHasTierFeature(subscriber, 'telegramAlerts')) {
    return {
      eligible: false,
      status: TelegramService.TELEGRAM_STATUS.SKIPPED_TIER,
      reason: 'insufficient_tier',
      tier,
      telegramEnabled,
      chatIdPresent
    };
  }
  if (!telegram.chatId) {
    return {
      eligible: false,
      status: TelegramService.TELEGRAM_STATUS.SKIPPED_NO_CHAT_ID,
      reason: 'missing_chat_id',
      tier,
      telegramEnabled,
      chatIdPresent: false
    };
  }
  if (telegram.enabled === false) {
    return {
      eligible: false,
      status: TelegramService.TELEGRAM_STATUS.SKIPPED_DISABLED,
      reason: 'telegram_disabled',
      tier,
      telegramEnabled: false,
      chatIdPresent: true
    };
  }
  const entryGuard = evaluateActionableEntryDelivery(signal);
  if (entryGuard.skip) {
    return {
      eligible: false,
      status: TelegramService.TELEGRAM_STATUS.SKIPPED_STALE,
      reason: entryGuard.reason,
      tier,
      telegramEnabled,
      chatIdPresent
    };
  }
  return {
    eligible: true,
    status: TelegramService.TELEGRAM_STATUS.SEND_STARTED,
    reason: null,
    tier,
    telegramEnabled: true,
    chatIdPresent: true
  };
}

async function deliverInApp(io, signalDoc, subscriber, options = {}) {
  const hydrated = await hydrateLiveEntryForDelivery(signalDoc);
  const eventType = hydrated?.alertType || signalDoc?.alertType || 'entry';
  const entryGuard = evaluateActionableEntryDelivery(
    hydrated?.toObject ? hydrated.toObject() : hydrated || {}
  );
  logEntryDeliveryGuard('socket', subscriber, hydrated, entryGuard);
  if (entryGuard.skip) {
    const signalPlain = hydrated?.toObject ? hydrated.toObject() : hydrated || {};
    if (isEntrySequenceSkipReason(entryGuard.reason) && signalPlain.entryAcceptedAt) {
      return DeliverySequencer.withChannelSequence({
        signalDoc: hydrated,
        subscriberId: subscriber?.id || 'broadcast',
        channel: 'socket',
        alertType: eventType,
        waitMode: options.waitMode,
        send: async () => {
          await DurableDelivery.recordChannelSkip(
            specFrom(hydrated, eventType, 'socket', subscriber?.id || 'broadcast'),
            { reason: entryGuard.reason, notEligible: false }
          );
          return {
            ok: false,
            skipped: true,
            reason: entryGuard.reason,
            commitAcceptedEntrySkip: true
          };
        }
      });
    }
    return { ok: false, skipped: true, reason: entryGuard.reason };
  }
  return DeliverySequencer.withChannelSequence({
    signalDoc: hydrated,
    subscriberId: subscriber?.id || 'broadcast',
    channel: 'socket',
    alertType: eventType,
    waitMode: options.waitMode,
    send: async () => {
      const claimed = await claimDelivery(
        hydrated,
        eventType,
        'socket',
        subscriber?.id || 'broadcast',
        { subscriber }
      );
      if (!claimed) return { skipped: true, reason: 'duplicate_milestone' };

      if (process.env.NODE_ENV === 'test' && typeof testBeforeSocket === 'function') {
        await testBeforeSocket(subscriber, hydrated);
      }

      const forClient = subscriber?.subscription
        ? sanitizeSignalForTier(hydrated, subscriber.subscription)
        : hydrated;
      const payload = toLiveAlertPayload(forClient);

      // Delivery channels only — canonical lifecycle events are emitted once in broadcast.
      if (payload.userId) {
        io.to(`user:${payload.userId}`).emit('tv:live-alert', payload);
      } else {
        io.emit('tv:live-alert', payload);
      }

      await commitDeliverySuccess(hydrated, eventType, 'socket', subscriber?.id || 'broadcast');
      return { ok: true, ...payload };
    }
  });
}

async function deliverEmail(subscriber, signalDoc, options = {}) {
  if (!subscriber?.email) {
    await recordSkipOutcome(signalDoc, subscriber, 'email', 'no_email', { notEligible: true });
    return { ok: false, skipped: true, reason: 'no_email' };
  }
  if (!userHasTierFeature(subscriber, 'emailAlerts')) {
    await recordSkipOutcome(signalDoc, subscriber, 'email', 'insufficient_tier', { notEligible: true });
    return { ok: false, skipped: true, reason: 'insufficient_tier' };
  }

  const signal = signalDoc?.toObject ? signalDoc.toObject() : signalDoc;
  if (signal?.selfTest || process.env.PIPELINE_SELF_TEST_ACTIVE === 'true') {
    console.log('[TradeDelivery] email skipped (pipeline self-test)');
    await recordSkipOutcome(signalDoc, subscriber, 'email', 'self_test_skip');
    return { ok: false, skipped: true, reason: 'self_test_skip' };
  }

  const prefs = subscriber.preferences || {};
  if (prefs.emailAlerts === false) {
    await recordSkipOutcome(signalDoc, subscriber, 'email', 'opt_out', { notEligible: true });
    return { ok: false, skipped: true, reason: 'opt_out' };
  }

  const hydrated = await hydrateLiveEntryForDelivery(signal);
  const liveSignal = hydrated?.toObject ? hydrated.toObject() : hydrated;
  const eventType = signalDoc.alertType || liveSignal.alertType || 'entry';
  const entryGuard = evaluateActionableEntryDelivery(liveSignal);
  logEntryDeliveryGuard('email', subscriber, liveSignal, entryGuard);
  if (entryGuard.skip) {
    console.log(`[TradeDelivery] email skipped (${entryGuard.reason})`);
    if (!liveSignal.entryAcceptedAt) {
      return { ok: false, skipped: true, reason: entryGuard.reason };
    }
    return DeliverySequencer.withChannelSequence({
      signalDoc: hydrated,
      subscriberId: subscriber.id,
      channel: 'email',
      alertType: eventType,
      waitMode: options.waitMode,
      send: async () => {
        await DurableDelivery.recordChannelSkip(
          specFrom(hydrated, eventType, 'email', subscriber.id),
          { reason: entryGuard.reason, notEligible: false }
        );
        return {
          ok: false,
          skipped: true,
          reason: entryGuard.reason,
          commitAcceptedEntrySkip: true
        };
      }
    });
  }
  return DeliverySequencer.withChannelSequence({
    signalDoc: hydrated,
    subscriberId: subscriber.id,
    channel: 'email',
    alertType: eventType,
    waitMode: options.waitMode,
    send: async () => {
      const claimed = await claimDelivery(hydrated, eventType, 'email', subscriber.id, {
        subscriber
      });
      if (!claimed) return { ok: false, reason: 'duplicate_milestone' };

      try {
        const emailSpec = specFrom(hydrated, eventType, 'email', subscriber.id);
        await DurableDelivery.markSendingBySpec(emailSpec);
        const deliveryJobId = DurableDelivery.jobIdFor(emailSpec);
        const result = await mailer.sendTradeAlertEmail({
          to: subscriber.email,
          displayName: subscriber.displayName,
          signal: liveSignal,
          metadata: {
            channel: 'email',
            eventType: String(eventType),
            subscriberId: String(subscriber.id),
            deliveryJobId: String(deliveryJobId),
            signalUuid: String(liveSignal.signalUuid || liveSignal.signalId || '')
          },
          tag: `kaching-${String(eventType || 'entry')}`.slice(0, 64)
        });
        if (result && result.ok === true) {
          const providerExtra = {
            reason: 'provider_http_ok',
            providerMessageId: result.id || null,
            provider: result.provider || null
          };
          await DurableDelivery.markProviderAcceptedBySpec(emailSpec, providerExtra);
          await commitDeliverySuccess(hydrated, eventType, 'email', subscriber.id, providerExtra);
          return { ok: true, reason: null, providerMessageId: result.id || null, provider: result.provider };
        }
        const failReason = result?.reason || 'skipped_or_failed';
        if (EMAIL_EXPECTED_SKIP_REASONS.has(String(failReason))) {
          await DurableDelivery.recordChannelSkip(emailSpec, {
            reason: failReason,
            notEligible: false
          });
        } else {
          await recordDeliveryFailure(hydrated, eventType, 'email', subscriber.id, {
            reason: failReason
          });
        }
        return {
          ok: false,
          skipped: EMAIL_EXPECTED_SKIP_REASONS.has(String(failReason)),
          reason: failReason,
          sentFallback: Boolean(result?.sentFallback)
        };
      } catch (err) {
        console.warn('[TradeDelivery] email failed:', err.message);
        await recordDeliveryFailure(hydrated, eventType, 'email', subscriber.id, {
          reason: err.message || 'email_exception'
        });
        return { ok: false, reason: err.message || 'email_exception' };
      }
    }
  });
}

async function deliverTelegram(subscriber, signalDoc, options = {}) {
  // Not gated on MT5 — linked Telegram + telegramAlerts tier is enough (Alerts Only / notify-only).
  const hydrated = await hydrateLiveEntryForDelivery(signalDoc);
  const meta = extractPipelineMeta(hydrated || {});
  const subLabel = subscriber?.email || subscriber?.id || 'unknown';
  const eligibility = evaluateTelegramEligibility(subscriber, hydrated);
  if (!eligibility.eligible && (isEntrySequenceSkipReason(eligibility.reason) || eligibility.reason === 'stale_entry')) {
    logEntryDeliveryGuard('telegram', subscriber, hydrated, {
      skip: true,
      reason: eligibility.reason
    });
  }

  const signalPlain = hydrated?.toObject ? hydrated.toObject() : hydrated || {};
  const requestId = signalPlain.pipelineRequestId || options.pipelineRequestId || 'n/a';
  console.log(
    `[TELEGRAM ELIGIBILITY] requestId=${requestId} signalUuid=${meta.signalUuid || 'n/a'} ` +
      `symbol=${meta.symbol || 'n/a'} timeframe=${meta.timeframe || 'n/a'} ` +
      `subscriber=${subLabel} userId=${subscriber?.id || 'n/a'} tier=${eligibility.tier} ` +
      `telegramEnabled=${eligibility.telegramEnabled} chatIdPresent=${eligibility.chatIdPresent} ` +
      `eligible=${eligibility.eligible}` +
      (eligibility.reason ? ` skipReason=${eligibility.reason}` : '')
  );

  if (!eligibility.eligible) {
    if (eligibility.reason === 'self_test_skip') {
      console.log('[TradeDelivery] telegram skipped (pipeline self-test)');
    }
    const entrySkip =
      isEntrySequenceSkipReason(eligibility.reason) && Boolean(signalPlain.entryAcceptedAt);
    if (entrySkip) {
      const eventType = signalPlain.alertType || 'entry';
      return DeliverySequencer.withChannelSequence({
        signalDoc: hydrated,
        subscriberId: subscriber?.id,
        channel: 'telegram',
        alertType: eventType,
        waitMode: options.waitMode,
        send: async () => {
          await DurableDelivery.recordChannelSkip(
            specFrom(hydrated, eventType, 'telegram', subscriber?.id),
            { reason: eligibility.reason, notEligible: false }
          );
          try {
            const { emitTvDeliver } = require('../utils/tvStageLog');
            emitTvDeliver({
              ...signalPlain,
              subscriberId: subscriber?.id,
              channel: 'telegram',
              state: 'skipped',
              reason: eligibility.reason
            });
          } catch {
            /* diagnostics */
          }
          void persistChannelDelivery(signalPlain._id || signalDoc?._id, subscriber?.id, 'telegram', {
            state: 'skipped',
            outcomeStatus: 'skipped',
            reason: eligibility.reason
          });
          return {
            ok: false,
            skipped: true,
            status: eligibility.status,
            reason: eligibility.reason,
            tier: eligibility.tier,
            telegramEnabled: eligibility.telegramEnabled,
            chatIdPresent: eligibility.chatIdPresent,
            commitAcceptedEntrySkip: true
          };
        }
      });
    }
    try {
      await DurableDelivery.recordChannelSkip(
        specFrom(signalDoc, signalPlain.alertType || 'entry', 'telegram', subscriber?.id),
        { reason: eligibility.reason || 'not_eligible', notEligible: true }
      );
    } catch {
      /* diagnostics */
    }
    try {
      const { emitTvDeliver } = require('../utils/tvStageLog');
      emitTvDeliver({
        ...signalPlain,
        subscriberId: subscriber?.id,
        channel: 'telegram',
        state: 'skipped',
        reason: eligibility.reason || 'not_eligible'
      });
    } catch {
      /* diagnostics */
    }
    void persistChannelDelivery(signalPlain._id || signalDoc?._id, subscriber?.id, 'telegram', {
      state: 'not_eligible',
      outcomeStatus: 'not_eligible',
      reason: eligibility.reason || 'not_eligible'
    });
    return {
      ok: false,
      skipped: true,
      notEligible: true,
      status: eligibility.status,
      reason: eligibility.reason,
      tier: eligibility.tier,
      telegramEnabled: eligibility.telegramEnabled,
      chatIdPresent: eligibility.chatIdPresent
    };
  }

  const eventType = signalPlain.alertType || 'entry';
  const result = await DeliverySequencer.withChannelSequence({
    signalDoc: hydrated,
    subscriberId: subscriber?.id,
    channel: 'telegram',
    alertType: eventType,
    waitMode: options.waitMode,
    send: async () => {
      const claimed = await claimDelivery(hydrated, eventType, 'telegram', subscriber?.id, {
        subscriber,
        telegramOptions: options
      });
      if (!claimed) {
        return {
          ok: false,
          status: TelegramService.TELEGRAM_STATUS.SKIPPED_STALE,
          reason: 'duplicate_milestone',
          tier: eligibility.tier
        };
      }

      console.log(
        `[TELEGRAM DELIVERY START] requestId=${requestId} signalUuid=${meta.signalUuid || 'n/a'} ` +
          `symbol=${meta.symbol || 'n/a'} subscriber=${subLabel} tier=${eligibility.tier}`
      );
      logDeliveryTimeline('delivery_attempt', {
        ...meta,
        eventType,
        channel: 'telegram',
        subscriberId: subscriber?.id,
        deliveryAttemptAt: Date.now()
      });

      try {
        await DurableDelivery.markSendingBySpec(
          specFrom(signalDoc, eventType, 'telegram', subscriber?.id)
        );
        const result = await TelegramService.notifySubscriber(subscriber, hydrated, options);
        // Backward-compatible: notifySubscriber historically returned a boolean.
        if (typeof result === 'boolean') {
          if (result) {
            await DurableDelivery.markProviderAcceptedBySpec(
              specFrom(signalDoc, eventType, 'telegram', subscriber?.id)
            );
            await commitDeliverySuccess(signalDoc, eventType, 'telegram', subscriber?.id);
          } else {
            await recordDeliveryFailure(signalDoc, eventType, 'telegram', subscriber?.id, {
              reason: 'notify_returned_false'
            });
          }
          return {
            ok: result,
            status: result
              ? TelegramService.TELEGRAM_STATUS.SEND_SUCCESS
              : TelegramService.TELEGRAM_STATUS.SEND_FAILED,
            reason: result ? null : 'notify_returned_false',
            tier: eligibility.tier,
            telegramEnabled: eligibility.telegramEnabled,
            chatIdPresent: eligibility.chatIdPresent
          };
        }
        const ok = Boolean(result?.ok);
        if (ok) {
          await DurableDelivery.markProviderAcceptedBySpec(
            specFrom(signalDoc, eventType, 'telegram', subscriber?.id)
          );
          await commitDeliverySuccess(signalDoc, eventType, 'telegram', subscriber?.id);
          logDeliveryTimeline('provider_accepted', {
            ...meta,
            eventType,
            channel: 'telegram',
            subscriberId: subscriber?.id,
            providerAcceptedAt: Date.now(),
            deliveryCompletedAt: Date.now()
          });
        } else {
          const failReason = result?.reason || result?.description || 'telegram_send_failed';
          if (failReason === 'duplicate_milestone') {
            await commitDeliverySuccess(signalDoc, eventType, 'telegram', subscriber?.id, {
              reason: failReason
            });
          } else if (isExpectedTelegramSkip(failReason, result?.status)) {
            await DurableDelivery.recordChannelSkip(
              specFrom(signalDoc, eventType, 'telegram', subscriber?.id),
              { reason: failReason, notEligible: false }
            );
          } else {
            await recordDeliveryFailure(signalDoc, eventType, 'telegram', subscriber?.id, {
              reason: failReason
            });
          }
        }
        return {
          ok,
          skipped: !ok && isExpectedTelegramSkip(result?.reason, result?.status),
          status: result?.status || TelegramService.TELEGRAM_STATUS.SEND_FAILED,
          reason: result?.reason || result?.description || null,
          httpStatus: result?.httpStatus ?? null,
          telegramErrorCode: result?.telegramErrorCode ?? null,
          description: result?.description || null,
          telegramMessageId: result?.telegramMessageId || null,
          tier: result?.tier || eligibility.tier,
          telegramEnabled: result?.telegramEnabled ?? eligibility.telegramEnabled,
          chatIdPresent: result?.chatIdPresent ?? eligibility.chatIdPresent
        };
      } catch (err) {
        console.warn('[TradeDelivery] telegram failed:', err.message);
        await recordDeliveryFailure(signalDoc, eventType, 'telegram', subscriber?.id, {
          reason: err.message || 'telegram_exception'
        });
        return {
          ok: false,
          status: TelegramService.TELEGRAM_STATUS.SEND_FAILED,
          reason: err.message || 'telegram_exception',
          httpStatus: err.httpStatus ?? null,
          telegramErrorCode: err.telegramErrorCode ?? null,
          description: err.description || err.message || 'telegram_exception',
          tier: eligibility.tier,
          telegramEnabled: eligibility.telegramEnabled,
          chatIdPresent: eligibility.chatIdPresent
        };
      }
    }
  });
  if (result?.deferred) {
    await DurableDelivery.ensureJob({
      eventId: signalPlain.eventId || signalPlain.signalUuid || signalPlain.signalId,
      canonicalTradeId:
        signalPlain.canonicalTradeId || signalPlain.signalUuid || signalPlain.signalId,
      subscriberId: subscriber?.id,
      channel: 'telegram',
      eventType,
      payload: {
        subscriber: DurableDelivery.snapshotSubscriber(subscriber),
        signal: DurableDelivery.snapshotSignal(hydrated),
        telegramOptions: options
      }
    });
  }
  try {
    const { emitTvDeliver } = require('../utils/tvStageLog');
    const state = result?.ok
      ? 'delivered'
      : result?.deferred || result?.reason === 'delivery_sequence_wait'
        ? 'blocked'
        : isExpectedTelegramSkip(result?.reason, result?.status)
          ? 'skipped'
          : result?.ok === false
            ? 'failed_retryable'
            : 'attempted';
    emitTvDeliver({
      ...signalPlain,
      subscriberId: subscriber?.id,
      channel: 'telegram',
      deliveryJobId: undefined,
      state,
      reason: result?.reason || result?.status,
      predecessorEvent: result?.predecessorEvent,
      deliverySequenceKey: result?.deliverySequenceKey,
      waitMs: result?.waitMs,
      retryScheduled: result?.retryScheduled
    });
  } catch {
    /* diagnostics */
  }
  void persistChannelDelivery(signalPlain._id || signalDoc?._id, subscriber?.id, 'telegram', {
    state: result?.ok
      ? 'success'
      : result?.deferred
        ? 'pending'
        : result?.notEligible
          ? 'not_eligible'
          : isExpectedTelegramSkip(result?.reason, result?.status) || result?.skipped
            ? 'skipped'
            : 'failed',
    outcomeStatus: result?.ok
      ? 'success'
      : result?.deferred
        ? 'pending'
        : result?.notEligible
          ? 'not_eligible'
          : isExpectedTelegramSkip(result?.reason, result?.status) || result?.skipped
            ? 'skipped'
            : 'failed',
    reason: result?.reason || result?.status
  });
  return result;
}

/**
 * Queue MT5 trade for AUTO mode only. Does not require Telegram.
 * MANUAL mode queues only via Telegram Execute (or future in-app Execute).
 */
async function deliverMt5Auto(subscriber, signalDoc, options = {}) {
  const hydrated = await hydrateLiveEntryForDelivery(signalDoc);
  const probe = hydrated?.toObject ? hydrated.toObject() : hydrated;
  if (probe?.selfTest || process.env.PIPELINE_SELF_TEST_ACTIVE === 'true') {
    await recordSkipOutcome(signalDoc, subscriber, 'mt5', 'self_test_skip');
    return { ok: false, skipped: true, reason: 'self_test_skip' };
  }

  if (!subscriber?.id || !signalDoc?._id) {
    await recordSkipOutcome(signalDoc, subscriber, 'mt5', 'missing_ids', { notEligible: true });
    return { ok: false, skipped: true, reason: 'missing_ids' };
  }

  if (!userHasTierFeature(subscriber, 'mt5Execution')) {
    await recordSkipOutcome(signalDoc, subscriber, 'mt5', 'subscription_required', {
      notEligible: true
    });
    return { ok: false, skipped: true, reason: 'subscription_required' };
  }

  if (!isEntryAlert(signalDoc.alertType || 'signal')) {
    await recordSkipOutcome(signalDoc, subscriber, 'mt5', 'not_entry_signal');
    return { ok: false, skipped: true, reason: 'not_entry_signal' };
  }

  const mt5EntryGuard = evaluateActionableEntryDelivery(probe);
  if (mt5EntryGuard.skip) {
    logEntryDeliveryGuard('mt5', subscriber, probe, mt5EntryGuard);
    await recordSkipOutcome(signalDoc, subscriber, 'mt5', mt5EntryGuard.reason);
    return { ok: false, skipped: true, reason: mt5EntryGuard.reason };
  }

  const mode = resolveExecutionMode(subscriber);
  if (mode !== 'auto') {
    await recordSkipOutcome(signalDoc, subscriber, 'mt5', 'manual_mode', { notEligible: true });
    return { ok: false, skipped: true, reason: 'manual_mode' };
  }

  const eventType = signalDoc.alertType || 'entry';
  return DeliverySequencer.withChannelSequence({
    signalDoc: hydrated,
    subscriberId: subscriber.id,
    channel: 'mt5',
    alertType: eventType,
    waitMode: options.waitMode,
    send: async () => {
      const claimed = await claimDelivery(signalDoc, eventType, 'mt5', subscriber.id, {
        subscriber
      });
      if (!claimed) return { ok: false, reason: 'duplicate_milestone' };

      try {
        const queued = await Mt5TradeCopierService.queueExecutionForUser(subscriber.id, signalDoc._id, {
          source: 'auto'
        });
        if (queued?.ok) {
          await commitDeliverySuccess(signalDoc, eventType, 'mt5', subscriber.id);
        } else if (isExpectedMt5Skip(queued?.reason)) {
          await DurableDelivery.recordChannelSkip(
            specFrom(signalDoc, eventType, 'mt5', subscriber.id),
            {
              reason: queued?.reason,
              notEligible: MT5_NOT_ELIGIBLE_REASONS.has(String(queued?.reason))
            }
          );
        } else {
          await recordDeliveryFailure(signalDoc, eventType, 'mt5', subscriber.id, {
            reason: queued?.reason || 'queue_error'
          });
        }
        return queued && queued.ok === true ? { ...queued, ok: true } : queued;
      } catch (err) {
        console.warn('[TradeDelivery] MT5 auto queue failed:', err.message);
        await recordDeliveryFailure(signalDoc, eventType, 'mt5', subscriber.id, {
          reason: err.message || 'queue_error'
        });
        return { ok: false, reason: 'queue_error', message: err.message };
      }
    }
  });
}

/**
 * Dispatch one Signal to every delivery channel for a subscriber.
 * TradingViewAlertService should only validate/enrich/publish — this owns routing.
 */
/**
 * Persist a channel DeliveryJob BEFORE provider HTTP so a process crash cannot
 * lose an accepted ENTRY's email/telegram work after fan-out has started it.
 * beginAttempt/claimDelivery later reuses this job (idempotent ensureJob).
 */
async function ensureChannelDeliveryJobDurable(signalDoc, subscriber, channel, options = {}) {
  if (!subscriber?.id || !signalDoc) return null;
  const eventType = String(signalDoc.alertType || 'entry').toLowerCase();
  const plain = signalDoc?.toObject ? signalDoc.toObject() : signalDoc;
  const { resolveCanonicalTradeId } = require('../utils/tradeEventIdentity');
  const canonicalTradeId =
    resolveCanonicalTradeId(plain) ||
    String(plain.canonicalTradeId || plain.signalUuid || plain.signalId || '').trim();
  const eventId = String(plain.eventId || '').trim() || canonicalTradeId;
  if (!eventId && !canonicalTradeId) return null;
  return DurableDelivery.ensureJob({
    eventId,
    canonicalTradeId,
    subscriberId: String(subscriber.id),
    channel: String(channel),
    eventType,
    signalUuid: plain.signalUuid || plain.signalId || canonicalTradeId,
    payload: {
      signal: plain,
      subscriber: {
        id: subscriber.id,
        email: subscriber.email,
        displayName: subscriber.displayName,
        subscription: subscriber.subscription,
        telegram: subscriber.telegram,
        mt5: subscriber.mt5,
        preferences: subscriber.preferences
      },
      telegramOptions: options.telegramOptions || null,
      correlation: compactCorrelation(
        mergeCorrelation(plain, {
          requestId: plain.pipelineRequestId || plain.correlation?.requestId,
          subscriberId: subscriber.id,
          channel
        })
      )
    },
    correlation: compactCorrelation(
      mergeCorrelation(plain, {
        requestId: plain.pipelineRequestId || plain.correlation?.requestId,
        subscriberId: subscriber.id,
        channel
      })
    ),
    refs: buildDurableRefs({
      eventId,
      canonicalTradeId,
      subscriberId: subscriber.id,
      channel,
      eventType,
      signalUuid: plain.signalUuid || plain.signalId,
      signalId: plain._id || plain.id,
      payload: { signalData: plain }
    })
  });
}

function trackDetachedProvider(label, promise) {
  const p = Promise.resolve(promise).catch(err => {
    console.warn(
      `[TradeDelivery] detached provider failed: ${label} err=${err?.message || err}`
    );
  });
  if (process.env.NODE_ENV === 'test') {
    if (!trackDetachedProvider._pending) trackDetachedProvider._pending = new Set();
    trackDetachedProvider._pending.add(p);
    p.finally(() => trackDetachedProvider._pending.delete(p));
  }
  return p;
}

async function waitForDetachedProvidersForTests() {
  const pending = trackDetachedProvider._pending;
  if (!pending || pending.size === 0) return;
  await Promise.allSettled([...pending]);
}

async function deliverToSubscriber(io, signalDoc, subscriber = null, options = {}) {
  let telegramSent = Boolean(signalDoc.telegramSent);
  let telegramAttempted = Boolean(signalDoc.telegramAttempted);
  let mt5Sent = Boolean(signalDoc.mt5Sent);
  let emailSent = Boolean(signalDoc.emailSent);
  let executionStatus = signalDoc.executionStatus || 'pending';
  let executionChannel = signalDoc.executionChannel || 'none';
  let telegramAlertSent = Boolean(signalDoc.telegramAlertSent);
  let telegramAlertSentAt = signalDoc.telegramAlertSentAt || null;
  let telegramAlertDelivered = Boolean(signalDoc.telegramAlertDelivered);
  let telegramAlertDeliveredAt = signalDoc.telegramAlertDeliveredAt || null;
  let mt5Reason = '-';

  const hydratedDoc = await hydrateLiveEntryForDelivery(signalDoc);
  const signal = hydratedDoc?.toObject ? hydratedDoc.toObject() : { ...hydratedDoc };
  if (subscriber?.id && !signal.userId) {
    signal.userId = subscriber.id;
  }

  const meta = extractPipelineMeta(signal);
  const subLabel = subscriber?.email || subscriber?.id || 'broadcast';

  const executionMode = subscriber ? resolveExecutionMode(subscriber) : 'manual';
  const telegramMode = subscriber ? resolveTelegramMode(subscriber) : TELEGRAM_MODES.MANUAL_CONFIRMATION;
  const isEntry = isEntryAlert(signal.alertType || 'signal');
  const entryGuard = evaluateActionableEntryDelivery(signal);
  const mt5Linked =
    Boolean(subscriber) && Mt5TradeCopierService.isMt5Linked(subscriber.mt5 || {});
  // Pro Alerts Only: telegramMode preference while executionMode stays manual — no Execute/Ignore.
  const alertsOnly =
    Boolean(subscriber) && executionMode === 'manual' && isAlertsOnlyTelegram(subscriber);
  // Pro Manual Confirmation only — Alerts Only never shows Execute/Ignore; Premium Auto never does.
  const includeExecuteButton =
    Boolean(subscriber) &&
    isEntry &&
    !entryGuard.skip &&
    executionMode === 'manual' &&
    !alertsOnly &&
    telegramMode === TELEGRAM_MODES.MANUAL_CONFIRMATION &&
    userHasTierFeature(subscriber, 'mt5Execution') &&
    mt5Linked;

  const confirmSeconds = subscriber ? resolveConfirmSeconds(subscriber) : 180;
  let mt5ConfirmStatus = signal.mt5ConfirmStatus || 'none';
  let mt5ConfirmExpiresAt = signal.mt5ConfirmExpiresAt || null;
  let tgPipelineStatus = 'SKIP';
  let mt5PipelineStatus = 'SKIP';
  let emailPipelineStatus = 'SKIP';
  let criticalStartedAt = 0;

  if (includeExecuteButton) {
    mt5ConfirmStatus = 'pending';
    mt5ConfirmExpiresAt = computeConfirmExpiresAt(new Date(), confirmSeconds);
  }

  if (subscriber) {
    let emailResult;
    let tgResult;
    let mt5Result;
    if (isEntry) {
      const settledOrFallback = (settled, fallbackReason) => {
        if (settled.status === 'fulfilled') return settled.value;
        console.warn(
          `[TradeDelivery] independent channel rejected: ${fallbackReason}; sub=${subLabel} err=${
            settled.reason?.message || settled.reason || 'rejected'
          }`
        );
        return { ok: false, reason: fallbackReason };
      };
      // ENTRY: independent durable channels.
      // Proven USDCAD 2026-09-09: awaiting Email inside TV_FANOUT_CONCURRENCY held
      // slots ~15–30s and delayed Telegram 78–198s.
      // Proven by code: mapWithConcurrency awaits deliverToSubscriber; awaiting
      // Telegram Bot API here also holds the slot and delays the NEXT subscriber's
      // MT5 (cross-subscriber coupling). Same-subscriber TG+MT5 already start in
      // parallel — only release after MT5 attempt scheduling + durable TG/email jobs.
      criticalStartedAt = Date.now();
      const releaseSlotWithoutAwaitingNotify = Boolean(options.releaseAfterCriticalProviders);

      if (releaseSlotWithoutAwaitingNotify) {
        await ensureChannelDeliveryJobDurable(signal, subscriber, 'email');
        await ensureChannelDeliveryJobDurable(signal, subscriber, 'telegram', {
          telegramOptions: {
            includeExecuteButton,
            alertOnly: alertsOnly,
            confirmExpiresAt: mt5ConfirmExpiresAt,
            confirmSeconds,
            waitMode: options.waitMode
          }
        });
      }

      console.log(`[DELIVERY Email START] sub=${subLabel} symbol=${meta.symbol || 'n/a'}`);
      const emailPromise = deliverEmail(subscriber, signal, { waitMode: options.waitMode });
      console.log(`[DELIVERY Telegram START] sub=${subLabel} symbol=${meta.symbol || 'n/a'}`);
      const tgPromise = deliverTelegram(subscriber, signal, {
        includeExecuteButton,
        alertOnly: alertsOnly,
        confirmExpiresAt: mt5ConfirmExpiresAt,
        confirmSeconds,
        waitMode: options.waitMode
      });
      // Premium Automatic only — Pro Manual (including Alerts Only preference) never auto-queues.
      console.log(`[DELIVERY MT5 START] sub=${subLabel} symbol=${meta.symbol || 'n/a'}`);
      const mt5Promise = deliverMt5Auto(subscriber, signal, { waitMode: options.waitMode });

      if (releaseSlotWithoutAwaitingNotify) {
        const mt5Settled = await Promise.allSettled([mt5Promise]).then((rows) => rows[0]);
        mt5Result = settledOrFallback(mt5Settled, 'queue_error');
        tgResult = {
          ok: true,
          deferred: true,
          reason: 'telegram_nonblocking_inflight',
          status: TelegramService.TELEGRAM_STATUS.NOT_ATTEMPTED
        };
        emailResult = {
          ok: true,
          deferred: true,
          reason: 'email_nonblocking_inflight'
        };
        trackDetachedProvider(`telegram:${subLabel}`, tgPromise.then((result) => {
          const ok = Boolean(result?.ok);
          const reason = result?.reason || result?.description || (ok ? 'SUCCESS' : 'skipped_or_failed');
          const skip = isExpectedTelegramSkip(reason, result?.status);
          const status = ok ? 'PASS' : skip ? 'SKIP' : 'FAIL';
          if (status === 'PASS') {
            console.log(`[DELIVERY Telegram SUCCESS] sub=${subLabel} (nonblocking)`);
          } else if (status === 'SKIP') {
            console.log(
              `[DELIVERY Telegram SKIP] sub=${subLabel} reason=${reason} (nonblocking)`
            );
          } else {
            console.warn(
              `[DELIVERY Telegram FAILED] sub=${subLabel} symbol=${meta.symbol || 'n/a'} reason=${reason} (nonblocking)`
            );
          }
          logPipeline('DeliveryTelegram', status, {
            ...meta,
            reason: ok
              ? `SUCCESS_NONBLOCKING; sub=${subLabel}`
              : skip
                ? `SKIP_NONBLOCKING; reason=${reason}; sub=${subLabel}`
                : `FAILED_NONBLOCKING; ${reason}; sub=${subLabel}`
          });
          return result;
        }));
        trackDetachedProvider(`email:${subLabel}`, emailPromise.then((result) => {
          const ok = Boolean(result?.ok);
          const reason = result?.reason || (ok ? 'SUCCESS' : 'skipped_or_failed');
          const skip = EMAIL_EXPECTED_SKIP_REASONS.has(String(reason || ''));
          const status = ok ? 'PASS' : skip ? 'SKIP' : 'FAIL';
          if (status === 'PASS') {
            console.log(`[DELIVERY Email SUCCESS] sub=${subLabel} (nonblocking)`);
          } else if (status === 'SKIP') {
            console.log(`[DELIVERY Email SKIP] sub=${subLabel} reason=${reason} (nonblocking)`);
          } else {
            console.warn(
              `[DELIVERY Email FAILED] sub=${subLabel} symbol=${meta.symbol || 'n/a'} reason=${reason} (nonblocking)`
            );
          }
          logPipeline('DeliveryEmail', status, {
            ...meta,
            reason: ok
              ? `SUCCESS_NONBLOCKING; to=${subscriber.email}`
              : skip
                ? `SKIP_NONBLOCKING; reason=${reason}; sub=${subLabel}`
                : `FAILED_NONBLOCKING; ${reason}; sub=${subLabel}`
          });
          return result;
        }));
      } else {
        const [tgSettled, mt5Settled, emailSettled] = await Promise.allSettled([
          tgPromise,
          mt5Promise,
          emailPromise
        ]);
        tgResult = settledOrFallback(tgSettled, 'telegram_exception');
        mt5Result = settledOrFallback(mt5Settled, 'queue_error');
        emailResult = settledOrFallback(emailSettled, 'email_exception');
      }
    } else {
      console.log(`[DELIVERY Email START] sub=${subLabel} symbol=${meta.symbol || 'n/a'}`);
      emailResult = await deliverEmail(subscriber, signal, { waitMode: options.waitMode });
    }
    const emailOk = Boolean(emailResult?.ok);
    if (emailOk && !emailResult?.deferred) emailSent = true;
    const emailSelfTest =
      signal?.selfTest || process.env.PIPELINE_SELF_TEST_ACTIVE === 'true';
    const emailReason = emailResult?.reason || (emailOk ? 'SUCCESS' : 'skipped_or_failed');
    const emailSkip = EMAIL_EXPECTED_SKIP_REASONS.has(String(emailReason || ''));
    if (emailResult?.deferred) {
      emailPipelineStatus = 'PASS';
      console.log(
        `[DELIVERY Email DEFERRED] sub=${subLabel} symbol=${meta.symbol || 'n/a'} reason=nonblocking_fanout_slot`
      );
      logPipeline('DeliveryEmail', 'PASS', {
        ...meta,
        reason: `STARTED_NONBLOCKING; to=${subscriber.email}`
      });
    } else {
      emailPipelineStatus = emailOk || emailSelfTest ? 'PASS' : emailSkip ? 'SKIP' : 'FAIL';
      if (emailPipelineStatus === 'PASS') {
        console.log(
          `[DELIVERY Email SUCCESS] sub=${subLabel}${emailSelfTest && !emailOk ? ' (self_test_skip)' : ''}`
        );
      } else if (emailPipelineStatus === 'SKIP') {
        console.log(`[DELIVERY Email SKIP] sub=${subLabel} reason=${emailReason}`);
      } else {
        console.warn(
          `[DELIVERY Email FAILED] sub=${subLabel} symbol=${meta.symbol || 'n/a'} reason=${emailReason}`
        );
      }
      logPipeline('DeliveryEmail', emailPipelineStatus, {
        ...meta,
        reason: emailOk
          ? `SUCCESS; to=${subscriber.email}`
          : emailSelfTest
            ? `self_test_skip; sub=${subLabel}`
            : emailSkip
              ? `SKIP; reason=${emailReason}; sub=${subLabel}`
              : `FAILED; ${emailReason}; sub=${subLabel}`
      });
    }

    if (!isEntry) {
      console.log(`[DELIVERY Telegram START] sub=${subLabel} symbol=${meta.symbol || 'n/a'}`);
      tgResult = await deliverTelegram(subscriber, signal, {
        includeExecuteButton,
        alertOnly: alertsOnly,
        confirmExpiresAt: mt5ConfirmExpiresAt,
        confirmSeconds,
        waitMode: options.waitMode
      });
    }
    const tgOk = Boolean(tgResult?.ok);
    const tgDeferred = Boolean(tgResult?.deferred);
    const tgStatus = tgResult?.status || TelegramService.TELEGRAM_STATUS.NOT_ATTEMPTED;
    const tgReason =
      tgResult?.description ||
      tgResult?.reason ||
      (tgOk ? 'SUCCESS' : 'skipped_or_failed');
    if (tgOk && !tgDeferred) {
      telegramSent = true;
      if (alertsOnly && isEntry) {
        telegramAlertSent = true;
        telegramAlertSentAt = new Date();
        // Bot API sendMessage success ≈ delivered to Telegram servers (read receipts future-ready).
        telegramAlertDelivered = true;
        telegramAlertDeliveredAt = telegramAlertSentAt;
        executionChannel = 'telegram_alert';
        executionStatus = executionStatus === 'pending' ? 'skipped' : executionStatus;
      }
    }
    const tgExpectedSkip = isExpectedTelegramSkip(tgResult?.reason, tgStatus);
    if (tgDeferred) {
      tgPipelineStatus = 'PASS';
      console.log(
        `[DELIVERY Telegram DEFERRED] sub=${subLabel} symbol=${meta.symbol || 'n/a'} reason=nonblocking_fanout_slot`
      );
      logPipeline('DeliveryTelegram', 'PASS', {
        ...meta,
        reason: `STARTED_NONBLOCKING; sub=${subLabel}`
      });
    } else {
      tgPipelineStatus = tgOk || emailSelfTest ? 'PASS' : tgExpectedSkip ? 'SKIP' : 'FAIL';
      if (tgPipelineStatus === 'PASS' || tgPipelineStatus === 'FAIL') {
        telegramAttempted = true;
      }
      if (tgPipelineStatus === 'PASS') {
        console.log(
          `[DELIVERY Telegram SUCCESS] sub=${subLabel} status=${tgStatus}` +
            `${emailSelfTest && !tgOk ? ' (self_test_skip)' : ''}`
        );
      } else if (tgPipelineStatus === 'SKIP') {
        console.log(
          `[DELIVERY Telegram SKIP] sub=${subLabel} status=${tgStatus} reason=${tgReason}`
        );
      } else {
        console.warn(
          `[DELIVERY Telegram FAILED] sub=${subLabel} symbol=${meta.symbol || 'n/a'} ` +
            `status=${tgStatus} reason=${tgReason}` +
            `${tgResult?.httpStatus != null ? ` httpStatus=${tgResult.httpStatus}` : ''}` +
            `${tgResult?.telegramErrorCode != null ? ` telegramErrorCode=${tgResult.telegramErrorCode}` : ''}`
        );
        console.warn(
          `[WEBHOOK FAIL:DELIVERY] channel=telegram sub=${subLabel} status=${tgStatus} reason=${tgReason}`
        );
      }
      logPipeline('DeliveryTelegram', tgPipelineStatus, {
        ...meta,
        userId: subscriber?.id || null,
        reason: tgOk
          ? `SUCCESS; status=${tgStatus}; sub=${subLabel}; mode=${executionMode}; telegramMode=${telegramMode}${alertsOnly ? '; telegram_alert_sent' : ''}`
          : emailSelfTest
            ? `self_test_skip; status=${tgStatus}; sub=${subLabel}`
            : tgExpectedSkip
              ? `SKIP; status=${tgStatus}; reason=${tgReason}; sub=${subLabel}`
              : `FAILED; status=${tgStatus}; reason=${tgReason}` +
                `${tgResult?.httpStatus != null ? `; httpStatus=${tgResult.httpStatus}` : ''}` +
                `${tgResult?.telegramErrorCode != null ? `; telegramErrorCode=${tgResult.telegramErrorCode}` : ''}` +
                `; sub=${subLabel}`
      });
    }
    if (tgOk && !tgDeferred && subscriber?.id) {
      try {
        const PipelineSubscriberStatsService = require('./PipelineSubscriberStatsService');
        void PipelineSubscriberStatsService.recordDelivery(subscriber.id, 'telegram', meta);
      } catch {
        /* diagnostics */
      }
    }

    if (!isEntry) {
      // Premium Automatic only — Pro Manual (including Alerts Only preference) never auto-queues.
      console.log(`[DELIVERY MT5 START] sub=${subLabel} symbol=${meta.symbol || 'n/a'}`);
      mt5Result = await deliverMt5Auto(subscriber, signal, { waitMode: options.waitMode });
    }
    mt5Reason = mt5Result?.reason || (mt5Result?.ok ? 'queued' : 'skipped');
    if (mt5Result?.ok) {
      mt5Sent = true;
      executionStatus = 'sent';
      executionChannel = 'mt5_auto';
      mt5ConfirmStatus = 'none';
      mt5ConfirmExpiresAt = null;
    } else if (
      mt5Result?.reason === 'mt5_not_linked' ||
      mt5Result?.reason === 'mt5_disabled' ||
      mt5Result?.reason === 'manual_mode' ||
      mt5Result?.reason === 'subscription_required' ||
      mt5Result?.reason === 'not_entry_signal' ||
      mt5Result?.reason === 'self_test_skip'
    ) {
      executionStatus = executionStatus === 'pending' ? 'skipped' : executionStatus;
    }
    const mt5Ok = Boolean(mt5Result?.ok);
    const mt5ExpectedSkip = isExpectedMt5Skip(mt5Reason);
    mt5PipelineStatus =
      mt5Ok || mt5Reason === 'self_test_skip' ? 'PASS' : mt5ExpectedSkip ? 'SKIP' : 'FAIL';
    if (mt5PipelineStatus === 'PASS') {
      console.log(`[DELIVERY MT5 SUCCESS] reason=${mt5Reason}; sub=${subLabel}`);
    } else if (mt5PipelineStatus === 'SKIP') {
      console.log(
        `[DELIVERY MT5 SKIP] reason=${mt5Reason}; mode=${executionMode}; linked=${mt5Linked}; sub=${subLabel}`
      );
    } else {
      console.warn(`[DELIVERY MT5 FAILED] reason=${mt5Reason}; sub=${subLabel}`);
      console.warn(`[WEBHOOK FAIL:DELIVERY] channel=mt5 reason=${mt5Reason}; sub=${subLabel}`);
    }
    logPipeline('DeliveryMT5', mt5PipelineStatus, {
      ...meta,
      userId: subscriber?.id || null,
      reason:
        mt5PipelineStatus === 'PASS'
          ? `SUCCESS; ${mt5Reason}; mode=${executionMode}; telegramMode=${telegramMode}; sub=${subLabel}`
          : mt5PipelineStatus === 'SKIP'
            ? `SKIP / NOT_LINKED_OR_N_A; ${mt5Reason}; mode=${executionMode}; telegramMode=${telegramMode}; linked=${mt5Linked}; sub=${subLabel}`
            : `FAILED; ${mt5Reason}; mode=${executionMode}; telegramMode=${telegramMode}; sub=${subLabel}`
    });
    if (mt5PipelineStatus === 'PASS' && subscriber?.id) {
      try {
        const PipelineSubscriberStatsService = require('./PipelineSubscriberStatsService');
        void PipelineSubscriberStatsService.recordDelivery(subscriber.id, 'mt5', meta);
      } catch {
        /* diagnostics */
      }
    }
  }

  const deliveryStatus = resolveDeliveryStatus({
    telegramSent,
    mt5Sent,
    emailSent,
    tgPipelineStatus,
    mt5PipelineStatus,
    emailPipelineStatus
  });

  const enrichedDoc = {
    ...signal,
    telegramSent,
    telegramAttempted,
    mt5Sent,
    emailSent,
    executionStatus,
    executionChannel,
    telegramAlertSent,
    telegramAlertSentAt,
    telegramAlertDelivered,
    telegramAlertDeliveredAt,
    mt5ConfirmStatus,
    mt5ConfirmExpiresAt,
    deliveryStatus
  };

  const pipelineToOutcome = status =>
    status === 'PASS' ? 'success' : status === 'FAIL' ? 'failed' : status === 'SKIP' ? 'skipped' : 'pending';
  void persistChannelDelivery(enrichedDoc._id, subscriber?.id, 'email', {
    state: pipelineToOutcome(emailPipelineStatus),
    outcomeStatus: pipelineToOutcome(emailPipelineStatus)
  });
  void persistChannelDelivery(enrichedDoc._id, subscriber?.id, 'mt5', {
    state: pipelineToOutcome(mt5PipelineStatus),
    outcomeStatus: pipelineToOutcome(mt5PipelineStatus),
    reason: mt5Reason
  });

  await persistDeliveryFlags(enrichedDoc._id, {
    telegramSent,
    telegramAttempted,
    mt5Sent,
    emailSent,
    executionStatus,
    executionChannel,
    telegramAlertSent,
    telegramAlertSentAt,
    telegramAlertDelivered,
    telegramAlertDeliveredAt,
    mt5ConfirmStatus,
    mt5ConfirmExpiresAt,
    deliveryStatus
  });

  const socketContext = {
    io,
    enrichedDoc,
    subscriber,
    options,
    meta,
    subLabel,
    emailSent,
    telegramSent,
    mt5Sent
  };

  const canReleaseAfterCritical =
    Boolean(options.releaseAfterCriticalProviders) &&
    Boolean(isEntry) &&
    Boolean(subscriber);

  if (canReleaseAfterCritical) {
    let socketOwned = false;
    try {
      await ensureSocketJobOwned(enrichedDoc, subscriber);
      socketOwned = true;
    } catch (err) {
      if (isRedisUnavailableErr(err)) {
        console.warn(
          `[TradeDelivery] socket ensureJob redis_unavailable; holding fan-out slot; sub=${subLabel}`
        );
      } else {
        console.warn(
          `[TradeDelivery] socket ensureJob failed; holding fan-out slot; sub=${subLabel} err=${err.message}`
        );
      }
    }
    if (socketOwned) {
      const queued = enqueuePostSlotSocket(() => finalizeSocketDelivery(socketContext));
      const criticalMs = criticalStartedAt ? Date.now() - criticalStartedAt : 0;
      recordSlotTiming({
        sub: subLabel,
        symbol: meta.symbol || 'n/a',
        criticalMs,
        queued,
        overflowToRecovery: !queued
      });
      console.log(
        `[DELIVERY SLOT RELEASE] sub=${subLabel} symbol=${meta.symbol || 'n/a'} ` +
          `criticalMs=${criticalMs} socket=${queued ? 'deferred' : 'recovery_pending'}`
      );
      return {
        ok: true,
        deferredSocket: true,
        queuedForRecovery: !queued,
        telegramSent,
        emailSent,
        mt5Sent
      };
    }
  }

  return finalizeSocketDelivery(socketContext);
}

async function finalizeSocketDelivery({
  io,
  enrichedDoc,
  subscriber,
  options,
  meta,
  subLabel,
  emailSent,
  telegramSent,
  mt5Sent
}) {
  console.log(`[DELIVERY Socket START] sub=${subLabel} symbol=${meta.symbol || 'n/a'}`);
  try {
    const payload = await deliverInApp(io, enrichedDoc, subscriber, { waitMode: options.waitMode });
    if (payload?.skipped) {
      void persistChannelDelivery(enrichedDoc._id, subscriber?.id, 'socket', {
        state: 'skipped',
        outcomeStatus: 'skipped',
        reason: payload.reason || 'duplicate_milestone'
      });
      logPipeline('DeliverySocket', 'SKIP', {
        ...meta,
        userId: subscriber?.id || null,
        reason: `SKIP; reason=${payload.reason || 'duplicate_milestone'}; sub=${subLabel}`
      });
      return payload;
    }
    void persistChannelDelivery(enrichedDoc._id, subscriber?.id, 'socket', {
      state: 'success',
      outcomeStatus: 'success'
    });
    console.log(`[DELIVERY Socket SUCCESS] sub=${subLabel}`);
    logPipeline('DeliverySocket', 'PASS', {
      ...meta,
      userId: subscriber?.id || null,
      reason: `SUCCESS; tv:live-alert; sub=${subLabel}; email=${emailSent}; tg=${telegramSent}; mt5=${mt5Sent}`
    });
    if (subscriber?.id) {
      try {
        const PipelineSubscriberStatsService = require('./PipelineSubscriberStatsService');
        void PipelineSubscriberStatsService.recordDelivery(subscriber.id, 'socket', meta);
        void PipelineSubscriberStatsService.recordPublished(subscriber.id, meta);
      } catch {
        /* diagnostics */
      }
    }
    return payload;
  } catch (err) {
    void persistChannelDelivery(enrichedDoc._id, subscriber?.id, 'socket', {
      state: 'failed',
      outcomeStatus: 'failed',
      reason: err.message
    });
    persistMergedDeliveryStatus(enrichedDoc._id, 'partial');
    console.warn(`[DELIVERY Socket FAILED] sub=${subLabel} err=${err.message}`);
    logPipeline('DeliverySocket', 'FAIL', {
      ...meta,
      userId: subscriber?.id || null,
      reason: `FAILED; ${err.message}; sub=${subLabel}`
    });
    if (options.releaseAfterCriticalProviders) {
      try {
        await DurableDelivery.scheduleRetryBySpec(
          specFrom(enrichedDoc, enrichedDoc.alertType || 'entry', 'socket', subscriber?.id || 'broadcast'),
          { reason: err.message || 'socket_exception' }
        );
      } catch (retryErr) {
        console.warn('[TradeDelivery] socket retry schedule failed:', retryErr.message);
      }
      return { ok: false, reason: err.message, deferredSocket: true };
    }
    throw err;
  }
}

/**
 * Manual Execute path (Telegram callback / future in-app).
 * Time-limited: expired confirmations never queue. Identical MT5 engine after queue.
 */
async function queueManualExecution(userId, signalId) {
  const signal = await loadSignalById(signalId);
  if (!signal) {
    return { ok: false, reason: 'signal_not_found' };
  }

  const plain = signal.toObject ? signal.toObject() : signal;
  const livePlain = (await hydrateLiveEntryForDelivery(plain)) || plain;
  const entryGuard = evaluateActionableEntryDelivery(livePlain);
  if (entryGuard.skip) {
    logEntryDeliveryGuard('mt5_manual', { id: userId }, livePlain, entryGuard);
    return { ok: false, skipped: true, reason: entryGuard.reason };
  }

  // Alerts Only never queues — Execute callbacks must not reach MT5.
  try {
    const UserConfig = require('../models/User');
    const mongoose = require('mongoose');
    let user = null;
    if (mongoose.connection.readyState === 1) {
      user = await UserConfig.findById(userId);
    } else {
      const devUserStore = require('../utils/devUserStore');
      user = await devUserStore.findById(userId);
    }
    if (
      user &&
      resolveExecutionMode(user) === 'manual' &&
      isAlertsOnlyTelegram(user)
    ) {
      return { ok: false, reason: 'alerts_only_mode' };
    }
  } catch {
    /* ignore lookup errors; queue path still validates below */
  }

  if (plain.mt5Sent || ['sent', 'executed'].includes(plain.executionStatus)) {
    return { ok: false, reason: 'already_queued' };
  }

  if (plain.userId && String(plain.userId) !== String(userId)) {
    return { ok: false, reason: 'forbidden' };
  }

  if (plain.mt5ConfirmStatus === 'ignored' || plain.executionStatus === 'ignored') {
    return { ok: false, reason: 'confirm_ignored' };
  }

  if (
    plain.mt5ConfirmStatus === 'expired' ||
    plain.executionStatus === 'expired' ||
    isConfirmExpired(plain.mt5ConfirmExpiresAt)
  ) {
    if (plain.mt5ConfirmStatus !== 'expired') {
      await markManualConfirmExpired(plain);
    }
    return { ok: false, reason: 'confirm_expired' };
  }

  const result = await Mt5TradeCopierService.queueExecutionForUser(userId, signalId, {
    source: 'manual'
  });

  if (result.ok && isDbConnected()) {
    await Signal.findByIdAndUpdate(signalId, {
      mt5ConfirmStatus: 'executed',
      mt5Sent: true,
      executionStatus: 'sent',
      executionChannel: 'mt5_manual'
    }).catch(() => {});
  }

  return result;
}

/**
 * Ignore Trade — discard confirmation; never queues.
 */
async function ignoreManualExecution(userId, signalId) {
  const signal = await loadSignalById(signalId);
  if (!signal) {
    return { ok: false, reason: 'signal_not_found' };
  }
  const plain = signal.toObject ? signal.toObject() : signal;

  if (plain.userId && String(plain.userId) !== String(userId)) {
    return { ok: false, reason: 'forbidden' };
  }

  if (plain.mt5Sent || plain.mt5ConfirmStatus === 'executed') {
    return { ok: false, reason: 'already_queued' };
  }

  if (plain.mt5ConfirmStatus === 'expired' || isConfirmExpired(plain.mt5ConfirmExpiresAt)) {
    await markManualConfirmExpired(plain);
    return { ok: false, reason: 'confirm_expired' };
  }

  await markManualConfirmIgnored(plain);
  return { ok: true, ignored: true };
}

let confirmExpiryTimer = null;

function startManualConfirmExpiryJob() {
  if (confirmExpiryTimer) return;
  const tick = () => {
    expirePendingManualConfirmations().catch(err =>
      console.warn('[TradeDelivery] confirm expiry sweep failed:', err.message)
    );
  };
  tick();
  confirmExpiryTimer = setInterval(tick, 30 * 1000);
  if (typeof confirmExpiryTimer.unref === 'function') confirmExpiryTimer.unref();
}

function stopManualConfirmExpiryJob() {
  if (confirmExpiryTimer) {
    clearInterval(confirmExpiryTimer);
    confirmExpiryTimer = null;
  }
}

async function deliverDurableJob(io, job, options = {}) {
  let subscriber = job?.payload?.subscriber;
  let signalDoc = job?.payload?.signal;
  if (!subscriber || !signalDoc) {
    const recovered = await DurableDelivery.rehydrateJobContext(job);
    if (recovered.ok) {
      subscriber = recovered.subscriber || subscriber;
      signalDoc = recovered.signal || signalDoc;
      job = recovered.job || job;
    } else if (recovered.retryable) {
      if (job?.jobId) {
        await DurableDelivery.scheduleRetry(job.jobId, { reason: recovered.reason || 'missing_channel_payload' });
      }
      return { ok: false, reason: recovered.reason || 'missing_channel_payload' };
    } else {
      if (job?.jobId) {
        await DurableDelivery.commitFailedTerminal(job.jobId, {
          reason: 'delivery_context_unrecoverable'
        });
      }
      try {
        const { emitTvDeliver } = require('../utils/tvStageLog');
        emitTvDeliver({
          ...DurableDelivery.correlationFromJob?.(job),
          ...(job || {}),
          channel: job?.channel,
          subscriberId: job?.subscriberId,
          deliveryJobId: job?.jobId,
          state: 'failed_terminal',
          reason: 'delivery_context_unrecoverable'
        });
      } catch {
        /* diagnostics */
      }
      return { ok: false, reason: 'delivery_context_unrecoverable' };
    }
  }
  if (!subscriber || !signalDoc) {
    if (job?.jobId) {
      await DurableDelivery.commitFailedTerminal(job.jobId, {
        reason: 'delivery_context_unrecoverable'
      });
    }
    return { ok: false, reason: 'delivery_context_unrecoverable' };
  }
  // Overlay-after-rehydrate: Mongo Signal is usually the original ENTRY.
  // Job identity (eventType / eventId / canonicalTradeId) is authoritative.
  signalDoc = overlayJobIdentityOnSignal(signalDoc, job);
  if (isEntryAlert(signalDoc.alertType || job.eventType || 'entry')) {
    const liveId = signalDoc._id || signalDoc.id || job.refs?.signalId || job.payload?.signal?._id;
    const live = liveId ? await loadSignalById(liveId) : null;
    if (live) signalDoc = mergeLiveLifecycleForEntryDelivery(signalDoc, live);
  }
  const ch = String(job.channel || '');
  const waitMode = options.waitMode;
  if (ch === 'telegram') {
    return deliverTelegram(subscriber, signalDoc, {
      ...(job.payload?.telegramOptions || {}),
      waitMode
    });
  }
  if (ch === 'email') {
    return deliverEmail(subscriber, signalDoc, { waitMode });
  }
  if (ch === 'socket') {
    return deliverInApp(io, signalDoc, subscriber, { waitMode });
  }
  if (ch === 'mt5') {
    return deliverMt5Auto(subscriber, signalDoc, { waitMode });
  }
  return { ok: false, reason: 'unknown_channel' };
}

function resolveExecutionMode(subscriber) {
  return Mt5TradeCopierService.resolveExecutionMode(subscriber);
}

module.exports = {
  resolveExecutionMode,
  toLiveAlertPayload,
  formatLiveAlertMessage,
  deliverToSubscriber,
  deliverInApp,
  deliverEmail,
  deliverTelegram,
  evaluateTelegramEligibility,
  deliverMt5Auto,
  queueManualExecution,
  ignoreManualExecution,
  markManualConfirmExpired,
  markManualConfirmIgnored,
  expirePendingManualConfirmations,
  startManualConfirmExpiryJob,
  stopManualConfirmExpiryJob,
  deliverDurableJob,
  waitForPostSlotSocketIdle,
  waitForDetachedProvidersForTests,
  ensureChannelDeliveryJobDurable,
  resetPostSlotSocketForTests,
  setTestBeforeSocket,
  getPostSlotSocketStatsForTests,
  resolveConfirmSeconds,
  formatConfirmWindowLabel,
  isExpectedMt5Skip,
  isExpectedTelegramSkip,
  resolveDeliveryStatus,
  resolveSignalDeliverySummary,
  MT5_EXPECTED_SKIP_REASONS,
  TELEGRAM_EXPECTED_SKIP_REASONS
};
