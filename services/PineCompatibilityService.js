/**
 * Pine event compatibility gateway.
 *
 * Single entry point: normalizeIncomingPineEvent(raw, context) → KachingTradeEvent.
 * Adapters only detect structure, normalize fields, infer event type, derive missing
 * identity, normalize timestamps/side/prices, and stamp metadata. They do not run
 * Redis, lifecycle, persist, or subscriber fan-out.
 *
 * Identity derivation lives here + tradeEventIdentity (one authority). No random UUIDs.
 */

'use strict';

const { createHash } = require('crypto');
const {
  STABLE_SCHEMA_VERSION,
  ADAPTER_IDS,
  COMPATIBILITY_MODE,
  alertTypeToEventType,
  eventTypeToAlertType,
  eventSequenceFor,
  compatibilityLabel
} = require('../contracts/KachingTradeEvent');
const {
  inspectPayloadCapabilities,
  selectAdapter,
  REGISTERED_ADAPTERS
} = require('../config/PineCompatibilityRegistry');
const { normalizePineClientVersion } = require('../utils/PineClientVersion');
const { normalizeSymbol } = require('../config/symbols');
const { normalizeTimeframe } = require('../utils/activeSignalRegistry');
const { timeframeToMs } = require('../utils/signalOutcome');
const {
  parseEventTimestamp,
  parseEpochMs,
  resolveCanonicalTradeId,
  resolveLogicalEventId
} = require('../utils/tradeEventIdentity');
const { normalizeSignalLevels } = require('../utils/kachingSignalLevels');

function trimStr(value) {
  if (value == null) return '';
  return String(value).trim();
}

