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
    symbolSuffix: '',
    lastSyncAt: null,
    linkedAt: null,
    terminalId: null
  };
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

async function updateSettings(userId, settings = {}) {
  const user = await findUserById(userId);
  const current = user?.mt5 || defaultMt5Config();
  const mt5 = {
    ...current,
    riskPercent: settings.riskPercent != null ? Number(settings.riskPercent) : current.riskPercent,
    symbolSuffix:
      settings.symbolSuffix != null ? String(settings.symbolSuffix) : current.symbolSuffix || '',
    enabled: settings.enabled != null ? Boolean(settings.enabled) : current.enabled !== false
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

function computeLotSize(signal, user) {
  const mt5 = user?.mt5 || {};
  const balance = Number(mt5.accountBalance || 0);
  const riskPercent = Number(mt5.riskPercent || 1);

  if (signal.riskMetrics?.suggestedLotSize && balance > 0) {
    return signal.riskMetrics.suggestedLotSize;
  }

  const metrics = computeRiskMetrics(signal, {
    accountBalance: balance,
    riskPercent
  });

  return metrics?.suggestedLotSize || 0.01;
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

async function createExecution(user, signalDoc) {
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
  if ((!lotSize || lotSize <= 0) && userHasTierFeature(user, 'autoLotSizing')) {
    lotSize = 0.01;
  }
  if (!lotSize || lotSize <= 0) {
    return { ok: false, reason: 'lot_size_unavailable' };
  }

  const stopLoss = Number(signal.stop_loss_1 ?? signal.stop_loss);
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
    trailingStop: userHasTierFeature(user, 'trailingStop'),
    breakEven: userHasTierFeature(user, 'breakEvenAutomation'),
    status: 'pending',
    source: 'telegram'
  };

  let execution;
  if (isDbConnected()) {
    execution = await TradeExecution.create(payload);
  } else {
    execution = saveDevExecution(payload);
  }

  return { ok: true, execution };
}

async function queueExecutionForUser(userId, signalId) {
  const user = await findUserById(userId);
  if (!user) return { ok: false, reason: 'user_not_found' };

  let signal = await findSignalById(signalId);
  if (!signal) {
    return { ok: false, reason: 'signal_not_found' };
  }

  return createExecution(user, signal);
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
    return { ok: true, userId, trades: items };
  }

  const trades = [...devExecutions.values()]
    .filter(e => e.userId === userId && e.status === 'pending')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .slice(0, 10);

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
    linked: Boolean(mt5.linkToken),
    enabled: mt5.enabled !== false,
    accountBalance: mt5.accountBalance,
    accountCurrency: mt5.accountCurrency || 'USD',
    riskPercent: mt5.riskPercent ?? 1,
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
  generateLinkToken,
  updateSettings,
  syncAccountFromEa,
  queueExecutionForUser,
  getPendingExecutions,
  reportExecution,
  getPublicStatus,
  formatExecutionSummary,
  computeLotSize,
  findUserByMt5Token
};
