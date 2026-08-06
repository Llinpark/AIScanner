/**
 * Aggregate delivery / latency stats for admin dashboard cards.
 * Diagnostics only — reads Signal + PipelineStatus ring summaries.
 */

const mongoose = require('mongoose');
const Signal = require('../models/Signal');
const PipelineStatusService = require('../services/PipelineStatusService');
const { percent } = require('../utils/pipelineObservability');

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function daysAgo(n) {
  const x = startOfDay();
  x.setDate(x.getDate() - n);
  return x;
}

async function computeDeliveryStatistics() {
  const latency = PipelineStatusService.getLatencySummary();
  const empty = {
    signalsToday: 0,
    signalsWeek: 0,
    signalsMonth: 0,
    delivered: 0,
    failed: 0,
    partial: 0,
    telegramSuccessPct: null,
    mt5SuccessPct: null,
    webhookSuccessPct: null,
    avgPipelineLatencyMs: latency.pipeline.avgMs,
    fastestPipelineLatencyMs: latency.pipeline.fastestMs,
    slowestPipelineLatencyMs: latency.pipeline.slowestMs,
    avgWebhookToMongoMs: latency.webhookToMongo.avgMs,
    avgMongoToTelegramMs: latency.mongoToTelegram.avgMs,
    latency
  };

  if (mongoose.connection.readyState !== 1) {
    return { ...empty, dbConnected: false };
  }

  const today = startOfDay();
  const week = daysAgo(7);
  const month = daysAgo(30);

  const entryFilter = {
    alertType: { $in: ['entry', 'signal'] }
  };

  const [
    signalsToday,
    signalsWeek,
    signalsMonth,
    delivered,
    failed,
    partial,
    telegramSent,
    telegramTotal,
    mt5Sent,
    mt5Total
  ] = await Promise.all([
    Signal.countDocuments({ ...entryFilter, createdAt: { $gte: today } }),
    Signal.countDocuments({ ...entryFilter, createdAt: { $gte: week } }),
    Signal.countDocuments({ ...entryFilter, createdAt: { $gte: month } }),
    Signal.countDocuments({ ...entryFilter, deliveryStatus: 'delivered' }),
    Signal.countDocuments({ ...entryFilter, deliveryStatus: 'failed' }),
    Signal.countDocuments({ ...entryFilter, deliveryStatus: 'partial' }),
    Signal.countDocuments({ ...entryFilter, telegramSent: true }),
    Signal.countDocuments({
      ...entryFilter,
      createdAt: { $gte: month }
    }),
    Signal.countDocuments({ ...entryFilter, mt5Sent: true }),
    Signal.countDocuments({
      ...entryFilter,
      createdAt: { $gte: month },
      mt5Sent: { $exists: true }
    })
  ]);

  // Webhook success % from in-memory counters (auth+webhook failures vs total events).
  const live = await PipelineStatusService.getLivePipeline(100);
  const webhookEvents = (live.events || []).filter(e =>
    /WebhookReceived|Auth/i.test(e.type || '')
  );
  const webhookPass = webhookEvents.filter(e => e.status === 'PASS').length;
  const webhookSuccessPct = percent(webhookPass, webhookEvents.length);

  return {
    dbConnected: true,
    signalsToday,
    signalsWeek,
    signalsMonth,
    delivered,
    failed,
    partial,
    telegramSuccessPct: percent(telegramSent, telegramTotal),
    mt5SuccessPct: percent(mt5Sent, mt5Total),
    webhookSuccessPct,
    avgPipelineLatencyMs: latency.pipeline.avgMs,
    fastestPipelineLatencyMs: latency.pipeline.fastestMs,
    slowestPipelineLatencyMs: latency.pipeline.slowestMs,
    avgWebhookToMongoMs: latency.webhookToMongo.avgMs,
    avgMongoToTelegramMs: latency.mongoToTelegram.avgMs,
    latency
  };
}

module.exports = {
  computeDeliveryStatistics
};
