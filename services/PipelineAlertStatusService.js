/**
 * Build per-subscriber TradingView alert status rows for admin UI.
 */

const mongoose = require('mongoose');
const UserConfig = require('../models/User');
const PipelineSubscriberStatsService = require('./PipelineSubscriberStatsService');
const {
  evaluateWebhookAge,
  evaluateAlertEngineReminder,
  buildPipelineTimeline,
  WAITING_FIRST_WEBHOOK
} = require('../utils/pipelineObservability');

function iso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

async function listActiveSubscriberAlertStatus() {
  if (mongoose.connection.readyState !== 1) {
    return { subscribers: [], activeSubscribers: 0, waitingSubscribers: 0 };
  }

  const users = await UserConfig.find({
    'subscription.status': 'active',
    role: { $nin: ['admin', 'super_admin'] }
  })
    .select(
      'email displayName tradingviewUsername subscription pipelineStats telegram mt5 createdAt'
    )
    .lean();

  await PipelineSubscriberStatsService.hydrateFromUsers(users);

  const rows = users.map(user => {
    const id = user._id.toString();
    const mem = PipelineSubscriberStatsService.getStats(id) || {};
    const ps = user.pipelineStats || {};
    const lastWebhookAt = iso(mem.lastWebhookAt || ps.lastWebhookAt);
    const lastPineGeneratedAt = iso(mem.lastPineGeneratedAt || ps.lastPineGeneratedAt);
    const lastPineStrategy = mem.lastPineStrategy || ps.lastPineStrategy || null;
    const lastPublishedSignalAt = iso(mem.lastPublishedSignalAt || ps.lastPublishedSignalAt);
    const lastTelegramAt = iso(mem.lastTelegramAt || ps.lastTelegramAt);
    const lastSocketAt = iso(mem.lastSocketAt || ps.lastSocketAt);
    const lastMT5At = iso(mem.lastMT5At || ps.lastMT5At);
    const lastMongoSaveAt = iso(mem.lastMongoSaveAt || ps.lastMongoSaveAt);

    const age = evaluateWebhookAge(lastWebhookAt, { strategy: lastPineStrategy });
    const reminder = evaluateAlertEngineReminder(lastPineGeneratedAt, lastWebhookAt);
    const timeline = buildPipelineTimeline({
      pineGeneratedAt: lastPineGeneratedAt,
      lastWebhookAt,
      lastAlertFiredAt: lastWebhookAt,
      lastAuthAt: lastWebhookAt,
      lastMongoSaveAt,
      lastPublishedAt: lastPublishedSignalAt,
      lastSocketAt,
      lastTelegramAt,
      lastMT5At
    });

    const signalLabel = lastWebhookAt
      ? lastPublishedSignalAt || lastMongoSaveAt || lastWebhookAt
      : null;

    return {
      userId: id,
      email: user.email,
      displayName: user.displayName || null,
      tradingviewUsername: user.tradingviewUsername || null,
      tier: user.subscription?.tier || null,
      lastPineGeneratedAt,
      lastPineStrategy,
      lastPineScriptId: mem.lastPineScriptId || ps.lastPineScriptId || null,
      alertCreationReminder:
        'After generating Pine, create (or recreate) the TradingView alert with webhook URL + JSON message. Backend cannot see alert creation.',
      lastWebhookAt,
      lastSignalPublishedAt: lastPublishedSignalAt,
      lastSignalLabel: signalLabel
        ? `Last signal ${new Date(signalLabel).toLocaleString()}`
        : WAITING_FIRST_WEBHOOK,
      waitingForFirstWebhook: !lastWebhookAt,
      lastTelegramAt,
      lastMT5At,
      lastSocketAt,
      lastMongoSaveAt,
      webhookAge: age,
      alertEngineReminder: reminder,
      timeline,
      telegramLinked: Boolean(user.telegram?.chatId),
      mt5Linked: Boolean(user.mt5?.enabled || user.mt5?.lastPairAt || (user.mt5?.devices || []).length)
    };
  });

  const waitingSubscribers = rows.filter(r => r.waitingForFirstWebhook).length;

  return {
    subscribers: rows,
    activeSubscribers: rows.length,
    waitingSubscribers
  };
}

module.exports = {
  listActiveSubscriberAlertStatus
};
