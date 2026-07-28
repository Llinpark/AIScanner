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

function isDbConnected() {
  return mongoose.connection.readyState === 1;
}

/**
 * Resolve Auto vs Manual MT5 execution for a subscriber.
 * Delegates to Mt5TradeCopierService so defaults stay in one place.
 */
function resolveExecutionMode(subscriber) {
  return Mt5TradeCopierService.resolveExecutionMode(subscriber);
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

  if (payload.userId) {
    // Per-user room only — avoids leaking Premium SMC / pair data to other tiers.
    io.to(`user:${payload.userId}`).emit('tv:live-alert', payload);
    io.to(`user:${payload.userId}`).emit('signal:update', forClient);
  } else {
    io.emit('tv:live-alert', payload);
    io.emit('signal:update', forClient);
  }

  return payload;
}

async function deliverEmail(subscriber, signalDoc) {
  if (!subscriber?.email) return false;
  if (!userHasTierFeature(subscriber, 'emailAlerts')) return false;

  // User may opt out via preferences.
  const prefs = subscriber.preferences || {};
  if (prefs.emailAlerts === false) return false;

  try {
    const signal = signalDoc?.toObject ? signalDoc.toObject() : signalDoc;
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

async function deliverTelegram(subscriber, signalDoc, { includeExecuteButton = false } = {}) {
  if (!userHasTierFeature(subscriber, 'telegramAlerts')) {
    return false;
  }

  try {
    return await TelegramService.notifySubscriber(subscriber, signalDoc, {
      includeExecuteButton
    });
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

  const signal = signalDoc?.toObject ? signalDoc.toObject() : { ...signalDoc };
  if (subscriber?.id && !signal.userId) {
    signal.userId = subscriber.id;
  }

  const executionMode = subscriber ? resolveExecutionMode(subscriber) : 'manual';
  const isEntry = isEntryAlert(signal.alertType || 'signal');
  const includeExecuteButton =
    Boolean(subscriber) &&
    isEntry &&
    executionMode === 'manual' &&
    userHasTierFeature(subscriber, 'mt5Execution');

  if (subscriber) {
    const emailOk = await deliverEmail(subscriber, signal);
    if (emailOk) emailSent = true;

    const tgOk = await deliverTelegram(subscriber, signal, { includeExecuteButton });
    if (tgOk) telegramSent = true;

    const mt5Result = await deliverMt5Auto(subscriber, signal);
    if (mt5Result?.ok) {
      mt5Sent = true;
      executionStatus = 'sent';
    } else if (
      mt5Result?.reason === 'mt5_not_linked' ||
      mt5Result?.reason === 'mt5_disabled' ||
      mt5Result?.reason === 'manual_mode' ||
      mt5Result?.reason === 'subscription_required' ||
      mt5Result?.reason === 'not_entry_signal'
    ) {
      executionStatus = executionStatus === 'pending' ? 'skipped' : executionStatus;
    }
  }

  const enrichedDoc = {
    ...signal,
    telegramSent,
    mt5Sent,
    emailSent,
    executionStatus,
    deliveryStatus: 'delivered'
  };

  await persistDeliveryFlags(enrichedDoc._id, {
    telegramSent,
    mt5Sent,
    emailSent,
    executionStatus,
    deliveryStatus: 'delivered'
  });

  const payload = await deliverInApp(io, enrichedDoc, subscriber);
  return payload;
}

/**
 * Manual Execute path (Telegram callback / future in-app). Always queues when allowed.
 */
async function queueManualExecution(userId, signalId) {
  return Mt5TradeCopierService.queueExecutionForUser(userId, signalId, { source: 'manual' });
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
  queueManualExecution
};
