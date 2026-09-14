'use strict';

/**
 * Delivery-time guard for actionable ENTRY alerts.
 *
 * Accept-time freshness (MAX_ENTRY_SIGNAL_AGE_MS vs event timestamp) is not
 * enough: ENTRY can be accepted while still fresh, then TP/SL can close the
 * trade, then a delayed fan-out / recovery job still holds an OPEN snapshot
 * with entryAcceptedAt set. That snapshot must not be sent as a new BUY/SELL.
 *
 * Same-bar overlap: if ENTRY was accepted within MAX_TERMINAL_ENTRY_OVERLAP_MS,
 * subscribers are still owed BUY/SELL first (sequencer). After that window,
 * skip the provider send and commit the ENTRY sequence so TP/SL can remain
 * informational.
 */

const { isEntryAlert, isTerminalEntry } = require('./signalOutcome');
const { evaluateEntryFreshness, parseEpochMs } = require('./tradeEventIdentity');

const DEFAULT_MAX_TERMINAL_ENTRY_OVERLAP_MS = 15 * 1000;

/**
 * Max age from webhook receipt (preferred) or entryAcceptedAt until actionable
 * ENTRY may still be sent as a live opportunity.
 *
 * Basis (production USDCAD 2026-09-09T10:45Z, canonicalTradeId
 * USDCAD-scalping-c3-1788950520000-short):
 * - webhook receivedAt → entryAcceptedAt ≈ 10.6s
 * - accept → first email deliveredAt ≈ 48s (email held fan-out slots)
 * - accept → first Telegram deliveredAt ≈ 78s
 * - accept → last Telegram deliveredAt ≈ 198s
 * 60s is above a healthy post-fix Telegram hop target and below the measured
 * congestion delay that delivered stale ENTRYs after the market moved.
 */
const DEFAULT_MAX_ENTRY_DELIVERY_AGE_MS = 60 * 1000;

const PAST_ENTRY_STAGES = new Set([
  'TP1',
  'TP2',
  'TP3',
  'SL',
  'EXPIRED',
  'CANCELLED',
  'COMPLETED'
]);

const PAST_ENTRY_OUTCOMES = new Set([
  'tp1',
  'tp2',
  'tp3',
  'sl',
  'expired',
  'cancelled',
  'won',
  'lost'
]);

function getMaxTerminalEntryOverlapMs() {
  const raw = process.env.MAX_TERMINAL_ENTRY_OVERLAP_MS;
  if (raw == null || raw === '') return DEFAULT_MAX_TERMINAL_ENTRY_OVERLAP_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_TERMINAL_ENTRY_OVERLAP_MS;
}

function getMaxEntryDeliveryAgeMs() {
  const raw = process.env.MAX_ENTRY_DELIVERY_AGE_MS;
  if (raw == null || raw === '') return DEFAULT_MAX_ENTRY_DELIVERY_AGE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_ENTRY_DELIVERY_AGE_MS;
}

function plain(doc) {
  if (!doc) return null;
  return doc.toObject ? doc.toObject() : { ...doc };
}

function lifecyclePastEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (isTerminalEntry(entry)) return true;
  const stage = String(entry.lifecycleStage || '').toUpperCase();
  if (PAST_ENTRY_STAGES.has(stage)) return true;
  const outcome = String(entry.outcome || '').toLowerCase();
  return PAST_ENTRY_OUTCOMES.has(outcome);
}

function isEntrySequenceSkipReason(reason) {
  const r = String(reason || '');
  return (
    r === 'terminal_before_entry_delivery' ||
    r === 'stale_trade_before_delivery' ||
    r === 'stale_entry' ||
    r === 'stale_entry_delivery_age'
  );
}

/**
 * Copy live lifecycle fields onto an ENTRY accept/job snapshot.
 * Keeps alertType/eventId from the snapshot (job identity stays ENTRY).
 */
function mergeLiveLifecycleForEntryDelivery(snapshot, latest) {
  if (!snapshot) return snapshot;
  const base = plain(snapshot);
  if (!isEntryAlert(base.alertType || 'entry')) return snapshot;
  if (!latest) return snapshot;
  const live = plain(latest);
  return {
    ...base,
    tradeStatus: live.tradeStatus != null ? live.tradeStatus : base.tradeStatus,
    outcome: live.outcome != null ? live.outcome : base.outcome,
    lifecycleStage: live.lifecycleStage != null ? live.lifecycleStage : base.lifecycleStage,
    closedAt: live.closedAt != null ? live.closedAt : base.closedAt,
    highestMilestone: live.highestMilestone != null ? live.highestMilestone : base.highestMilestone,
    expiresAt: live.expiresAt != null ? live.expiresAt : base.expiresAt,
    entryAcceptedAt: base.entryAcceptedAt || live.entryAcceptedAt
  };
}

function evaluateActionableEntryDelivery(signal = {}, opts = {}) {
  const now = opts.now != null ? Number(opts.now) : Date.now();
  const overlapMs = getMaxTerminalEntryOverlapMs();
  const alertType = signal.alertType || 'entry';
  if (!isEntryAlert(alertType)) {
    return { skip: false, reason: null, overlapMs };
  }

  const freshness = evaluateEntryFreshness(signal, {
    now,
    isDuplicate: Boolean(opts.isDuplicate)
  });
  if (freshness.stale) {
    return { skip: true, reason: 'stale_trade_before_delivery', freshness, overlapMs };
  }

  if (signal.expiresAt) {
    const exp = new Date(signal.expiresAt).getTime();
    if (!Number.isNaN(exp) && exp <= now) {
      return { skip: true, reason: 'stale_entry', freshness, overlapMs };
    }
  }

  if (lifecyclePastEntry(signal)) {
    const acceptedMs = parseEpochMs(signal.entryAcceptedAt);
    if (acceptedMs != null && now - acceptedMs <= overlapMs) {
      return {
        skip: false,
        reason: 'live_overlap_entry_owed',
        freshness,
        ageSinceAcceptMs: Math.max(0, now - acceptedMs),
        overlapMs
      };
    }

    return {
      skip: true,
      reason: isTerminalEntry(signal) ? 'terminal_before_entry_delivery' : 'stale_trade_before_delivery',
      freshness,
      ageSinceAcceptMs: acceptedMs != null ? Math.max(0, now - acceptedMs) : null,
      overlapMs
    };
  }

  const maxDeliveryAgeMs = getMaxEntryDeliveryAgeMs();
  const receiptMs =
    parseEpochMs(signal.webhookReceivedAt) || parseEpochMs(signal.entryAcceptedAt);
  if (receiptMs != null && maxDeliveryAgeMs > 0) {
    const deliveryAgeMs = Math.max(0, now - receiptMs);
    if (deliveryAgeMs > maxDeliveryAgeMs) {
      return {
        skip: true,
        reason: 'stale_entry_delivery_age',
        freshness,
        deliveryAgeMs,
        maxDeliveryAgeMs,
        overlapMs
      };
    }
  }

  return { skip: false, reason: null, freshness, overlapMs, maxDeliveryAgeMs };
}

module.exports = {
  DEFAULT_MAX_TERMINAL_ENTRY_OVERLAP_MS,
  DEFAULT_MAX_ENTRY_DELIVERY_AGE_MS,
  getMaxEntryDeliveryAgeMs,
  PAST_ENTRY_STAGES,
  getMaxTerminalEntryOverlapMs,
  lifecyclePastEntry,
  isEntrySequenceSkipReason,
  mergeLiveLifecycleForEntryDelivery,
  evaluateActionableEntryDelivery
};
