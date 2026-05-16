const mongoose = require('mongoose');
const Signal = require('../models/Signal');
const UserConfig = require('../models/User');
const { canAccessTradingViewAlerts } = require('../utils/subscriptionAccess');

function isDbConnected() {
  return mongoose.connection.readyState === 1;
}

const ALERT_TYPES = new Set([
  'entry',
  'stop_loss',
  'take_profit_1',
  'take_profit_2',
  'take_profit_3',
  'signal'
]);

function normalizeTradingViewUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeAlertType(value) {
  const raw = String(value || 'signal').trim().toLowerCase();
  if (raw === 'sl' || raw === 'stoploss') return 'stop_loss';
  if (raw === 'tp' || raw === 'tp1') return 'take_profit_1';
  if (raw === 'tp2') return 'take_profit_2';
  if (raw === 'tp3') return 'take_profit_3';
  return ALERT_TYPES.has(raw) ? raw : 'signal';
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
  const typeLabel = {
    entry: 'ENTRY',
    stop_loss: 'STOP LOSS',
    take_profit_1: 'TAKE PROFIT 1',
    take_profit_2: 'TAKE PROFIT 2',
    take_profit_3: 'TAKE PROFIT 3',
    signal: 'SIGNAL'
  }[signal.alertType] || 'SIGNAL';

  return `${typeLabel} ${signal.direction.toUpperCase()} ${signal.symbol} | Entry ${signal.entry} | SL ${signal.stop_loss} | TP1 ${signal.take_profit_1} | TP2 ${signal.take_profit_2} | TP3 ${signal.take_profit_3}`;
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
    take_profit_1: signal.take_profit_1,
    take_profit_2: signal.take_profit_2,
    take_profit_3: signal.take_profit_3,
    confidence: signal.confidence,
    notes: signal.notes,
    tradingviewUsername: signal.tradingviewUsername,
    appUsername: signal.appUsername,
    createdAt: signal.createdAt,
    message: formatLiveAlertMessage(signal)
  };
}

