const { createHash } = require('crypto');
const { isEntryAlert, isOutcomeAlert, timeframeToMs } = require('./signalOutcome');

/**
 * MAX_ENTRY_SIGNAL_AGE_MS — hard cap on Entry event age vs the *event* timestamp
 * (signalTime / timestamp / time / barTime), never HTTP receipt time.
 *
 * Default: 1_800_000 (30 minutes).
 *
 * Why 30 minutes: TradingView retries and transient delays are typically seconds
 * to a few minutes. Historical Pine replay / chart reload is hours or days old.
 * Duplicate retries of an already-accepted canonical id skip this check.
 * Missing timestamps are NOT rejected (cannot prove replay).
 *
 * Override with env MAX_ENTRY_SIGNAL_AGE_MS (positive integer milliseconds).
 */
const DEFAULT_MAX_ENTRY_SIGNAL_AGE_MS = 30 * 60 * 1000;
const DEFAULT_MAX_LEGACY_ENTRY_AGE_MS = DEFAULT_MAX_ENTRY_SIGNAL_AGE_MS;
const DEFAULT_MAX_LEGACY_OUTCOME_AGE_MS = 2 * 60 * 60 * 1000;

const EVENT_TYPE_TOKEN = Object.freeze({
  entry: 'ENTRY',
  signal: 'ENTRY',
  take_profit_1: 'TP1',
  take_profit_2: 'TP2',
  take_profit_3: 'TP3',
  stop_loss: 'SL',
  expired: 'EXPIRED',
  cancelled: 'CANCELLED'
});

const EVENT_SEQ = Object.freeze({
  entry: 0,
  signal: 0,
  take_profit_1: 1,
  take_profit_2: 2,
  take_profit_3: 3,
  stop_loss: 3,
  expired: 3,
  cancelled: 3
});

function envPositiveMs(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getMaxEntrySignalAgeMs() {
  return envPositiveMs('MAX_ENTRY_SIGNAL_AGE_MS', DEFAULT_MAX_ENTRY_SIGNAL_AGE_MS);
}

function getMaxLegacyEntryAgeMs() {
  return envPositiveMs('MAX_LEGACY_ENTRY_AGE_MS', DEFAULT_MAX_LEGACY_ENTRY_AGE_MS);
}

function getMaxLegacyOutcomeAgeMs() {
  return envPositiveMs('MAX_LEGACY_OUTCOME_AGE_MS', DEFAULT_MAX_LEGACY_OUTCOME_AGE_MS);
}

function hashIdentity(value) {
  const s = String(value || '').trim();
  if (!s) return 'none';
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

/**
 * Canonical trade identity: canonicalTradeId > signalUuid > canonicalSignalKey.
 * Never symbol+timeframe+latest-open.
 */
function resolveCanonicalTradeId(signalOrBody = {}) {
  const named = String(
    signalOrBody.canonicalTradeId || signalOrBody.canonical_trade_id || ''
  ).trim();
  if (named) return named;
  const uuid = String(
    signalOrBody.signalUuid ||
      signalOrBody.signalId ||
      signalOrBody.signal_id ||
      signalOrBody.signalGroupId ||
      ''
  ).trim();
  if (uuid) return uuid;
  const key = String(
    signalOrBody.canonicalSignalKey || signalOrBody.canonical_signal_key || ''
  ).trim();
  if (key) return key;
  return '';
}

function parseEpochMs(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date) {
    const t = raw.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw <= 0) return null;
    // 10-digit unix seconds vs 13-digit unix ms. Tiny test ids (e.g. 123) are ignored.
    if (raw >= 1e12) return raw;
    if (raw >= 1e9) return raw * 1000;
    return null;
  }
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d{10,13}$/.test(s)) return parseEpochMs(Number(s));
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Event time from payload fields, then from canonical UUID (Pine embeds signalTime).
 */
