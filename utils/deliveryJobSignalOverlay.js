/**
 * Overlay durable job identity onto a rehydrated Mongo Signal / accept snapshot.
 *
 * Mongo Signal typically remains the original ENTRY document. Recovery must not
 * reclassify TP/SL jobs as ENTRY. Job identity is authoritative for:
 *   alertType, eventType, eventId, canonicalTradeId, signalUuid
 *
 * Additive overlay — does not live in protected durableDelivery.js.
 */

'use strict';

const {
  ALERT_TYPE_BY_EVENT,
  EVENT_BY_ALERT_TYPE,
  alertTypeToEventType
} = require('../contracts/KachingTradeEvent');

const KNOWN_ALERT_TYPES = new Set([
  'entry',
  'signal',
  'take_profit_1',
  'take_profit_2',
  'take_profit_3',
  'stop_loss',
  'expired',
  'cancelled'
]);

function plain(doc) {
  if (!doc) return null;
  return doc.toObject ? doc.toObject() : { ...doc };
}

function resolveJobAlertType(eventType) {
  const raw = String(eventType || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (KNOWN_ALERT_TYPES.has(lower)) return lower === 'signal' ? 'entry' : lower;
  const token = raw.toUpperCase();
  if (ALERT_TYPE_BY_EVENT[token]) return ALERT_TYPE_BY_EVENT[token];
  if (EVENT_BY_ALERT_TYPE[lower]) return ALERT_TYPE_BY_EVENT[EVENT_BY_ALERT_TYPE[lower]];
  return '';
}

/**
 * Apply job identity onto a signal document used for provider formatting.
 * Levels / instrument / direction on the signal are preserved (same trade).
 */
function overlayJobIdentityOnSignal(signal, job) {
  if (!signal || !job) return signal;
  const base = plain(signal);
  const jobAlertType = resolveJobAlertType(job.eventType || job.alertType);
  const alertType = jobAlertType || base.alertType;
  const eventType = job.eventType
    ? alertTypeToEventType(alertType, job.eventType)
    : base.eventType || alertTypeToEventType(alertType);
  return {
    ...base,
    alertType: alertType || base.alertType,
    eventType: eventType || base.eventType,
    eventId: job.eventId || base.eventId,
    canonicalTradeId: job.canonicalTradeId || base.canonicalTradeId,
    signalUuid: job.signalUuid || base.signalUuid
  };
}

/**
 * Fan-out recovery reconstructs acceptResult from Mongo ENTRY. Overlay the
 * durable fan-out job's lifecycle identity before re-processing.
 */
function overlayFanoutAcceptResult(acceptResult, job) {
  if (!acceptResult || !job) return acceptResult;
  const signalData = overlayJobIdentityOnSignal(
    acceptResult.signalData || acceptResult.saved,
    job
  );
  return {
    ...acceptResult,
    signalData,
    saved: acceptResult.saved
      ? overlayJobIdentityOnSignal(acceptResult.saved, job)
      : acceptResult.saved
  };
}

function isJobIdentityMismatch(signal, job) {
  if (!signal || !job) return false;
  const jobAlert = resolveJobAlertType(job.eventType || job.alertType);
  if (!jobAlert) return false;
  const signalAlert = String(signal.alertType || '').trim().toLowerCase();
  return Boolean(signalAlert) && signalAlert !== jobAlert && signalAlert !== 'signal';
}

module.exports = {
  KNOWN_ALERT_TYPES,
  resolveJobAlertType,
  overlayJobIdentityOnSignal,
  overlayFanoutAcceptResult,
  isJobIdentityMismatch
};
