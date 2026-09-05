'use strict';

/**
 * Forensics-only TradingView webhook ACK timing.
 * Does not change accept/fan-out/HTTP status semantics.
 */

const os = require('os');

const SLOW_ACK_MS = 1500;

function resolveMachineId() {
  return String(
    process.env.FLY_MACHINE_ID || process.env.FLY_ALLOC_ID || os.hostname() || 'n/a'
  );
}

function sanitizeField(value, fallback = '-') {
  if (value == null || value === '') return fallback;
  const text = String(value)
    .replace(/\s+/g, '_')
    .replace(/[\r\n]+/g, '')
    .slice(0, 128);
  return text || fallback;
}

function formatMs(value) {
  if (value == null || value === '') return '-';
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '-';
  return String(Math.round(n));
}

function outcomeFromStatus(status, explicit) {
  if (explicit) return String(explicit);
  const n = Number(status);
  if (n === 202 || n === 201) return 'accepted';
  if (n >= 500) return 'error';
  return 'rejected';
}

function boolField(value) {
  if (value == null || value === '') return '-';
  if (value === true || value === 'true' || value === '1') return 'true';
  if (value === false || value === 'false' || value === '0') return 'false';
  return sanitizeField(value);
}

function formatTvAckLine(tag, fields) {
  return (
    `[${tag}] ` +
    `requestId=${sanitizeField(fields.requestId)} ` +
    `machine=${sanitizeField(fields.machine || resolveMachineId())} ` +
    `symbol=${sanitizeField(fields.symbol)} ` +
    `tf=${sanitizeField(fields.tf)} ` +
    `authMs=${formatMs(fields.authMs)} ` +
    `acceptMs=${formatMs(fields.acceptMs)} ` +
    `ackMs=${formatMs(fields.ackMs)} ` +
    `status=${sanitizeField(fields.status)} ` +
    `outcome=${sanitizeField(fields.outcome)} ` +
    `accepted=${boolField(fields.accepted)} ` +
    `persisted=${boolField(fields.persisted)} ` +
    `deferredFanout=${boolField(fields.deferredFanout)} ` +
    `skippedFanout=${boolField(fields.skippedFanout)} ` +
    `reason=${sanitizeField(fields.reason)}`
  );
}

function emitTvAck(fields, { log = console.log } = {}) {
  const ackMs = Number(fields.ackMs);
  const payload = {
    requestId: fields.requestId,
    machine: fields.machine || resolveMachineId(),
    symbol: fields.symbol,
    tf: fields.tf,
    authMs: fields.authMs,
    acceptMs: fields.acceptMs,
    ackMs: fields.ackMs,
    status: fields.status,
    outcome: outcomeFromStatus(fields.status, fields.outcome),
    accepted: fields.accepted,
    persisted: fields.persisted,
    deferredFanout: fields.deferredFanout,
    skippedFanout: fields.skippedFanout,
    reason: fields.reason,
    eventId: fields.eventId,
    signalUuid: fields.signalUuid,
    canonicalTradeId: fields.canonicalTradeId
  };
  log(formatTvAckLine('TV_ACK', payload));
  if (Number.isFinite(ackMs) && ackMs >= SLOW_ACK_MS) {
    log(formatTvAckLine('TV_ACK_SLOW', payload));
  }
  try {
    const { recordTvAck } = require('./tvAckOutcomeStore');
    recordTvAck(payload);
  } catch {
    /* diagnostics only */
  }
  try {
    const WebhookIntakeService = require('../services/WebhookIntakeService');
    WebhookIntakeService.recordAsync({
      ...payload,
      statusCode: payload.status,
      timeframe: payload.tf
    });
  } catch {
    /* diagnostics only — never delay ACK */
  }
  return payload;
}

function msSince(startNs) {
  return Number(process.hrtime.bigint() - startNs) / 1e6;
}

/**
 * Prefix middleware: one [TV_ACK] per HTTP response, including limiter 429s.
 * Stores probe fields on req for the route handler to fill.
 */
function attachTvAckProbe(req, res, next) {
  if (req.tvAckProbe) return next();
  const t0Ns = process.hrtime.bigint();
  const requestId = (() => {
    try {
      const { ensureRequestId } = require('./webhookPipelineDiag');
      return ensureRequestId(req);
    } catch {
      return req.headers['x-request-id'] || `tvw_${Date.now().toString(36)}`;
    }
  })();
  req.tvAckProbe = {
    t0Ns,
    requestId,
    authMs: null,
    acceptMs: null,
    symbol: '-',
    tf: '-',
    outcome: null,
    logged: false
  };
  const flush = () => {
    if (!req.tvAckProbe || req.tvAckProbe.logged) return;
    req.tvAckProbe.logged = true;
    emitTvAck({
      requestId: req.tvAckProbe.requestId,
      symbol: req.tvAckProbe.symbol,
      tf: req.tvAckProbe.tf,
      authMs: req.tvAckProbe.authMs,
      acceptMs: req.tvAckProbe.acceptMs,
      ackMs: msSince(t0Ns),
      status: res.statusCode,
      outcome: req.tvAckProbe.outcome,
      accepted: req.tvAckProbe.accepted,
      persisted: req.tvAckProbe.persisted,
      deferredFanout: req.tvAckProbe.deferredFanout,
      skippedFanout: req.tvAckProbe.skippedFanout,
      reason: req.tvAckProbe.reason,
      eventId: req.tvAckProbe.eventId,
      signalUuid: req.tvAckProbe.signalUuid,
      canonicalTradeId: req.tvAckProbe.canonicalTradeId
    });
  };
  res.on('finish', flush);
  res.on('close', () => {
    if (req.tvAckProbe && !req.tvAckProbe.logged && !res.writableEnded) {
      flush();
    }
  });
  return next();
}

module.exports = {
  SLOW_ACK_MS,
  resolveMachineId,
  sanitizeField,
  formatMs,
  outcomeFromStatus,
  formatTvAckLine,
  emitTvAck,
  msSince,
  attachTvAckProbe
};