function parseEventTimestamp(body = {}) {
  const direct =
    parseEpochMs(body.signalTime) ||
    parseEpochMs(body.signal_time) ||
    parseEpochMs(body.timestamp) ||
    parseEpochMs(body.time) ||
    parseEpochMs(body.barTime) ||
    parseEpochMs(body.bar_time) ||
    parseEpochMs(body.eventTimestamp) ||
    parseEpochMs(body.event_timestamp) ||
    parseEpochMs(body.barTime) ||
    parseEpochMs(body.bar_time);
  if (direct) return direct;

  const id = resolveCanonicalTradeId(body);
  const embedded = String(id).match(/-c\d+-(\d{10,13})-/);
  if (embedded) return parseEpochMs(Number(embedded[1]));
  return null;
}

function parseBridgeEventIndex(body = {}) {
  const raw = body.bridgeEventIndex ?? body.bridge_event_index ?? body.eventIndex ?? body.event_index;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function eventSequenceRank(alertType) {
  const t = String(alertType || 'entry').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(EVENT_SEQ, t) ? EVENT_SEQ[t] : 9;
}

function resolveEventTypeToken(alertType) {
  const t = String(alertType || 'entry').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(EVENT_TYPE_TOKEN, t)) return EVENT_TYPE_TOKEN[t];
  const raw = String(alertType || 'ENTRY').trim();
  return raw ? raw.toUpperCase() : 'ENTRY';
}

/**
 * Deterministic logical event key: symbol|tf|canonicalTradeId|ENTRY|TP1|…
 * Prefer Pine-supplied eventId. Same logical event with different signalUuids
 * still collapses when eventId (or canonicalTradeId+eventType) matches.
 */
function resolveLogicalEventId(body = {}) {
  const explicit = String(body.eventId || body.event_id || '').trim();
  if (explicit) return explicit;
  const tradeId = resolveCanonicalTradeId(body);
  if (!tradeId) return '';
  const evType =
    String(body.eventType || body.event_type || '').trim() ||
    resolveEventTypeToken(body.alertType || body.alert_type);
  const symbol = String(body.symbol || body.ticker || '').trim();
  const tf = String(
    body.canonicalSignalTf ||
      body.canonical_signal_tf ||
      body.timeframe ||
      body.tf ||
      ''
  ).trim();
  return `${symbol}|${tf}|${tradeId}|${evType}`;
}

/**
 * Compare two events for same-bar deterministic order:
 * sequence rank, then event timestamp, then bridgeEventIndex.
 */
function compareEventOrder(a = {}, b = {}) {
  const rank = eventSequenceRank(a.alertType) - eventSequenceRank(b.alertType);
  if (rank !== 0) return rank;
  const ta = Number(a.eventTimestamp || 0);
  const tb = Number(b.eventTimestamp || 0);
  if (ta !== tb) return ta - tb;
  return Number(a.bridgeEventIndex || 0) - Number(b.bridgeEventIndex || 0);
}

/**
 * Stale-entry policy. Duplicate retries of an already-accepted id are never stale.
 * Missing timestamp → not stale (cannot distinguish delay from replay).
 */
function evaluateEntryFreshness(signalData = {}, opts = {}) {
  const now = opts.now != null ? Number(opts.now) : Date.now();
  const isDuplicate = Boolean(opts.isDuplicate);
  if (isDuplicate) {
    return { stale: false, reason: null, ageMs: null, maxAgeMs: getMaxEntrySignalAgeMs() };
  }
  if (!isEntryAlert(signalData.alertType || 'entry')) {
    return { stale: false, reason: null, ageMs: null, maxAgeMs: getMaxEntrySignalAgeMs() };
  }

  const eventTs = Number(signalData.eventTimestamp) || parseEventTimestamp(signalData);
  if (!eventTs) {
    return {
      stale: false,
      reason: null,
      ageMs: null,
      maxAgeMs: getMaxEntrySignalAgeMs(),
      missingTimestamp: true
    };
  }

  const ageMs = Math.max(0, now - eventTs);
  const cap = getMaxEntrySignalAgeMs();
  // Give slower timeframes a floor of 3 bars so a delayed 15m/1h webhook is not
  // rejected solely because it sat in TradingView's retry queue.
  const barMs = timeframeToMs(signalData.timeframe || '15m');
  const maxAgeMs = Math.max(cap, 3 * barMs);

  if (ageMs > maxAgeMs) {
    return { stale: true, reason: 'stale_entry', ageMs, maxAgeMs, eventTimestamp: eventTs };
  }
  return { stale: false, reason: null, ageMs, maxAgeMs, eventTimestamp: eventTs };
}

