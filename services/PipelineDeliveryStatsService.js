/**
 * Aggregate delivery / latency stats for admin dashboard cards.
 * Diagnostics only.
 *
 * DISPLAYED channel success % uses the operational 24h window:
 *   succeeded / (succeeded + failed) among jobs created in the last 24h.
 * SKIPPED and NOT_ELIGIBLE are excluded from the denominator.
 * Zero operational provider attempts → null ("—"), never 100%.
 * 30d DeliveryJob totals remain as historical context only — they must not
 * make an inactive channel look healthy (TEST 9).
 *
 * Webhook intake metrics use WebhookIntakeService (durable), not the last-100
 * DurableDelivery-flooded pipeline ring. webhookSuccessPct is ACCEPTANCE
 * (accepted / received), never subscriber delivery. Intake documents TTL ~7d.
 *
 * Historical Signals without DeliveryJob rows are LEGACY/UNKNOWN — not invented.
 *
 * MT5: if live linked-subscriber count is 0, successPct is forced null with
 * reason no_mt5_subscribers_linked regardless of historical job successes.
 */

const mongoose = require('mongoose');
const Signal = require('../models/Signal');
const PipelineStatusService = require('../services/PipelineStatusService');
const WebhookIntakeService = require('../services/WebhookIntakeService');
const { percent } = require('../utils/pipelineObservability');
const { mapJobToOutcome, CHANNELS, isFanoutJob } = require('../utils/deliveryOutcomes');
const { getSequenceWaitUnhealthyMs } = require('../utils/deliverySequencer');

const OPERATIONAL_WINDOW_HOURS = 24;
const WEBHOOK_INTAKE_TTL_DAYS = 7;

