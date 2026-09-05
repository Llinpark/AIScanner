/**
 * Structured end-to-end pipeline logger for TradingView → webhook → Mongo → delivery.
 * Format: [PIPELINE] Stage | Timestamp | Symbol | Timeframe | signalUuid | PASS/FAIL | Reason
 */

function pipelineStamp() {
  return new Date().toISOString();
}

function pipelineField(value, fallback = '-') {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value).replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

/**
 * @param {string} stage
 * @param {'PASS'|'FAIL'|string} status
 * @param {object} [meta]
 */
function logPipeline(stage, status, meta = {}) {
  const line = [
    '[PIPELINE]',
    pipelineField(stage),
    pipelineStamp(),
    pipelineField(meta.symbol),
    pipelineField(meta.timeframe || meta.tf),
    pipelineField(meta.signalUuid || meta.signalId || meta.uuid),
    pipelineField(status, 'FAIL'),
    pipelineField(meta.reason || meta.message || '-')
  ].join(' | ');

  if (String(status).toUpperCase() === 'FAIL') {
    console.warn(line);
  } else {
    console.log(line);
  }

  // Mirror into admin diagnostics store (never throw).
  try {
    const PipelineStatusService = require('../services/PipelineStatusService');
    PipelineStatusService.record(stage, status, meta);
  } catch {
    // diagnostics must not break webhook path
  }

  return line;
}

function extractPipelineMeta(body = {}) {
  return {
    symbol: body.symbol || body.ticker || body.instrument || body.market,
    timeframe: body.timeframe || body.interval || body.tf,
    signalUuid: body.signalUuid || body.signalId || body.signal_id || body.signalGroupId,
    alertType: body.alertType || body.alert_type || body.type || undefined,
    eventTimestamp: body.eventTimestamp || body.signalTime || body.timestamp || body.barTime || undefined,
    scriptGenerationId: body.scriptGenerationId || undefined,
    selfTest: body.selfTest === true || body.self_test === true || undefined,
    requestId: body.pipelineRequestId || body.requestId || undefined,
    eventId: body.eventId || body.event_id || undefined,
    canonicalTradeId: body.canonicalTradeId || body.canonical_trade_id || undefined,
    eventType: body.eventType || body.event_type || undefined,
    eventSequence: body.eventSequence || body.event_sequence || undefined,
    pineClientVersion: body.pineClientVersion || body.pine_client_version || undefined,
    detectedPineVersion: body.detectedPineVersion || body.pineClientVersion || body.pine_client_version || undefined,
    compatibilityAdapter: body.compatibilityAdapter || undefined,
    compatibilityMode: body.compatibilityMode || undefined,
    compatibilityLabel: body.compatibilityLabel || undefined,
    legacy: body.legacy === true || body.legacyAdapted === true || undefined,
    isRealtimeState: body.isRealtimeState || undefined,
    staleDecision: body.staleDecision || undefined,
    duplicateDecision: body.duplicateDecision || undefined,
    tokenVersion: body.tokenVersion || undefined,
    barTime: body.barTime || body.bar_time || undefined
  };
}

function clientIp(req) {
  return (
    req.headers['fly-client-ip'] ||
    req.headers['cf-connecting-ip'] ||
    req.headers['x-real-ip'] ||
    (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

function payloadSize(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.length;
  if (typeof req.body === 'string') return Buffer.byteLength(req.body, 'utf8');
  if (req.body != null) {
    try {
      return Buffer.byteLength(JSON.stringify(req.body), 'utf8');
    } catch {
      return 0;
    }
  }
  return 0;
}

module.exports = {
  logPipeline,
  extractPipelineMeta,
  clientIp,
  payloadSize,
  pipelineStamp
};
