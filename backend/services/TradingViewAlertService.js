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
  const meta = extractPipelineMeta(signalData);

  if (!isDbConnected()) {
    const saved = {
      ...signalData,
      createdAt: new Date(),
      _id: signalData._id || `mem_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    };
    if (Array.isArray(inMemorySignals)) {
      inMemorySignals.unshift(saved);
    }
    logPipeline('MongoSave', 'PASS', {
      ...meta,
      reason: `in_memory_fallback; id=${saved._id}`
    });
    return saved;
  }

  try {
    const signal = new Signal(signalData);
    // Must await — otherwise ValidationError rejects escape the try/catch.
    const saved = await signal.save();
    if (Array.isArray(inMemorySignals)) {
      inMemorySignals.unshift(saved.toObject ? saved.toObject() : saved);
    }
    logPipeline('MongoSave', 'PASS', {
      ...meta,
      signalUuid: saved.signalUuid || saved.signalId || meta.signalUuid,
      reason: `id=${saved._id}`
    });
    return saved;
  } catch (error) {
    const details =
      error?.errors
        ? Object.entries(error.errors)
            .map(([k, v]) => `${k}:${v?.message || v}`)
            .join(', ')
        : error.message;
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

/**
 * One Pine signal → ONE Mongo Signal document → fan-out delivery.
 * Never clones Signal docs per subscriber.
 */
async function broadcastToSubscribers(io, signalData, inMemorySignals = [], options = {}) {
  const subscribers = await findActiveSubscribers();
  const eligible = subscribers.filter(sub => subscriberAllowsSignal(sub, signalData));

  let saved = options.existingSaved || null;
  let broadcastSaved = false;

  if (!saved) {
    // Persist once (broadcast record). Levels come only from TradingView payload.
    const enriched = await SignalEnrichmentService.enrichFromTradingViewWebhook(
      { ...signalData, isBroadcast: true },
      {
        fromTradingViewWebhook: true,
        skipMarketData: true,
        timeframe: signalData.timeframe || '1h'
      }
    );
    saved = await saveSignal(enriched, inMemorySignals);
    broadcastSaved = true;
  }

  emitLifecycleSocket(io, saved, signalData.alertType);

  if (eligible.length === 0) {
    if (subscribers.length === 0) {
      await deliverLiveAlert(io, saved);
    }
    return {
      delivered: 0,
      subscribers: [],
      broadcastSaved,
      skippedByEntitlement: subscribers.length,
      signalUuid: saved.signalUuid || saved.signalId
    };
  }

  const settled = await mapWithConcurrency(eligible, FANOUT_CONCURRENCY, async subscriber => {
    await deliverLiveAlert(io, saved, subscriber);
    return { userId: subscriber.id, email: subscriber.email };
  });
  const results = settled.filter(Boolean);

  return {
    delivered: results.length,
    subscribers: results,
    broadcastSaved,
    skippedByEntitlement: subscribers.length - eligible.length,
    signalUuid: saved.signalUuid || saved.signalId
  };
}

function emitLifecycleSocket(io, signalDoc, alertType) {
  if (!io || !signalDoc) return;
  const payload = signalDoc.toObject ? signalDoc.toObject() : signalDoc;
  const type = String(alertType || payload.alertType || '').toLowerCase();
  const TradeLifecycle = require('./TradeLifecycleService');

  if (TradeLifecycle.isEntryAlert(type)) {
    io.emit('signal_created', payload);
    io.emit('signal:update', payload); // legacy alias
    return;
  }
  if (TradeLifecycle.isTerminalAlert(type)) {
    io.emit('signal_closed', payload);
    io.emit('signal:outcome', payload); // legacy alias
    return;
  }
  if (TradeLifecycle.isOutcomeAlert(type) || TradeLifecycle.isPartialAlert(type)) {
    io.emit('signal_updated', payload);
    io.emit('signal:outcome', payload); // legacy alias
  }
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
    notes: body.message || body.note || body.notes || KACHING_ALERT_NAMES.signal,
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
    // Dev self-test marker — never set by TradingView Pine; suppresses external fan-out.
    selfTest: body.selfTest === true || body.self_test === true || undefined
  };

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
        `[TV Webhook] Validation rejected fields=${rejected.join(',') || 'n/a'} ` +
          `symbol=${signalData.symbol} msg=${error.message}`
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
async function processTradingViewWebhook(io, rawBody, inMemorySignals = []) {
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
      reason: 'forbidden_reset_payload',
      message:
        'No-Signal / active=false / delete resets are rejected. Active trades persist until TP3/SL/expiry/cancel.'
    };
  }

  const baseData = buildSignalData(body);

  // Any TradingView instrument is accepted — chart OHLC is the source of truth.
  // Symbol allowlists are not used for webhook ingest.

  // Single source of truth: registry + DB + state machine (symbol+timeframe+strategy).
  const lifecycle = await TradeLifecycleService.processIncomingTradeAlert(
    baseData,
    inMemorySignals,
    { fromTradingViewWebhook: true, skipMarketData: true }
  );

  if (lifecycle.rejected) {
    logPipeline('Lifecycle', 'FAIL', {
      ...extractPipelineMeta(baseData),
      reason: lifecycle.reason || 'lifecycle_rejected'
    });
    return {
      mode: 'rejected',
      publishOnly: true,
      rejected: true,
      reason: lifecycle.reason,
      activeSignal: lifecycle.activeSignal,
      message: lifecycle.message
    };
  }

  const { signalData, updatedEntry } = lifecycle;

  logPipeline('Lifecycle', 'PASS', {
    ...extractPipelineMeta(signalData),
    reason: updatedEntry ? 'outcome_linked' : 'entry_accepted'
  });

  // Outcomes update the single parent Signal; entries create one broadcast Signal.
  const delivery = await broadcastToSubscribers(
    io,
    updatedEntry
      ? {
          ...(updatedEntry.toObject ? updatedEntry.toObject() : updatedEntry),
          alertType: signalData.alertType
        }
      : signalData,
    inMemorySignals,
    {
      fromTradingViewWebhook: true,
      skipMarketData: true,
      existingSaved: updatedEntry || undefined
    }
  );

  logSignalEvent('broadcast', {
    symbol: signalData.symbol,
    timeframe: signalData.timeframe,
    alertType: signalData.alertType,
    signalUuid: signalData.signalUuid || signalData.signalId || signalData.signalGroupId,
    lifecycleStage: signalData.lifecycleStage,
    reason: `delivered=${delivery.delivered}`
  });

  console.log(
    `[TV Webhook] Published ${signalData.alertType} ${signalData.symbol} ` +
      `tf=${signalData.timeframe || '-'} uuid=${signalData.signalUuid || signalData.signalId || '-'} ` +
      `(publish-only, delivered=${delivery.delivered}, skipped=${delivery.skippedByEntitlement || 0}, no market-data fetch)`
  );

  return {
    mode: 'broadcast',
    publishOnly: true,
    outcomeLinked: Boolean(updatedEntry),
    signalUuid: signalData.signalUuid || signalData.signalId || signalData.signalGroupId,
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
  isForbiddenResetPayload,
  KACHING_ALERT_NAMES
};
