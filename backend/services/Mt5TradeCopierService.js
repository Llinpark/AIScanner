const crypto = require('crypto');
const mongoose = require('mongoose');
const TradeExecution = require('../models/TradeExecution');
const Signal = require('../models/Signal');
const UserConfig = require('../models/User');
const devUserStore = require('../utils/devUserStore');
const { userHasTierFeature } = require('../utils/subscriptionAccess');
const { computeRiskMetrics } = require('../utils/signalRisk');
const { toMt5Symbol, mt5OrderType } = require('../utils/mt5Symbols');
const { isEntryAlert } = require('../utils/signalOutcome');

const devExecutions = new Map();

function isDbConnected() {
  return mongoose.connection.readyState === 1;
}

async function findUserById(userId) {
  if (isDbConnected()) {
    return UserConfig.findById(userId);
  }
  return devUserStore.findById(userId);
}

async function findUserByMt5Token(token) {
  const normalized = String(token || '').trim();
  if (!normalized) return null;

  if (isDbConnected()) {
    return UserConfig.findOne({ 'mt5.linkToken': normalized });
  }
  return devUserStore.findByMt5Token(normalized);
}

async function persistUserMt5(userId, mt5) {
  if (isDbConnected()) {
    return UserConfig.findByIdAndUpdate(userId, { mt5, updatedAt: new Date() }, { new: true });
  }
  return devUserStore.upsertUser(userId, { mt5 });
}

function defaultMt5Config() {
  return {
    linkToken: null,
    enabled: false,
    accountBalance: null,
    accountCurrency: 'USD',
    riskPercent: 1,
    fixedLotSize: 0.01,
    symbolSuffix: '',
    executionMode: null,
    lastSyncAt: null,
    linkedAt: null,
    terminalId: null
  };
}

/**
 * Premium defaults to auto; Pro (and tiers without mt5AutoExecution) to manual.
 * Explicit user setting wins when the tier allows auto.
 */
function resolveExecutionMode(user) {
  const mt5 = user?.mt5 || {};
  const canAuto = userHasTierFeature(user, 'mt5AutoExecution');

  if (mt5.executionMode === 'auto') {
    return canAuto ? 'auto' : 'manual';
  }
  if (mt5.executionMode === 'manual') {
    return 'manual';
  }

  return canAuto ? 'auto' : 'manual';
}

async function generateLinkToken(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  const current = (await findUserById(userId))?.mt5 || defaultMt5Config();

  const mt5 = {
    ...current,
    linkToken: token,
    enabled: true,
    linkedAt: current.linkedAt || new Date()
  };

  await persistUserMt5(userId, mt5);
  return { token, mt5 };
}

const RISK_PERCENT_MIN = 0.1;
/** Safety ceiling only (allow aggressive sizing); not a product recommendation. Must match frontend RISK_MAX. */
const RISK_PERCENT_MAX = 100;
const FIXED_LOT_MIN = 0.01;
const FIXED_LOT_MAX = 100;

function clampRiskPercent(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return Number(fallback) || 1;
  return Math.min(RISK_PERCENT_MAX, Math.max(RISK_PERCENT_MIN, Number(n.toFixed(2))));
}

function clampFixedLotSize(value, fallback = 0.01) {
  const n = Number(value);
  if (!Number.isFinite(n)) return Number(fallback) || 0.01;
  return Math.min(FIXED_LOT_MAX, Math.max(FIXED_LOT_MIN, Number(n.toFixed(2))));
}

async function updateSettings(userId, settings = {}) {
  const user = await findUserById(userId);
  const current = user?.mt5 || defaultMt5Config();

  let executionMode = current.executionMode;
  if (settings.executionMode != null) {
    const requested = String(settings.executionMode).toLowerCase();
    if (requested === 'auto' || requested === 'manual') {
      if (requested === 'auto' && !userHasTierFeature(user, 'mt5AutoExecution')) {
        executionMode = 'manual';
      } else {
        executionMode = requested;
      }
    }
  }

  const mt5 = {
    ...current,
    riskPercent:
      settings.riskPercent != null
        ? clampRiskPercent(settings.riskPercent, current.riskPercent ?? 1)
        : clampRiskPercent(current.riskPercent ?? 1),
    fixedLotSize:
      settings.fixedLotSize != null
        ? clampFixedLotSize(settings.fixedLotSize, current.fixedLotSize ?? 0.01)
        : clampFixedLotSize(current.fixedLotSize ?? 0.01),
    symbolSuffix:
      settings.symbolSuffix != null ? String(settings.symbolSuffix) : current.symbolSuffix || '',
    enabled: settings.enabled != null ? Boolean(settings.enabled) : current.enabled !== false,
    executionMode
  };

  await persistUserMt5(userId, mt5);
  return mt5;
}

