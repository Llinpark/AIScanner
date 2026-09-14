'use strict';

/**
 * Structured JSON timeline for one trade lifecycle event.
 * Logging only — never throws, never changes delivery decisions.
 */

const { resolveMachineId } = require('./tvAckLog');
const { resolveCanonicalTradeId } = require('./tradeEventIdentity');

function epochOrNull(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function logDeliveryTimeline(stage, fields = {}) {
  const payload = {
    stage: String(stage || 'unknown'),
    tradeId:
      fields.tradeId ||
      fields.canonicalTradeId ||
      resolveCanonicalTradeId(fields.signal || fields.signalDoc || fields) ||
      null,
    signalUuid: fields.signalUuid || fields.signalId || null,
    symbol: fields.symbol || fields.ticker || null,
    side: fields.side || fields.direction || null,
    eventType: fields.eventType || fields.alertType || null,
    eventTimestamp: epochOrNull(fields.eventTimestamp || fields.signalTime || fields.barTime),
    alertFiredAt: epochOrNull(fields.alertFiredAt),
    webhookReceivedAt: epochOrNull(fields.webhookReceivedAt),
    mongoPersistedAt: epochOrNull(fields.mongoPersistedAt),
    jobCreatedAt: epochOrNull(fields.jobCreatedAt),
    jobStartedAt: epochOrNull(fields.jobStartedAt),
    deliveryAttemptAt: epochOrNull(fields.deliveryAttemptAt),
    providerAcceptedAt: epochOrNull(fields.providerAcceptedAt),
    deliveryCompletedAt: epochOrNull(fields.deliveryCompletedAt),
    machineId: fields.machineId || resolveMachineId(),
    processId: process.pid,
    deliveryJobId: fields.deliveryJobId || fields.jobId || null,
    parentEntryJobId: fields.parentEntryJobId || null,
    channel: fields.channel || null,
    subscriberId: fields.subscriberId || null,
    reason: fields.reason || null,
    at: new Date().toISOString()
  };
  try {
    console.log(`[DELIVERY_TIMELINE] ${JSON.stringify(payload)}`);
  } catch {
    /* diagnostics must never break delivery */
  }
  return payload;
}

module.exports = {
  logDeliveryTimeline
};