function compactInstrument(symbol) {
  return trimStr(symbol)
    .toUpperCase()
    .replace(/\//g, '')
    .replace(/\s+/g, '');
}

function parseNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizePriceForIdentity(price) {
  const n = parseNumber(price);
  if (n == null) return 'na';
  return n.toFixed(8);
}

function sideFromBody(body = {}) {
  const raw = trimStr(body.direction || body.action || body.side || body.order || '').toLowerCase();
  if (['buy', 'long', 'bull', 'bullish'].includes(raw)) return 'BUY';
  if (['sell', 'short', 'bear', 'bearish'].includes(raw)) return 'SELL';
  return null;
}

function directionFromSide(side) {
  if (side === 'BUY') return 'long';
  if (side === 'SELL') return 'short';
  return '';
}

function detectTokenVersion(token) {
  const t = trimStr(token);
  if (t.startsWith('kls_v2.')) return 'kls_v2';
  if (t.startsWith('kls_v1.')) return 'kls_v1';
  return null;
}

function pickTimeframe(body = {}) {
  return (
    trimStr(body.canonicalSignalTf) ||
    trimStr(body.canonical_signal_tf) ||
    trimStr(body.canonicalTimeframe) ||
    trimStr(body.timeframe) ||
    trimStr(body.interval) ||
    trimStr(body.tf) ||
    '1h'
  );
}

function tradeTimeBucket(eventTs, timeframe, expiryBars) {
  const barMs = timeframeToMs(timeframe);
  const bars = Number(expiryBars);
  const lifeMs = (Number.isFinite(bars) && bars > 0 ? bars : 24) * barMs;
  const window = Math.max(lifeMs, 60 * 60 * 1000);
  if (!eventTs) return 'nots';
  return String(Math.floor(Number(eventTs) / window) * window);
}

/**
 * Deterministic legacy trade id. Never Math.random / randomUUID.
 * Prices + side + instrument identify the setup; time bucket is coarse enough
 * that ENTRY and later TP/SL of the same trade stay together. HTTP receipt
 * time is never used.
 */
function deriveLegacyCanonicalTradeId(parts = {}) {
  const symbol = compactInstrument(parts.symbol);
  const tf = normalizeTimeframe(parts.timeframe || '1h');
  const side = String(parts.side || 'NA').toUpperCase();
  const userId = trimStr(parts.userId) || 'anon';
  const material = [
    'legacy',
    userId,
    symbol,
    tf,
    side,
    normalizePriceForIdentity(parts.entry),
    normalizePriceForIdentity(parts.tp1),
    normalizePriceForIdentity(parts.tp2),
    normalizePriceForIdentity(parts.tp3),
    normalizePriceForIdentity(parts.sl),
    tradeTimeBucket(parts.eventTimestamp, tf, parts.expiryBars)
  ].join('|');
  const hash = createHash('sha256').update(material).digest('hex').slice(0, 24);
  return `leg-${hash}`;
}

function deriveLegacyEventId(parts = {}) {
  const symbol = compactInstrument(parts.symbol);
  const tf = normalizeTimeframe(parts.timeframe || '1h');
  const tradeId = trimStr(parts.canonicalTradeId);
  const eventType = String(parts.eventType || 'ENTRY').toUpperCase();
  return `${symbol}|${tf}|${tradeId}|${eventType}`;
}

function resolveRealtimeState(body = {}) {
  const raw =
    body.isRealtime ??
    body.is_realtime ??
    body.barstateRealtime ??
    body.barstate_isrealtime;
  if (raw == null || raw === '') return 'unknown';
  const s = String(raw).trim().toLowerCase();
  const live = s === 'true' || s === '1' || s === 'yes' || raw === true || raw === 1;
  return live ? true : false;
}

function namedTradeId(body = {}) {
  return resolveCanonicalTradeId(body);
}

function commonFields(body = {}, context = {}) {
  const levels = normalizeSignalLevels(body);
  const eventType = alertTypeToEventType(
    body.alertType || body.alert_type || body.type,
    body.eventType || body.event_type
  );
  const explicitSeq = body.eventSequence ?? body.event_sequence;
  const sequence =
    explicitSeq != null && String(explicitSeq).trim() !== '' && Number.isFinite(Number(explicitSeq))
      ? Number(explicitSeq)
      : eventSequenceFor(eventType);
  const symbolRaw = trimStr(body.symbol || body.ticker || body.instrument || body.market);
  const timeframe = normalizeTimeframe(pickTimeframe(body));
  const timestamp = parseEventTimestamp(body) || parseEpochMs(body.signalTime) || null;
  const side = sideFromBody(body);
  const userId = trimStr(context.userId || body.userId || body.user_id) || null;
  const tvu = trimStr(
    body.tradingviewUsername || body.tradingview_username || body.username || ''
  ).replace(/^@/, '').toLowerCase() || null;

  return {
    levels,
    eventType,
    sequence,
    symbolRaw,
    symbol: normalizeSymbol(symbolRaw || 'UNKNOWN') || symbolRaw,
    compactSymbol: compactInstrument(symbolRaw),
    timeframe,
    timestamp,
    side,
    userId,
    tvu,
    scriptGenerationId: trimStr(
      body.scriptGenerationId || body.script_generation_id || body.generationId
    ) || null,
    tokenVersion: detectTokenVersion(body.licenseToken || body.license_token),
    expiryBars: body.expiryBars ?? body.expiry_bars
  };
}

function finishIdentity(body, fields, adapterId, { preferNamed = true } = {}) {
  let canonicalTradeId = preferNamed ? namedTradeId(body) : '';
  if (!canonicalTradeId) {
    canonicalTradeId = deriveLegacyCanonicalTradeId({
      userId: fields.userId,
      symbol: fields.compactSymbol || fields.symbol,
      timeframe: fields.timeframe,
      side: fields.side,
      entry: fields.levels.entry,
      tp1: fields.levels.take_profit_1,
      tp2: fields.levels.take_profit_2,
      tp3: fields.levels.take_profit_3,
      sl: fields.levels.stop_loss,
      eventTimestamp: fields.timestamp,
      expiryBars: fields.expiryBars
    });
  }

  const signalUuid =
    trimStr(
      body.signalUuid ||
        body.signalId ||
        body.signal_id ||
        body.signalGroupId ||
        body.canonicalSignalKey
    ) || canonicalTradeId;

  let eventId = trimStr(body.eventId || body.event_id);
  if (!eventId) {
    eventId =
      resolveLogicalEventId({
        ...body,
        eventId: undefined,
        canonicalTradeId,
        signalUuid,
        eventType: fields.eventType,
        alertType: eventTypeToAlertType(fields.eventType),
        symbol: fields.compactSymbol || fields.symbol,
        timeframe: fields.timeframe,
        canonicalSignalTf: fields.timeframe
      }) ||
      deriveLegacyEventId({
        symbol: fields.compactSymbol || fields.symbol,
        timeframe: fields.timeframe,
        canonicalTradeId,
        eventType: fields.eventType
      });
  }

  return { canonicalTradeId, signalUuid, eventId };
}

function buildCanonical(body, context, selection, identity, fields, extras = {}) {
  const native =
    selection.adapterId === ADAPTER_IDS.PINE13 || selection.adapterId === ADAPTER_IDS.STABLE;
  const receivedAt = Number(context.receivedAt) || Date.now();
  const pineVersion =
    selection.pineVersion ||
    normalizePineClientVersion(body.pineClientVersion || body.pine_client_version);

  return {
    schemaVersion: STABLE_SCHEMA_VERSION,
    source: {
      platform: 'tradingview',
      pineVersion: pineVersion || null,
      compatibilityMode: native ? COMPATIBILITY_MODE.NATIVE : COMPATIBILITY_MODE.ADAPTED
    },
    identity: {
      eventId: identity.eventId,
      canonicalTradeId: identity.canonicalTradeId,
      signalUuid: identity.signalUuid,
      symbol: fields.symbol,
      canonicalTimeframe: fields.timeframe
    },
    event: {
      type: fields.eventType,
      sequence: fields.sequence,
      timestamp: fields.timestamp,
      isRealtime: resolveRealtimeState(body)
    },
    trade: {
      side: fields.side,
      entry: fields.levels.entry ?? null,
      tp1: fields.levels.take_profit_1 ?? null,
      tp2: fields.levels.take_profit_2 ?? null,
      tp3: fields.levels.take_profit_3 ?? null,
      sl: fields.levels.stop_loss ?? null
    },
    security: {
      userId: fields.userId,
      tradingViewUsername: fields.tvu,
      scriptGenerationId: fields.scriptGenerationId,
      tokenVersion: fields.tokenVersion
    },
    metadata: {
      originalPineVersion: pineVersion || null,
      receivedAt,
      compatibilityAdapter: selection.adapterId,
      legacy: selection.adapterId === ADAPTER_IDS.LEGACY,
      capabilities: selection.capabilities,
      detectionReason: selection.reason,
      schemaInferred: extras.schemaInferred === true,
      identityDerived: extras.identityDerived === true
    }
  };
}

function adaptStableFamily(body, context, selection) {
  const fields = commonFields(body, context);
  const named = namedTradeId(body);
  const explicitEventId = trimStr(body.eventId || body.event_id);
  const identity = finishIdentity(body, fields, selection.adapterId, { preferNamed: true });
  return buildCanonical(body, context, selection, identity, fields, {
    schemaInferred: selection.adapterId === ADAPTER_IDS.PINE13 && !selection.capabilities.hasStableSchema,
    identityDerived: !explicitEventId || !named
  });
}

function adaptPine12(body, context, selection) {
  const fields = commonFields(body, context);
  const named = namedTradeId(body);
  const identity = finishIdentity(body, fields, selection.adapterId, { preferNamed: true });
  const canonical = buildCanonical(body, context, selection, identity, fields, {
    identityDerived: !trimStr(body.eventId || body.event_id) || !named
  });
  canonical.source.compatibilityMode = COMPATIBILITY_MODE.ADAPTED;
  canonical.metadata.legacy = false;
  return canonical;
}

function adaptLegacy(body, context, selection) {
  const fields = commonFields(body, context);
  const named = namedTradeId(body);
  const identity = finishIdentity(body, fields, selection.adapterId, { preferNamed: true });
  return buildCanonical(body, context, selection, identity, fields, {
    identityDerived: !named || !trimStr(body.eventId || body.event_id)
  });
}

const ADAPTERS = Object.freeze({
  [ADAPTER_IDS.STABLE]: adaptStableFamily,
  [ADAPTER_IDS.PINE13]: adaptStableFamily,
  [ADAPTER_IDS.PINE12]: adaptPine12,
  [ADAPTER_IDS.LEGACY]: adaptLegacy
});

/**
 * RAW → DETECT → ADAPTER → canonical KachingTradeEvent.
 * Never rejects solely because pineClientVersion is missing.
 *
 * @param {object} rawBody
 * @param {{ receivedAt?: number, userId?: string }} [context]
 * @returns {object} KachingTradeEvent
 */
function normalizeIncomingPineEvent(rawBody = {}, context = {}) {
  const body = rawBody && typeof rawBody === 'object' ? rawBody : {};
  const capabilities = inspectPayloadCapabilities(body);
  const selection = selectAdapter(body, capabilities);
  const adapter = ADAPTERS[selection.adapterId] || ADAPTERS[ADAPTER_IDS.LEGACY];
  const canonical = adapter(body, context, selection);
  if (!canonical.identity.eventId) {
    canonical.identity.eventId = deriveLegacyEventId({
      symbol: canonical.identity.symbol,
      timeframe: canonical.identity.canonicalTimeframe,
      canonicalTradeId: canonical.identity.canonicalTradeId,
      eventType: canonical.event.type
    });
    canonical.metadata.identityDerived = true;
  }
  if (!canonical.identity.canonicalTradeId) {
    canonical.identity.canonicalTradeId = deriveLegacyCanonicalTradeId({
      userId: canonical.security.userId,
      symbol: canonical.identity.symbol,
      timeframe: canonical.identity.canonicalTimeframe,
      side: canonical.trade.side,
      entry: canonical.trade.entry,
      tp1: canonical.trade.tp1,
      tp2: canonical.trade.tp2,
      tp3: canonical.trade.tp3,
      sl: canonical.trade.sl,
      eventTimestamp: canonical.event.timestamp
    });
    canonical.metadata.identityDerived = true;
  }
  return canonical;
}

/**
 * Overlay canonical fields onto a copy of the raw webhook body so existing
 * buildSignalData mapping always sees one shape (take_profit_1, eventId, …).
 */
function applyCanonicalToRawBody(rawBody = {}, canonical) {
  const body = { ...(rawBody && typeof rawBody === 'object' ? rawBody : {}) };
  if (!canonical) return body;
  const { identity, event, trade, source, metadata, security } = canonical;
  if (identity.symbol && !trimStr(rawBody.symbol || rawBody.ticker)) body.symbol = identity.symbol;
  if (identity.canonicalTimeframe) {
    if (!trimStr(rawBody.timeframe || rawBody.interval || rawBody.tf)) {
      body.timeframe = identity.canonicalTimeframe;
    }
    if (!trimStr(rawBody.canonicalSignalTf || rawBody.canonical_signal_tf || rawBody.canonicalTimeframe)) {
      body.canonicalSignalTf = identity.canonicalTimeframe;
    }
  }
  body.canonicalTradeId = identity.canonicalTradeId;
  body.eventId = identity.eventId;
  if (identity.signalUuid) {
    body.signalUuid = body.signalUuid || identity.signalUuid;
    body.signalId = body.signalId || identity.signalUuid;
    body.canonicalSignalKey = body.canonicalSignalKey || identity.canonicalTradeId;
  }
  body.eventType = event.type;
  body.eventSequence = event.sequence;
  const origAlert = trimStr(
    rawBody.alertType ||
      rawBody.alert_type ||
      rawBody.type ||
      rawBody.eventType ||
      rawBody.event_type
  );
  if (origAlert) {
    const lower = origAlert.toLowerCase();
    const knownAlert = new Set([
      'entry',
      'signal',
      'stop_loss',
      'take_profit_1',
      'take_profit_2',
      'take_profit_3',
      'expired',
      'cancelled'
    ]);
    body.alertType = knownAlert.has(lower) ? lower : eventTypeToAlertType(event.type);
  }
  if (trade.side && (rawBody.direction || rawBody.action || rawBody.side)) {
    body.direction = directionFromSide(trade.side);
  }
  if (trade.entry != null) body.entry = trade.entry;
  if (trade.sl != null) {
    body.stop_loss = trade.sl;
    body.stop_loss_1 = trade.sl;
  }
  if (trade.tp1 != null) body.take_profit_1 = trade.tp1;
  if (trade.tp2 != null) body.take_profit_2 = trade.tp2;
  if (trade.tp3 != null) body.take_profit_3 = trade.tp3;
  if (event.timestamp) body.signalTime = body.signalTime || event.timestamp;
  if (event.isRealtime === true) body.isRealtime = true;
  else if (event.isRealtime === false) body.isRealtime = false;
  body.schemaVersion = STABLE_SCHEMA_VERSION;
  if (source.pineVersion && !body.pineClientVersion) body.pineClientVersion = source.pineVersion;
  if (security.scriptGenerationId && !body.scriptGenerationId) {
    body.scriptGenerationId = security.scriptGenerationId;
  }
  body.compatibilityAdapter = metadata.compatibilityAdapter;
  body.compatibilityMode = source.compatibilityMode;
  body.legacyAdapted = Boolean(metadata.legacy);
  return body;
}

function attachCanonicalMetadata(signalData, canonical) {
  if (!signalData || !canonical) return signalData;
  signalData.schemaVersion = canonical.schemaVersion;
  signalData.eventId = canonical.identity.eventId;
  signalData.canonicalTradeId = canonical.identity.canonicalTradeId;
  signalData.eventType = canonical.event.type;
  signalData.eventSequence = canonical.event.sequence;
  if (canonical.event.timestamp && !signalData.eventTimestamp) {
    signalData.eventTimestamp = canonical.event.timestamp;
  }
  signalData.detectedPineVersion = canonical.source.pineVersion;
  signalData.compatibilityAdapter = canonical.metadata.compatibilityAdapter;
  signalData.compatibilityMode = canonical.source.compatibilityMode;
  signalData.compatibilityLabel = compatibilityLabel(canonical);
  signalData.legacy = Boolean(canonical.metadata.legacy);
  signalData.isRealtimeState =
    canonical.event.isRealtime === true
      ? 'true'
      : canonical.event.isRealtime === false
        ? 'false'
        : 'unknown';
  signalData.kachingCapabilities = canonical.metadata.capabilities;
  signalData.receivedAt = canonical.metadata.receivedAt;
  signalData.identityDerived = Boolean(canonical.metadata.identityDerived);
  if (canonical.security.tokenVersion) {
    signalData.tokenVersion = canonical.security.tokenVersion;
  }
  return signalData;
}

function observabilityFromCanonical(canonical, extra = {}) {
  if (!canonical) return extra;
  return {
    ...extra,
    detectedPineVersion: canonical.source.pineVersion || extra.detectedPineVersion,
    compatibilityAdapter: canonical.metadata.compatibilityAdapter,
    compatibilityMode: canonical.source.compatibilityMode,
    compatibilityLabel: compatibilityLabel(canonical),
    legacy: Boolean(canonical.metadata.legacy),
    eventId: canonical.identity.eventId,
    canonicalTradeId: canonical.identity.canonicalTradeId,
    eventType: canonical.event.type,
    eventSequence: canonical.event.sequence,
    isRealtimeState:
      canonical.event.isRealtime === true
        ? 'true'
        : canonical.event.isRealtime === false
          ? 'false'
          : 'unknown'
  };
}

module.exports = {
  REGISTERED_ADAPTERS,
  ADAPTERS,
  normalizeIncomingPineEvent,
  applyCanonicalToRawBody,
  attachCanonicalMetadata,
  observabilityFromCanonical,
  deriveLegacyCanonicalTradeId,
  deriveLegacyEventId,
  compactInstrument,
  normalizePriceForIdentity,
  sideFromBody
};