async function syncAccountFromEa(token, payload = {}) {
  const user = await findUserByMt5Token(token);
  if (!user) return { ok: false, reason: 'invalid_token' };

  const userId = user._id?.toString() || user.id;
  const current = user.mt5 || defaultMt5Config();
  const mt5 = {
    ...current,
    accountBalance: Number(payload.balance ?? payload.accountBalance ?? current.accountBalance),
    accountCurrency: payload.currency || payload.accountCurrency || current.accountCurrency || 'USD',
    terminalId: payload.terminalId || payload.terminal_id || current.terminalId,
    lastSyncAt: new Date(),
    enabled: true
  };

  await persistUserMt5(userId, mt5);
  return { ok: true, userId, mt5 };
}

/**
 * Premium (`autoLotSizing`): risk-% lot from synced MT5 balance.
 * Pro (no autoLot): fixedLotSize from settings (default 0.01).
 * Returns null when Premium balance has not synced yet.
 */
function computeLotSize(signal, user) {
  const mt5 = user?.mt5 || {};

  if (!userHasTierFeature(user, 'autoLotSizing')) {
    const fixed = Number(mt5.fixedLotSize || 0.01);
    return fixed > 0 ? fixed : 0.01;
  }

  const balance = Number(mt5.accountBalance || 0);
  if (!(balance > 0)) {
    return null;
  }

  // Always size from the user's current saved risk % (ignore stale signal.riskMetrics).
  const riskPercent = clampRiskPercent(mt5.riskPercent || 1);
  const metrics = computeRiskMetrics(signal, {
    accountBalance: balance,
    riskPercent
  });

  return metrics?.suggestedLotSize || null;
}

function pipSizeForSymbol(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (s.includes('JPY')) return 0.01;
  if (s.includes('XAU') || s.includes('GOLD')) return 0.1;
  if (s.includes('XAG') || s.includes('SILVER')) return 0.01;
  if (s.includes('BTC') || s.includes('US30') || s.includes('US100') || s.includes('NAS')) return 1;
  return 0.0001;
}

/** Defaults: trail distance = initial SL distance in pips; step = 20% of that (min 1). */
function buildTradeManagementParams(signal, user) {
  const entry = Number(signal.entry);
  const stopLoss = Number(signal.stop_loss_1 ?? signal.stop_loss);
  const pip = pipSizeForSymbol(signal.symbol);
  const slDistancePips =
    Number.isFinite(entry) && Number.isFinite(stopLoss) && pip > 0
      ? Math.abs(entry - stopLoss) / pip
      : 20;

  const trailDistancePips = Math.max(1, Number(slDistancePips.toFixed(1)));
  const trailStepPips = Math.max(1, Number((trailDistancePips * 0.2).toFixed(1)));

  return {
    trailingStop: userHasTierFeature(user, 'trailingStop'),
    breakEven: userHasTierFeature(user, 'breakEvenAutomation'),
    trailDistancePips,
    trailStepPips,
    breakEvenTriggerR: 1,
    breakEvenOffsetPips: 2
  };
}

async function findSignalById(signalId) {
  if (!signalId) return null;

  if (isDbConnected()) {
    try {
      return Signal.findById(signalId);
    } catch {
      return null;
    }
  }

  return null;
}

