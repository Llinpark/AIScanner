const mongoose = require('mongoose');
const Signal = require('../models/Signal');
const UserConfig = require('../models/User');
const { userCanAccessLiveAlerts, getEffectiveSubscription } = require('../utils/subscriptionAccess');
const devUserStore = require('../utils/devUserStore');
const {
  KACHING_ALERT_NAMES,
  normalizeSignalLevels,
  validateKachingEntrySignal,
  formatKachingAlertMessage
} = require('../utils/kachingSignalLevels');
const SignalOutcomeService = require('../services/SignalOutcomeService');
const SignalEnrichmentService = require('../services/SignalEnrichmentService');
const TelegramService = require('../services/TelegramService');
const { normalizeSymbol } = require('../config/symbols');

function isDbConnected() {
  return mongoose.connection.readyState === 1;
}

function useDevUserStore() {
  return !isDbConnected();
}

const ALERT_TYPES = new Set([
  'entry',
  'stop_loss',
  'take_profit_1',
  'take_profit_2',
  'take_profit_3',
  'signal'
]);

function normalizeAlertType(value) {
  const raw = String(value || 'signal').trim().toLowerCase();
  if (raw === 'sl' || raw === 'stoploss') return 'stop_loss';
  if (raw === 'tp' || raw === 'tp1') return 'take_profit_1';
  if (raw === 'tp2') return 'take_profit_2';
  if (raw === 'tp3') return 'take_profit_3';
  return ALERT_TYPES.has(raw) ? raw : 'signal';
}

function normalizeTradingViewUsername(value) {
  return String(value || '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase();
}

function parseWebhookBody(body) {
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }

  if (!body || typeof body !== 'object') {
    return {};
  }

  if (typeof body.message === 'string') {
    try {
      const parsed = JSON.parse(body.message);
      return { ...body, ...parsed };
    } catch {
      return body;
    }
  }

  return body;
}

function formatLiveAlertMessage(signal) {
  return formatKachingAlertMessage(signal);
}

function toLiveAlertPayload(signalDoc) {
  const signal = signalDoc.toObject ? signalDoc.toObject() : signalDoc;
  return {
    id: signal._id,
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
    userId: signal.userId,
    createdAt: signal.createdAt,
    message: formatLiveAlertMessage(signal)
  };
}

function toSubscriberRecord(user) {
  if (!user || !userCanAccessLiveAlerts(user)) return null;
  return {
    id: user._id?.toString() || user.id,
    email: user.email,
    displayName: user.displayName,
    subscription: getEffectiveSubscription(user),
    telegram: user.telegram || null,
    mt5: user.mt5 || null
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
    const users = await UserConfig.find({});
    return users.map(toSubscriberRecord).filter(Boolean);
  } catch (error) {
    console.warn('[Alerts] findActiveSubscribers fallback:', error.message);
    return devUserStore
      .listActiveSubscribers()
      .map(toSubscriberRecord)
      .filter(Boolean);
  }
}

