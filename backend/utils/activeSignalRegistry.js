const { normalizeSymbol } = require('../config/symbols');
const { getRedisClient } = require('./redisClient');

/**
 * Durable Active Signal Registry — one open trade per symbol:timeframe.
 * Backing stores (in priority order):
 *   1) Redis (multi-instance / Fly)
 *   2) Mongo Signal open docs (hydrate on miss)
 *   3) In-process Map (tests / Redis unavailable)
 *
 * Confirmed trades are never replaced by a later scan; only terminal closes free the slot.
 */

const memoryStore = new Map();
const REDIS_PREFIX = 'kaching:active:';
const REDIS_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days safety TTL; terminal clears explicitly

const TV_PERIOD_MAP = Object.freeze({
  '1': '1m',
  '3': '3m',
  '5': '5m',
  '15': '15m',
  '30': '30m',
  '45': '45m',
  '60': '1h',
  '120': '2h',
  '240': '4h',
  d: '1d',
  D: '1d',
  '1d': '1d',
  '1D': '1d',
  w: '1w',
  W: '1w',
  '1w': '1w',
  '1W': '1w',
  m: '1M',
  M: '1M',
  '1M': '1M'
});

function normalizeTimeframe(timeframe) {
  const raw = String(timeframe || '1h').trim();
  if (!raw) return '1h';
  if (TV_PERIOD_MAP[raw]) return TV_PERIOD_MAP[raw];
  const lower = raw.toLowerCase();
  if (TV_PERIOD_MAP[lower]) return TV_PERIOD_MAP[lower];
  if (TV_PERIOD_MAP[raw.toUpperCase()]) return TV_PERIOD_MAP[raw.toUpperCase()];
  if (/^\d+[smhdw]$/i.test(lower)) return lower;
  if (/^1m$/i.test(raw)) return '1M';
  const mins = lower.match(/^(\d+)\s*(min|mins|minute|minutes)$/);
  if (mins) {
    const n = mins[1];
    return TV_PERIOD_MAP[n] || `${n}m`;
  }
  const hours = lower.match(/^(\d+)\s*(h|hr|hour|hours)$/);
  if (hours) return hours[1] === '1' ? '1h' : `${hours[1]}h`;
  return lower;
}

function normalizeStrategy(strategyOrSignal) {
  if (strategyOrSignal && typeof strategyOrSignal === 'object') {
    return normalizeStrategy(
      strategyOrSignal.strategyId ||
        strategyOrSignal.strategyName ||
        strategyOrSignal.strategy ||
        strategyOrSignal.pattern ||
        ''
    );
  }
  const raw = String(strategyOrSignal || '')
    .trim()
    .toLowerCase();
  if (!raw) return 'default';
  if (raw.includes('scalp') || raw === 'liquidity_sweep_fvg_scalp') return 'scalping';
  if (raw.includes('day') || raw.includes('fvg') || raw === 'liquidity_sweep_fvg_daytrading') {
    return 'daytrading';
  }
  return raw.replace(/\s+/g, '_').slice(0, 64);
}

/** Spec: one active trade per symbol/timeframe (strategy not required for slot exclusivity). */
function registryKey(symbol, timeframe, _strategy) {
  const sym = normalizeSymbol(symbol || '');
  if (!sym) return '';
  return `${sym}:${normalizeTimeframe(timeframe)}`;
}

function redisKey(key) {
  return `${REDIS_PREFIX}${key}`;
}

function resolveArgs(symbolOrSignal, timeframe, strategy) {
  if (symbolOrSignal && typeof symbolOrSignal === 'object') {
    return {
      symbol: symbolOrSignal.symbol,
      timeframe: symbolOrSignal.timeframe || timeframe,
      strategy:
        strategy ||
        symbolOrSignal.strategyId ||
        symbolOrSignal.strategyName ||
        symbolOrSignal.strategy ||
        symbolOrSignal.pattern
    };
  }
  return { symbol: symbolOrSignal, timeframe, strategy };
}

function toRecord(signal) {
  return {
    signalUuid: signal.signalUuid || signal.signalId || signal.signalGroupId || null,
    symbol: normalizeSymbol(signal.symbol),
    timeframe: normalizeTimeframe(signal.timeframe),
    strategy: normalizeStrategy(signal),
    direction: signal.direction,
    entry: signal.entry,
    stop_loss: signal.stop_loss ?? signal.stop_loss_1,
    take_profit_1: signal.take_profit_1,
    take_profit_2: signal.take_profit_2,
    take_profit_3: signal.take_profit_3,
    stage: signal.lifecycleStage || signal.stage || 'ACTIVE',
    expiryBars: signal.expiryBars ?? null,
    expiresAt: signal.expiresAt || null,
    createdAt: signal.createdAt || new Date().toISOString(),
    registeredAt: new Date().toISOString()
  };
}

