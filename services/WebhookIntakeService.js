'use strict';

/**
 * Durable TV webhook intake accounting. Writers are fire-and-forget (after HTTP ACK).
 */

const os = require('os');

const CATEGORIES = Object.freeze([
  'AUTH_FAILED',
  'RATE_LIMITED',
  'INVALID_PAYLOAD',
  'ACCEPTED',
  'CANDLE_ACK',
  'REJECTED',
  'LOCK_TIMEOUT',
  'SERVER_ERROR'
]);

const MEM_MAX = 400;
/** @type {Array<object>} */
let memory = [];

function resolveMachine() {
  return String(process.env.FLY_MACHINE_ID || process.env.FLY_ALLOC_ID || os.hostname() || 'n/a');
}

function classifyCategory(fields = {}) {
  if (fields.category && CATEGORIES.includes(String(fields.category))) return String(fields.category);
  const status = Number(fields.statusCode || fields.status);
  const reason = String(fields.reason || fields.outcome || '');
  if (status === 201) return 'CANDLE_ACK';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (status === 400) return 'INVALID_PAYLOAD';
  if (status === 423 || /lock_timeout|canonical_lock_busy|LOCK_TIMEOUT/i.test(reason)) {
    return 'LOCK_TIMEOUT';
  }
  if (status >= 500) return 'SERVER_ERROR';
  if (status === 202) return 'ACCEPTED';
  if (status >= 400) return 'REJECTED';
  return 'REJECTED';
}

function compact(fields = {}) {
  const receivedAt = fields.receivedAt ? new Date(fields.receivedAt) : new Date();
  return {
    requestId: fields.requestId ? String(fields.requestId) : null,
    machine: fields.machine || resolveMachine(),
    symbol: fields.symbol || null,
    timeframe: fields.timeframe || fields.tf || null,
    statusCode: fields.statusCode != null ? Number(fields.statusCode) : Number(fields.status) || null,
    outcome: fields.outcome || null,
    category: classifyCategory(fields),
    accepted: Boolean(fields.accepted),
    persisted: Boolean(fields.persisted),
    deferredFanout: Boolean(fields.deferredFanout),
    skippedFanout: Boolean(fields.skippedFanout),
    reason: fields.reason ? String(fields.reason).slice(0, 300) : null,
    authMs: fields.authMs != null ? Number(fields.authMs) : null,
    acceptMs: fields.acceptMs != null ? Number(fields.acceptMs) : null,
    ackMs: fields.ackMs != null ? Number(fields.ackMs) : null,
    receivedAt
  };
}

function recordAsync(fields = {}) {
  const doc = compact(fields);
  memory.push(doc);
  if (memory.length > MEM_MAX) memory.splice(0, memory.length - MEM_MAX);
  setImmediate(() => {
    persistMongo(doc).catch(() => {});
  });
  return doc;
}

async function persistMongo(doc) {
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) return;
    if (String(process.env.NODE_ENV || '').toLowerCase() === 'test') return;
    const WebhookIntake = require('../models/WebhookIntake');
    await WebhookIntake.create(doc);
  } catch {
    /* diagnostic-only */
  }
}

async function aggregateWindow({ since, until } = {}) {
  const from = since || new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const to = until || new Date();
  const empty = {
    received: 0,
    http2xx: 0,
    accepted: 0,
    persisted: 0,
    fanoutScheduled: 0,
    skippedNoFanout: 0,
    rejected: 0,
    byCategory: {},
    source: 'memory'
  };

  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState === 1 && String(process.env.NODE_ENV || '').toLowerCase() !== 'test') {
      const WebhookIntake = require('../models/WebhookIntake');
      const rows = await WebhookIntake.aggregate([
        { $match: { receivedAt: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: '$category',
            n: { $sum: 1 },
            http2xx: {
              $sum: { $cond: [{ $and: [{ $gte: ['$statusCode', 200] }, { $lt: ['$statusCode', 300] }] }, 1, 0] }
            },
            accepted: { $sum: { $cond: ['$accepted', 1, 0] } },
            persisted: { $sum: { $cond: ['$persisted', 1, 0] } },
            fanoutScheduled: { $sum: { $cond: ['$deferredFanout', 1, 0] } },
            skippedNoFanout: { $sum: { $cond: ['$skippedFanout', 1, 0] } },
            rejected: {
              $sum: { $cond: [{ $gte: ['$statusCode', 400] }, 1, 0] }
            }
          }
        }
      ]);
      const out = { ...empty, source: 'mongo', byCategory: {} };
      for (const row of rows) {
        out.received += row.n || 0;
        out.http2xx += row.http2xx || 0;
        out.accepted += row.accepted || 0;
        out.persisted += row.persisted || 0;
        out.fanoutScheduled += row.fanoutScheduled || 0;
        out.skippedNoFanout += row.skippedNoFanout || 0;
        out.rejected += row.rejected || 0;
        if (row._id) out.byCategory[row._id] = row.n || 0;
      }
      return out;
    }
  } catch {
    /* fall through to memory */
  }

  const slice = memory.filter(d => d.receivedAt >= from && d.receivedAt <= to);
  const out = { ...empty, source: 'memory', byCategory: {} };
  for (const d of slice) {
    out.received += 1;
    const st = Number(d.statusCode);
    if (st >= 200 && st < 300) out.http2xx += 1;
    if (d.accepted) out.accepted += 1;
    if (d.persisted) out.persisted += 1;
    if (d.deferredFanout) out.fanoutScheduled += 1;
    if (d.skippedFanout) out.skippedNoFanout += 1;
    if (st >= 400) out.rejected += 1;
    out.byCategory[d.category] = (out.byCategory[d.category] || 0) + 1;
  }
  return out;
}

async function findByRequestId(requestId, { limit = 20 } = {}) {
  const id = String(requestId || '').trim();
  if (!id) return [];
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState === 1 && String(process.env.NODE_ENV || '').toLowerCase() !== 'test') {
      const WebhookIntake = require('../models/WebhookIntake');
      return WebhookIntake.find({ requestId: id }).sort({ receivedAt: 1 }).limit(limit).lean();
    }
  } catch {
    /* memory */
  }
  return memory.filter(d => d.requestId === id);
}

function resetForTests() {
  memory = [];
}

module.exports = {
  CATEGORIES,
  classifyCategory,
  recordAsync,
  aggregateWindow,
  findByRequestId,
  resetForTests,
  _memory: () => memory
};
