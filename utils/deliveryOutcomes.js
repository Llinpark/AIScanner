'use strict';

/**
 * Per-subscriber × channel delivery accounting.
 * Durable source of truth is DeliveryJob (identity: event + trade + subscriber + channel).
 * Signal.deliveryStatus is a derived rollup — never last-writer.
 */

const OUTCOME = Object.freeze({
  PENDING: 'pending',
  SUCCESS: 'success',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  NOT_ELIGIBLE: 'not_eligible'
});

const CHANNELS = Object.freeze(['telegram', 'email', 'mt5', 'socket']);

const PIPELINE_TO_OUTCOME = Object.freeze({
  PASS: OUTCOME.SUCCESS,
  FAIL: OUTCOME.FAILED,
  SKIP: OUTCOME.SKIPPED,
  PENDING: OUTCOME.PENDING
});

function emptyChannel() {
  return {
    eligible: 0,
    pending: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    notEligible: 0,
    successPct: null
  };
}

function mapJobToOutcome(job = {}) {
  if (job.outcomeStatus && Object.values(OUTCOME).includes(String(job.outcomeStatus))) {
    return String(job.outcomeStatus);
  }
  const state = String(job.state || job.outcome || '').toLowerCase();
  if (state === 'delivered' || state === 'success' || state === 'pass') return OUTCOME.SUCCESS;
  if (state === 'failed_terminal' || state === 'failed' || state === 'fail') return OUTCOME.FAILED;
  if (state === 'skipped' || state === 'skip') return OUTCOME.SKIPPED;
  if (state === 'not_eligible') return OUTCOME.NOT_ELIGIBLE;
  return OUTCOME.PENDING;
}

function isFanoutJob(job = {}) {
  return job.channel === '_fanout' || job.subscriberId === '_event';
}

function addOutcome(bucket, outcome) {
  const o = String(outcome || OUTCOME.PENDING);
  if (o === OUTCOME.SUCCESS) {
    bucket.succeeded += 1;
    bucket.eligible += 1;
  } else if (o === OUTCOME.FAILED) {
    bucket.failed += 1;
    bucket.eligible += 1;
  } else if (o === OUTCOME.PENDING) {
    bucket.pending += 1;
    bucket.eligible += 1;
  } else if (o === OUTCOME.NOT_ELIGIBLE) {
    bucket.notEligible += 1;
  } else {
    bucket.skipped += 1;
  }
}

function successPct(succeeded, failed) {
  const attempts = succeeded + failed;
  if (!attempts) return null;
  return Math.round((succeeded / attempts) * 1000) / 10;
}

function finalizeChannel(bucket) {
  bucket.successPct = successPct(bucket.succeeded, bucket.failed);
  return bucket;
}

/**
 * @param {Array<{ channel?: string, outcome?: string, state?: string, outcomeStatus?: string }>} outcomes
 */
function resolveSignalDeliverySummary(outcomes = []) {
  const perChannel = {
    telegram: emptyChannel(),
    email: emptyChannel(),
    mt5: emptyChannel(),
    socket: emptyChannel()
  };
  const totals = {
    totalEligible: 0,
    totalPending: 0,
    totalSucceeded: 0,
    totalFailed: 0,
    totalSkipped: 0,
    totalNotEligible: 0
  };

  const list = Array.isArray(outcomes) ? outcomes : [];
  for (const row of list) {
    if (isFanoutJob(row)) continue;
    const channel = String(row.channel || '').toLowerCase();
    if (!CHANNELS.includes(channel)) continue;
    const outcome = row.outcome || mapJobToOutcome(row);
    addOutcome(perChannel[channel], outcome);
  }

  for (const ch of CHANNELS) {
    finalizeChannel(perChannel[ch]);
    totals.totalEligible += perChannel[ch].eligible;
    totals.totalPending += perChannel[ch].pending;
    totals.totalSucceeded += perChannel[ch].succeeded;
    totals.totalFailed += perChannel[ch].failed;
    totals.totalSkipped += perChannel[ch].skipped;
    totals.totalNotEligible += perChannel[ch].notEligible;
  }

  let signalStatus = 'pending';
  if (totals.totalEligible === 0) {
    signalStatus =
      totals.totalSkipped + totals.totalNotEligible > 0 ? 'skipped' : 'pending';
  } else if (totals.totalPending > 0) {
    signalStatus = 'pending';
  } else if (totals.totalFailed > 0 && totals.totalSucceeded > 0) {
    signalStatus = 'partial';
  } else if (totals.totalFailed > 0) {
    signalStatus = 'failed';
  } else if (totals.totalSucceeded > 0) {
    signalStatus = 'delivered';
  }

  return {
    accounting: list.length ? 'per_recipient' : 'legacy_unknown',
    signalStatus,
    ...totals,
    telegram: perChannel.telegram,
    email: perChannel.email,
    mt5: perChannel.mt5,
    socket: perChannel.socket,
    telegramEligible: perChannel.telegram.eligible,
    telegramPending: perChannel.telegram.pending,
    telegramSkipped: perChannel.telegram.skipped + perChannel.telegram.notEligible,
    telegramFailed: perChannel.telegram.failed,
    telegramSucceeded: perChannel.telegram.succeeded,
    telegramSuccessPct: perChannel.telegram.successPct
  };
}

