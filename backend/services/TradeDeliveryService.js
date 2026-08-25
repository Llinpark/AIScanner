const mongoose = require('mongoose');
const Signal = require('../models/Signal');
const {
  sanitizeSignalForTier,
  userHasTierFeature,
  getEffectiveSubscription
} = require('../utils/subscriptionAccess');
const { isEntryAlert, isTerminalEntry } = require('../utils/signalOutcome');
const mailer = require('../utils/mailer');
const TelegramService = require('./TelegramService');
const SubscriberSignalFormatter = require('./SubscriberSignalFormatter');
const Mt5TradeCopierService = require('./Mt5TradeCopierService');
const { logPipeline, extractPipelineMeta } = require('../utils/pipelineLog');
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
 * MT5 expected-skip must not force failed when Telegram succeeded.
 * Telegram FAIL with MT5 SKIP (Telegram-only path) → failed.
 * Telegram PASS with MT5 FAIL (auto attempted) → partial.
 */
function resolveDeliveryStatus({ telegramSent, mt5Sent, tgPipelineStatus, mt5PipelineStatus }) {
  const tgFail = tgPipelineStatus === 'FAIL';
  const mt5Fail = mt5PipelineStatus === 'FAIL';
  const tgSkip = tgPipelineStatus === 'SKIP';
  const mt5Skip = mt5PipelineStatus === 'SKIP';
  const tgOk = tgPipelineStatus === 'PASS' || Boolean(telegramSent);
  const mt5Ok = mt5PipelineStatus === 'PASS' || Boolean(mt5Sent);

  if (tgFail && mt5Fail) return 'failed';
  // Telegram-only path: TG failed and MT5 was never required → overall failed.
  if (tgFail && mt5Skip) return 'failed';
  // MT5-auto path with no Telegram attempt: MT5 failed → overall failed.
  if (mt5Fail && tgSkip) return 'failed';
  // Mixed: one channel succeeded, the other genuinely failed.
  if ((tgFail && mt5Ok) || (mt5Fail && tgOk)) return 'partial';
  if (tgOk || mt5Ok || (tgSkip && mt5Skip)) return 'delivered';
  return 'delivered';
}

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
  if (Object.keys($set).length === 0) return;
  Signal.findByIdAndUpdate(signalId, { $set }).catch(err =>
    console.warn('[TradeDelivery] delivery status update failed:', err.message)
  );
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
  if (isEntryAlert(signal.alertType || 'entry') && isTerminalEntry(signal) && !signal.entryAcceptedAt) {
    return {
      eligible: false,
      status: TelegramService.TELEGRAM_STATUS.SKIPPED_STALE,
      reason: 'terminal_before_entry_delivery',
      tier,
      telegramEnabled,
      chatIdPresent
    };
  }
  if (SubscriberSignalFormatter.isStaleFreshEntry(signal)) {
    return {
      eligible: false,
      status: TelegramService.TELEGRAM_STATUS.SKIPPED_STALE,
      reason: 'stale_entry',
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

async function deliverInApp(io, signalDoc, subscriber) {
  const eventType = signalDoc?.alertType || 'entry';
  return DeliverySequencer.withChannelSequence({
    signalDoc,
    subscriberId: subscriber?.id || 'broadcast',
    channel: 'socket',
    alertType: eventType,
    send: async () => {
      const claimed = await claimDelivery(
        signalDoc,
        eventType,
        'socket',
        subscriber?.id || 'broadcast',
        { subscriber }
      );
      if (!claimed) return { skipped: true, reason: 'duplicate_milestone' };

      const forClient = subscriber?.subscription
        ? sanitizeSignalForTier(signalDoc, subscriber.subscription)
        : signalDoc;
      const payload = toLiveAlertPayload(forClient);

      // Delivery channels only — canonical lifecycle events are emitted once in broadcast.
      if (payload.userId) {
        io.to(`user:${payload.userId}`).emit('tv:live-alert', payload);
      } else {
        io.emit('tv:live-alert', payload);
      }

      await commitDeliverySuccess(signalDoc, eventType, 'socket', subscriber?.id || 'broadcast');
      return payload;
    }
  });
}

async function deliverEmail(subscriber, signalDoc) {
  if (!subscriber?.email) return { ok: false, reason: 'no_email' };
  if (!userHasTierFeature(subscriber, 'emailAlerts')) return { ok: false, reason: 'insufficient_tier' };

  const signal = signalDoc?.toObject ? signalDoc.toObject() : signalDoc;
  if (signal?.selfTest || process.env.PIPELINE_SELF_TEST_ACTIVE === 'true') {
    console.log('[TradeDelivery] email skipped (pipeline self-test)');
    return { ok: false, reason: 'self_test_skip' };
  }

  const prefs = subscriber.preferences || {};
  if (prefs.emailAlerts === false) return { ok: false, reason: 'opt_out' };

  if (isEntryAlert(signal.alertType || 'entry') && isTerminalEntry(signal) && !signal.entryAcceptedAt) {
    console.log('[TradeDelivery] email skipped (terminal_before_entry_delivery)');
    return { ok: false, reason: 'terminal_before_entry_delivery' };
  }
  if (SubscriberSignalFormatter.isStaleFreshEntry(signal)) {
    console.log('[TradeDelivery] email skipped (stale entry)');
    return { ok: false, reason: 'stale_entry' };
  }

  const eventType = signalDoc.alertType || signal.alertType || 'entry';
  return DeliverySequencer.withChannelSequence({
    signalDoc,
    subscriberId: subscriber.id,
    channel: 'email',
    alertType: eventType,
    send: async () => {
      const claimed = await claimDelivery(signalDoc, eventType, 'email', subscriber.id, {
        subscriber
      });
      if (!claimed) return { ok: false, reason: 'duplicate_milestone' };

      try {
        await DurableDelivery.markSendingBySpec(specFrom(signalDoc, eventType, 'email', subscriber.id));
        const result = await mailer.sendTradeAlertEmail({
          to: subscriber.email,
          displayName: subscriber.displayName,
          signal
        });
        if (result && result.ok === true) {
          await DurableDelivery.markProviderAcceptedBySpec(
            specFrom(signalDoc, eventType, 'email', subscriber.id)
          );
          await commitDeliverySuccess(signalDoc, eventType, 'email', subscriber.id);
          return { ok: true, reason: null };
        }
        const failReason = result?.reason || 'skipped_or_failed';
        if (EMAIL_EXPECTED_SKIP_REASONS.has(String(failReason))) {
          await commitDeliverySuccess(signalDoc, eventType, 'email', subscriber.id, {
            reason: failReason
          });
        } else {
          await recordDeliveryFailure(signalDoc, eventType, 'email', subscriber.id, {
            reason: failReason
          });
        }
        return {
          ok: false,
          reason: failReason,
          sentFallback: Boolean(result?.sentFallback)
        };
      } catch (err) {
        console.warn('[TradeDelivery] email failed:', err.message);
        await recordDeliveryFailure(signalDoc, eventType, 'email', subscriber.id, {
          reason: err.message || 'email_exception'
        });
        return { ok: false, reason: err.message || 'email_exception' };
      }
    }
  });
}

async function deliverTelegram(subscriber, signalDoc, options = {}) {
  // Not gated on MT5 — linked Telegram + telegramAlerts tier is enough (Alerts Only / notify-only).
  const meta = extractPipelineMeta(signalDoc || {});
  const subLabel = subscriber?.email || subscriber?.id || 'unknown';
  const eligibility = evaluateTelegramEligibility(subscriber, signalDoc);

  const signalPlain = signalDoc?.toObject ? signalDoc.toObject() : signalDoc || {};
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
    return {
      ok: false,
      status: eligibility.status,
      reason: eligibility.reason,
      tier: eligibility.tier,
      telegramEnabled: eligibility.telegramEnabled,
      chatIdPresent: eligibility.chatIdPresent
    };
  }

  const eventType = signalPlain.alertType || 'entry';
  const result = await DeliverySequencer.withChannelSequence({
    signalDoc,
    subscriberId: subscriber?.id,
    channel: 'telegram',
    alertType: eventType,
    send: async () => {
      const claimed = await claimDelivery(signalDoc, eventType, 'telegram', subscriber?.id, {
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

      try {
        await DurableDelivery.markSendingBySpec(
          specFrom(signalDoc, eventType, 'telegram', subscriber?.id)
        );
        const result = await TelegramService.notifySubscriber(subscriber, signalDoc, options);
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
        } else {
          const failReason = result?.reason || result?.description || 'telegram_send_failed';
          if (isExpectedTelegramSkip(failReason, result?.status)) {
            await commitDeliverySuccess(signalDoc, eventType, 'telegram', subscriber?.id, {
              reason: failReason
            });
          } else {
            await recordDeliveryFailure(signalDoc, eventType, 'telegram', subscriber?.id, {
              reason: failReason
            });
          }
        }
        return {
          ok,
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
        signal: DurableDelivery.snapshotSignal(signalDoc),
        telegramOptions: options
      }
    });
  }
  return result;
}

/**
 * Queue MT5 trade for AUTO mode only. Does not require Telegram.
 * MANUAL mode queues only via Telegram Execute (or future in-app Execute).
 */
async function deliverMt5Auto(subscriber, signalDoc) {
  const probe = signalDoc?.toObject ? signalDoc.toObject() : signalDoc;
  if (probe?.selfTest || process.env.PIPELINE_SELF_TEST_ACTIVE === 'true') {
    return { ok: false, reason: 'self_test_skip' };
  }

  if (!subscriber?.id || !signalDoc?._id) {
    return { ok: false, reason: 'missing_ids' };
  }

  if (!userHasTierFeature(subscriber, 'mt5Execution')) {
    return { ok: false, reason: 'subscription_required' };
  }

  if (!isEntryAlert(signalDoc.alertType || 'signal')) {
    return { ok: false, reason: 'not_entry_signal' };
  }

  const mode = resolveExecutionMode(subscriber);
  if (mode !== 'auto') {
    return { ok: false, reason: 'manual_mode' };
  }

  const eventType = signalDoc.alertType || 'entry';
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
      await commitDeliverySuccess(signalDoc, eventType, 'mt5', subscriber.id, {
        reason: queued?.reason
      });
    } else {
      await recordDeliveryFailure(signalDoc, eventType, 'mt5', subscriber.id, {
        reason: queued?.reason || 'queue_error'
      });
    }
    return queued;
  } catch (err) {
    console.warn('[TradeDelivery] MT5 auto queue failed:', err.message);
    await recordDeliveryFailure(signalDoc, eventType, 'mt5', subscriber.id, {
      reason: err.message || 'queue_error'
    });
    return { ok: false, reason: 'queue_error', message: err.message };
  }
}

/**
 * Dispatch one Signal to every delivery channel for a subscriber.
 * TradingViewAlertService should only validate/enrich/publish — this owns routing.
 */
async function deliverToSubscriber(io, signalDoc, subscriber = null) {
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

  const signal = signalDoc?.toObject ? signalDoc.toObject() : { ...signalDoc };
  if (subscriber?.id && !signal.userId) {
    signal.userId = subscriber.id;
  }

  const meta = extractPipelineMeta(signal);
  const subLabel = subscriber?.email || subscriber?.id || 'broadcast';

  const executionMode = subscriber ? resolveExecutionMode(subscriber) : 'manual';
  const telegramMode = subscriber ? resolveTelegramMode(subscriber) : TELEGRAM_MODES.MANUAL_CONFIRMATION;
  const isEntry = isEntryAlert(signal.alertType || 'signal');
  const mt5Linked =
    Boolean(subscriber) && Mt5TradeCopierService.isMt5Linked(subscriber.mt5 || {});
  // Pro Alerts Only: telegramMode preference while executionMode stays manual — no Execute/Ignore.
  const alertsOnly =
    Boolean(subscriber) && executionMode === 'manual' && isAlertsOnlyTelegram(subscriber);
  // Pro Manual Confirmation only — Alerts Only never shows Execute/Ignore; Premium Auto never does.
  const includeExecuteButton =
    Boolean(subscriber) &&
    isEntry &&
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

  if (includeExecuteButton) {
    mt5ConfirmStatus = 'pending';
    mt5ConfirmExpiresAt = computeConfirmExpiresAt(new Date(), confirmSeconds);
  }

  if (subscriber) {
    console.log(`[DELIVERY Email START] sub=${subLabel} symbol=${meta.symbol || 'n/a'}`);
    const emailResult = await deliverEmail(subscriber, signal);
    const emailOk = Boolean(emailResult?.ok);
    if (emailOk) emailSent = true;
    const emailSelfTest =
      signal?.selfTest || process.env.PIPELINE_SELF_TEST_ACTIVE === 'true';
    const emailReason = emailResult?.reason || (emailOk ? 'SUCCESS' : 'skipped_or_failed');
    const emailSkip = EMAIL_EXPECTED_SKIP_REASONS.has(String(emailReason || ''));
    const emailPipelineStatus = emailOk || emailSelfTest ? 'PASS' : emailSkip ? 'SKIP' : 'FAIL';
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

    console.log(`[DELIVERY Telegram START] sub=${subLabel} symbol=${meta.symbol || 'n/a'}`);
    const tgResult = await deliverTelegram(subscriber, signal, {
      includeExecuteButton,
      alertOnly: alertsOnly,
      confirmExpiresAt: mt5ConfirmExpiresAt,
      confirmSeconds
    });
    const tgOk = Boolean(tgResult?.ok);
    const tgStatus = tgResult?.status || TelegramService.TELEGRAM_STATUS.NOT_ATTEMPTED;
    const tgReason =
      tgResult?.description ||
      tgResult?.reason ||
      (tgOk ? 'SUCCESS' : 'skipped_or_failed');
    if (tgOk) {
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
    if (tgOk && subscriber?.id) {
      try {
        const PipelineSubscriberStatsService = require('./PipelineSubscriberStatsService');
        void PipelineSubscriberStatsService.recordDelivery(subscriber.id, 'telegram', meta);
      } catch {
        /* diagnostics */
      }
    }

    // Premium Automatic only — Pro Manual (including Alerts Only preference) never auto-queues.
    console.log(`[DELIVERY MT5 START] sub=${subLabel} symbol=${meta.symbol || 'n/a'}`);
    const mt5Result = await deliverMt5Auto(subscriber, signal);
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
    tgPipelineStatus,
    mt5PipelineStatus
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

  console.log(`[DELIVERY Socket START] sub=${subLabel} symbol=${meta.symbol || 'n/a'}`);
  try {
    const payload = await deliverInApp(io, enrichedDoc, subscriber);
    if (payload?.skipped) {
      logPipeline('DeliverySocket', 'SKIP', {
        ...meta,
        userId: subscriber?.id || null,
        reason: `SKIP; reason=${payload.reason || 'duplicate_milestone'}; sub=${subLabel}`
      });
      return payload;
    }
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
    console.warn(`[DELIVERY Socket FAILED] sub=${subLabel} err=${err.message}`);
    logPipeline('DeliverySocket', 'FAIL', {
      ...meta,
      userId: subscriber?.id || null,
      reason: `FAILED; ${err.message}; sub=${subLabel}`
    });
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

async function deliverDurableJob(io, job) {
  const subscriber = job?.payload?.subscriber;
  const signalDoc = job?.payload?.signal;
  if (!subscriber || !signalDoc) {
    if (job?.jobId) {
      await DurableDelivery.scheduleRetry(job.jobId, { reason: 'missing_channel_payload' });
    }
    return { ok: false, reason: 'missing_channel_payload' };
  }
  const ch = String(job.channel || '');
  if (ch === 'telegram') {
    return deliverTelegram(subscriber, signalDoc, job.payload?.telegramOptions || {});
  }
  if (ch === 'email') {
    return deliverEmail(subscriber, signalDoc);
  }
  if (ch === 'socket') {
    return deliverInApp(io, signalDoc, subscriber);
  }
  if (ch === 'mt5') {
    return deliverMt5Auto(subscriber, signalDoc);
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
  resolveConfirmSeconds,
  formatConfirmWindowLabel,
  isExpectedMt5Skip,
  isExpectedTelegramSkip,
  resolveDeliveryStatus,
  MT5_EXPECTED_SKIP_REASONS,
  TELEGRAM_EXPECTED_SKIP_REASONS
};
