/**
 * Central Pine compatibility registry — the only place that maps incoming
 * payloads to an adapter. Downstream code must not switch on pineVersion /
 * legacy / tp1 vs takeProfit1.
 *
 * Detection priority:
 *  1. explicit pineClientVersion
 *  2. explicit payload schemaVersion
 *  3. known fields / capabilities
 *  4. payload signature heuristics
 *  5. fallback LegacyPineAdapter
 *
 * Missing pineClientVersion is never a reject reason.
 */

'use strict';

const {
  STABLE_SCHEMA_VERSION,
  ADAPTER_IDS
} = require('../contracts/KachingTradeEvent');
const { normalizePineClientVersion, compareVersions } = require('../utils/PineClientVersion');

function trimStr(value) {
  if (value == null) return '';
  return String(value).trim();
}

function hasOwnNonEmpty(body, keys) {
  for (const key of keys) {
    const v = body[key];
    if (v != null && String(v).trim() !== '') return true;
  }
  return false;
}

/**
 * Capability flags used for adapter selection (not a reject list).
 * @param {object} body
 */
function inspectPayloadCapabilities(body = {}) {
  const schema = trimStr(body.schemaVersion || body.schema_version).toLowerCase();
  return {
    hasEventId: hasOwnNonEmpty(body, ['eventId', 'event_id']),
    hasCanonicalTradeId: hasOwnNonEmpty(body, ['canonicalTradeId', 'canonical_trade_id']),
    hasEventSequence:
      body.eventSequence != null ||
      body.event_sequence != null ||
      String(body.eventSequence || body.event_sequence || '').trim() !== '',
    hasRealtimeFlag:
      (body.isRealtime != null && body.isRealtime !== '') ||
      (body.is_realtime != null && body.is_realtime !== '') ||
      body.barstateRealtime != null ||
      body.barstate_isrealtime != null,
    hasStableSchema: schema === STABLE_SCHEMA_VERSION,
    hasEventType: hasOwnNonEmpty(body, ['eventType', 'event_type']),
    hasSignalUuid: hasOwnNonEmpty(body, [
      'signalUuid',
      'signalId',
      'signal_id',
      'signalGroupId',
      'canonicalSignalKey',
      'canonical_signal_key'
    ]),
    hasCanonicalTf: hasOwnNonEmpty(body, [
      'canonicalSignalTf',
      'canonical_signal_tf',
      'canonicalTimeframe'
    ]),
    hasPineVersion: Boolean(
      normalizePineClientVersion(
        body.pineClientVersion || body.pine_client_version || body.clientVersion || body.client_version
      )
    ),
    hasTakeProfitSnake: body.take_profit_1 != null || body.take_profit_2 != null,
    hasTakeProfitCamel: body.takeProfit1 != null || body.tp1 != null,
    hasActionField: body.action != null && body.direction == null,
    hasTickerOnly: Boolean(trimStr(body.ticker)) && !trimStr(body.symbol)
  };
}

function pineMajor(version) {
  const n = parseInt(String(version || '').split('.')[0], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {object} body
 * @param {ReturnType<typeof inspectPayloadCapabilities>} [caps]
 * @returns {{ adapterId: string, pineVersion: string|null, capabilities: object, reason: string }}
 */
function selectAdapter(body = {}, caps = inspectPayloadCapabilities(body)) {
  const pineVersion = normalizePineClientVersion(
    body.pineClientVersion ||
      body.pine_client_version ||
      body.clientVersion ||
      body.client_version ||
      null
  );

  const modernShape =
    caps.hasEventId && caps.hasCanonicalTradeId && (caps.hasEventType || caps.hasEventSequence);

  // 1. explicit pineClientVersion
  if (pineVersion) {
    const major = pineMajor(pineVersion);
    if (major === 1 && compareVersions(pineVersion, '1.3.0') >= 0) {
      if (caps.hasStableSchema) {
        return {
          adapterId: ADAPTER_IDS.STABLE,
          pineVersion,
          capabilities: caps,
          reason: 'explicit_schemaVersion_with_1_3'
        };
      }
      return {
        adapterId: ADAPTER_IDS.PINE13,
        pineVersion,
        capabilities: caps,
        reason: 'pineClientVersion_1_3'
      };
    }
    if (
      /^1\.2(\.|$)/.test(pineVersion) ||
      (compareVersions(pineVersion, '1.2.0') >= 0 && compareVersions(pineVersion, '1.3.0') < 0)
    ) {
      return {
        adapterId: ADAPTER_IDS.PINE12,
        pineVersion,
        capabilities: caps,
        reason: 'pineClientVersion_1_2'
      };
    }
    if (major === 1) {
      if (modernShape) {
        return {
          adapterId: ADAPTER_IDS.PINE13,
          pineVersion,
          capabilities: caps,
          reason: 'pineClientVersion_1_x_modern_fields'
        };
      }
      return {
        adapterId: ADAPTER_IDS.PINE12,
        pineVersion,
        capabilities: caps,
        reason: 'pineClientVersion_1_x'
      };
    }
    if (major != null && major < 1) {
      return {
        adapterId: ADAPTER_IDS.LEGACY,
        pineVersion,
        capabilities: caps,
        reason: 'pineClientVersion_older_major'
      };
    }
    if (modernShape) {
      return {
        adapterId: ADAPTER_IDS.PINE13,
        pineVersion,
        capabilities: caps,
        reason: 'future_major_modern_fields'
      };
    }
  }

  // 2. explicit schemaVersion
  if (caps.hasStableSchema) {
    return {
      adapterId: ADAPTER_IDS.STABLE,
      pineVersion,
      capabilities: caps,
      reason: 'explicit_schemaVersion'
    };
  }

  // 3. known fields / capabilities
  if (modernShape && caps.hasRealtimeFlag) {
    return {
      adapterId: ADAPTER_IDS.PINE13,
      pineVersion,
      capabilities: caps,
      reason: 'capability_stable_shape'
    };
  }
  if (modernShape) {
    return {
      adapterId: ADAPTER_IDS.PINE13,
      pineVersion,
      capabilities: caps,
      reason: 'capability_event_identity'
    };
  }
  if (caps.hasSignalUuid || caps.hasCanonicalTf) {
    return {
      adapterId: ADAPTER_IDS.PINE12,
      pineVersion,
      capabilities: caps,
      reason: 'capability_uuid_or_canonical_tf'
    };
  }

  // 4. payload signature heuristics
  if (caps.hasTakeProfitCamel || caps.hasActionField || caps.hasTickerOnly) {
    return {
      adapterId: ADAPTER_IDS.LEGACY,
      pineVersion,
      capabilities: caps,
      reason: 'heuristic_legacy_fields'
    };
  }
  if (caps.hasTakeProfitSnake && caps.hasSignalUuid === false) {
    return {
      adapterId: ADAPTER_IDS.LEGACY,
      pineVersion,
      capabilities: caps,
      reason: 'heuristic_snake_without_uuid'
    };
  }

  // 5. fallback
  return {
    adapterId: ADAPTER_IDS.LEGACY,
    pineVersion,
    capabilities: caps,
    reason: 'fallback_legacy'
  };
}

const REGISTERED_ADAPTERS = Object.freeze([
  ADAPTER_IDS.LEGACY,
  ADAPTER_IDS.PINE12,
  ADAPTER_IDS.PINE13,
  ADAPTER_IDS.STABLE
]);

module.exports = {
  ADAPTER_IDS,
  REGISTERED_ADAPTERS,
  inspectPayloadCapabilities,
  selectAdapter
};
