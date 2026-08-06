/**
 * Per-subscriber pipeline timestamps (diagnostics only).
 * In-memory map + additive UserConfig.pipelineStats persistence.
 */

const mongoose = require('mongoose');

const EMPTY_STATS = () => ({
  lastWebhookAt: null,
  lastPublishedSignalAt: null,
  lastMongoSaveAt: null,
  lastTelegramAt: null,
  lastSocketAt: null,
  lastMT5At: null,
  lastPineGeneratedAt: null,
  lastPineStrategy: null,
  lastPineScriptId: null,
  lastSymbol: null,
  lastTimeframe: null,
  lastSignalUuid: null,
  webhookCount: 0,
  updatedAt: null
});

/** @type {Map<string, object>} */
const memory = new Map();

function keyOf(userId) {
  return String(userId || '').trim();
}

function getMemory(userId) {
  const key = keyOf(userId);
  if (!key) return null;
  if (!memory.has(key)) {
    memory.set(key, EMPTY_STATS());
  }
  return memory.get(key);
}

function mergeStats(base, patch) {
  return { ...EMPTY_STATS(), ...(base || {}), ...(patch || {}) };
}

function stampMeta(stats, meta = {}) {
  if (meta.symbol) stats.lastSymbol = meta.symbol;
  if (meta.timeframe || meta.tf) stats.lastTimeframe = meta.timeframe || meta.tf;
  if (meta.signalUuid || meta.signalId || meta.uuid) {
    stats.lastSignalUuid = meta.signalUuid || meta.signalId || meta.uuid;
  }
  stats.updatedAt = new Date().toISOString();
}

async function persistToUser(userId, patch) {
  const key = keyOf(userId);
  if (!key || mongoose.connection.readyState !== 1) return;
  try {
    const UserConfig = require('../models/User');
    const set = {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (v !== undefined) set[`pipelineStats.${k}`] = v;
    }
    if (!Object.keys(set).length) return;
    set['pipelineStats.updatedAt'] = new Date();
    await UserConfig.updateOne({ _id: key }, { $set: set }).exec();
  } catch {
    // Diagnostics must never break webhook / pine paths.
  }
}

function touchLocal(userId, mutator) {
  const stats = getMemory(userId);
  if (!stats) return null;
  mutator(stats);
  return { ...stats };
}

async function recordWebhook(userId, meta = {}) {
  const now = new Date();
  const snapshot = touchLocal(userId, stats => {
    stats.lastWebhookAt = now.toISOString();
    stats.webhookCount = (stats.webhookCount || 0) + 1;
    stampMeta(stats, meta);
  });
  if (!snapshot) return null;
  void persistToUser(userId, {
    lastWebhookAt: now,
    webhookCount: snapshot.webhookCount,
    lastSymbol: snapshot.lastSymbol,
    lastTimeframe: snapshot.lastTimeframe,
    lastSignalUuid: snapshot.lastSignalUuid
  });
  return snapshot;
}

async function recordPineGenerated(userId, meta = {}) {
  const now = new Date();
  const snapshot = touchLocal(userId, stats => {
    stats.lastPineGeneratedAt = now.toISOString();
    if (meta.strategy) stats.lastPineStrategy = String(meta.strategy);
    if (meta.scriptId) stats.lastPineScriptId = String(meta.scriptId);
    stats.updatedAt = now.toISOString();
  });
  if (!snapshot) return null;
  void persistToUser(userId, {
    lastPineGeneratedAt: now,
    lastPineStrategy: snapshot.lastPineStrategy,
    lastPineScriptId: snapshot.lastPineScriptId
  });
  return snapshot;
}

async function recordMongoSave(userId, meta = {}) {
  const now = new Date();
  const snapshot = touchLocal(userId, stats => {
    stats.lastMongoSaveAt = now.toISOString();
    stampMeta(stats, meta);
  });
  if (!snapshot) return null;
  void persistToUser(userId, { lastMongoSaveAt: now });
  return snapshot;
}

async function recordPublished(userId, meta = {}) {
  const now = new Date();
  const snapshot = touchLocal(userId, stats => {
    stats.lastPublishedSignalAt = now.toISOString();
    stampMeta(stats, meta);
  });
  if (!snapshot) return null;
  void persistToUser(userId, { lastPublishedSignalAt: now });
  return snapshot;
}

async function recordDelivery(userId, channel, meta = {}) {
  const now = new Date();
  const field =
    channel === 'telegram'
      ? 'lastTelegramAt'
      : channel === 'mt5'
        ? 'lastMT5At'
        : channel === 'socket'
          ? 'lastSocketAt'
          : null;
  if (!field) return null;
  const snapshot = touchLocal(userId, stats => {
    stats[field] = now.toISOString();
    stampMeta(stats, meta);
  });
  if (!snapshot) return null;
  void persistToUser(userId, { [field]: now });
  return snapshot;
}

function getStats(userId) {
  const local = getMemory(userId);
  return local ? { ...local } : null;
}

/**
 * Hydrate memory from User documents (best-effort).
 */
async function hydrateFromUsers(userDocs = []) {
  for (const user of userDocs) {
    const id = user?._id?.toString?.() || user?.id;
    if (!id) continue;
    const ps = user.pipelineStats || {};
    const existing = getMemory(id) || EMPTY_STATS();
    memory.set(
      keyOf(id),
      mergeStats(existing, {
        lastWebhookAt: ps.lastWebhookAt
          ? new Date(ps.lastWebhookAt).toISOString()
          : existing.lastWebhookAt,
        lastPublishedSignalAt: ps.lastPublishedSignalAt
          ? new Date(ps.lastPublishedSignalAt).toISOString()
          : existing.lastPublishedSignalAt,
        lastMongoSaveAt: ps.lastMongoSaveAt
          ? new Date(ps.lastMongoSaveAt).toISOString()
          : existing.lastMongoSaveAt,
        lastTelegramAt: ps.lastTelegramAt
          ? new Date(ps.lastTelegramAt).toISOString()
          : existing.lastTelegramAt,
        lastSocketAt: ps.lastSocketAt
          ? new Date(ps.lastSocketAt).toISOString()
          : existing.lastSocketAt,
        lastMT5At: ps.lastMT5At ? new Date(ps.lastMT5At).toISOString() : existing.lastMT5At,
        lastPineGeneratedAt: ps.lastPineGeneratedAt
          ? new Date(ps.lastPineGeneratedAt).toISOString()
          : existing.lastPineGeneratedAt,
        lastPineStrategy: ps.lastPineStrategy || existing.lastPineStrategy,
        lastPineScriptId: ps.lastPineScriptId || existing.lastPineScriptId,
        lastSymbol: ps.lastSymbol || existing.lastSymbol,
        lastTimeframe: ps.lastTimeframe || existing.lastTimeframe,
        lastSignalUuid: ps.lastSignalUuid || existing.lastSignalUuid,
        webhookCount: ps.webhookCount != null ? ps.webhookCount : existing.webhookCount,
        updatedAt: ps.updatedAt
          ? new Date(ps.updatedAt).toISOString()
          : existing.updatedAt
      })
    );
  }
}

function listMemoryStats() {
  return [...memory.entries()].map(([userId, stats]) => ({ userId, ...stats }));
}

function resetForTests() {
  memory.clear();
}

module.exports = {
  EMPTY_STATS,
  recordWebhook,
  recordPineGenerated,
  recordMongoSave,
  recordPublished,
  recordDelivery,
  getStats,
  hydrateFromUsers,
  listMemoryStats,
  resetForTests
};
