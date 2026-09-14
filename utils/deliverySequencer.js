/**
 * Subscriber delivery sequencer — one authoritative ordering decision.
 *
 * Scope: canonicalTradeId + subscriberId + delivery channel.
 * Redis is the cross-machine authority (seq lock + committed HASH).
 * Process-local TradeEventDispatcher remains a same-process optimization only.
 *
 * Guarantee: an outcome is not sent on a channel until ENTRY is committed into
 * that subscriber's sequence for that channel. Commit = successful send
 * (Telegram Bot API HTTP 200 ≈ queued at Telegram), not user read receipts.
 * ENTRY never waits for TP/SL.
 *
 * Skip-milestone: ENTRY → TP3 is allowed when TP1/TP2 were never accepted.
 * Never invent synthetic TP1/TP2. Never deliver TP3 before ENTRY.
 */

const TradeEventStore = require('./tradeEventStore');
const {
  eventSequenceRank,
  resolveCanonicalTradeId,
  hashIdentity
} = require('./tradeEventIdentity');
const { isEntryAlert } = require('./signalOutcome');
const { logPipeline, extractPipelineMeta } = require('./pipelineLog');
const { withTimeout } = require('./boundedWait');
const { isEntrySequenceSkipReason } = require('./entryDeliveryGuard');
const { logDeliveryTimeline } = require('./deliveryTimeline');

/**
 * Live overlapping ENTRY/TP wait (in-process only). Recovery must use check-once.
 * Historical 120s in-handler poll is forbidden — it storms delivery_sequence_wait.
 */
const DEFAULT_DELIVERY_SEQ_WAIT_MS = 3000;
/** Live overlapping wait poll. 15ms was a log/lock storm; 50ms is enough. */
const DEFAULT_DELIVERY_SEQ_POLL_MS = 50;
/** After this age a blocked sequence wait becomes FAILED_TERMINAL (no infinite park). */
const DEFAULT_SEQUENCE_WAIT_MAX_MS = 10 * 60 * 1000;
/** Admin-visible unhealthy threshold for jobs still waiting on ENTRY. */
const DEFAULT_SEQUENCE_WAIT_UNHEALTHY_MS = 60 * 1000;
const OPTIONAL_PREDECESSORS = Object.freeze(['take_profit_1', 'take_profit_2']);