/**
 * Adapter for the historical resolveDeliveryStatus({ telegramSent, mt5Sent, tgPipelineStatus, ... }) shape.
 */
function outcomesFromLegacyFlags({
  telegramSent,
  mt5Sent,
  emailSent,
  socketSent,
  tgPipelineStatus,
  mt5PipelineStatus,
  emailPipelineStatus,
  socketPipelineStatus
} = {}) {
  const rows = [];
  const push = (channel, pipelineStatus, sent) => {
    if (pipelineStatus == null && sent == null) return;
    let outcome = PIPELINE_TO_OUTCOME[String(pipelineStatus || '').toUpperCase()];
    if (!outcome) {
      if (sent === true) outcome = OUTCOME.SUCCESS;
      else if (sent === false && pipelineStatus) outcome = OUTCOME.PENDING;
      else return;
    }
    rows.push({ channel, outcome });
  };
  push('telegram', tgPipelineStatus, telegramSent);
  push('mt5', mt5PipelineStatus, mt5Sent);
  push('email', emailPipelineStatus, emailSent);
  push('socket', socketPipelineStatus, socketSent);
  return rows;
}

function resolveDeliveryStatus(flags) {
  const summary = resolveSignalDeliverySummary(outcomesFromLegacyFlags(flags));
  return summary.signalStatus;
}

/**
 * Merge denormalized Signal.deliveryStatus so one subscriber cannot erase another.
 * failed + later delivered → partial. skipped never upgrades to delivered.
 */
function mergeSignalDeliveryStatus(previous, next) {
  const prev = String(previous || 'pending');
  const nxt = String(next || 'pending');
  if (prev === nxt) return nxt;
  if (prev === 'partial' || nxt === 'partial') return 'partial';
  if ((prev === 'failed' && nxt === 'delivered') || (prev === 'delivered' && nxt === 'failed')) {
    return 'partial';
  }
  if (prev === 'failed' && (nxt === 'skipped' || nxt === 'pending')) return 'failed';
  if (prev === 'delivered' && nxt === 'skipped') return 'delivered';
  if (prev === 'delivered' && nxt === 'pending') return 'delivered';
  if (prev === 'skipped' && nxt === 'delivered') return 'delivered';
  if (prev === 'skipped' && nxt === 'failed') return 'failed';
  if (prev === 'pending') return nxt;
  return nxt;
}

/**
 * Concurrent-safe Mongo filters so one subscriber cannot erase another.
 * Callers apply each op with updateOne(filter, { $set }).
 */
function mergeDeliveryStatusOps(nextStatus) {
  const accounting = { deliveryAccounting: 'per_recipient' };
  const nxt = String(nextStatus || 'pending');
  if (nxt === 'partial') {
    return [{ filter: {}, set: { deliveryStatus: 'partial', ...accounting } }];
  }
  if (nxt === 'delivered') {
    return [
      { filter: { deliveryStatus: 'failed' }, set: { deliveryStatus: 'partial', ...accounting } },
      {
        filter: { deliveryStatus: { $nin: ['failed', 'partial', 'delivered'] } },
        set: { deliveryStatus: 'delivered', ...accounting }
      }
    ];
  }
  if (nxt === 'failed') {
    return [
      { filter: { deliveryStatus: 'delivered' }, set: { deliveryStatus: 'partial', ...accounting } },
      {
        filter: { deliveryStatus: { $nin: ['delivered', 'partial', 'failed'] } },
        set: { deliveryStatus: 'failed', ...accounting }
      }
    ];
  }
  if (nxt === 'skipped') {
    return [
      {
        filter: { deliveryStatus: { $in: ['pending'] } },
        set: { deliveryStatus: 'skipped', ...accounting }
      }
    ];
  }
  return [];
}

module.exports = {
  OUTCOME,
  CHANNELS,
  mapJobToOutcome,
  isFanoutJob,
  resolveSignalDeliverySummary,
  outcomesFromLegacyFlags,
  resolveDeliveryStatus,
  mergeSignalDeliveryStatus,
  mergeDeliveryStatusOps,
  successPct
};
