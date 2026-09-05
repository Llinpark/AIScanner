'use strict';

/**
 * Stable end-to-end correlation contract.
 * Identity fields (signalUuid, eventId) are never replaced — only copied/merged.
 * symbolRaw vs symbolNormalized are explicit; callers must not overwrite signal.symbol.
 */

const { normalizeSymbol, toCompactSymbol } = require('../config/symbols');

const DELIVERY_STATES = Object.freeze([
  'pending',
  'blocked',
  'skipped',
  'attempted',
  'provider_accepted',
  'delivered',
  'retrying',
  'failed_retryable',
  'failed_terminal',
  'not_applicable'
]);

function asText(value) {
  if (value == null || value === '') return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function symbolNormalizedOf(symbolRaw) {
  const raw = asText(symbolRaw);
  if (!raw) return undefined;
  try {
    const slashForm = normalizeSymbol(raw);
    const compact = toCompactSymbol(raw) || String(slashForm || raw).replace(/\//g, '');
    return compact || slashForm || raw;
  } catch {
    return String(raw).replace(/\//g, '').toUpperCase();
  }
}

function emptyCorrelation() {
  return {
    requestId: undefined,
    eventId: undefined,
    signalUuid: undefined,
    canonicalTradeId: undefined,
    signalId: undefined,
    fanoutJobId: undefined,
    deliveryJobId: undefined,
    subscriberId: undefined,
    channel: undefined,
    symbolRaw: undefined,
    symbolNormalized: undefined
  };
}

function pickCorrelation(source = {}) {
  const nested = source.correlation && typeof source.correlation === 'object' ? source.correlation : {};
  const symbolRaw =
    asText(nested.symbolRaw) ||
    asText(source.symbolRaw) ||
    asText(source.symbol);
  return {
    requestId:
      asText(nested.requestId) ||
      asText(source.requestId) ||
      asText(source.pipelineRequestId),
    eventId: asText(nested.eventId) || asText(source.eventId),
    signalUuid: asText(nested.signalUuid) || asText(source.signalUuid) || asText(source.signalId),
    canonicalTradeId:
      asText(nested.canonicalTradeId) ||
      asText(source.canonicalTradeId) ||
      asText(source.canonicalSignalKey),
    signalId: asText(nested.signalId) || asText(source.signalId) || asText(source._id),
    fanoutJobId: asText(nested.fanoutJobId) || asText(source.fanoutJobId),
    deliveryJobId: asText(nested.deliveryJobId) || asText(source.deliveryJobId) || asText(source.jobId),
    subscriberId: asText(nested.subscriberId) || asText(source.subscriberId) || asText(source.userId),
    channel: asText(nested.channel) || asText(source.channel),
    symbolRaw,
    symbolNormalized:
      asText(nested.symbolNormalized) ||
      asText(source.symbolNormalized) ||
      symbolNormalizedOf(symbolRaw)
  };
}

function mergeCorrelation(...parts) {
  const out = emptyCorrelation();
  for (const part of parts) {
    const picked = pickCorrelation(part || {});
    for (const key of Object.keys(out)) {
      if (picked[key] != null && picked[key] !== '') out[key] = picked[key];
    }
  }
  if (out.symbolRaw && !out.symbolNormalized) {
    out.symbolNormalized = symbolNormalizedOf(out.symbolRaw);
  }
  return out;
}

function compactCorrelation(corr) {
  const out = {};
  const src = corr && typeof corr === 'object' ? corr : {};
  for (const [key, value] of Object.entries(src)) {
    if (value != null && value !== '') out[key] = value;
  }
  return out;
}

function attachCorrelation(target, extra = {}) {
  if (!target || typeof target !== 'object') return extra;
  const next = compactCorrelation(mergeCorrelation(target, target.correlation, extra));
  target.correlation = next;
  if (next.requestId && !target.pipelineRequestId) {
    target.pipelineRequestId = next.requestId;
  }
  if (next.eventId && target.eventId == null) target.eventId = next.eventId;
  if (next.canonicalTradeId && target.canonicalTradeId == null) {
    target.canonicalTradeId = next.canonicalTradeId;
  }
  return next;
}

function correlationFromJob(job = {}) {
  return compactCorrelation(
    mergeCorrelation(job, job.payload, job.payload?.signal, job.payload?.signalData, job.payload?.acceptResult, {
      deliveryJobId: job.jobId,
      subscriberId: job.subscriberId,
      channel: job.channel,
      eventId: job.eventId,
      canonicalTradeId: job.canonicalTradeId,
      signalUuid: job.signalUuid
    })
  );
}

function buildDurableRefs(spec = {}) {
  const corr = mergeCorrelation(spec, spec.correlation, spec.signalDoc, spec.payload);
  return compactCorrelation({
    signalUuid: corr.signalUuid || spec.signalUuid,
    signalId: corr.signalId || spec.signalId || spec.signalDoc?._id || spec.signalDoc?.id,
    subscriberId: spec.subscriberId || corr.subscriberId,
    channel: spec.channel || corr.channel,
    eventType: spec.eventType || spec.alertType,
    canonicalTradeId: corr.canonicalTradeId || spec.canonicalTradeId,
    eventId: corr.eventId || spec.eventId,
    requestId: corr.requestId,
    correlation: compactCorrelation(corr)
  });
}

function symbolSearchKeys(symbol) {
  const raw = asText(symbol);
  if (!raw) return [];
  const normalized = symbolNormalizedOf(raw);
  const slash = (() => {
    try {
      return normalizeSymbol(raw);
    } catch {
      return raw;
    }
  })();
  const compact = String(normalized || raw).replace(/\//g, '').toUpperCase();
  return [...new Set([raw, slash, compact, String(raw).replace(/\//g, '').toUpperCase()].filter(Boolean))];
}

module.exports = {
  DELIVERY_STATES,
  asText,
  symbolNormalizedOf,
  emptyCorrelation,
  pickCorrelation,
  mergeCorrelation,
  compactCorrelation,
  attachCorrelation,
  correlationFromJob,
  buildDurableRefs,
  symbolSearchKeys
};