function isLifecycleOutcome(alertType) {
  return isOutcomeAlert(alertType);
}

/**
 * Optional Pine isRealtime flag.
 * true → normal; false → non_realtime_event; missing → unknown (freshness gate).
 */
function evaluateRealtimeFlag(signalOrBody = {}) {
  const raw =
    signalOrBody.isRealtime ??
    signalOrBody.is_realtime ??
    signalOrBody.barstateRealtime ??
    signalOrBody.barstate_isrealtime;
  if (raw == null || raw === '') {
    return { reject: false, reason: null, missing: true, state: 'unknown' };
  }
  const s = String(raw).trim().toLowerCase();
  const live = s === 'true' || s === '1' || s === 'yes' || raw === true || raw === 1;
  if (!live) {
    return { reject: true, reason: 'non_realtime_event', missing: false, state: 'false' };
  }
  return { reject: false, reason: null, missing: false, state: 'true' };
}

/**
 * Freshness for isRealtime=unknown. Event timestamp vs receivedAt (never treat
 * HTTP receipt as the event time). Missing timestamp → cannot prove stale.
 */
function evaluateUnknownRealtimeFreshness(signalData = {}, opts = {}) {
  const receivedAt = Number(opts.receivedAt || opts.now || Date.now());
  const eventTs = Number(signalData.eventTimestamp) || parseEventTimestamp(signalData);
  const isEntry = isEntryAlert(signalData.alertType || 'entry');
  const maxAgeMs = isEntry ? getMaxLegacyEntryAgeMs() : getMaxLegacyOutcomeAgeMs();
  if (!eventTs) {
    return {
      stale: false,
      reason: null,
      ageMs: null,
      maxAgeMs,
      missingTimestamp: true
    };
  }
  const ageMs = Math.max(0, receivedAt - eventTs);
  if (ageMs > maxAgeMs) {
    return {
      stale: true,
      reason: isEntry ? 'stale_entry' : 'stale_outcome',
      ageMs,
      maxAgeMs,
      eventTimestamp: eventTs
    };
  }
  return { stale: false, reason: null, ageMs, maxAgeMs, eventTimestamp: eventTs };
}

function mapOutcomeIgnoreReason(raw) {
  const r = String(raw || '');
  if (
    r === 'same_stage_replay' ||
    r === 'already_terminal_same' ||
    r === 'already_terminal' ||
    r === 'backward_transition'
  ) {
    return 'duplicate_lifecycle_event';
  }
  return r || 'outcome_ignored';
}

module.exports = {
  DEFAULT_MAX_ENTRY_SIGNAL_AGE_MS,
  DEFAULT_MAX_LEGACY_ENTRY_AGE_MS,
  DEFAULT_MAX_LEGACY_OUTCOME_AGE_MS,
  EVENT_SEQ,
  EVENT_TYPE_TOKEN,
  getMaxEntrySignalAgeMs,
  getMaxLegacyEntryAgeMs,
  getMaxLegacyOutcomeAgeMs,
  hashIdentity,
  resolveCanonicalTradeId,
  resolveEventTypeToken,
  resolveLogicalEventId,
  parseEpochMs,
  parseEventTimestamp,
  parseBridgeEventIndex,
  eventSequenceRank,
  compareEventOrder,
  evaluateEntryFreshness,
  evaluateUnknownRealtimeFreshness,
  isLifecycleOutcome,
  evaluateRealtimeFlag,
  mapOutcomeIgnoreReason
};
