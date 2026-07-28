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
const SignalOutcomeService = require('../services/SignalOutcomeService');
const SignalEnrichmentService = require('../services/SignalEnrichmentService');
const TradeDeliveryService = require('../services/TradeDeliveryService');
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

const FANOUT_CONCURRENCY = Math.max(
  1,
  Math.min(32, Number(process.env.TV_FANOUT_CONCURRENCY || 8))
);

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

/**
 * Publish a saved Signal through TradeDeliveryService (Socket.IO, email, Telegram, MT5).
 * TradingViewAlertService no longer drives Telegram or MT5 directly.
 */
async function deliverLiveAlert(io, signalDoc, subscriber = null) {
  return TradeDeliveryService.deliverToSubscriber(io, signalDoc, subscriber);
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

  const settled = await mapWithConcurrency(eligible, FANOUT_CONCURRENCY, async subscriber => {
    await deliverLiveAlert(io, savedSignal, subscriber);
    return { userId: subscriber.id, email: subscriber.email };
  });
  results.push(...settled.filter(Boolean));

  return {
    delivered: results.length,
    subscribers: results,
    skippedByEntitlement: subscribers.length - eligible.length
  };
}

async function broadcastToSubscribers(io, signalData, inMemorySignals = [], options = {}) {
  const subscribers = await findActiveSubscribers();
  const eligible = subscribers.filter(sub => subscriberAllowsSignal(sub, signalData));

  if (options.existingSaved) {
    const delivery = await deliverBroadcastToSubscribers(io, options.existingSaved, subscribers);
    return { ...delivery, broadcastSaved: false, reusedExisting: true };
  }

  const results = [];

  if (eligible.length === 0) {
    // Still persist one broadcast record for audit when nobody is entitled.
    const saved = await saveSignal({ ...signalData, isBroadcast: true }, inMemorySignals);
    if (subscribers.length === 0) {
      await deliverLiveAlert(io, saved);
    }
    return {
      delivered: 0,
      subscribers: [],
      broadcastSaved: true,
      skippedByEntitlement: subscribers.length
    };
  }

  const settled = await mapWithConcurrency(eligible, FANOUT_CONCURRENCY, async subscriber => {
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
    return { userId: subscriber.id, email: subscriber.email };
  });
  results.push(...settled.filter(Boolean));

  return {
    delivered: results.length,
    subscribers: results,
    broadcastSaved: true,
    skippedByEntitlement: subscribers.length - eligible.length
  };
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
    emailSent: false,
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
 * TradingView webhook / inject path — validate, enrich, and publish a Signal.
 * Delivery (Socket.IO / email / Telegram / MT5) is owned by TradeDeliveryService.
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
      `(publish-only, delivered=${delivery.delivered}, skipped=${delivery.skippedByEntitlement || 0}, no market-data fetch)`
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
  subscriberAllowsSignal,
  saveSignal,
  deliverLiveAlert,
  broadcastToSubscribers,
  processIncomingWebhook,
  processTradingViewWebhook,
  publishTradingViewAlert,
  buildSignalData,
  KACHING_ALERT_NAMES
};
