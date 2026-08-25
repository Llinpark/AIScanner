/**
 * Kaching Stable Pine Event Contract v1
 * =====================================
 *
 * Public API between TradingView Pine (transport client) and the Kaching backend
 * (intelligence + compatibility layer). This is the ONE canonical shape every
 * downstream consumer must use after the webhook gateway.
 *
 * Stability rules:
 * - Do not casually rename or remove fields.
 * - Additive optional fields only.
 * - A future v2 must still accept v1 payloads.
 * - Current generated Pine 1.3.0 already emits this contract (eventId,
 *   canonicalTradeId, eventType, eventSequence, isRealtime, alertType, levels).
 *   schemaVersion may be inferred as "stable-v1" when those fields are present;
 *   Pine 1.3.0 is not rewritten just to stamp the name.
 *
 * Pine vs backend boundary:
 * - Change Pine only when TradingView must calculate or emit something the
 *   backend cannot know (chart drawings, barstate.isrealtime, wick hits, UUIDs
 *   frozen on the chart).
 * - Telegram / Email / MT5 formatting, duplicate suppression, Redis, Mongo,
 *   lifecycle, admin stats, dashboard, retries, stale rules, risk, notification
 *   templates → backend only. Never require subscribers to regenerate Pine.
 *
 * Drawing product rule: no drawing remains when no active trade. Old Pine
 * visual bugs cannot be fixed remotely; backend alerts still deliver via
 * compatibility. Stable foundation is frozen once finalized.
 */

'use strict';

const STABLE_SCHEMA_VERSION = 'stable-v1';

const EVENT_TYPES = Object.freeze([
  'ENTRY',
  'TP1',
  'TP2',
  'TP3',
  'SL',
  'CANCELLED',
  'EXPIRED'
]);

const SIDES = Object.freeze(['BUY', 'SELL']);

const REALTIME_STATES = Object.freeze(['true', 'false', 'unknown']);

const ADAPTER_IDS = Object.freeze({
  LEGACY: 'LegacyPineAdapter',
  PINE12: 'Pine12Adapter',
  PINE13: 'Pine13Adapter',
  STABLE: 'StablePineAdapter'
});

const COMPATIBILITY_MODE = Object.freeze({
  NATIVE: 'native',
  ADAPTED: 'adapted'
});

const ALERT_TYPE_BY_EVENT = Object.freeze({
  ENTRY: 'entry',
  TP1: 'take_profit_1',
  TP2: 'take_profit_2',
  TP3: 'take_profit_3',
  SL: 'stop_loss',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired'
});

const EVENT_BY_ALERT_TYPE = Object.freeze({
  entry: 'ENTRY',
  signal: 'ENTRY',
  buy: 'ENTRY',
  sell: 'ENTRY',
  take_profit_1: 'TP1',
  take_profit_2: 'TP2',
  take_profit_3: 'TP3',
  tp1: 'TP1',
  tp2: 'TP2',
  tp3: 'TP3',
  tp: 'TP1',
  stop_loss: 'SL',
  stoploss: 'SL',
  sl: 'SL',
  cancelled: 'CANCELLED',
  canceled: 'CANCELLED',
  cancel: 'CANCELLED',
  expired: 'EXPIRED',
  expire: 'EXPIRED',
  expiry: 'EXPIRED',
  candle_expiry: 'EXPIRED'
});

const EVENT_SEQUENCE = Object.freeze({
  ENTRY: 0,
  TP1: 1,
  TP2: 2,
  TP3: 3,
  SL: 3,
  EXPIRED: 3,
  CANCELLED: 3
});

/**
 * @typedef {object} KachingTradeEvent
 * @property {"stable-v1"} schemaVersion
 * @property {{ platform: string, pineVersion: string|null, compatibilityMode: string }} source
 * @property {{ eventId: string, canonicalTradeId: string, signalUuid: string, symbol: string, canonicalTimeframe: string }} identity
 * @property {{ type: string, sequence: number, timestamp: number|null, isRealtime: true|false|"unknown" }} event
 * @property {{ side: "BUY"|"SELL"|null, entry: number|null, tp1: number|null, tp2: number|null, tp3: number|null, sl: number|null }} trade
 * @property {{ userId: string|null, tradingViewUsername: string|null, scriptGenerationId: string|null, tokenVersion: "kls_v1"|"kls_v2"|null }} security
 * @property {{ originalPineVersion: string|null, receivedAt: number, compatibilityAdapter: string, legacy: boolean, capabilities: object, schemaInferred?: boolean }} metadata
 */

function emptyCanonical(overrides = {}) {
  return {
    schemaVersion: STABLE_SCHEMA_VERSION,
    source: {
      platform: 'tradingview',
      pineVersion: null,
      compatibilityMode: COMPATIBILITY_MODE.ADAPTED
    },
    identity: {
      eventId: '',
      canonicalTradeId: '',
      signalUuid: '',
      symbol: '',
      canonicalTimeframe: ''
    },
    event: {
      type: 'ENTRY',
      sequence: 0,
      timestamp: null,
      isRealtime: 'unknown'
    },
    trade: {
      side: null,
      entry: null,
      tp1: null,
      tp2: null,
      tp3: null,
      sl: null
    },
    security: {
      userId: null,
      tradingViewUsername: null,
      scriptGenerationId: null,
      tokenVersion: null
    },
    metadata: {
      originalPineVersion: null,
      receivedAt: Date.now(),
      compatibilityAdapter: ADAPTER_IDS.LEGACY,
      legacy: true,
      capabilities: {}
    },
    ...overrides
  };
}

function eventTypeToAlertType(eventType) {
  const t = String(eventType || 'ENTRY').trim().toUpperCase();
  return ALERT_TYPE_BY_EVENT[t] || 'entry';
}

function alertTypeToEventType(alertType, explicitEventType) {
  const explicit = String(explicitEventType || '').trim().toUpperCase();
  if (EVENT_TYPES.includes(explicit)) return explicit;
  const raw = String(alertType || '').trim().toLowerCase();
  if (EVENT_BY_ALERT_TYPE[raw]) return EVENT_BY_ALERT_TYPE[raw];
  if (EVENT_TYPES.includes(String(alertType || '').trim().toUpperCase())) {
    return String(alertType).trim().toUpperCase();
  }
  return 'ENTRY';
}

function eventSequenceFor(eventType) {
  const t = String(eventType || 'ENTRY').trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(EVENT_SEQUENCE, t) ? EVENT_SEQUENCE[t] : 9;
}

function compatibilityLabel(canonical) {
  const native = canonical?.source?.compatibilityMode === COMPATIBILITY_MODE.NATIVE;
  return native ? 'Native' : 'Adapted';
}

module.exports = {
  STABLE_SCHEMA_VERSION,
  EVENT_TYPES,
  SIDES,
  REALTIME_STATES,
  ADAPTER_IDS,
  COMPATIBILITY_MODE,
  ALERT_TYPE_BY_EVENT,
  EVENT_BY_ALERT_TYPE,
  EVENT_SEQUENCE,
  emptyCanonical,
  eventTypeToAlertType,
  alertTypeToEventType,
  eventSequenceFor,
  compatibilityLabel
};
