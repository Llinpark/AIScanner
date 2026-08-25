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

const DEFAULT_DELIVERY_SEQ_WAIT_MS = 120000;
const OPTIONAL_PREDECESSORS = Object.freeze(['take_profit_1', 'take_profit_2']);

function getDeliverySeqWaitMs() {
  const raw = process.env.DELIVERY_SEQ_WAIT_MS;
  if (raw != null && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'test') return 8000;
  return DEFAULT_DELIVERY_SEQ_WAIT_MS;
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
  if (result.ok === false) return false;
  return true;
}

function seqLogMeta(signalDoc, extra = {}) {
  return {
    ...extractPipelineMeta(signalDoc || {}),
    ...extra
  };
}

async function timeoutBuffer({ canonicalId, subscriberId, channel, ev, signalDoc, seqHash, missing }) {
  await TradeEventStore.bufferDeliverySequence(canonicalId, subscriberId, channel, {
    alertType: ev,
    signalUuid: signalDoc?.signalUuid || signalDoc?.signalId,
    requestId: signalDoc?.pipelineRequestId,
    missing
  });
  try {
    const DurableDelivery = require('./durableDelivery');
    await DurableDelivery.ensureJob({
      eventId: signalDoc?.eventId || canonicalId,
      canonicalTradeId: canonicalId,
      subscriberId,
      channel,
      eventType: ev,
      signalUuid: signalDoc?.signalUuid || signalDoc?.signalId,
      payload: { signal: signalDoc }
    });
    await DurableDelivery.scheduleRetryBySpec(
      {
        eventId: signalDoc?.eventId || canonicalId,
        canonicalTradeId: canonicalId,
        subscriberId,
        channel,
        eventType: ev
      },
      { reason: `blocked_waiting_for_entry:${(missing || []).join(',')}`, blockedWaitingForEntry: true }
    );
  } catch (err) {
    console.warn('[DeliverySequence] durable block persist failed:', err.message);
  }
  logPipeline('DeliverySequence', 'PENDING', seqLogMeta(signalDoc, {
    reason:
      `delivery_sequence_wait; timeout; predecessor=${(missing || []).join(',') || 'entry'}; ` +
      `eventType=${ev}; deliverySequenceKey=${seqHash}; channel=${channel}; buffered=1`
  }));
  return { ok: false, reason: 'delivery_sequence_wait', deferred: true };
}

/**
 * Serialize send() per canonical trade × subscriber × channel.
 * Outcomes wait (condition poll + Redis lock) until predecessors are committed.
 */
async function withChannelSequence({
  signalDoc,
  subscriberId,
  channel,
  alertType,
  send
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
  const waitMs = getDeliverySeqWaitMs();
  const deadline = Date.now() + waitMs;
  const lockTtlSec = Math.max(60, Math.ceil(waitMs / 1000) + 5);

  if (!canonicalId) {
    return send();
  }

  while (true) {
    const remaining = Math.max(0, deadline - Date.now());
    const acquired = await TradeEventStore.acquireLock(lockId, {
      ttlSec: lockTtlSec,
      waitMs: isEntry ? Math.min(800, remaining || 800) : remaining
    });

    if (!acquired.ok) {
      if (acquired.reason === 'redis_unavailable' || acquired.backend === 'none') {
        if (isEntry) return send();
        logPipeline('DeliverySequence', 'FAIL', seqLogMeta(signalDoc, {
          reason:
            `delivery_sequence_wait; redis_unavailable; eventType=${ev}; ` +
            `deliverySequenceKey=${seqHash}; channel=${ch}`
        }));
        return { ok: false, reason: 'redis_unavailable', deferred: false };
      }
      if (isEntry) {
        return send();
      }
      if (Date.now() >= deadline) {
        return timeoutBuffer({
          canonicalId,
          subscriberId: sub,
          channel: ch,
          ev,
          signalDoc,
          seqHash,
          missing: ['entry']
        });
      }
      await sleep(15);
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
        if (missing.length) {
          logPipeline('DeliverySequence', 'PENDING', seqLogMeta(signalDoc, {
            reason:
              `delivery_sequence_wait; predecessor=${missing.join(',')}; eventType=${ev}; ` +
              `eventSequence=${eventSequenceRank(ev)}; deliverySequenceKey=${seqHash}; ` +
              `channel=${ch}`
          }));
          await TradeEventStore.releaseLock(lockId, acquired.token);
          released = true;
          if (Date.now() >= deadline) {
            return timeoutBuffer({
              canonicalId,
              subscriberId: sub,
              channel: ch,
              ev,
              signalDoc,
              seqHash,
              missing
            });
          }
          await sleep(15);
          continue;
        }
      }

      const result = await send();
      if (shouldCommitResult(result)) {
        await TradeEventStore.markDeliveryCommitted(canonicalId, sub, ch, ev);
        logPipeline('DeliverySequence', 'PASS', seqLogMeta(signalDoc, {
          reason:
            `delivery_sequence_release; eventType=${ev}; eventSequence=${eventSequenceRank(ev)}; ` +
            `deliverySequenceKey=${seqHash}; channel=${ch}`
        }));
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
      if (!released) await TradeEventStore.releaseLock(lockId, acquired.token);
    }
  }
}

module.exports = {
  DEFAULT_DELIVERY_SEQ_WAIT_MS,
  getDeliverySeqWaitMs,
  seqEventType,
  requiredPredecessors,
  deliverySequenceKey,
  deliverySequenceHash,
  withChannelSequence,
  shouldCommitResult
};
