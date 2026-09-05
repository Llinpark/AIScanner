/**
 * Pine client version registry (observability only).
 *
 * Tracks subscriber script version, generation metadata, capabilities,
 * and last webhook version. NEVER gates auth, delivery, scoring, or filters.
 */

'use strict';

const mongoose = require('mongoose');
const {
  extractPineClientMeta,
  PINE_CLIENT_VERSION,
  CURRENT_PINE_CAPABILITIES
} = require('../utils/PineClientVersion');

const EMPTY_ENTRY = () => ({
  userId: null,
  pineClientVersion: null,
  scriptGenerationId: null,
  scriptId: null,
  strategy: null,
  generatedAt: null,
  capabilities: [],
  lastWebhookVersion: null,
  lastWebhookAt: null,
  lastWebhookCapabilities: [],
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
    memory.set(key, EMPTY_ENTRY());
    memory.get(key).userId = key;
  }
  return memory.get(key);
}

async function persistToUser(userId, patch) {
  const key = keyOf(userId);
  if (!key || mongoose.connection.readyState !== 1) return;
  try {
    const UserConfig = require('../models/User');
    const set = {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (v !== undefined) set[`pineClientRegistry.${k}`] = v;
    }
    if (!Object.keys(set).length) return;
    set['pineClientRegistry.updatedAt'] = new Date();
    await UserConfig.updateOne({ _id: key }, { $set: set }).exec();
  } catch {
    // Registry must never break webhook / pine paths.
  }
}

/**
 * Record a successful Pine generation (called from pine-gen endpoint).
 * Fire-and-forget safe.
 *
 * @param {string} userId
 * @param {object} meta
 */
async function recordGeneration(userId, meta = {}) {
  try {
    const entry = getMemory(userId);
    if (!entry) return null;

    const now = new Date();
    entry.pineClientVersion =
      meta.pineClientVersion != null
        ? String(meta.pineClientVersion)
        : PINE_CLIENT_VERSION;
    entry.scriptGenerationId =
      meta.scriptGenerationId != null ? String(meta.scriptGenerationId) : entry.scriptGenerationId;
    entry.scriptId = meta.scriptId != null ? String(meta.scriptId) : entry.scriptId;
    entry.strategy = meta.strategy != null ? String(meta.strategy) : entry.strategy;
    entry.generatedAt =
      meta.generatedAt != null ? String(meta.generatedAt) : now.toISOString();
    entry.capabilities = Array.isArray(meta.capabilities)
      ? meta.capabilities.map(String)
      : [...CURRENT_PINE_CAPABILITIES];
    entry.updatedAt = now.toISOString();

    void persistToUser(userId, {
      pineClientVersion: entry.pineClientVersion,
      scriptGenerationId: entry.scriptGenerationId,
      scriptId: entry.scriptId,
      strategy: entry.strategy,
      generatedAt: entry.generatedAt ? new Date(entry.generatedAt) : now,
      capabilities: entry.capabilities
    });

    return { ...entry };
  } catch {
    // Registry must never break pine-gen / webhook paths.
    return null;
  }
}

/**
 * Update registry from an authenticated webhook (fire-and-forget).
 * Missing version is fine — still records lastWebhookAt / null version.
 * NEVER throws to callers; swallows all errors.
 *
 * @param {string|null|undefined} userId
 * @param {object} body - webhook body
 */
async function recordWebhookVersion(userId, body = {}) {
  try {
    const entry = getMemory(userId);
    if (!entry) return null;

    const meta = extractPineClientMeta(body || {});
    const now = new Date();
    entry.lastWebhookVersion = meta.pineClientVersion;
    entry.lastWebhookAt = now.toISOString();
    entry.lastWebhookCapabilities = meta.capabilities;
    if (meta.scriptGenerationId) entry.scriptGenerationId = meta.scriptGenerationId;
    if (meta.generatedAt && !entry.generatedAt) entry.generatedAt = meta.generatedAt;
    if (meta.pineClientVersion && !entry.pineClientVersion) {
      entry.pineClientVersion = meta.pineClientVersion;
    }
    if (meta.capabilities.length && !entry.capabilities.length) {
      entry.capabilities = meta.capabilities;
    }
    entry.updatedAt = now.toISOString();

    void persistToUser(userId, {
      lastWebhookVersion: entry.lastWebhookVersion,
      lastWebhookAt: now,
      lastWebhookCapabilities: entry.lastWebhookCapabilities,
      scriptGenerationId: entry.scriptGenerationId,
      pineClientVersion: entry.pineClientVersion,
      capabilities: entry.capabilities,
      generatedAt: entry.generatedAt ? new Date(entry.generatedAt) : undefined
    });

    return { ...entry };
  } catch {
    return null;
  }
}

function getEntry(userId) {
  const local = getMemory(userId);
  return local ? { ...local } : null;
}

function listEntries() {
  return [...memory.entries()].map(([userId, entry]) => ({ userId, ...entry }));
}

function resetForTests() {
  memory.clear();
}

module.exports = {
  EMPTY_ENTRY,
  recordGeneration,
  recordWebhookVersion,
  getEntry,
  listEntries,
  resetForTests
};