async function redisGet(key) {
  try {
    const redis = await getRedisClient();
    if (!redis) return null;
    const raw = await redis.get(redisKey(key));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function redisSet(key, record) {
  try {
    const redis = await getRedisClient();
    if (!redis) return false;
    await redis.setEx(redisKey(key), REDIS_TTL_SECONDS, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

async function redisDel(key) {
  try {
    const redis = await getRedisClient();
    if (!redis) return false;
    await redis.del(redisKey(key));
    return true;
  } catch {
    return false;
  }
}

async function hydrateFromMongo(symbol, timeframe) {
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) return null;
    const Signal = require('../models/Signal');
    const compact = normalizeSymbol(symbol).replace(/\//g, '');
    const tf = normalizeTimeframe(timeframe);
    const doc = await Signal.findOne({
      alertType: { $in: ['entry', 'signal'] },
      tradeStatus: { $in: ['open', 'partial'] },
      symbol: { $regex: compact, $options: 'i' },
      timeframe: { $regex: new RegExp(`^${tf}$`, 'i') }
    })
      .sort({ createdAt: -1 })
      .lean();
    return doc ? toRecord(doc) : null;
  } catch (err) {
    console.warn('[ActiveSignalRegistry] Mongo hydrate failed:', err.message);
    return null;
  }
}

async function getActive(symbolOrSignal, timeframe, strategy) {
  const { symbol, timeframe: tf } = resolveArgs(symbolOrSignal, timeframe, strategy);
  const key = registryKey(symbol, tf);
  if (!key) return null;

  const fromRedis = await redisGet(key);
  if (fromRedis) {
    memoryStore.set(key, fromRedis);
    return fromRedis;
  }

  if (memoryStore.has(key)) return memoryStore.get(key);

  const fromMongo = await hydrateFromMongo(symbol, tf);
  if (fromMongo) {
    memoryStore.set(key, fromMongo);
    await redisSet(key, fromMongo);
    return fromMongo;
  }
  return null;
}

function getActiveSync(symbolOrSignal, timeframe, strategy) {
  const { symbol, timeframe: tf } = resolveArgs(symbolOrSignal, timeframe, strategy);
  const key = registryKey(symbol, tf);
  if (!key) return null;
  return memoryStore.get(key) || null;
}

async function hasActive(symbolOrSignal, timeframe, strategy) {
  return Boolean(await getActive(symbolOrSignal, timeframe, strategy));
}

async function registerActive(signal) {
  const key = registryKey(signal?.symbol, signal?.timeframe);
  if (!key) return null;
  const record = toRecord(signal);
  memoryStore.set(key, record);
  await redisSet(key, record);
  return record;
}

async function updateActiveStage(symbolOrSignal, stage, patch = {}, timeframe, strategy) {
  const { symbol, timeframe: tf } = resolveArgs(
    symbolOrSignal,
    timeframe ?? patch.timeframe,
    strategy ?? patch.strategy ?? patch.strategyName
  );
  const key = registryKey(symbol, tf);
  const existing = (await getActive(symbol, tf)) || memoryStore.get(key);
  if (!existing) return null;
  const next = { ...existing, ...patch, stage, updatedAt: new Date().toISOString() };
  memoryStore.set(key, next);
  await redisSet(key, next);
  return next;
}

async function clearActive(symbolOrSignal, reason = 'closed', timeframe, strategy) {
  const { symbol, timeframe: tf } = resolveArgs(symbolOrSignal, timeframe, strategy);
  const key = registryKey(symbol, tf);
  const existing = memoryStore.get(key) || (await redisGet(key)) || null;
  memoryStore.delete(key);
  await redisDel(key);
  if (existing) {
    return { ...existing, clearedReason: reason, clearedAt: new Date().toISOString() };
  }
  return null;
}

function listActive() {
  return Array.from(memoryStore.values());
}

function resetForTests() {
  memoryStore.clear();
}

module.exports = {
  registryKey,
  normalizeTimeframe,
  normalizeStrategy,
  getActive,
  getActiveSync,
  hasActive,
  registerActive,
  updateActiveStage,
  clearActive,
  listActive,
  resetForTests
};
