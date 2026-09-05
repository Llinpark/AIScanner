'use strict';

/**
 * Compact one-line correlation logs. Keep [TV_ACK] in tvAckLog.js.
 * Allowed delivery states: pending, blocked, skipped, attempted, provider_accepted,
 * delivered, retrying, failed_retryable, failed_terminal, not_applicable.
 */

const { sanitizeField } = require('./tvAckLog');
const { compactCorrelation, mergeCorrelation, DELIVERY_STATES } = require('./signalCorrelation');

const ALLOWED = new Set(DELIVERY_STATES);

function field(value, fallback = '-') {
  return sanitizeField(value, fallback);
}

function stateOf(value, fallback = 'pending') {
  const s = String(value || '').toLowerCase();
  if (ALLOWED.has(s)) return s;
  if (s === 'blocked_waiting_for_entry') return 'blocked';
  if (s === 'retry_pending') return 'retrying';
  if (s === 'failed_terminal') return 'failed_terminal';
  if (s === 'provider_accepted') return 'provider_accepted';
  if (s === 'not_eligible') return 'skipped';
  if (s === 'sending' || s === 'processing') return 'attempted';
  return fallback;
}

function formatTvStageLine(tag, fields = {}) {
  const c = compactCorrelation(mergeCorrelation(fields, fields.correlation));
  return (
    `[${tag}] ` +
    `requestId=${field(c.requestId)} ` +
    `eventId=${field(c.eventId)} ` +
    `signalUuid=${field(c.signalUuid)} ` +
    `canonicalTradeId=${field(c.canonicalTradeId)} ` +
    `signalId=${field(c.signalId)} ` +
    `fanoutJobId=${field(c.fanoutJobId)} ` +
    `deliveryJobId=${field(c.deliveryJobId)} ` +
    `subscriberId=${field(c.subscriberId)} ` +
    `channel=${field(c.channel)} ` +
    `symbolRaw=${field(c.symbolRaw || fields.symbolRaw || fields.symbol)} ` +
    `symbolNormalized=${field(c.symbolNormalized)} ` +
    `accepted=${field(fields.accepted, '-')} ` +
    `persisted=${field(fields.persisted, '-')} ` +
    `deferredFanout=${field(fields.deferredFanout, '-')} ` +
    `skippedFanout=${field(fields.skippedFanout, '-')} ` +
    `state=${field(stateOf(fields.state, fields.state || '-'))} ` +
    `reason=${field(fields.reason)}`
  );
}

function emitTvStage(tag, fields = {}, { log = console.log } = {}) {
  const line = formatTvStageLine(tag, fields);
  log(line);
  try {
    const { recordTvStage } = require('./tvAckOutcomeStore');
    recordTvStage(tag, fields);
  } catch {
    /* diagnostics only */
  }
  return line;
}

function emitTvAccept(fields, opts) {
  return emitTvStage('TV_ACCEPT', fields, opts);
}

function emitTvPersist(fields, opts) {
  return emitTvStage('TV_PERSIST', fields, opts);
}

function emitTvFanout(fields, opts) {
  return emitTvStage('TV_FANOUT', fields, opts);
}

function emitTvDeliver(fields, opts) {
  return emitTvStage('TV_DELIVER', fields, opts);
}

module.exports = {
  ALLOWED_DELIVERY_STATES: DELIVERY_STATES,
  stateOf,
  formatTvStageLine,
  emitTvStage,
  emitTvAccept,
  emitTvPersist,
  emitTvFanout,
  emitTvDeliver
};