async function saveSignal(signalData, inMemorySignals) {
  if (!isDbConnected()) {
    const saved = {
      ...signalData,
      createdAt: new Date(),
      _id: signalData._id || `mem_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    };
    if (Array.isArray(inMemorySignals)) {
      inMemorySignals.unshift(saved);
    }
    return saved;
  }

  try {
    const signal = new Signal(signalData);
    return signal.save();
  } catch (error) {
    console.warn('[Alerts] saveSignal fallback:', error.message);
    return { ...signalData, createdAt: new Date(), _id: null };
  }
}

async function deliverLiveAlert(io, signalDoc, subscriber = null) {
  let telegramSent = Boolean(signalDoc.telegramSent);
  let mt5Sent = Boolean(signalDoc.mt5Sent);
  let executionStatus = signalDoc.executionStatus || 'pending';

  if (subscriber) {
    try {
      const tgResult = await TelegramService.notifySubscriber(subscriber, signalDoc);
      if (tgResult !== false) {
        telegramSent = true;
      }
    } catch (err) {
      console.warn('[Telegram] notify failed:', err.message);
    }

    try {
      const Mt5TradeCopierService = require('./Mt5TradeCopierService');
      if (subscriber?.id && signalDoc?._id && typeof Mt5TradeCopierService.queueExecutionForUser === 'function') {
        const mt5Result = await Mt5TradeCopierService.queueExecutionForUser(subscriber.id, signalDoc._id);
        if (mt5Result?.ok) {
          mt5Sent = true;
          executionStatus = 'sent';
        } else if (mt5Result?.reason === 'mt5_not_linked' || mt5Result?.reason === 'mt5_disabled') {
          executionStatus = executionStatus === 'pending' ? 'skipped' : executionStatus;
        }
      }
    } catch (err) {
      // MT5 is optional; never fail webhook distribution because of copier errors.
      console.warn('[MT5] queue failed:', err.message);
    }
  }

  const enrichedDoc = {
    ...(signalDoc.toObject ? signalDoc.toObject() : signalDoc),
    telegramSent,
    mt5Sent,
    executionStatus,
    deliveryStatus: 'delivered'
  };

  // Persist delivery flags when we have a real Mongo document id.
  if (isDbConnected() && enrichedDoc._id && !String(enrichedDoc._id).startsWith('mem_')) {
    Signal.findByIdAndUpdate(enrichedDoc._id, {
      telegramSent,
      mt5Sent,
      executionStatus,
      deliveryStatus: 'delivered'
    }).catch(err => console.warn('[Alerts] delivery status update failed:', err.message));
  }

  const payload = toLiveAlertPayload(enrichedDoc);

  if (payload.userId) {
    io.to(`user:${payload.userId}`).emit('tv:live-alert', payload);
  }

  io.emit('signal:update', enrichedDoc);

  return payload;
}

async function deliverBroadcastToSubscribers(io, savedSignal, subscribers) {
  const results = [];

  if (subscribers.length === 0) {
    await deliverLiveAlert(io, savedSignal);
    return { delivered: 0, subscribers: [] };
  }

  for (const subscriber of subscribers) {
    await deliverLiveAlert(io, savedSignal, subscriber);
    results.push({ userId: subscriber.id, email: subscriber.email });
  }

  return { delivered: results.length, subscribers: results };
}

async function broadcastToSubscribers(io, signalData, inMemorySignals = [], options = {}) {
  const subscribers = await findActiveSubscribers();

  if (options.existingSaved) {
    const delivery = await deliverBroadcastToSubscribers(io, options.existingSaved, subscribers);
    return { ...delivery, broadcastSaved: false, reusedExisting: true };
  }

  const results = [];

  if (subscribers.length === 0) {
    const saved = await saveSignal({ ...signalData, isBroadcast: true }, inMemorySignals);
    await deliverLiveAlert(io, saved);
    return { delivered: 0, subscribers: [], broadcastSaved: true };
  }

  for (const subscriber of subscribers) {
    const mt5 = subscriber.mt5 || {};
    const basePayload = { ...signalData, userId: subscriber.id, isBroadcast: true };

    // Always metadata enrichment for distributed signals — never candles / live providers.
    const enriched = await SignalEnrichmentService.enrichFromTradingViewWebhook(basePayload, {
      fromTradingViewWebhook: true,
      skipMarketData: true,
      userId: subscriber.id,
      subscriber,
      accountBalance: mt5.accountBalance,
      riskPercent: mt5.riskPercent || 1,
      timeframe: signalData.timeframe || '1h'
    });

    const saved = await saveSignal(enriched, inMemorySignals);

    await deliverLiveAlert(io, saved, subscriber);
    results.push({ userId: subscriber.id, email: subscriber.email });
  }

  return { delivered: results.length, subscribers: results, broadcastSaved: true };
}

function buildSignalData(body) {
  const direction = String(body.direction || body.action || 'neutral').toLowerCase();
  const levels = normalizeSignalLevels(body, direction);
  const strategyName =
    body.strategyName ||
    body.strategy_name ||
    body.strategy ||
    body.patternLabel ||
    body.pattern_label ||
    null;
  const timeframe = body.timeframe || body.interval || body.tf || '1h';

  const signalData = {
    symbol: normalizeSymbol(body.symbol || body.ticker || 'UNKNOWN'),
    direction,
    ...levels,
    confidence: Math.min(Math.max(parseFloat(body.confidence || 0) || 0, 0), 1),
    notes: body.message || body.note || body.notes || KACHING_ALERT_NAMES.signal,
    alertType: normalizeAlertType(body.alertType || body.alert_type || body.type),
    pattern: body.pattern || null,
    patternLabel: body.patternLabel || body.pattern_label || null,
    gapTop: parseFloat(body.gapTop || body.gap_top || 0) || undefined,
    gapBottom: parseFloat(body.gapBottom || body.gap_bottom || 0) || undefined,
    strategy: strategyName,
    strategyName,
    timeframe,
    signalSource: 'tradingview',
    source: 'tradingview',
    origin: 'tradingview_webhook',
    deliveryStatus: 'pending',
    executionStatus: 'pending',
    telegramSent: false,
    mt5Sent: false,
    chartSnapshot: body.chartSnapshot || body.chart_snapshot || undefined
  };

  if (signalData.pattern === 'perfect_fvg' && !signalData.patternLabel) {
    signalData.patternLabel = 'Pattern A: Perfect Fair Value Gap';
  }
  if (signalData.pattern === 'breakaway_gap' && !signalData.patternLabel) {
    signalData.patternLabel = 'Pattern B: Breakaway Gap';
  }

  validateKachingEntrySignal(signalData);

  return signalData;
}

/**
 * TradingView webhook / inject path — validate, persist, and publish only.
 * Never fetches candles, never runs indicator / liquidity / FVG / SMC pipelines.
 */
async function processTradingViewWebhook(io, rawBody, inMemorySignals = []) {
  const body = parseWebhookBody(rawBody);
  const baseData = buildSignalData(body);

  const { signalData, updatedEntry } = await SignalOutcomeService.processSignalLifecycle(
    baseData,
    inMemorySignals,
    { fromTradingViewWebhook: true, skipMarketData: true }
  );

  if (updatedEntry) {
    io.emit('signal:outcome', updatedEntry);
  }

  const delivery = await broadcastToSubscribers(io, signalData, inMemorySignals, {
    fromTradingViewWebhook: true,
    skipMarketData: true
  });

  console.log(
    `[TV Webhook] Published ${signalData.alertType} ${signalData.symbol} ` +
      `(publish-only, delivered=${delivery.delivered}, no market-data fetch)`
  );

  return {
    mode: 'broadcast',
    publishOnly: true,
    outcomeLinked: Boolean(updatedEntry),
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

module.exports = {
  ALERT_TYPES,
  normalizeAlertType,
  normalizeTradingViewUsername,
  parseWebhookBody,
  formatLiveAlertMessage,
  toLiveAlertPayload,
  findActiveSubscribers,
  saveSignal,
  deliverLiveAlert,
  broadcastToSubscribers,
  processIncomingWebhook,
  processTradingViewWebhook,
  publishTradingViewAlert,
  buildSignalData,
  KACHING_ALERT_NAMES
};