function saveDevExecution(record) {
  const id = record._id || `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const saved = { ...record, _id: id, createdAt: record.createdAt || new Date() };
  devExecutions.set(id, saved);
  return saved;
}

async function findExistingExecution(userId, signalId) {
  if (isDbConnected()) {
    return TradeExecution.findOne({ userId, signalId: String(signalId) });
  }

  return [...devExecutions.values()].find(
    e => e.userId === userId && String(e.signalId) === String(signalId)
  );
}

async function createExecution(user, signalDoc, options = {}) {
  const userId = user._id?.toString() || user.id;
  const signal = signalDoc?.toObject ? signalDoc.toObject() : signalDoc;
  const signalId = String(signal._id || signal.id || '');

  if (!signalId) {
    return { ok: false, reason: 'missing_signal_id' };
  }

  if (!isEntryAlert(signal.alertType || 'signal')) {
    return { ok: false, reason: 'not_entry_signal' };
  }

  if (!userHasTierFeature(user, 'mt5Execution')) {
    return { ok: false, reason: 'subscription_required' };
  }

  const mt5 = user.mt5 || {};
  if (!mt5.linkToken) {
    return { ok: false, reason: 'mt5_not_linked' };
  }

  if (mt5.enabled === false) {
    return { ok: false, reason: 'mt5_disabled' };
  }

  const existing = await findExistingExecution(userId, signalId);
  if (existing && ['pending', 'sent', 'filled'].includes(existing.status)) {
    return { ok: false, reason: 'already_queued', execution: existing };
  }

  let lotSize = computeLotSize(signal, user);
  if (!lotSize || lotSize <= 0) {
    if (userHasTierFeature(user, 'autoLotSizing')) {
      return {
        ok: false,
        reason: 'lot_size_unavailable',
        message:
          'Premium auto lot sizing needs a synced MT5 balance. Keep the EA running so SyncAccount can update your balance.'
      };
    }
    return { ok: false, reason: 'lot_size_unavailable' };
  }

  const stopLoss = Number(signal.stop_loss_1 ?? signal.stop_loss);
  const management = buildTradeManagementParams(signal, user);
  const source =
    options.source === 'manual' || options.source === 'telegram' || options.source === 'auto'
      ? options.source
      : 'auto';

  const payload = {
    userId,
    signalId,
    symbol: signal.symbol,
    mt5Symbol: toMt5Symbol(signal.symbol, mt5.symbolSuffix || ''),
    direction: mt5OrderType(signal.direction),
    entry: Number(signal.entry),
    stopLoss,
    takeProfit1: Number(signal.take_profit_1),
    takeProfit2: Number(signal.take_profit_2),
    takeProfit3: Number(signal.take_profit_3),
    lotSize: Number(lotSize.toFixed(2)),
    riskPercent: Number(mt5.riskPercent || 1),
    accountBalance: Number(mt5.accountBalance || 0) || null,
    ...management,
    status: 'pending',
    source
  };

  let execution;
  if (isDbConnected()) {
    execution = await TradeExecution.create(payload);
  } else {
    execution = saveDevExecution(payload);
  }

  return { ok: true, execution };
}

async function queueExecutionForUser(userId, signalId, options = {}) {
  const user = await findUserById(userId);
  if (!user) return { ok: false, reason: 'user_not_found' };

  let signal = await findSignalById(signalId);
  if (!signal) {
    return { ok: false, reason: 'signal_not_found' };
  }

  return createExecution(user, signal, options);
}

async function getPendingExecutions(token) {
  const user = await findUserByMt5Token(token);
  if (!user) return { ok: false, reason: 'invalid_token' };

  const userId = user._id?.toString() || user.id;

  if (isDbConnected()) {
    const items = await TradeExecution.find({ userId, status: 'pending' })
      .sort({ createdAt: 1 })
      .limit(10)
      .lean();

    // Claim immediately so a slow report cannot double-fill on the next poll.
    if (items.length > 0) {
      const ids = items.map(t => t._id);
      await TradeExecution.updateMany(
        { _id: { $in: ids }, status: 'pending' },
        { $set: { status: 'sent' } }
      );
      items.forEach(t => {
        t.status = 'sent';
      });
    }

    return { ok: true, userId, trades: items };
  }

  const trades = [...devExecutions.values()]
    .filter(e => e.userId === userId && e.status === 'pending')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .slice(0, 10);

  for (const trade of trades) {
    const updated = { ...trade, status: 'sent' };
    devExecutions.set(trade._id, updated);
    trade.status = 'sent';
  }

  return { ok: true, userId, trades };
}

async function reportExecution(token, payload = {}) {
  const user = await findUserByMt5Token(token);
  if (!user) return { ok: false, reason: 'invalid_token' };

  const executionId = String(payload.executionId || payload.id || '');
  if (!executionId) return { ok: false, reason: 'missing_execution_id' };

  const status = ['filled', 'failed', 'sent'].includes(payload.status) ? payload.status : 'failed';
  const update = {
    status,
    mt5Ticket: payload.ticket ? String(payload.ticket) : undefined,
    fillPrice: payload.fillPrice != null ? Number(payload.fillPrice) : undefined,
    errorMessage: payload.error || payload.errorMessage || undefined,
    executedAt: status === 'filled' || status === 'failed' ? new Date() : undefined
  };

  let execution;
  if (isDbConnected()) {
    execution = await TradeExecution.findOneAndUpdate(
      { _id: executionId, userId: user._id?.toString() || user.id },
      update,
      { new: true }
    );
  } else {
    const existing = devExecutions.get(executionId);
    if (existing && existing.userId === (user._id?.toString() || user.id)) {
      execution = { ...existing, ...update };
      devExecutions.set(executionId, execution);
    }
  }

  if (!execution) return { ok: false, reason: 'execution_not_found' };

  if (payload.balance != null || payload.accountBalance != null) {
    await syncAccountFromEa(token, payload);
  }

  return { ok: true, execution };
}

async function getPublicStatus(user) {
  const mt5 = user?.mt5 || defaultMt5Config();
  const userId = user._id?.toString() || user.id;
  const featureEnabled = userHasTierFeature(user, 'mt5Execution');

  let pendingCount = 0;
  let recentExecutions = [];

  if (featureEnabled && userId) {
    if (isDbConnected()) {
      pendingCount = await TradeExecution.countDocuments({ userId, status: 'pending' });
      recentExecutions = await TradeExecution.find({ userId })
        .sort({ createdAt: -1 })
        .limit(5)
        .lean();
    } else {
      const mine = [...devExecutions.values()].filter(e => e.userId === userId);
      pendingCount = mine.filter(e => e.status === 'pending').length;
      recentExecutions = mine.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
    }
  }

  return {
    featureEnabled,
    autoLotSizing: userHasTierFeature(user, 'autoLotSizing'),
    mt5AutoExecution: userHasTierFeature(user, 'mt5AutoExecution'),
    trailingStop: userHasTierFeature(user, 'trailingStop'),
    breakEvenAutomation: userHasTierFeature(user, 'breakEvenAutomation'),
    linked: Boolean(mt5.linkToken),
    enabled: mt5.enabled !== false,
    executionMode: resolveExecutionMode(user),
    accountBalance: mt5.accountBalance,
    accountCurrency: mt5.accountCurrency || 'USD',
    riskPercent: clampRiskPercent(mt5.riskPercent ?? 1),
    fixedLotSize: clampFixedLotSize(mt5.fixedLotSize ?? 0.01),
    symbolSuffix: mt5.symbolSuffix || '',
    lastSyncAt: mt5.lastSyncAt,
    linkedAt: mt5.linkedAt,
    pendingCount,
    recentExecutions
  };
}

function formatExecutionSummary(execution) {
  if (!execution) return '';
  return [
    `Symbol: ${execution.symbol}`,
    `Direction: ${String(execution.direction).toUpperCase()}`,
    `Entry: ${Number(execution.entry).toFixed(5)}`,
    `SL: ${Number(execution.stopLoss).toFixed(5)}`,
    `TP1: ${Number(execution.takeProfit1).toFixed(5)}`,
    `Lot: ${Number(execution.lotSize).toFixed(2)}`
  ].join('\n');
}

module.exports = {
  defaultMt5Config,
  resolveExecutionMode,
  generateLinkToken,
  updateSettings,
  syncAccountFromEa,
  queueExecutionForUser,
  getPendingExecutions,
  reportExecution,
  getPublicStatus,
  formatExecutionSummary,
  computeLotSize,
  buildTradeManagementParams,
  findUserByMt5Token
};
