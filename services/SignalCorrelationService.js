'use strict';

/**
 * Super-admin diagnostic correlation lookup. No secrets. Bounded queries only.
 */

const mongoose = require('mongoose');
const Signal = require('../models/Signal');
const DeliveryJob = require('../models/DeliveryJob');
const WebhookIntakeService = require('./WebhookIntakeService');
const { symbolSearchKeys } = require('../utils/signalCorrelation');
const { mapJobToOutcome, isFanoutJob } = require('../utils/deliveryOutcomes');

function redactJob(job) {
  if (!job) return null;
  const payload = job.payload && typeof job.payload === 'object' ? job.payload : {};
  return {
    jobId: job.jobId,
    channel: job.channel,
    subscriberId: job.subscriberId,
    eventType: job.eventType,
    state: job.state,
    outcomeStatus: job.outcomeStatus || mapJobToOutcome(job),
    outcomeReason: job.outcomeReason || job.lastError || job.deliveryReason || null,
    attemptCount: job.attemptCount || 0,
    sendAttempts: job.sendAttempts || 0,
    signalUuid: job.signalUuid,
    requestId: job.requestId || job.correlation?.requestId || null,
    predecessorEvent: job.predecessorEvent || null,
    deliverySequenceKey: job.deliverySequenceKey || null,
    waitMs: job.waitMs != null ? job.waitMs : null,
    retryScheduled: job.retryScheduled,
    createdAt: job.createdAt,
    hasSubscriberSnapshot: Boolean(payload.subscriber),
    hasSignalSnapshot: Boolean(payload.signal || payload.signalData)
  };
}

function firstFailingBoundary(events) {
  return (
    events.find(e => {
      const state = String(e.state || e.outcomeStatus || '');
      if (state === 'failed' || state === 'failed_terminal' || state === 'failed_retryable') return true;
      if (e.accepted === false && Number(e.statusCode) >= 400) return true;
      if (/unrecoverable|AUTH_FAILED|SERVER_ERROR/i.test(String(e.reason || e.category || ''))) return true;
      return false;
    }) || null
  );
}

