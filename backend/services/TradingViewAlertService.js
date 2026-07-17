const mongoose = require('mongoose');
const Signal = require('../models/Signal');
const UserConfig = require('../models/User');
const { canAccessLiveAlerts } = require('../utils/subscriptionAccess');
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
    userId: signal.userId,
    createdAt: signal.createdAt,
    message: formatLiveAlertMessage(signal)
  };
}

function toSubscriberRecord(user) {
  if (!user || !canAccessLiveAlerts(user.subscription)) return null;
  return {
    id: user._id?.toString() || user.id,
    email: user.email,
    displayName: user.displayName,
    subscription: user.subscription,
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
  const payload = toLiveAlertPayload(signalDoc);

  if (payload.userId) {
    io.to(`user:${payload.userId}`).emit('tv:live-alert', payload);
  }

  io.emit('signal:update', signalDoc);

  if (subscriber) {
    TelegramService.notifySubscriber(subscriber, signalDoc).catch(err =>
      console.warn('[Telegram] notify failed:', err.message)
    );
  }

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
    const MarketScannerService = require('../services/MarketScannerService');
    const candles = MarketScannerService.getCandles(signalData.symbol);
    const enriched = await SignalEnrichmentService.enrichSignal(
      { ...signalData, userId: subscriber.id, isBroadcast: true },
      {
        accountBalance: mt5.accountBalance,
        riskPercent: mt5.riskPercent || 1,
        candles,
        timeframe: signalData.timeframe || '1h'
      }
    );

    const saved = await saveSignal(enriched, inMemorySignals);

    await deliverLiveAlert(io, saved, subscriber);
    results.push({ userId: subscriber.id, email: subscriber.email });
  }

  return { delivered: results.length, subscribers: results, broadcastSaved: true };
}

function buildSignalData(body) {
  const direction = String(body.direction || body.action || 'neutral').toLowerCase();
  const levels = normalizeSignalLevels(body, direction);

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
    source: 'tradingview'
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

async function processIncomingWebhook(io, rawBody, inMemorySignals = []) {
  const body = parseWebhookBody(rawBody);
  const baseData = buildSignalData(body);
  const { signalData, updatedEntry } = await SignalOutcomeService.processSignalLifecycle(
    baseData,
    inMemorySignals
  );

  if (updatedEntry) {
    io.emit('signal:outcome', updatedEntry);
  }

  return {
    mode: 'broadcast',
    outcomeLinked: Boolean(updatedEntry),
    ...(await broadcastToSubscribers(io, signalData, inMemorySignals))
  };
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
  buildSignalData,
  KACHING_ALERT_NAMES
};
