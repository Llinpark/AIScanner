/**
 * Aggregate delivery / latency stats for admin dashboard cards.
 * Diagnostics only — reads Signal + PipelineStatus ring summaries.
 *
 * Counting rules:
 * - Signals today/week/month = unique canonical signalUuid (fan-out must not inflate).
 * - Telegram / MT5 success % use the SAME month window for numerator and denominator.
 * - MT5 success denominator = only signals that actually attempted MT5 auto/manual
 *   (not Telegram-only expected skips). Empty denominator → null → Admin "—".
 * - Failed = Mongo deliveryStatus "failed" in the month window (genuine channel failures
 *   only; expected MT5 skips never write deliveryStatus=failed).
 *
 * Date boundaries (timezone):
 * - All windows use UTC calendar days via Date.UTC / getUTC* (Fly machines run UTC).
 * - Today  = [00:00:00.000 UTC today, ∞)
 * - Week   = [00:00:00.000 UTC of (today − 7 calendar days), ∞)  // rolling 7 days
 * - Month  = [00:00:00.000 UTC of (today − 30 calendar days), ∞) // rolling 30 days
 *
 * Latency (Webhook→Mongo, Mongo→Telegram, Avg pipeline):
 * - Derived from paired PASS stages in PipelineStatusService (Redis-backed ring/inflight).
 * - Not mixed with Mongo date windows; samples are operational stage deltas for recent
 *   matched signalUuid chains (PASS only — SKIP/FAIL do not stamp latency).
 */

const mongoose = require('mongoose');
const Signal = require('../models/Signal');
const PipelineStatusService = require('../services/PipelineStatusService');
const { percent } = require('../utils/pipelineObservability');

/** UTC start-of-day for consistent Admin Today/Week/Month windows. */
function startOfDay(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function daysAgo(n) {
  const x = startOfDay();
  x.setUTCDate(x.getUTCDate() - n);
  return x;
}

async function countUniqueCanonicalSignals(match) {
  const rows = await Signal.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          $ifNull: ['$signalUuid', { $toString: '$_id' }]
        }
      }
    },
    { $count: 'n' }
  ]);
  return rows[0]?.n || 0;
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
    timezone: 'UTC',
    windowNote:
      'today=UTC midnight; week=rolling 7d UTC; month=rolling 30d UTC; TG/MT5 % use month; latency from PASS stage pairs',
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

  const monthEntry = { ...entryFilter, createdAt: { $gte: month } };

  // MT5 attempted = auto/manual queue path actually used (not Telegram-only skips).
  const mt5AttemptedFilter = {
    ...monthEntry,
    $or: [{ mt5Sent: true }, { executionChannel: { $in: ['mt5_auto', 'mt5_manual'] } }]
  };

  const [
    signalsToday,
    signalsWeek,
    signalsMonth,
    delivered,
    failed,
    partial,
    telegramSentMonth,
    telegramTotalMonth,
    mt5SentMonth,
    mt5AttemptedMonth
  ] = await Promise.all([
    countUniqueCanonicalSignals({ ...entryFilter, createdAt: { $gte: today } }),
    countUniqueCanonicalSignals({ ...entryFilter, createdAt: { $gte: week } }),
    countUniqueCanonicalSignals({ ...entryFilter, createdAt: { $gte: month } }),
    Signal.countDocuments({ ...monthEntry, deliveryStatus: 'delivered' }),
    Signal.countDocuments({ ...monthEntry, deliveryStatus: 'failed' }),
    Signal.countDocuments({ ...monthEntry, deliveryStatus: 'partial' }),
    Signal.countDocuments({ ...monthEntry, telegramSent: true }),
    Signal.countDocuments(monthEntry),
    Signal.countDocuments({ ...monthEntry, mt5Sent: true }),
    Signal.countDocuments(mt5AttemptedFilter)
  ]);

  // Webhook success % from live ring (include parse/rate-limit failures).
  const live = await PipelineStatusService.getLivePipeline(100);
  const webhookEvents = (live.events || []).filter(e =>
    /WebhookReceived|Auth|WebhookParseError|WebhookRateLimited/i.test(e.type || '')
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
    telegramSuccessPct: percent(telegramSentMonth, telegramTotalMonth),
    // null when no MT5 attempts in window → Admin shows "—" (N/A), not 0% failure.
    mt5SuccessPct: percent(mt5SentMonth, mt5AttemptedMonth),
    webhookSuccessPct,
    avgPipelineLatencyMs: latency.pipeline.avgMs,
    fastestPipelineLatencyMs: latency.pipeline.fastestMs,
    slowestPipelineLatencyMs: latency.pipeline.slowestMs,
    avgWebhookToMongoMs: latency.webhookToMongo.avgMs,
    avgMongoToTelegramMs: latency.mongoToTelegram.avgMs,
    timezone: 'UTC',
    windowNote: empty.windowNote,
    latency
  };
}

module.exports = {
  computeDeliveryStatistics,
  countUniqueCanonicalSignals,
  startOfDay,
  daysAgo
};