async function lookupCorrelation({ requestId, signalUuid, eventId, canonicalTradeId, symbol, subscriberId }) {
  const q = {
    requestId: requestId ? String(requestId).trim() : '',
    signalUuid: signalUuid ? String(signalUuid).trim() : '',
    eventId: eventId ? String(eventId).trim() : '',
    canonicalTradeId: canonicalTradeId ? String(canonicalTradeId).trim() : '',
    symbol: symbol ? String(symbol).trim() : '',
    subscriberId: subscriberId ? String(subscriberId).trim() : ''
  };

  const trace = [];
  let intake = [];
  if (q.requestId) {
    intake = await WebhookIntakeService.findByRequestId(q.requestId, { limit: 20 });
    for (const row of intake) {
      trace.push({
        at: row.receivedAt,
        stage: 'tv_post',
        reached: true,
        statusCode: row.statusCode,
        category: row.category,
        accepted: row.accepted,
        persisted: row.persisted,
        deferredFanout: row.deferredFanout,
        skippedFanout: row.skippedFanout,
        reason: row.reason
      });
    }
  }

  let signals = [];
  if (mongoose.connection.readyState === 1) {
    const signalQuery = [];
    if (q.requestId) {
      signalQuery.push({ pipelineRequestId: q.requestId }, { 'correlation.requestId': q.requestId });
    }
    if (q.signalUuid) signalQuery.push({ signalUuid: q.signalUuid });
    if (q.eventId) signalQuery.push({ eventId: q.eventId });
    if (q.canonicalTradeId) signalQuery.push({ canonicalTradeId: q.canonicalTradeId });
    if (q.symbol) {
      const keys = symbolSearchKeys(q.symbol);
      if (keys.length) signalQuery.push({ symbol: { $in: keys } });
    }
    if (signalQuery.length) {
      signals = await Signal.find({ $or: signalQuery })
        .select(
          'signalUuid alertType symbol timeframe pipelineRequestId correlation deliveryStatus deliveryAccounting deliverySummary telegramSent telegramAttempted emailSent mt5Sent createdAt eventId canonicalTradeId'
        )
        .sort({ createdAt: -1 })
        .limit(25)
        .lean();
    }
  }

  for (const sig of signals) {
    trace.push({
      at: sig.createdAt,
      stage: 'signal_persisted',
      signalUuid: sig.signalUuid,
      alertType: sig.alertType,
      deliveryStatus: sig.deliveryStatus,
      deliveryAccounting: sig.deliveryAccounting || 'legacy_unknown',
      requestId: sig.pipelineRequestId || sig.correlation?.requestId || null
    });
  }

  let jobs = [];
  const uuids = [...new Set(signals.map(s => s.signalUuid).filter(Boolean))];
  if (q.signalUuid && !uuids.includes(q.signalUuid)) uuids.push(q.signalUuid);
  if (mongoose.connection.readyState === 1 && (uuids.length || q.requestId || q.subscriberId)) {
    const jobQuery = [];
    if (uuids.length) jobQuery.push({ signalUuid: { $in: uuids.slice(0, 25) } });
    if (q.requestId) jobQuery.push({ requestId: q.requestId }, { 'correlation.requestId': q.requestId });
    if (q.eventId) jobQuery.push({ eventId: q.eventId });
    if (q.canonicalTradeId) jobQuery.push({ canonicalTradeId: q.canonicalTradeId });
    if (q.subscriberId) jobQuery.push({ subscriberId: q.subscriberId });
    if (jobQuery.length) {
      jobs = await DeliveryJob.find({ $or: jobQuery })
        .sort({ createdAt: 1 })
        .limit(200)
        .lean();
    }
  }

  const channelJobs = jobs.filter(j => !isFanoutJob(j)).map(redactJob);
  const fanoutJobs = jobs.filter(j => isFanoutJob(j)).map(redactJob);
  for (const job of jobs) {
    trace.push({
      at: job.createdAt,
      stage: isFanoutJob(job) ? 'fanout_job' : 'delivery_job',
      channel: job.channel,
      subscriberId: job.subscriberId,
      state: job.state,
      outcomeStatus: job.outcomeStatus || mapJobToOutcome(job),
      reason: job.lastError || job.outcomeReason,
      signalUuid: job.signalUuid
    });
  }

  trace.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));

  const eligibleSubs = [...new Set(channelJobs.map(j => j.subscriberId).filter(Boolean))];

  return {
    ok: true,
    diagnosticOnly: true,
    query: q,
    tvPostReached: intake.length > 0,
    httpStatus: intake.length ? intake[intake.length - 1].statusCode : null,
    signalPersisted: signals.length > 0,
    fanoutScheduled: fanoutJobs.length > 0,
    eligibleSubscribers: eligibleSubs.length,
    signals: signals.map(s => ({
      signalUuid: s.signalUuid,
      alertType: s.alertType,
      symbol: s.symbol,
      timeframe: s.timeframe,
      deliveryStatus: s.deliveryStatus,
      deliveryAccounting: s.deliveryAccounting || 'legacy_unknown',
      deliverySummary: s.deliverySummary || null,
      requestId: s.pipelineRequestId || s.correlation?.requestId || null,
      createdAt: s.createdAt
    })),
    fanoutJobs,
    deliveryJobs: channelJobs,
    jobs: channelJobs,
    timeline: trace,
    firstFailingBoundary: firstFailingBoundary([
      ...intake.map(i => ({
        at: i.receivedAt,
        statusCode: i.statusCode,
        accepted: i.accepted,
        category: i.category,
        reason: i.reason
      })),
      ...trace
    ])
  };
}

module.exports = {
  lookupCorrelation,
  firstFailingBoundary
};
