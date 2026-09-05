'use strict';

/**
 * Dedicated compact ACK / delivery outcome ring.
 * Keyed separately from the DurableDelivery-flooded pipeline events ring
 * so webhook admin cards are not drowned.
 *
 * Redis is preferred. Process memory is a diagnostic mirror for this process
 * only — not a delivery authority and not a cross-machine fallback for send.
 */

const RING_MAX = 400;
const REDIS_ACK_KEY = 'kaching:tv:ack_outcomes';
const REDIS_STAGE_KEY = 'kaching:tv:stage_outcomes';
const REDIS_TTL_SECONDS = 60 * 60 * 24 * 7;

/** @type {Array<object>} */
let ackRing = [];
/** @type {Array<object>} */
let stageRing = [];

function pushBounded(ring, entry, max = RING_MAX) {
  ring.unshift(entry);
  if (ring.length > max) ring.length = max;
  return ring;
}

function compactEntry(tag, fields = {}) {
  return {
    tag: String(tag || 'TV_ACK'),
    at: new Date().toISOString(),
    requestId: fields.requestId || fields.correlation?.requestId || null,
    eventId: fields.eventId || fields.correlation?.eventId || null,
    signalUuid: fields.signalUuid || fields.correlation?.signalUuid || null,
    canonicalTradeId: fields.canonicalTradeId || fields.correlation?.canonicalTradeId || null,
    signalId: fields.signalId || fields.correlation?.signalId || null,
    subscriberId: fields.subscriberId || fields.correlation?.subscriberId || null,
    channel: fields.channel || fields.correlation?.channel || null,
    symbol: fields.symbol || fields.symbolRaw || fields.correlation?.symbolRaw || null,
    symbolNormalized: fields.symbolNormalized || fields.correlation?.symbolNormalized || null,
    status: fields.status != null ? Number(fields.status) : null,
    outcome: fields.outcome || null,
    accepted: fields.accepted === true || fields.accepted === 'true',
    persisted: fields.persisted === true || fields.persisted === 'true',
    deferredFanout: fields.deferredFanout === true || fields.deferredFanout === 'true',
    skippedFanout: fields.skippedFanout === true || fields.skippedFanout === 'true',
    state: fields.state || null,
    reason: fields.reason || fields.outcome || null
  };
}

async function redisPush(key, entry) {
  try {
    const { getRedisClient } = require('./redisClient');
    const client = await getRedisClient();
    if (!client) return;
    const payload = JSON.stringify(entry);
    if (typeof client.lPush === 'function') {
      await client.lPush(key, payload);
      if (typeof client.lTrim === 'function') await client.lTrim(key, 0, RING_MAX - 1);
    } else if (typeof client.sendCommand === 'function') {
      await client.sendCommand(['LPUSH', key, payload]);
      await client.sendCommand(['LTRIM', key, '0', String(RING_MAX - 1)]);
    }
    if (typeof client.expire === 'function') await client.expire(key, REDIS_TTL_SECONDS);
  } catch {
    /* diagnostics only — do not fail accept/delivery */
  }
}

function recordTvAck(fields = {}) {
  const entry = compactEntry('TV_ACK', fields);
  ackRing = pushBounded(ackRing, entry);
  void redisPush(REDIS_ACK_KEY, entry);
  return entry;
}

function recordTvStage(tag, fields = {}) {
  const entry = compactEntry(tag, fields);
  stageRing = pushBounded(stageRing, entry);
  void redisPush(REDIS_STAGE_KEY, entry);
  return entry;
}

function listAckMemory(limit = 200) {
  return ackRing.slice(0, Math.max(1, Math.min(RING_MAX, Number(limit) || 200)));
}

function listStageMemory(limit = 200) {
  return stageRing.slice(0, Math.max(1, Math.min(RING_MAX, Number(limit) || 200)));
}

async function listAckOutcomes(limit = 200) {
  const cap = Math.max(1, Math.min(RING_MAX, Number(limit) || 200));
  try {
    const { getRedisClient } = require('./redisClient');
    const client = await getRedisClient();
    if (client && typeof client.lRange === 'function') {
      const raw = await client.lRange(REDIS_ACK_KEY, 0, cap - 1);
      if (Array.isArray(raw) && raw.length) {
        return raw.map(row => (typeof row === 'string' ? JSON.parse(row) : row)).filter(Boolean);
      }
    }
  } catch {
    /* fall through to process mirror */
  }
  return listAckMemory(cap);
}

function matchesQuery(entry, q = {}) {
  const eq = (a, b) => a && b && String(a) === String(b);
  if (q.requestId && !eq(entry.requestId, q.requestId)) return false;
  if (q.eventId && !eq(entry.eventId, q.eventId)) return false;
  if (q.signalUuid && !eq(entry.signalUuid, q.signalUuid)) return false;
  if (q.canonicalTradeId && !eq(entry.canonicalTradeId, q.canonicalTradeId)) return false;
  if (q.subscriberId && !eq(entry.subscriberId, q.subscriberId)) return false;
  if (q.symbol) {
    const { symbolSearchKeys } = require('./signalCorrelation');
    const keys = new Set(symbolSearchKeys(q.symbol).map(s => String(s).toUpperCase()));
    const hay = [entry.symbol, entry.symbolNormalized]
      .filter(Boolean)
      .map(s => String(s).toUpperCase());
    if (!hay.some(h => keys.has(h) || keys.has(h.replace(/\//g, '')))) return false;
  }
  return true;
}

function searchMemory(q = {}, limit = 100) {
  const cap = Math.max(1, Math.min(RING_MAX, Number(limit) || 100));
  const hits = [];
  for (const row of [...ackRing, ...stageRing]) {
    if (matchesQuery(row, q)) hits.push(row);
    if (hits.length >= cap) break;
  }
  return hits;
}

function summarizeAckOutcomes(entries = []) {
  const webhook = {
    received: 0,
    http2xx: 0,
    accepted: 0,
    persisted: 0,
    fanoutScheduled: 0,
    skippedNoFanout: 0,
    rejected: 0
  };
  for (const e of entries) {
    webhook.received += 1;
    const status = Number(e.status);
    if (status >= 200 && status < 300) webhook.http2xx += 1;
    if (e.accepted && !e.skippedFanout) webhook.accepted += 1;
    if (e.persisted) webhook.persisted += 1;
    if (e.deferredFanout) webhook.fanoutScheduled += 1;
    if (e.skippedFanout) webhook.skippedNoFanout += 1;
    if (e.outcome === 'rejected' || e.outcome === 'error' || (status >= 400 && status < 600)) {
      webhook.rejected += 1;
    }
  }
  const successPct =
    webhook.received > 0 ? Math.round((webhook.accepted / webhook.received) * 1000) / 10 : null;
  return { webhook, webhookSuccessPct: successPct };
}

function resetForTests() {
  ackRing = [];
  stageRing = [];
}

module.exports = {
  RING_MAX,
  REDIS_ACK_KEY,
  REDIS_STAGE_KEY,
  recordTvAck,
  recordTvStage,
  listAckMemory,
  listStageMemory,
  listAckOutcomes,
  searchMemory,
  matchesQuery,
  summarizeAckOutcomes,
  resetForTests
};
