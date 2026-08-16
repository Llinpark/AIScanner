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
    const saved = {
      ...signalData,
      createdAt: new Date(),
      _id: signalData._id || `mem_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    };
    if (Array.isArray(inMemorySignals)) {
      inMemorySignals.unshift(saved);
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
    const signal = new Signal(signalData);
    // Must await — otherwise ValidationError rejects escape the try/catch.
    const saved = await signal.save();
    if (Array.isArray(inMemorySignals)) {
      inMemorySignals.unshift(saved.toObject ? saved.toObject() : saved);
    }
    console.log(
      `[SIGNAL CREATE SUCCESS] requestId=${requestId} id=${saved._id} ` +
        `signalUuid=${saved.signalUuid || saved.signalId || meta.signalUuid || 'n/a'}`
    );
    console.log(
      `[SIGNAL PERSIST SUCCESS] requestId=${requestId} id=${saved._id} ` +
        `signalUuid=${saved.signalUuid || saved.signalId || meta.signalUuid || 'n/a'}`
    );
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

async function broadcastToSubscribers(io, signalData, inMemorySignals = [], options = {}) {
  const meta = extractPipelineMeta(signalData);
  const requestId = signalData.pipelineRequestId || 'n/a';
  const subscribers = await findActiveSubscribers();
  console.log(
    `[BROADCAST START] requestId=${requestId} signalUuid=${meta.signalUuid || 'n/a'} ` +
      `symbol=${meta.symbol || 'n/a'} timeframe=${meta.timeframe || 'n/a'} ` +
      `activeSubscribers=${subscribers.length}`
  );

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
    } else {
      logPipeline('Broadcast', 'FAIL', {
        ...meta,
        signalUuid: saved.signalUuid || saved.signalId || meta.signalUuid,
        reason: `NO_ELIGIBLE_SUBSCRIBERS; active=${subscribers.length}; skipped=${skipped.length}`
      });
    }
    return {
      delivered: 0,
      subscribers: [],
      broadcastSaved,
      skippedByEntitlement: subscribers.length,
      skipped,
      signalUuid: saved.signalUuid || saved.signalId
    };
  }

  const settled = await mapWithConcurrency(eligible, FANOUT_CONCURRENCY, async subscriber => {
    console.log(
      `[BROADCAST DELIVERY START] signalUuid=${saved.signalUuid || meta.signalUuid || 'n/a'} ` +
        `symbol=${meta.symbol || 'n/a'} userId=${subscriber.id || 'n/a'}`
    );
    await deliverLiveAlert(io, saved, subscriber);
    return { userId: subscriber.id, email: subscriber.email };
  });
  const results = settled.filter(Boolean);

  return {
    delivered: results.length,
    subscribers: results,
    broadcastSaved,
    skippedByEntitlement: subscribers.length - eligible.length,
    skipped,
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

  // Additive Pine client metadata (optional). Old payloads without these fields stay valid.
  const pineMeta = extractPineClientMeta(body);
  if (pineMeta.pineClientVersion) signalData.pineClientVersion = pineMeta.pineClientVersion;
  if (pineMeta.scriptGenerationId) signalData.scriptGenerationId = pineMeta.scriptGenerationId;
  if (pineMeta.generatedAt) signalData.pineGeneratedAt = pineMeta.generatedAt;
  if (pineMeta.capabilities.length) signalData.pineCapabilities = pineMeta.capabilities;
  signalData.pineCompatMode = pineMeta.mode;

  // Correlation only — not a Mongo schema field; stripped on strict persist, kept in-memory for diag.
  if (body.pipelineRequestId) {
    signalData.pipelineRequestId = String(body.pipelineRequestId);
  }

  // Option A additive identity/display fields (never required; never gate auth/delivery).
  const chartTf = body.chartTf || body.chart_tf || body.chartTimeframe || null;
  const canonicalSignalTf =
    body.canonicalSignalTf || body.canonical_signal_tf || body.canonicalTimeframe || null;
  const canonicalSignalKey =
    body.canonicalSignalKey || body.canonical_signal_key || permanentId || null;
  if (chartTf) signalData.chartTf = String(chartTf);
  if (canonicalSignalTf) signalData.canonicalSignalTf = String(canonicalSignalTf);
  if (canonicalSignalKey) signalData.canonicalSignalKey = String(canonicalSignalKey);

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
  // Keep request correlation across lifecycle rebuilds (diagnostics only).
  if (baseData.pipelineRequestId && signalData && !signalData.pipelineRequestId) {
    signalData.pipelineRequestId = baseData.pipelineRequestId;
  }

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