async function findSubscriberByTvUsername(tradingviewUsername) {
  const normalized = normalizeTradingViewUsername(tradingviewUsername);
  if (!normalized || !isDbConnected()) return null;

  const user = await UserConfig.findOne({
    tradingviewUsername: { $regex: new RegExp(`^${escapeRegex(normalized)}$`, 'i') }
  });

  if (!user || !canAccessTradingViewAlerts(user.subscription)) {
    return null;
  }

  return user;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findActiveSubscribers() {
  if (!isDbConnected()) {
    return [];
  }

  try {
    const users = await UserConfig.find({
      tradingviewUsername: { $exists: true, $ne: '' }
    });
    return users.filter(user => canAccessTradingViewAlerts(user.subscription));
  } catch (error) {
    console.warn('[TradingView] findActiveSubscribers skipped:', error.message);
    return [];
  }
}

async function saveSignal(signalData) {
  if (!isDbConnected()) {
    return { ...signalData, createdAt: new Date(), _id: null };
  }

  try {
    const signal = new Signal(signalData);
    return signal.save();
  } catch (error) {
    console.warn('[TradingView] saveSignal fallback:', error.message);
    return { ...signalData, createdAt: new Date(), _id: null };
  }
}

async function deliverLiveAlert(io, signalDoc) {
  const payload = toLiveAlertPayload(signalDoc);
  const tvRoom = `tv:${normalizeTradingViewUsername(payload.tradingviewUsername)}`;

  if (payload.tradingviewUsername) {
    io.to(tvRoom).emit('tv:live-alert', payload);
  }

  if (payload.appUsername) {
    io.to(`user:${payload.appUsername}`).emit('tv:live-alert', payload);
  }

  io.emit('signal:update', signalDoc);
  return payload;
}

async function deliverToTradingViewUser(io, tradingviewUsername, signalData) {
  const subscriber = await findSubscriberByTvUsername(tradingviewUsername);
  if (!subscriber) {
    return { delivered: false, reason: 'subscriber_not_found_or_inactive' };
  }

  const saved = await saveSignal({
    ...signalData,
    tradingviewUsername: normalizeTradingViewUsername(subscriber.tradingviewUsername),
    appUsername: subscriber.username,
    isBroadcast: false
  });

  const payload = await deliverLiveAlert(io, saved);
  return { delivered: true, payload, subscriber: subscriber.username };
}

async function broadcastToSubscribers(io, signalData) {
  const subscribers = await findActiveSubscribers();
  const results = [];

  for (const subscriber of subscribers) {
    const saved = await saveSignal({
      ...signalData,
      tradingviewUsername: normalizeTradingViewUsername(subscriber.tradingviewUsername),
      appUsername: subscriber.username,
      isBroadcast: true
    });

    const payload = await deliverLiveAlert(io, saved);
    results.push({ username: subscriber.username, tradingviewUsername: payload.tradingviewUsername });
  }

  return { delivered: results.length, subscribers: results };
}

async function processIncomingWebhook(io, rawBody) {
  const body = parseWebhookBody(rawBody);
  const tradingviewUsername = normalizeTradingViewUsername(
    body.tradingviewUsername || body.username || body.user || body.trader || ''
  );
  const broadcast =
    body.broadcast === true ||
    body.broadcast === 'true' ||
    !tradingviewUsername ||
    tradingviewUsername === 'broadcast';

  const direction = String(body.direction || body.action || 'neutral').toLowerCase();
  const entry = parseFloat(body.entry || body.price || 0) || 0;
  const stop_loss = parseFloat(body.stop_loss || body.sl || 0) || 0;
  const take_profit_1 = parseFloat(body.take_profit_1 || body.tp1 || 0) || 0;
  const take_profit_2 = parseFloat(body.take_profit_2 || body.tp2 || 0) || 0;
  const take_profit_3 = parseFloat(body.take_profit_3 || body.tp3 || 0) || 0;

  const safeEntry = entry || 0;
  const safeStop = stop_loss || (safeEntry ? safeEntry * 0.995 : 0);
  const safeTp1 = take_profit_1 || (safeEntry ? (direction === 'short' ? safeEntry * 0.99 : safeEntry * 1.01) : 0);
  const safeTp2 = take_profit_2 || (safeEntry ? (direction === 'short' ? safeEntry * 0.98 : safeEntry * 1.02) : 0);
  const safeTp3 = take_profit_3 || (safeEntry ? (direction === 'short' ? safeEntry * 0.965 : safeEntry * 1.035) : 0);

  const signalData = {
    symbol: body.symbol || body.ticker || 'UNKNOWN',
    direction,
    entry: safeEntry,
    stop_loss: safeStop,
    take_profit_1: safeTp1,
    take_profit_2: safeTp2,
    take_profit_3: safeTp3,
    confidence: Math.min(Math.max(parseFloat(body.confidence || 0) || 0, 0), 1),
    notes: body.message || body.note || body.notes || 'KachingFx live alert',
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

  if (!signalData.symbol || !signalData.direction) {
    throw new Error('Invalid TradingView payload: symbol and direction are required');
  }

  if (broadcast) {
    return {
      mode: 'broadcast',
      ...(await broadcastToSubscribers(io, signalData))
    };
  }

  return {
    mode: 'direct',
    ...(await deliverToTradingViewUser(io, tradingviewUsername, signalData))
  };
}

module.exports = {
  ALERT_TYPES,
  normalizeTradingViewUsername,
  normalizeAlertType,
  parseWebhookBody,
  formatLiveAlertMessage,
  toLiveAlertPayload,
  findSubscriberByTvUsername,
  findActiveSubscribers,
  deliverLiveAlert,
  deliverToTradingViewUser,
  broadcastToSubscribers,
  processIncomingWebhook
};