function startOfDay(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function daysAgo(n) {
  const x = startOfDay();
  x.setUTCDate(x.getUTCDate() - n);
  return x;
}

function hoursAgo(n) {
  return new Date(Date.now() - Number(n) * 3600 * 1000);
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

function emptyChannel() {
  return {
    eligible: 0,
    pending: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    notEligible: 0,
    providerAttempted: 0,
    successPct: null
  };
}

/**
 * Provider send started (markSending / sendAttempts) is not lease acquisition.
 * lastAttemptAt is set on LEASE_ACQUIRED — do not treat it as a provider attempt.
 * First-try success often has sendAttempts=0 and state=delivered; those still
 * count as outcome success/failed for the %, but are not "send started" unless
 * state is sending/provider_accepted or sendAttempts>0.
 */
function isProviderAttempted(job = {}) {
  if (Number(job.sendAttempts || 0) > 0) return true;
  const state = String(job.state || '').toLowerCase();
  if (state === 'sending' || state === 'provider_accepted') return true;
  return false;
}

function applyOutcome(bucket, outcome, meta = {}) {
  const n = Number(meta.n != null ? meta.n : 1) || 0;
  if (!n) return;
  const o = String(outcome || 'pending');
  if (o === 'success') {
    bucket.succeeded += n;
    bucket.eligible += n;
  } else if (o === 'failed') {
    bucket.failed += n;
    bucket.eligible += n;
  } else if (o === 'pending') {
    bucket.pending += n;
    bucket.eligible += n;
  } else if (o === 'not_eligible') {
    bucket.notEligible += n;
  } else {
    bucket.skipped += n;
  }
  if (meta.providerAttempted) bucket.providerAttempted += n;
}

function finalize(bucket) {
  bucket.successPct = percent(bucket.succeeded, bucket.succeeded + bucket.failed);
  return bucket;
}

/**
 * Headline % is operational-window completed attempts only.
 * Historical 30d successes cannot produce a misleading 100% when the
 * operational window has zero provider completions.
 * MT5 with zero currently linked subscribers always displays "—".
 */
function overlayChannelDisplay(window30d, operational, opts = {}) {
  const w = window30d || emptyChannel();
  const op = operational || emptyChannel();
  const liveEligibleCount =
    opts.liveEligibleCount == null ? null : Number(opts.liveEligibleCount);
  const forceUnlinked =
    Boolean(opts.forceUnlinkedWhenZeroEligible) && Number(liveEligibleCount) === 0;
  const opAttempted = (op.succeeded || 0) + (op.failed || 0);
  const windowAttempted = (w.succeeded || 0) + (w.failed || 0);

  let successPct = null;
  let displayReason = null;
  let pctWindow = 'operational_24h';

  if (forceUnlinked) {
    successPct = null;
    displayReason = opts.unlinkedReason || 'no_mt5_subscribers_linked';
    pctWindow = 'live_eligibility';
  } else if (opAttempted > 0) {
    successPct = percent(op.succeeded, opAttempted);
    pctWindow = 'operational_24h';
  } else {
    successPct = null;
    displayReason =
      windowAttempted > 0 ? 'no_operational_provider_attempts' : 'no_provider_attempts';
    pctWindow = 'operational_24h';
  }

  return {
    ...w,
    successPct,
    attempted: opAttempted,
    sent: op.succeeded || 0,
    displayReason,
    pctWindow,
    liveEligibleCount,
    window30d: {
      ...w,
      attempted: windowAttempted
    },
    operational: {
      ...op,
      attempted: opAttempted,
      successPct: opAttempted ? percent(op.succeeded, opAttempted) : null
    }
  };
}

function channelCard(ch) {
  const overlay = ch?.operational ? ch : null;
  const attempted =
    overlay?.attempted != null ? overlay.attempted : (ch.succeeded || 0) + (ch.failed || 0);
  return {
    ...ch,
    sent: ch.sent != null ? ch.sent : ch.succeeded,
    attempted,
    skipped: (ch.skipped || 0) + (ch.notEligible || 0),
    blocked: ch.pending,
    failedTerminal: ch.failed,
    passed: ch.succeeded
  };
}

async function aggregateChannelJobs(since) {
  const channels = {
    telegram: emptyChannel(),
    email: emptyChannel(),
    mt5: emptyChannel(),
    socket: emptyChannel()
  };
  const issues = {
    missing_channel_payload: 0,
    delivery_sequence_wait: 0,
    stale_trade_before_delivery: 0,
    redis_unavailable: 0,
    delivery_context_unrecoverable: 0,
    retrying: 0,
    failedTerminal: 0,
    sequence_wait_unhealthy: 0,
    sequence_wait_expired: 0,
    retry_scheduled: 0
  };
  let jobRows = 0;
  let usedMongo = false;
  try {
    const DeliveryJob = require('../models/DeliveryJob');
    if (!mongoose.connection?.db) {
      throw new Error('mongo_db_handle_missing');
    }
    const rows = await DeliveryJob.aggregate([
      {
        $match: {
          createdAt: { $gte: since },
          channel: { $in: CHANNELS }
        }
      },
      {
        $group: {
          _id: {
            channel: '$channel',
            outcome: { $ifNull: ['$outcomeStatus', '$state'] },
            lastError: { $ifNull: ['$lastError', '$outcomeReason'] },
            state: '$state',
            sendAttemptsPositive: { $gt: [{ $ifNull: ['$sendAttempts', 0] }, 0] }
          },
          n: { $sum: 1 }
        }
      }
    ]);
    for (const row of rows) {
      const ch = String(row._id?.channel || '').toLowerCase();
      if (!channels[ch]) continue;
      jobRows += row.n || 0;
      const mapped = mapJobToOutcome({
        outcomeStatus: row._id.outcome,
        state: row._id.state || row._id.outcome,
        channel: ch
      });
      const attempted = isProviderAttempted({
        state: row._id.state,
        sendAttempts: row._id.sendAttemptsPositive ? 1 : 0,
        outcomeStatus: row._id.outcome
      });
      applyOutcome(channels[ch], mapped, {
        providerAttempted: attempted,
        n: row.n || 0
      });
      const err = String(row._id.lastError || '');
      if (/missing_channel_payload/i.test(err)) issues.missing_channel_payload += row.n || 0;
      if (/delivery_sequence_wait|blocked_waiting_for_entry/i.test(err)) {
        issues.delivery_sequence_wait += row.n || 0;
      }
      if (/stale_trade_before_delivery/i.test(err)) issues.stale_trade_before_delivery += row.n || 0;
      if (/redis_unavailable/i.test(err)) issues.redis_unavailable += row.n || 0;
      if (/delivery_context_unrecoverable/i.test(err)) {
        issues.delivery_context_unrecoverable += row.n || 0;
      }
      if (String(row._id.outcome) === 'retry_pending' || String(row._id.state) === 'retry_pending') {
        issues.retrying += row.n || 0;
        issues.retry_scheduled += row.n || 0;
      }
      if (String(row._id.outcome) === 'failed_terminal' || mapped === 'failed') {
        issues.failedTerminal += row.n || 0;
      }
      if (/delivery_sequence_wait_expired/i.test(err)) {
        issues.sequence_wait_expired += row.n || 0;
      }
      if (
        String(row._id.state) === 'blocked_waiting_for_entry' ||
        /blocked_waiting_for_entry/i.test(err)
      ) {
        issues.sequence_wait_unhealthy += row.n || 0;
      }
    }
    usedMongo = true;
  } catch {
    /* tests without Mongo DeliveryJob — fall back to in-memory jobs */
  }
  if (!usedMongo && jobRows === 0) {
    try {
      const DurableDelivery = require('../utils/durableDelivery');
      const mem = DurableDelivery.listMemoryJobs ? DurableDelivery.listMemoryJobs() : [];
      const sinceMs = since instanceof Date ? since.getTime() : 0;
      for (const job of mem) {
        if (isFanoutJob(job)) continue;
        const created =
          job.createdAt instanceof Date
            ? job.createdAt.getTime()
            : Number(job.createdAt) || 0;
        if (sinceMs && created && created < sinceMs) continue;
        const ch = String(job.channel || '').toLowerCase();
        if (!channels[ch]) continue;
        jobRows += 1;
        const mapped = mapJobToOutcome(job);
        applyOutcome(channels[ch], mapped, { providerAttempted: isProviderAttempted(job) });
        const err = String(job.lastError || job.outcomeReason || '');
        if (/missing_channel_payload/i.test(err)) issues.missing_channel_payload += 1;
        if (/delivery_sequence_wait|blocked_waiting_for_entry/i.test(err)) {
          issues.delivery_sequence_wait += 1;
        }
        if (/stale_trade_before_delivery/i.test(err)) issues.stale_trade_before_delivery += 1;
        if (/redis_unavailable/i.test(err)) issues.redis_unavailable += 1;
        if (/delivery_context_unrecoverable/i.test(err)) {
          issues.delivery_context_unrecoverable += 1;
        }
        if (String(job.state) === 'retry_pending') {
          issues.retrying += 1;
          issues.retry_scheduled += 1;
        }
        if (String(job.state) === 'failed_terminal' || mapped === 'failed') {
          issues.failedTerminal += 1;
        }
        if (/delivery_sequence_wait_expired/i.test(err)) {
          issues.sequence_wait_expired += 1;
        }
        if (String(job.state) === 'blocked_waiting_for_entry') {
          const unhealthyMs = getSequenceWaitUnhealthyMs();
          if (!created || Date.now() - created >= unhealthyMs) {
            issues.sequence_wait_unhealthy += 1;
          }
        }
      }
    } catch {
      /* no in-memory jobs */
    }
  }
  for (const ch of CHANNELS) finalize(channels[ch]);
  return { channels, issues, jobRows };
}

async function countLiveEligibleSubscribers() {
  const empty = { telegram: 0, email: 0, mt5: 0, source: 'unavailable' };
  try {
    if (mongoose.connection.readyState !== 1 || !mongoose.connection?.db) {
      return empty;
    }
    const User = require('../models/User');
    const [mt5, telegram, email] = await Promise.all([
      User.countDocuments({
        'mt5.devices': {
          $elemMatch: {
            deviceId: { $exists: true, $nin: [null, ''] },
            $or: [{ revokedAt: null }, { revokedAt: { $exists: false } }]
          }
        }
      }),
      User.countDocuments({
        'telegram.enabled': { $ne: false },
        'telegram.chatId': { $exists: true, $nin: [null, ''] }
      }),
      User.countDocuments({
        email: { $exists: true, $nin: [null, ''] },
        'preferences.emailAlerts': { $ne: false }
      })
    ]);
    return { telegram, email, mt5, source: 'user_config' };
  } catch {
    return empty;
  }
}

function resolveHealth({ intake, channels, issues, redisStatus, recentAuthFailed }) {
  const reasons = [];
  let level = 'HEALTHY';
  const redisDown = redisStatus === 'unavailable';
  const tg = channels.telegram || emptyChannel();
  const email = channels.email || emptyChannel();
  const mt5 = channels.mt5 || emptyChannel();
  const socket = channels.socket || emptyChannel();
  const pending = tg.pending + email.pending + mt5.pending + socket.pending;
  const failed = tg.failed + email.failed + mt5.failed + socket.failed;

  if (redisDown) {
    level = 'CRITICAL';
    reasons.push('redis_unavailable');
  }
  if ((issues.delivery_context_unrecoverable || 0) >= 5) {
    level = 'CRITICAL';
    reasons.push('delivery_context_unrecoverable');
  }
  if (recentAuthFailed) {
    if (level !== 'CRITICAL') level = 'DEGRADED';
    reasons.push(
      pending > 0 && tg.succeeded === 0 ? 'auth_failed_with_delivery_pending' : 'auth_failed'
    );
  }
  if ((issues.missing_channel_payload || 0) > 0 || (issues.redis_unavailable || 0) > 0) {
    if (level === 'HEALTHY') level = 'DEGRADED';
    if (issues.missing_channel_payload) reasons.push('missing_channel_payload');
  }
  if (failed > 0 && level === 'HEALTHY') {
    level = 'DEGRADED';
    reasons.push(email.failed > 0 ? 'email_channel_failures' : 'channel_failures_in_window');
  }
  if (intake?.rejected > 0 && intake.accepted === 0 && intake.received > 0) {
    if (level === 'HEALTHY') level = 'DEGRADED';
    reasons.push('intake_rejects_without_accept');
  }
  return {
    level,
    reasons,
    window: 'operational_24h_delivery_plus_intake',
    note:
      'Auth FAIL + delivery pending is not HEALTHY. One isolated fail is DEGRADED, not permanent CRITICAL. Channel % is 24h operational, not 30d historical.'
  };
}

async function computeDeliveryStatistics() {
  const latency = PipelineStatusService.getLatencySummary();
  const emptyChannelStats = {
    telegram: emptyChannel(),
    email: emptyChannel(),
    mt5: emptyChannel(),
    socket: emptyChannel()
  };
  const windowNote =
    'today=UTC midnight; week=rolling 7d UTC; month=rolling 30d UTC Signal rollup; ' +
    'channel % = operational 24h completed provider attempts (success/(success+failed)); ' +
    '0 attempts → —; 30d job totals are historical context only; ' +
    `webhook acceptance = accepted/received from webhook_intake (TTL ~${WEBHOOK_INTAKE_TTL_DAYS}d, not subscriber delivery)`;
  const empty = {
    signalsToday: 0,
    signalsWeek: 0,
    signalsMonth: 0,
    signalsEntryMonth: 0,
    signalsLifecycleMonth: 0,
    delivered: 0,
    failed: 0,
    failedSignals: 0,
    providerFailed24h: 0,
    providerFailed30d: 0,
    partial: 0,
    skipped: 0,
    pending: 0,
    legacyUnknown: 0,
    telegramSuccessPct: null,
    telegramEligible: 0,
    telegramPending: 0,
    telegramSkipped: 0,
    telegramFailed: 0,
    telegramSucceeded: 0,
    emailSuccessPct: null,
    mt5SuccessPct: null,
    webhookSuccessPct: null,
    webhookMetric: 'acceptance',
    intake: {
      received: 0,
      http2xx: 0,
      accepted: 0,
      persisted: 0,
      fanoutScheduled: 0,
      skippedNoFanout: 0,
      rejected: 0,
      byCategory: {}
    },
    webhook: {
      received: 0,
      http2xx: 0,
      accepted: 0,
      persisted: 0,
      fanoutScheduled: 0,
      skippedNoFanout: 0,
      rejected: 0,
      byCategory: {}
    },
    telegram: channelCard(emptyChannel()),
    email: channelCard(emptyChannel()),
    mt5: channelCard(emptyChannel()),
    socket: channelCard(emptyChannel()),
    channels: emptyChannelStats,
    liveEligible: { telegram: 0, email: 0, mt5: 0, source: 'unavailable' },
    issues: {
      missing_channel_payload: 0,
      delivery_sequence_wait: 0,
      stale_trade_before_delivery: 0,
      redis_unavailable: 0,
      delivery_context_unrecoverable: 0,
      retrying: 0,
      failedTerminal: 0,
      sequence_wait_unhealthy: 0,
      sequence_wait_expired: 0,
      retry_scheduled: 0
    },
    health: { level: 'HEALTHY', reasons: [], window: 'n/a' },
    telegramAccounting: 'legacy_unknown',
    avgPipelineLatencyMs: latency.pipeline.operationalAvgMs != null
      ? latency.pipeline.operationalAvgMs
      : latency.pipeline.avgMs,
    avgPipelineLatencyRawMs: latency.pipeline.avgMs,
    fastestPipelineLatencyMs: latency.pipeline.fastestMs,
    slowestPipelineLatencyMs: latency.pipeline.slowestMs,
    avgWebhookToMongoMs: latency.webhookToMongo.avgMs,
    avgMongoToTelegramMs: latency.mongoToTelegram.avgMs,
    timezone: 'UTC',
    windowNote,
    operationalWindowHours: OPERATIONAL_WINDOW_HOURS,
    webhookIntakeTtlDays: WEBHOOK_INTAKE_TTL_DAYS,
    latencyNote: latency.note,
    latency
  };

  const intake = await WebhookIntakeService.aggregateWindow({ since: daysAgo(30) }).catch(() => empty.intake);
  empty.intake = intake;
  empty.webhook = intake;
  empty.webhookSuccessPct = percent(intake.accepted, intake.received);

  if (mongoose.connection.readyState !== 1) {
    return { ...empty, dbConnected: false, health: { level: 'DEGRADED', reasons: ['mongo_unavailable'] } };
  }

  const today = startOfDay();
  const week = daysAgo(7);
  const month = daysAgo(30);
  const operationalSince = hoursAgo(OPERATIONAL_WINDOW_HOURS);

  const entryFilter = {
    alertType: { $in: ['entry', 'signal'] },
    selfTest: { $ne: true }
  };
  const monthEntry = { ...entryFilter, createdAt: { $gte: month } };

  const [
    signalsToday,
    signalsWeek,
    signalsMonth,
    signalsLifecycleMonth,
    delivered,
    failed,
    partial,
    skipped,
    pending,
    legacyUnknown,
    jobAgg30,
    jobAgg24,
    liveEligible
  ] = await Promise.all([
    countUniqueCanonicalSignals({ ...entryFilter, createdAt: { $gte: today } }),
    countUniqueCanonicalSignals({ ...entryFilter, createdAt: { $gte: week } }),
    countUniqueCanonicalSignals({ ...entryFilter, createdAt: { $gte: month } }),
    countUniqueCanonicalSignals({
      alertType: { $nin: ['entry', 'signal'] },
      selfTest: { $ne: true },
      createdAt: { $gte: month }
    }),
    Signal.countDocuments({ ...monthEntry, deliveryStatus: 'delivered' }),
    Signal.countDocuments({ ...monthEntry, deliveryStatus: 'failed' }),
    Signal.countDocuments({ ...monthEntry, deliveryStatus: 'partial' }),
    Signal.countDocuments({ ...monthEntry, deliveryStatus: 'skipped' }),
    Signal.countDocuments({ ...monthEntry, deliveryStatus: 'pending' }),
    Signal.countDocuments({ ...monthEntry, deliveryAccounting: { $ne: 'per_recipient' } }),
    aggregateChannelJobs(month),
    aggregateChannelJobs(operationalSince),
    countLiveEligibleSubscribers()
  ]);

  const liveSourceOk = liveEligible.source === 'user_config';
  const telegram = overlayChannelDisplay(
    jobAgg30.channels.telegram,
    jobAgg24.channels.telegram,
    { liveEligibleCount: liveEligible.telegram }
  );
  const email = overlayChannelDisplay(
    jobAgg30.channels.email,
    jobAgg24.channels.email,
    { liveEligibleCount: liveEligible.email }
  );
  const mt5 = overlayChannelDisplay(jobAgg30.channels.mt5, jobAgg24.channels.mt5, {
    liveEligibleCount: liveEligible.mt5,
    forceUnlinkedWhenZeroEligible: liveSourceOk,
    unlinkedReason: 'no_mt5_subscribers_linked'
  });
  const socket = overlayChannelDisplay(
    jobAgg30.channels.socket,
    jobAgg24.channels.socket,
    { liveEligibleCount: null }
  );

  const channels = { telegram, email, mt5, socket };
  const providerFailed24h =
    (telegram.operational?.failed || 0) +
    (email.operational?.failed || 0) +
    (mt5.operational?.failed || 0) +
    (socket.operational?.failed || 0);
  const providerFailed30d =
    (telegram.window30d?.failed || 0) +
    (email.window30d?.failed || 0) +
    (mt5.window30d?.failed || 0) +
    (socket.window30d?.failed || 0);

  const redis = (() => {
    try {
      const { getRedisDiagnostics } = require('../utils/redisClient');
      const d = getRedisDiagnostics();
      return d.redisConnected ? 'ok' : d.redisConfigured ? 'unavailable' : 'not_configured';
    } catch {
      return 'unknown';
    }
  })();

  const health = resolveHealth({
    intake,
    channels: jobAgg24.channels,
    issues: jobAgg30.issues,
    redisStatus: redis,
    recentAuthFailed: (intake.byCategory?.AUTH_FAILED || 0) > 0
  });

  return {
    dbConnected: true,
    signalsToday,
    signalsWeek,
    signalsMonth,
    signalsEntryMonth: signalsMonth,
    signalsLifecycleMonth,
    delivered,
    failed,
    failedSignals: failed,
    providerFailed24h,
    providerFailed30d,
    partial,
    skipped,
    pending,
    legacyUnknown,
    telegramSuccessPct: telegram.successPct,
    telegramEligible: telegram.eligible,
    telegramPending: telegram.operational?.pending ?? telegram.pending,
    telegramSkipped: (telegram.operational?.skipped || 0) + (telegram.operational?.notEligible || 0),
    telegramFailed: telegram.operational?.failed ?? telegram.failed,
    telegramSucceeded: telegram.operational?.succeeded ?? telegram.succeeded,
    emailSuccessPct: email.successPct,
    mt5SuccessPct: mt5.successPct,
    webhookSuccessPct: empty.webhookSuccessPct,
    webhookMetric: 'acceptance',
    intake,
    webhook: intake,
    channels,
    telegram: channelCard(telegram),
    email: channelCard(email),
    mt5: channelCard(mt5),
    socket: channelCard(socket),
    liveEligible,
    issues: jobAgg30.issues,
    health,
    telegramAccounting: jobAgg30.jobRows > 0 ? 'per_recipient' : 'legacy_unknown',
    avgPipelineLatencyMs: empty.avgPipelineLatencyMs,
    avgPipelineLatencyRawMs: empty.avgPipelineLatencyRawMs,
    fastestPipelineLatencyMs: empty.fastestPipelineLatencyMs,
    slowestPipelineLatencyMs: empty.slowestPipelineLatencyMs,
    avgWebhookToMongoMs: empty.avgWebhookToMongoMs,
    avgMongoToTelegramMs: empty.avgMongoToTelegramMs,
    timezone: 'UTC',
    windowNote,
    operationalWindowHours: OPERATIONAL_WINDOW_HOURS,
    webhookIntakeTtlDays: WEBHOOK_INTAKE_TTL_DAYS,
    latencyNote: empty.latencyNote,
    latency
  };
}

module.exports = {
  computeDeliveryStatistics,
  countUniqueCanonicalSignals,
  startOfDay,
  daysAgo,
  hoursAgo,
  resolveHealth,
  overlayChannelDisplay,
  isProviderAttempted,
  emptyChannel,
  OPERATIONAL_WINDOW_HOURS,
  WEBHOOK_INTAKE_TTL_DAYS,
  findRequestOutcome: async query => {
    const SignalCorrelationService = require('./SignalCorrelationService');
    return SignalCorrelationService.lookupCorrelation({
      requestId: query.requestId,
      signalUuid: query.signalUuid,
      eventId: query.eventId,
      canonicalTradeId: query.canonicalTradeId,
      symbol: query.symbol,
      subscriberId: query.subscriber || query.subscriberId
    });
  }
};
