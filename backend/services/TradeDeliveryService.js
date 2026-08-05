const mongoose = require('mongoose');
const Signal = require('../models/Signal');
const {
  sanitizeSignalForTier,
  userHasTierFeature
} = require('../utils/subscriptionAccess');
const { isEntryAlert } = require('../utils/signalOutcome');
const { formatKachingAlertMessage } = require('../utils/kachingSignalLevels');
const { sendTradeAlertEmail } = require('../utils/mailer');
const TelegramService = require('./TelegramService');
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

function isDbConnected() {
  return mongoose.connection.readyState === 1;
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
  return formatKachingAlertMessage(signal);
}

function toLiveAlertPayload(signalDoc) {
  const signal = signalDoc.toObject ? signalDoc.toObject() : signalDoc;
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
    notes: signal.notes,
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
    message: formatLiveAlertMessage(signal)
  };
}

async function persistDeliveryFlags(signalId, flags) {
  if (!isDbConnected() || !signalId || String(signalId).startsWith('mem_')) return;
  Signal.findByIdAndUpdate(signalId, flags).catch(err =>
    console.warn('[TradeDelivery] delivery status update failed:', err.message)
  );
}

async function deliverInApp(io, signalDoc, subscriber) {
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

  return payload;
}

async function deliverEmail(subscriber, signalDoc) {
  if (!subscriber?.email) return false;
  if (!userHasTierFeature(subscriber, 'emailAlerts')) return false;

  // Dev pipeline self-test must not email real subscribers.
  const signal = signalDoc?.toObject ? signalDoc.toObject() : signalDoc;
  if (signal?.selfTest || process.env.PIPELINE_SELF_TEST_ACTIVE === 'true') {
    console.log('[TradeDelivery] email skipped (pipeline self-test)');
    return false;
  }

  // User may opt out via preferences.
  const prefs = subscriber.preferences || {};
  if (prefs.emailAlerts === false) return false;

  try {
    const result = await sendTradeAlertEmail({
      to: subscriber.email,
      displayName: subscriber.displayName,
      signal
    });
    return Boolean(result);
  } catch (err) {
    console.warn('[TradeDelivery] email failed:', err.message);
    return false;
  }
}

async function deliverTelegram(subscriber, signalDoc, options = {}) {
  if (!userHasTierFeature(subscriber, 'telegramAlerts')) {
    return false;
  }

  const signal = signalDoc?.toObject ? signalDoc.toObject() : signalDoc;
  if (signal?.selfTest || process.env.PIPELINE_SELF_TEST_ACTIVE === 'true') {
    console.log('[TradeDelivery] telegram skipped (pipeline self-test)');
    return false;
  }

  try {
    return await TelegramService.notifySubscriber(subscriber, signalDoc, options);
  } catch (err) {
    console.warn('[TradeDelivery] telegram failed:', err.message);
    return false;
  }
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

  try {
    return await Mt5TradeCopierService.queueExecutionForUser(subscriber.id, signalDoc._id, {
      source: 'auto'
    });
  } catch (err) {
    console.warn('[TradeDelivery] MT5 auto queue failed:', err.message);
    return { ok: false, reason: 'queue_error', message: err.message };
  }
}

/**
 * Dispatch one Signal to every delivery channel for a subscriber.
 * TradingViewAlertService should only validate/enrich/publish — this owns routing.
 */
async function deliverToSubscriber(io, signalDoc, subscriber = null) {
  let telegramSent = Boolean(signalDoc.telegramSent);
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

  if (includeExecuteButton) {
    mt5ConfirmStatus = 'pending';
    mt5ConfirmExpiresAt = computeConfirmExpiresAt(new Date(), confirmSeconds);
  }

  if (subscriber) {
    const emailOk = await deliverEmail(subscriber, signal);
    if (emailOk) emailSent = true;
    const emailSelfTest =
      signal?.selfTest || process.env.PIPELINE_SELF_TEST_ACTIVE === 'true';
    logPipeline('DeliveryEmail', emailOk || emailSelfTest ? 'PASS' : 'FAIL', {
      ...meta,
      reason: emailOk
        ? `to=${subscriber.email}`
        : emailSelfTest
          ? `self_test_skip; sub=${subLabel}`
          : `skipped_or_failed; sub=${subLabel}`
    });

    const tgOk = await deliverTelegram(subscriber, signal, {
      includeExecuteButton,
      alertOnly: alertsOnly,
      confirmExpiresAt: mt5ConfirmExpiresAt,
      confirmSeconds
    });
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
    logPipeline('DeliveryTelegram', tgOk || emailSelfTest ? 'PASS' : 'FAIL', {
      ...meta,
      reason: tgOk
        ? `sub=${subLabel}; mode=${executionMode}; telegramMode=${telegramMode}${alertsOnly ? '; telegram_alert_sent' : ''}`
        : emailSelfTest
          ? `self_test_skip; sub=${subLabel}`
          : `skipped_or_failed; sub=${subLabel}`
    });

    // Premium Automatic only — Pro Manual (including Alerts Only preference) never auto-queues.
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
    const mt5Ok = Boolean(mt5Result?.ok) || mt5Reason === 'self_test_skip';
    logPipeline('DeliveryMT5', mt5Ok ? 'PASS' : 'FAIL', {
      ...meta,
      reason: `${mt5Reason}; mode=${executionMode}; telegramMode=${telegramMode}; sub=${subLabel}`
    });
  }

  const enrichedDoc = {
    ...signal,
    telegramSent,
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
    deliveryStatus: 'delivered'
  };

  await persistDeliveryFlags(enrichedDoc._id, {
    telegramSent,
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
    deliveryStatus: 'delivered'
  });

  const payload = await deliverInApp(io, enrichedDoc, subscriber);
  logPipeline('DeliverySocket', 'PASS', {
    ...meta,
    reason: `tv:live-alert; sub=${subLabel}; email=${emailSent}; tg=${telegramSent}; mt5=${mt5Sent}`
  });
  return payload;
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
  deliverMt5Auto,
  queueManualExecution,
  ignoreManualExecution,
  markManualConfirmExpired,
  markManualConfirmIgnored,
  expirePendingManualConfirmations,
  startManualConfirmExpiryJob,
  stopManualConfirmExpiryJob,
  resolveConfirmSeconds,
  formatConfirmWindowLabel
};
