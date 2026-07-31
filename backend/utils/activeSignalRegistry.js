const { normalizeSymbol } = require('../config/symbols');

/**
 * In-process Active Signal Registry — one open trade per symbol:timeframe.
 * Concurrent trades on different timeframes for the same symbol are allowed.
 * NEVER blocks the whole system; only the matching symbol(+tf) slot is held.
 * Confirmed/active entries are never replaced by a later scan that finds no setup;
 * only terminal closes (TP3 / SL / expired / cancelled) free the slot.
 */
const activeByKey = new Map();

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
  '1d': '1d',
  w: '1w',
  '1w': '1w'
});

function normalizeTimeframe(timeframe) {
  const raw = String(timeframe || '1h').trim();
  if (!raw) return '1h';
  if (TV_PERIOD_MAP[raw]) return TV_PERIOD_MAP[raw];
  const lower = raw.toLowerCase();
  if (TV_PERIOD_MAP[lower]) return TV_PERIOD_MAP[lower];
  // Already-canonical forms: 15m, 1h, 4h, 1d
  if (/^\d+[smhdw]$/i.test(lower)) return lower;
  // TradingView bare minutes ("15") already handled; "15min" → 15m
  const mins = lower.match(/^(\d+)\s*(min|mins|minute|minutes)$/);
  if (mins) {
    const n = mins[1];
    return TV_PERIOD_MAP[n] || `${n}m`;
  }
  const hours = lower.match(/^(\d+)\s*(h|hr|hour|hours)$/);
  if (hours) return hours[1] === '1' ? '1h' : `${hours[1]}h`;
  return lower;
}

function registryKey(symbol, timeframe) {
  const sym = normalizeSymbol(symbol || '');
  if (!sym) return '';
  return `${sym}:${normalizeTimeframe(timeframe)}`;
}

function resolveArgs(symbolOrSignal, timeframe) {
  if (symbolOrSignal && typeof symbolOrSignal === 'object') {
    return {
      symbol: symbolOrSignal.symbol,
      timeframe: symbolOrSignal.timeframe || timeframe
    };
  }
  return { symbol: symbolOrSignal, timeframe };
}

function getActive(symbolOrSignal, timeframe) {
  const { symbol, timeframe: tf } = resolveArgs(symbolOrSignal, timeframe);
  const key = registryKey(symbol, tf);
  if (!key) return null;
  return activeByKey.get(key) || null;
}

function hasActive(symbolOrSignal, timeframe) {
  return Boolean(getActive(symbolOrSignal, timeframe));
}

function registerActive(signal) {
  const key = registryKey(signal?.symbol, signal?.timeframe);
  if (!key) return null;
  const record = {
    signalUuid: signal.signalUuid || signal.signalId || signal.signalGroupId || null,
    symbol: normalizeSymbol(signal.symbol),
    timeframe: normalizeTimeframe(signal.timeframe),
    direction: signal.direction,
    entry: signal.entry,
    stop_loss: signal.stop_loss ?? signal.stop_loss_1,
    take_profit_1: signal.take_profit_1,
    take_profit_2: signal.take_profit_2,
    take_profit_3: signal.take_profit_3,
    stage: signal.lifecycleStage || 'ACTIVE',
    expiryBars: signal.expiryBars ?? null,
    expiresAt: signal.expiresAt || null,
    createdAt: signal.createdAt || new Date().toISOString(),
    registeredAt: new Date().toISOString()
  };
  activeByKey.set(key, record);
  return record;
}

function updateActiveStage(symbolOrSignal, stage, patch = {}, timeframe) {
  const { symbol, timeframe: tf } = resolveArgs(symbolOrSignal, timeframe ?? patch.timeframe);
  const key = registryKey(symbol, tf);
  const existing = activeByKey.get(key);
  if (!existing) return null;
  const next = { ...existing, ...patch, stage, updatedAt: new Date().toISOString() };
  activeByKey.set(key, next);
  return next;
}

function clearActive(symbolOrSignal, reason = 'closed', timeframe) {
  const { symbol, timeframe: tf } = resolveArgs(symbolOrSignal, timeframe);
  const key = registryKey(symbol, tf);
  const existing = activeByKey.get(key) || null;
  if (existing) {
    activeByKey.delete(key);
    return { ...existing, clearedReason: reason, clearedAt: new Date().toISOString() };
  }
  return null;
}

function listActive() {
  return Array.from(activeByKey.values());
}

function resetForTests() {
  activeByKey.clear();
}

module.exports = {
  registryKey,
  normalizeTimeframe,
  getActive,
  hasActive,
  registerActive,
  updateActiveStage,
  clearActive,
  listActive,
  resetForTests
};