function getDeliverySeqWaitMs() {
  const raw = process.env.DELIVERY_SEQ_WAIT_MS;
  if (raw != null && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_DELIVERY_SEQ_WAIT_MS;
}

function getDeliverySeqPollMs() {
  const raw = process.env.DELIVERY_SEQ_POLL_MS;
  if (raw != null && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_DELIVERY_SEQ_POLL_MS;
}

function envPositiveMs(name, fallback) {
  const raw = process.env[name];
  if (raw != null && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

function getSequenceWaitMaxMs() {
  return envPositiveMs('SEQUENCE_WAIT_MAX_MS', DEFAULT_SEQUENCE_WAIT_MAX_MS);
}

function getSequenceWaitUnhealthyMs() {
  return envPositiveMs('SEQUENCE_WAIT_UNHEALTHY_MS', DEFAULT_SEQUENCE_WAIT_UNHEALTHY_MS);
}

function isEntryEventType(eventType) {
  const ev = seqEventType(eventType);
  return ev === 'entry' || isEntryAlert(ev);
}

/**
 * If sequencer HASH is missing but an ENTRY DeliveryJob is already delivered
 * for this subscriber+channel+trade, reconstruct committed sequencing state
 * so TP/SL is not parked forever. Skipped / not_eligible ENTRY must NOT
 * unblock outcomes — those channels never received the trade.
 */
async function recoverEntryCommitFromDeliveredJob(canonicalId, subscriberId, channel, signalDoc) {
  const DurableDelivery = require('./durableDelivery');
  const sub = String(subscriberId || 'broadcast');
  const ch = String(channel || 'unknown');
  const uuid = String(signalDoc?.signalUuid || signalDoc?.signalId || canonicalId || '').trim();

  const consider = job => {
    if (!job) return false;
    if (String(job.canonicalTradeId || '') !== String(canonicalId)) return false;
    if (String(job.subscriberId) !== sub) return false;
    if (String(job.channel) !== ch) return false;
    if (!isEntryEventType(job.eventType)) return false;
    const state = String(job.state || '').toLowerCase();
    return state === 'delivered';
  };

  let hit = (DurableDelivery.listMemoryJobs() || []).find(consider);
  if (!hit && uuid && typeof DurableDelivery.listJobsForSignal === 'function') {
    try {
      const listed = await withTimeout(
        DurableDelivery.listJobsForSignal(uuid),
        1500,
        'sequence_entry_job_lookup'
      );
      hit = (listed || []).find(consider);
    } catch (err) {
      logPipeline('DeliverySequence', 'FAIL', seqLogMeta(signalDoc, {
        reason: `sequence_entry_job_lookup_failed; ${err.message || err}`
      }));
    }
  }
  if (!hit) return false;
  await TradeEventStore.markDeliveryCommitted(canonicalId, sub, ch, 'entry');
  logPipeline('DeliverySequence', 'PASS', seqLogMeta(signalDoc, {
    reason:
      `sequence_entry_recovered; channel=${ch}; state=${hit.state}; ` +
      `canonicalTradeId=${canonicalId}; reconstructed_from=delivery_job`
  }));
  return true;
}

function isCheckOnceWaitMode(waitMode) {
  const m = String(waitMode || '').toLowerCase();
  return m === 'recovery' || m === 'check_once' || m === 'check-once';
}

function seqEventType(alertType) {
  const t = String(alertType || 'entry').trim().toLowerCase();
  return t === 'signal' ? 'entry' : t;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function deliverySequenceKey(canonicalId, subscriberId, channel) {
  return `${String(canonicalId || '')}|${String(subscriberId || 'broadcast')}|${String(channel || 'unknown')}`;
}

function deliverySequenceHash(canonicalId, subscriberId, channel) {
  return hashIdentity(deliverySequenceKey(canonicalId, subscriberId, channel));
}

/**
 * Predecessors that must already be committed for this subscriber/channel.
 * ENTRY: none. Outcomes always require ENTRY. TP1/TP2 are required only when
 * those milestones were accepted for this canonical trade (genuine skip allowed).
 */
function requiredPredecessors(alertType, acceptedList) {
  const ev = seqEventType(alertType);
  if (ev === 'entry' || isEntryAlert(ev)) return [];
  const accepted = new Set((acceptedList || []).map(seqEventType));
  const rank = eventSequenceRank(ev);
  const req = ['entry'];
  for (const t of OPTIONAL_PREDECESSORS) {
    if (eventSequenceRank(t) < rank && accepted.has(t)) req.push(t);
  }
  return req;
}

function shouldCommitResult(result) {
  if (result == null || result.deferred) return false;
  if (result.ok === true) return true;
  if (result.reason === 'duplicate_milestone') return true;
  // Channel never participates (no chatId / wrong tier). Commit so outcomes
  // on THIS channel are not parked forever — they will also be not-eligible.
  if (result.notEligible === true) return true;
  // Accepted ENTRY suppressed at delivery (lifecycle already past ENTRY, or
  // delivery-age exceeded): do NOT send BUY/SELL, but DO commit so TP/SL can
  // proceed. TradeDeliveryService only sets this flag when entryAcceptedAt is
  // present. Never-accepted terminal ENTRY must not reach this path.
  if (
    result.commitAcceptedEntrySkip === true &&
    isEntrySequenceSkipReason(result.reason)
  ) {
    return true;
  }
  // Unflagged stale/terminal ENTRY skip must not unblock outcomes (never
  // accepted, or caller did not opt into accepted-skip commit).
  if (isEntrySequenceSkipReason(result.reason)) return false;
  if (result.skipped === true) return false;
  if (result.ok === false) return false;
  return false;
}

function seqLogMeta(signalDoc, extra = {}) {
  return {
    ...extractPipelineMeta(signalDoc || {}),
    ...extra
  };
}

async function timeoutBuffer({ canonicalId, subscriberId, channel, ev, signalDoc, seqHash, missing, waitMs }) {
  await TradeEventStore.bufferDeliverySequence(canonicalId, subscriberId, channel, {
    alertType: ev,
    signalUuid: signalDoc?.signalUuid || signalDoc?.signalId,
    requestId: signalDoc?.pipelineRequestId || signalDoc?.correlation?.requestId,
    missing
  });
  try {
    const DurableDelivery = require('./durableDelivery');
    const { compactCorrelation, mergeCorrelation, buildDurableRefs } = require('./signalCorrelation');
    const spec = {
      eventId: signalDoc?.eventId || canonicalId,
      canonicalTradeId: canonicalId,
      subscriberId,
      channel,
      eventType: ev,
      signalUuid: signalDoc?.signalUuid || signalDoc?.signalId,
      payload: { signal: signalDoc },
      correlation: compactCorrelation(mergeCorrelation(signalDoc, {
        subscriberId,
        channel,
        canonicalTradeId: canonicalId
      })),
      refs: buildDurableRefs({
        eventId: signalDoc?.eventId || canonicalId,
        canonicalTradeId: canonicalId,
        subscriberId,
        channel,
        eventType: ev,
        signalDoc
      }),
      predecessorEvent: (missing || []).join(',') || 'entry',
      deliverySequenceKey: deliverySequenceKey(canonicalId, subscriberId, channel),
      waitMs: waitMs != null ? waitMs : getDeliverySeqWaitMs(),
      retryScheduled: true,
      deliveryReason: `blocked_waiting_for_entry:${(missing || []).join(',') || 'entry'}`
    };
    const parked = await withTimeout(
      DurableDelivery.ensureJob(spec),
      1500,
      'sequence_wait_ensure_job'
    );
    const ageMs = Date.now() - Number(parked?.createdAt || Date.now());
    if (ageMs >= getSequenceWaitMaxMs()) {
      await withTimeout(
        DurableDelivery.commitFailedTerminalBySpec(
          {
            eventId: signalDoc?.eventId || canonicalId,
            canonicalTradeId: canonicalId,
            subscriberId,
            channel,
            eventType: ev
          },
          { reason: 'delivery_sequence_wait_expired' }
        ),
        1500,
        'sequence_wait_expire_commit'
      );
      logPipeline('DeliverySequence', 'FAIL', seqLogMeta(signalDoc, {
        reason:
          `delivery_sequence_wait_expired; predecessor=${(missing || []).join(',') || 'entry'}; ` +
          `eventType=${ev}; channel=${channel}; ageMs=${ageMs}`
      }));
      try {
        const { emitTvDeliver } = require('./tvStageLog');
        emitTvDeliver({
          ...signalDoc,
          subscriberId,
          channel,
          canonicalTradeId: canonicalId,
          state: 'failed_terminal',
          reason: 'delivery_sequence_wait_expired',
          predecessorEvent: (missing || []).join(',') || 'entry',
          ageMs
        });
      } catch {
        /* diagnostics */
      }
      return {
        ok: false,
        reason: 'delivery_sequence_wait_expired',
        deferred: false,
        terminal: true,
        predecessorEvent: (missing || []).join(',') || 'entry'
      };
    }
    await withTimeout(
      DurableDelivery.scheduleRetryBySpec(
        {
          eventId: signalDoc?.eventId || canonicalId,
          canonicalTradeId: canonicalId,
          subscriberId,
          channel,
          eventType: ev
        },
        { reason: spec.deliveryReason, blockedWaitingForEntry: true }
      ),
      1500,
      'sequence_wait_schedule_retry'
    );
  } catch (err) {
    console.warn('[DeliverySequence] durable block persist failed:', err.message);
  }
  logPipeline('DeliverySequence', 'PENDING', seqLogMeta(signalDoc, {
    reason:
      `delivery_sequence_wait; timeout; predecessor=${(missing || []).join(',') || 'entry'}; ` +
      `eventType=${ev}; deliverySequenceKey=${seqHash}; channel=${channel}; buffered=1; ` +
      `waitMs=${waitMs != null ? waitMs : getDeliverySeqWaitMs()}; retryScheduled=yes`
  }));
  try {
    const { emitTvDeliver } = require('./tvStageLog');
    emitTvDeliver({
      ...signalDoc,
      subscriberId,
      channel,
      canonicalTradeId: canonicalId,
      state: 'blocked',
      reason: 'delivery_sequence_wait',
      predecessorEvent: (missing || []).join(',') || 'entry',
      deliverySequenceKey: deliverySequenceKey(canonicalId, subscriberId, channel),
      waitMs: waitMs != null ? waitMs : getDeliverySeqWaitMs(),
      retryScheduled: true
    });
  } catch {
    /* diagnostics */
  }
  return {
    ok: false,
    reason: 'delivery_sequence_wait',
    deferred: true,
    blocked: true,
    predecessorEvent: (missing || []).join(',') || 'entry',
    deliverySequenceKey: deliverySequenceKey(canonicalId, subscriberId, channel),
    waitMs: waitMs != null ? waitMs : getDeliverySeqWaitMs(),
    retryScheduled: true
  };
}

/**
 * Serialize send() per canonical trade × subscriber × channel.
 * Outcomes wait until predecessors are committed.
 *
 * waitMode:
 *   live              — short in-process wait for overlapping live ENTRY/TP (seconds)
 *   recovery/check_once — one Redis/Mongo check, then persist blocked + return
 *
 * Recovery MUST NEVER sit in a 120s polling loop.
 */
async function withChannelSequence({
  signalDoc,
  subscriberId,
  channel,
  alertType,
  send,
  waitMode
}) {
  if (typeof send !== 'function') {
    throw new Error('withChannelSequence requires send()');
  }

  const canonicalId =
    resolveCanonicalTradeId(signalDoc || {}) ||
    String(signalDoc?.signalUuid || signalDoc?.signalId || '').trim();
  const sub = String(subscriberId || 'broadcast');
  const ch = String(channel || 'unknown');
  const ev = seqEventType(alertType || signalDoc?.alertType);
  const seqHash = deliverySequenceHash(canonicalId, sub, ch);
  const lockId = `dseq:${canonicalId || '_none'}:${sub}:${ch}`;
  const isEntry = ev === 'entry' || isEntryAlert(ev);
  const checkOnce = isCheckOnceWaitMode(waitMode);
  const waitMs = checkOnce ? 0 : getDeliverySeqWaitMs();
  const deadline = Date.now() + waitMs;
  const lockTtlSec = Math.max(60, Math.ceil(Math.max(waitMs, 1000) / 1000) + 5);
  const pollMs = getDeliverySeqPollMs();

  if (!canonicalId) {
    logPipeline('DeliverySequence', 'FAIL', seqLogMeta(signalDoc, {
      reason: `missing_canonical_id; eventType=${ev}; channel=${ch}`
    }));
    logDeliveryTimeline('sequence_missing_identity', {
      ...seqLogMeta(signalDoc),
      eventType: ev,
      channel: ch,
      subscriberId: sub,
      reason: 'missing_canonical_id'
    });
    // Legacy ENTRY without Pine identity can still send. Outcomes cannot —
    // there is no trade key to wait on.
    if (isEntry) return send();
    return { ok: false, reason: 'missing_canonical_id', deferred: false };
  }

  let loggedWait = false;
  while (true) {
    const remaining = Math.max(0, deadline - Date.now());
    const acquired = await TradeEventStore.acquireLock(lockId, {
      ttlSec: lockTtlSec,
      waitMs: isEntry ? 800 : remaining
    });

    if (!acquired.ok) {
      if (acquired.reason === 'redis_unavailable' || acquired.backend === 'none') {
        logPipeline('DeliverySequence', 'FAIL', seqLogMeta(signalDoc, {
          reason:
            `delivery_sequence_wait; redis_unavailable; eventType=${ev}; ` +
            `deliverySequenceKey=${seqHash}; channel=${ch}`
        }));
        logDeliveryTimeline('sequence_redis_unavailable', {
          ...seqLogMeta(signalDoc),
          tradeId: canonicalId,
          eventType: ev,
          channel: ch,
          subscriberId: sub,
          reason: 'redis_unavailable'
        });
        return { ok: false, reason: 'redis_unavailable', deferred: false };
      }
      if (isEntry) {
        const already = await TradeEventStore.getCommittedDeliveries(canonicalId, sub, ch);
        if (already.has('entry')) {
          return { ok: true, skipped: true, reason: 'duplicate_milestone' };
        }
        logDeliveryTimeline('sequence_entry_lock_busy', {
          ...seqLogMeta(signalDoc),
          tradeId: canonicalId,
          eventType: ev,
          channel: ch,
          subscriberId: sub,
          reason: 'delivery_sequence_lock_busy'
        });
        return { ok: false, reason: 'delivery_sequence_lock_busy', deferred: true };
      }
      if (Date.now() >= deadline || waitMs === 0) {
        return timeoutBuffer({
          canonicalId,
          subscriberId: sub,
          channel: ch,
          ev,
          signalDoc,
          seqHash,
          missing: ['entry'],
          waitMs
        });
      }
      await sleep(pollMs);
      continue;
    }

    let released = false;
    try {
      let missing = [];
      if (!isEntry) {
        const accepted = await TradeEventStore.listAcceptedAlertTypes(canonicalId);
        const preds = requiredPredecessors(ev, accepted);
        const committed = await TradeEventStore.getCommittedDeliveries(canonicalId, sub, ch);
        missing = preds.filter(p => !committed.has(p));
        if (missing.includes('entry')) {
          const recovered = await recoverEntryCommitFromDeliveredJob(
            canonicalId,
            sub,
            ch,
            signalDoc
          );
          if (recovered) {
            missing = missing.filter(p => p !== 'entry');
          }
        }
        if (missing.length) {
          if (!loggedWait) {
            logPipeline('DeliverySequence', 'PENDING', seqLogMeta(signalDoc, {
              reason:
                `delivery_sequence_wait; predecessor=${missing.join(',')}; eventType=${ev}; ` +
                `eventSequence=${eventSequenceRank(ev)}; deliverySequenceKey=${seqHash}; ` +
                `channel=${ch}; waitMode=${checkOnce || waitMs === 0 ? 'check_once' : 'live'}`
            }));
            logDeliveryTimeline('blocked_waiting_for_entry', {
              ...seqLogMeta(signalDoc),
              tradeId: canonicalId,
              eventType: ev,
              channel: ch,
              subscriberId: sub,
              reason: `predecessor=${missing.join(',')}`
            });
            loggedWait = true;
          }
          await withTimeout(
            TradeEventStore.releaseLock(lockId, acquired.token),
            1500,
            'seq_release_lock'
          ).catch(() => {});
          released = true;
          if (Date.now() >= deadline || waitMs === 0) {
            return timeoutBuffer({
              canonicalId,
              subscriberId: sub,
              channel: ch,
              ev,
              signalDoc,
              seqHash,
              missing,
              waitMs
            });
          }
          await sleep(pollMs);
          continue;
        }
      }

      logDeliveryTimeline('delivery_attempt', {
        ...seqLogMeta(signalDoc),
        tradeId: canonicalId,
        eventType: ev,
        channel: ch,
        subscriberId: sub,
        deliveryAttemptAt: Date.now()
      });
      const result = await send();
      if (shouldCommitResult(result)) {
        await TradeEventStore.markDeliveryCommitted(canonicalId, sub, ch, ev);
        logPipeline('DeliverySequence', 'PASS', seqLogMeta(signalDoc, {
          reason:
            `delivery_sequence_release; eventType=${ev}; eventSequence=${eventSequenceRank(ev)}; ` +
            `deliverySequenceKey=${seqHash}; channel=${ch}`
        }));
        logDeliveryTimeline('delivery_committed', {
          ...seqLogMeta(signalDoc),
          tradeId: canonicalId,
          eventType: ev,
          channel: ch,
          subscriberId: sub,
          deliveryCompletedAt: Date.now(),
          reason: result?.reason || 'committed'
        });
        if (isEntry) {
          try {
            const DurableDelivery = require('./durableDelivery');
            await DurableDelivery.onEntryCommitted({
              canonicalTradeId: canonicalId,
              subscriberId: sub,
              channel: ch
            });
            await TradeEventStore.takeBufferedDeliveries(canonicalId, sub, ch);
          } catch (err) {
            console.warn('[DeliverySequence] entry unblock failed:', err.message);
          }
        }
      }
      if (result && result.deferred && result.reason === 'delivery_sequence_wait') {
        /* already recorded in timeoutBuffer */
      }
      return result;
    } finally {
      if (!released) {
        await withTimeout(
          TradeEventStore.releaseLock(lockId, acquired.token),
          1500,
          'seq_release_lock_final'
        ).catch(() => {});
      }
    }
  }
}

module.exports = {
  DEFAULT_DELIVERY_SEQ_WAIT_MS,
  DEFAULT_DELIVERY_SEQ_POLL_MS,
  DEFAULT_SEQUENCE_WAIT_MAX_MS,
  DEFAULT_SEQUENCE_WAIT_UNHEALTHY_MS,
  getDeliverySeqWaitMs,
  getDeliverySeqPollMs,
  getSequenceWaitMaxMs,
  getSequenceWaitUnhealthyMs,
  seqEventType,
  requiredPredecessors,
  deliverySequenceKey,
  deliverySequenceHash,
  withChannelSequence,
  shouldCommitResult,
  recoverEntryCommitFromDeliveredJob
};
