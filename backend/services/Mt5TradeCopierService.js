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
const { formatTvPrice } = require('../utils/priceFormat');
const {
  applyManagementEvent,
  formatManagementLabel
} = require('../utils/mt5TradeManagement');
const {
  clampConfirmSeconds,
  resolveConfirmSeconds,
  formatConfirmWindowLabel
} = require('../utils/mt5ManualConfirm');
const {
  shouldReclaimSentClaim,
  shouldApplyReportEvent,
  rememberAckedEventUuid
} = require('../utils/mt5EaReliability');

const devExecutions = new Map();

/** Reclaim claim-without-fill after this window (preserves first-claimer during active attempt). */
const SENT_RECLAIM_MS = 120 * 1000;

function isDbConnected() {
  return mongoose.connection.readyState === 1;
}

async function findUserById(userId) {
  if (isDbConnected()) {
    return UserConfig.findById(userId);
  }
  return devUserStore.findById(userId);
}

const ACCESS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const HEARTBEAT_OFFLINE_MS = 90 * 1000;

function activeDevices(mt5) {
  return (mt5?.devices || []).filter(d => d && !d.revokedAt);
}

function isMt5Linked(mt5) {
  return activeDevices(mt5).length > 0;
}

function findDevUserByDeviceToken(token, field) {
  if (typeof devUserStore.findByMt5DeviceToken === 'function') {
    return devUserStore.findByMt5DeviceToken(token, field);
  }
  const fs = require('fs');
  const path = require('path');
  const STORE_PATH = path.join(__dirname, '..', 'dev-users.json');
  if (!fs.existsSync(STORE_PATH)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return (
      Object.values(data).find(u =>
        (u.mt5?.devices || []).some(d => d && !d.revokedAt && String(d[field]) === token)
      ) || null
    );
  } catch {
    return null;
  }
}

/**
 * Resolve bridge auth via device accessToken only (PairCode → device tokens).
 */
async function resolveMt5Auth(token) {
  const normalized = String(token || '').trim();
  if (!normalized) return { user: null, reason: 'invalid_token' };

  let user = null;
  if (isDbConnected()) {
    user = await UserConfig.findOne({ 'mt5.devices.accessToken': normalized });
  } else {
    user = findDevUserByDeviceToken(normalized, 'accessToken');
  }
  if (!user) return { user: null, reason: 'invalid_token' };

  const device = (user.mt5?.devices || []).find(
    d => d && String(d.accessToken) === normalized && !d.revokedAt
  );
  if (!device) return { user: null, reason: 'invalid_token' };

  if (device.accessExpiresAt && new Date(device.accessExpiresAt).getTime() < Date.now()) {
    return { user, device, authType: 'device', reason: 'access_expired' };
  }

  return { user, device, authType: 'device' };
}

async function findUserByMt5Token(token) {
  const resolved = await resolveMt5Auth(token);
  if (!resolved.user || resolved.reason) return null;
  return resolved.user;
}

async function persistUserMt5(userId, mt5) {
  if (isDbConnected()) {
    return UserConfig.findByIdAndUpdate(userId, { mt5, updatedAt: new Date() }, { new: true });
  }
  return devUserStore.upsertUser(userId, { mt5 });
}

function defaultMt5Config() {
  return {
    enabled: false,
    accountBalance: null,
    accountCurrency: 'USD',
    riskPercent: 1,
    fixedLotSize: 0.01,
    symbolSuffix: '',
    executionMode: null,
    manualConfirmSeconds: null,
    lastSyncAt: null,
    linkedAt: null,
    terminalId: null,
    lastPairAt: null,
    broker: null,
    build: null,
    machineFingerprint: null,
    accountNumber: null,
    devices: []
  };
}

/**
 * Overlay EA identity fields after a successful PairCode exchange.
 */
async function attachPairMetadata(userId, meta = {}) {
  const user = await findUserById(userId);
  const current = user?.mt5 || defaultMt5Config();
  const mt5 = {
    ...current,
    terminalId:
      meta.terminalId != null ? String(meta.terminalId) : current.terminalId,
    broker: meta.broker != null ? String(meta.broker) : current.broker,
    build:
      meta.terminalBuild != null
        ? String(meta.terminalBuild)
        : meta.build != null
          ? String(meta.build)
          : current.build,
    machineFingerprint:
      meta.machineFingerprint != null
        ? String(meta.machineFingerprint)
        : current.machineFingerprint,
    accountNumber:
      meta.accountNumber != null ? String(meta.accountNumber) : current.accountNumber,
    lastPairAt: new Date(),
    linkedAt: current.linkedAt || new Date(),
    enabled: true
  };
  await persistUserMt5(userId, mt5);
  return mt5;
}

/**
 * Register a new authorized device (multi-device PairCode auth).
 */
async function registerPairedDevice(userId, meta = {}) {
  const user = await findUserById(userId);
  const current = user?.mt5 || defaultMt5Config();
  const devices = Array.isArray(current.devices) ? [...current.devices] : [];

  const deviceId = crypto.randomBytes(12).toString('hex');
  const accessToken = crypto.randomBytes(24).toString('hex');
  const refreshToken = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const accessExpiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_MS);
  const refreshExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);
  const friendlyName =
    meta.friendlyName || meta.label || meta.deviceLabel || 'MT5 Terminal';

  const device = {
    deviceId,
    accessToken,
    refreshToken,
    accessExpiresAt,
    refreshExpiresAt,
    friendlyName,
    label: friendlyName,
    broker: meta.broker != null ? String(meta.broker) : null,
    accountNumber: meta.accountNumber != null ? String(meta.accountNumber) : null,
    platform: meta.platform || 'Windows',
    terminalBuild:
      meta.terminalBuild != null
        ? String(meta.terminalBuild)
        : meta.build != null
          ? String(meta.build)
          : null,
    eaVersion: meta.eaVersion != null ? String(meta.eaVersion) : null,
    machineFingerprint:
      meta.machineFingerprint != null ? String(meta.machineFingerprint) : null,
    terminalId: meta.terminalId != null ? String(meta.terminalId) : null,
    firstPairedAt: now,
    lastHeartbeatAt: now,
    lastSeenIP: meta.lastSeenIP != null ? String(meta.lastSeenIP) : null,
    createdAt: now,
    revokedAt: null
  };

  devices.push(device);

  // Strip any leftover legacy linkToken field if present on older documents.
  const { linkToken: _dropLegacy, ...rest } = current;
  const mt5 = {
    ...rest,
    devices,
    enabled: true,
    linkedAt: current.linkedAt || now,
    lastPairAt: now,
    terminalId: device.terminalId || current.terminalId,
    broker: device.broker || current.broker,
    build: device.terminalBuild || current.build,
    machineFingerprint: device.machineFingerprint || current.machineFingerprint,
    accountNumber: device.accountNumber || current.accountNumber
  };

  await persistUserMt5(userId, mt5);
  return device;
}

async function refreshDeviceAccess(refreshToken, deviceIdHint = null) {
  const normalized = String(refreshToken || '').trim();
  if (!normalized) return { ok: false, reason: 'invalid_refresh' };

  let user = null;
  if (isDbConnected()) {
    user = await UserConfig.findOne({ 'mt5.devices.refreshToken': normalized });
  } else {
    user = findDevUserByDeviceToken(normalized, 'refreshToken');
  }
  if (!user) return { ok: false, reason: 'invalid_refresh' };

  const userId = user._id?.toString() || user.id;
  const devices = Array.isArray(user.mt5?.devices) ? [...user.mt5.devices] : [];
  const idx = devices.findIndex(
    d =>
      d &&
      !d.revokedAt &&
      String(d.refreshToken) === normalized &&
      (!deviceIdHint || String(d.deviceId) === String(deviceIdHint))
  );
  if (idx < 0) return { ok: false, reason: 'invalid_refresh' };

  const device = devices[idx];
  if (device.refreshExpiresAt && new Date(device.refreshExpiresAt).getTime() < Date.now()) {
    return { ok: false, reason: 'refresh_expired' };
  }

  const accessToken = crypto.randomBytes(24).toString('hex');
  const accessExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
  devices[idx] = {
    ...device,
    accessToken,
    accessExpiresAt,
    lastHeartbeatAt: new Date()
  };

  await persistUserMt5(userId, { ...user.mt5, devices, enabled: true });
  return {
    ok: true,
    accessToken,
    accessExpiresAt,
    deviceId: device.deviceId
  };
}

async function recordDeviceHeartbeat(token, payload = {}, meta = {}) {
  const resolved = await resolveMt5Auth(token);
  if (!resolved.user) return { ok: false, reason: resolved.reason || 'invalid_token' };
  if (resolved.reason === 'access_expired') {
    return { ok: false, reason: 'access_expired' };
  }
  if (!resolved.device) {
    return { ok: false, reason: 'invalid_token' };
  }

  const userId = resolved.user._id?.toString() || resolved.user.id;
  const current = resolved.user.mt5 || defaultMt5Config();
  const seenIp = meta.ip != null ? String(meta.ip) : payload.lastSeenIP || null;

  const devices = (current.devices || []).map(d => {
    if (String(d.deviceId) !== String(resolved.device.deviceId)) return d;
    return {
      ...d,
      lastHeartbeatAt: new Date(),
      lastSeenIP: seenIp != null ? String(seenIp) : d.lastSeenIP,
      broker: payload.broker != null ? String(payload.broker) : d.broker,
      accountNumber:
        payload.accountNumber != null ? String(payload.accountNumber) : d.accountNumber,
      eaVersion: payload.eaVersion != null ? String(payload.eaVersion) : d.eaVersion,
      terminalBuild:
        payload.terminalBuild != null
          ? String(payload.terminalBuild)
          : payload.build != null
            ? String(payload.build)
            : d.terminalBuild
    };
  });
  const mt5 = {
    ...current,
    devices,
    accountBalance:
      payload.balance != null || payload.accountBalance != null
        ? Number(payload.balance ?? payload.accountBalance)
        : current.accountBalance,
    accountCurrency:
      payload.currency || payload.accountCurrency || current.accountCurrency || 'USD',
    lastSyncAt: new Date(),
    enabled: true
  };
  await persistUserMt5(userId, mt5);
  return { ok: true, deviceId: resolved.device.deviceId, mt5 };
}

async function listAuthorizedDevices(userId) {
  const user = await findUserById(userId);
  const mt5 = user?.mt5 || defaultMt5Config();
  const now = Date.now();
  return activeDevices(mt5).map(d => {
    const lastHb = d.lastHeartbeatAt ? new Date(d.lastHeartbeatAt).getTime() : 0;
    const online = lastHb > 0 && now - lastHb <= HEARTBEAT_OFFLINE_MS;
    const friendlyName = d.friendlyName || d.label || 'MT5 Terminal';
    return {
      deviceId: d.deviceId,
      friendlyName,
      label: friendlyName,
      broker: d.broker,
      accountNumber: d.accountNumber,
      platform: d.platform || 'Windows',
      terminalBuild: d.terminalBuild,
      eaVersion: d.eaVersion,
      firstPairedAt: d.firstPairedAt || d.createdAt,
      lastHeartbeatAt: d.lastHeartbeatAt,
      lastSeenIP: d.lastSeenIP || null,
      createdAt: d.createdAt,
      online,
      status: online ? 'Active' : 'Offline'
    };
  });
}

async function revokeDevice(userId, deviceId) {
  const user = await findUserById(userId);
  if (!user) return { ok: false, reason: 'user_not_found' };
  const current = user.mt5 || defaultMt5Config();
  const devices = Array.isArray(current.devices) ? [...current.devices] : [];
  const idx = devices.findIndex(d => d && String(d.deviceId) === String(deviceId) && !d.revokedAt);
  if (idx < 0) return { ok: false, reason: 'device_not_found' };

  devices[idx] = {
    ...devices[idx],
    revokedAt: new Date(),
    accessToken: null,
    refreshToken: null
  };

  await persistUserMt5(userId, { ...current, devices });
  return { ok: true, deviceId: String(deviceId) };
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

  let manualConfirmSeconds = current.manualConfirmSeconds;
  if (settings.manualConfirmSeconds != null) {
    manualConfirmSeconds = clampConfirmSeconds(settings.manualConfirmSeconds);
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
    executionMode,
    manualConfirmSeconds
  };

  await persistUserMt5(userId, mt5);
  return mt5;
}

async function syncAccountFromEa(token, payload = {}) {
  const resolved = await resolveMt5Auth(token);
  if (!resolved.user) return { ok: false, reason: resolved.reason || 'invalid_token' };
  if (resolved.reason === 'access_expired') return { ok: false, reason: 'access_expired' };

  const user = resolved.user;
  const userId = user._id?.toString() || user.id;
  const current = user.mt5 || defaultMt5Config();

  let devices = current.devices || [];
  if (resolved.authType === 'device' && resolved.device) {
    devices = devices.map(d => {
      if (String(d.deviceId) !== String(resolved.device.deviceId)) return d;
      return {
        ...d,
        lastHeartbeatAt: new Date(),
        broker: payload.broker != null ? String(payload.broker) : d.broker,
        accountNumber:
          payload.accountNumber != null ? String(payload.accountNumber) : d.accountNumber
      };
    });
  }

  const mt5 = {
    ...current,
    devices,
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
  if (!isMt5Linked(mt5)) {
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
    takeProfit2: Number(signal.take_profit_2) || null,
    takeProfit3: Number(signal.take_profit_3) || null,
    lotSize: Number(lotSize.toFixed(2)),
    riskPercent: Number(mt5.riskPercent || 1),
    accountBalance: Number(mt5.accountBalance || 0) || null,
    ...management,
    status: 'pending',
    source,
    managementState: {
      phase: 'queued',
      tp1Hit: false,
      tp2Hit: false,
      tp3Hit: false,
      breakEvenApplied: false,
      trailingActive: false,
      remainingVolume: Number(lotSize.toFixed(2)),
      closedVolume: 0,
      partialClosePercent: 0,
      lastEvent: null,
      lastEventAt: null,
      events: []
    }
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

/**
 * Stuck sent-without-ticket → pending again so another (or same) device can retry.
 * Heartbeat-aware: if claimer device heartbeat is alive, wait (healthy slow EA).
 * Does not touch fills or ticketed claims (first-claimer / duplicate safety preserved).
 */
async function reclaimStaleSentClaims(userId) {
  const user = await findUserById(userId);
  const devices = activeDevices(user?.mt5 || defaultMt5Config());
  const nowMs = Date.now();

  if (isDbConnected()) {
    const candidates = await TradeExecution.find({
      userId,
      status: 'sent',
      $or: [{ mt5Ticket: null }, { mt5Ticket: '' }, { mt5Ticket: { $exists: false } }]
    }).lean();

    const ids = [];
    for (const trade of candidates) {
      if (
        shouldReclaimSentClaim({
          status: trade.status,
          mt5Ticket: trade.mt5Ticket,
          claimedAt: trade.claimedAt,
          createdAt: trade.createdAt,
          claimedByDeviceId: trade.claimedByDeviceId,
          devices,
          nowMs,
          reclaimMs: SENT_RECLAIM_MS,
          heartbeatOfflineMs: HEARTBEAT_OFFLINE_MS
        })
      ) {
        ids.push(trade._id);
      }
    }

    if (ids.length > 0) {
      await TradeExecution.updateMany(
        { _id: { $in: ids }, status: 'sent' },
        {
          $set: {
            status: 'pending',
            claimedAt: null,
            claimedByDeviceId: null,
            'managementState.phase': 'queued',
            'managementState.lastEvent': 'reclaimed'
          }
        }
      );
    }
    return { reclaimed: ids.length };
  }

  let reclaimed = 0;
  for (const [id, trade] of devExecutions.entries()) {
    if (trade.userId !== userId) continue;
    if (
      !shouldReclaimSentClaim({
        status: trade.status,
        mt5Ticket: trade.mt5Ticket,
        claimedAt: trade.claimedAt,
        createdAt: trade.createdAt,
        claimedByDeviceId: trade.claimedByDeviceId,
        devices,
        nowMs,
        reclaimMs: SENT_RECLAIM_MS,
        heartbeatOfflineMs: HEARTBEAT_OFFLINE_MS
      })
    ) {
      continue;
    }
    reclaimed += 1;
    devExecutions.set(id, {
      ...trade,
      status: 'pending',
      claimedAt: null,
      claimedByDeviceId: null,
      managementState: {
        ...(trade.managementState || {}),
        phase: 'queued',
        lastEvent: 'reclaimed'
      }
    });
  }
  return { reclaimed };
}

async function getPendingExecutions(token) {
  const resolved = await resolveMt5Auth(token);
  if (!resolved.user) return { ok: false, reason: resolved.reason || 'invalid_token' };
  if (resolved.reason === 'access_expired') return { ok: false, reason: 'access_expired' };

  const user = resolved.user;
  const userId = user._id?.toString() || user.id;
  const claimerDeviceId = resolved.device?.deviceId ? String(resolved.device.deviceId) : null;

  await reclaimStaleSentClaims(userId);

  if (isDbConnected()) {
    const items = await TradeExecution.find({ userId, status: 'pending' })
      .sort({ createdAt: 1 })
      .limit(10)
      .lean();

    // Claim immediately so a slow report cannot double-fill on the next poll.
    if (items.length > 0) {
      const ids = items.map(t => t._id);
      const claimedAt = new Date();
      await TradeExecution.updateMany(
        { _id: { $in: ids }, status: 'pending' },
        {
          $set: {
            status: 'sent',
            claimedAt,
            claimedByDeviceId: claimerDeviceId,
            'managementState.phase': 'sent'
          }
        }
      );
      items.forEach(t => {
        t.status = 'sent';
        t.claimedAt = claimedAt;
        t.claimedByDeviceId = claimerDeviceId;
      });
    }

    return { ok: true, userId, trades: items };
  }

  const trades = [...devExecutions.values()]
    .filter(e => e.userId === userId && e.status === 'pending')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .slice(0, 10);

  const claimedAt = new Date();
  for (const trade of trades) {
    const updated = {
      ...trade,
      status: 'sent',
      claimedAt,
      claimedByDeviceId: claimerDeviceId,
      managementState: { ...(trade.managementState || {}), phase: 'sent' }
    };
    devExecutions.set(trade._id, updated);
    trade.status = 'sent';
    trade.claimedAt = claimedAt;
    trade.claimedByDeviceId = claimerDeviceId;
  }

  return { ok: true, userId, trades };
}

async function reportExecution(token, payload = {}) {
  const resolved = await resolveMt5Auth(token);
  if (!resolved.user) return { ok: false, reason: resolved.reason || 'invalid_token' };
  if (resolved.reason === 'access_expired') return { ok: false, reason: 'access_expired' };

  const user = resolved.user;
  const userId = user._id?.toString() || user.id;
  const executionId = String(payload.executionId || payload.id || '');
  if (!executionId) return { ok: false, reason: 'missing_execution_id' };

  let existing = null;
  if (isDbConnected()) {
    existing = await TradeExecution.findOne({ _id: executionId, userId }).lean();
  } else {
    const row = devExecutions.get(executionId);
    if (row && row.userId === userId) existing = row;
  }
  if (!existing) return { ok: false, reason: 'execution_not_found' };

  const eventUuidRaw =
    payload.eventUuid != null && String(payload.eventUuid).trim()
      ? String(payload.eventUuid).trim()
      : payload.eventId != null && String(payload.eventId).trim()
        ? String(payload.eventId).trim()
        : null;

  const ackedPrev = existing.managementState?.ackedEventUuids || [];
  if (eventUuidRaw && !shouldApplyReportEvent(ackedPrev, eventUuidRaw)) {
    // Idempotent ack for durable EA queue retries
    return {
      ok: true,
      acknowledged: true,
      eventUuid: eventUuidRaw,
      duplicate: true,
      execution: existing
    };
  }

  // Legacy shape: status filled/failed/sent without event → still works.
  // Additive: event (tp1_hit, break_even, …) updates managementState.
  const hasEvent = Boolean(payload.event);
  const legacyStatus = ['filled', 'failed', 'sent', 'closed'].includes(payload.status)
    ? payload.status
    : hasEvent
      ? existing.status
      : 'failed';

  const applied = applyManagementEvent(existing, {
    ...payload,
    eventUuid: eventUuidRaw,
    status: legacyStatus,
    event: payload.event || (legacyStatus === 'filled' ? 'opened' : legacyStatus)
  });

  if (eventUuidRaw) {
    applied.managementState.ackedEventUuids = rememberAckedEventUuid(
      applied.managementState.ackedEventUuids || ackedPrev,
      eventUuidRaw
    );
  }

  const update = {
    status: applied.status,
    managementState: applied.managementState,
    mt5Ticket: payload.ticket != null && payload.ticket !== ''
      ? String(payload.ticket)
      : existing.mt5Ticket,
    fillPrice:
      payload.fillPrice != null
        ? Number(payload.fillPrice)
        : payload.price != null && (applied.event === 'opened' || legacyStatus === 'filled')
          ? Number(payload.price)
          : existing.fillPrice,
    errorMessage: payload.error || payload.errorMessage || existing.errorMessage,
    executedAt:
      applied.status === 'filled' || applied.status === 'failed'
        ? existing.executedAt || new Date()
        : existing.executedAt,
    closedAt:
      applied.status === 'closed' ? existing.closedAt || new Date() : existing.closedAt
  };

  // Strip undefined so we don't wipe fields in mongo $set via spread elsewhere
  Object.keys(update).forEach(k => {
    if (update[k] === undefined) delete update[k];
  });

  let execution;
  if (isDbConnected()) {
    execution = await TradeExecution.findOneAndUpdate(
      { _id: executionId, userId },
      { $set: update },
      { new: true }
    );
  } else {
    execution = { ...existing, ...update };
    devExecutions.set(executionId, execution);
  }

  if (!execution) return { ok: false, reason: 'execution_not_found' };

  if (payload.balance != null || payload.accountBalance != null) {
    await syncAccountFromEa(token, payload);
  }

  return {
    ok: true,
    acknowledged: true,
    eventUuid: eventUuidRaw || applied.eventUuid || null,
    duplicate: false,
    execution
  };
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

  const devices = await listAuthorizedDevices(userId);
  const anyOnline = devices.some(d => d.online);

  return {
    featureEnabled,
    autoLotSizing: userHasTierFeature(user, 'autoLotSizing'),
    mt5AutoExecution: userHasTierFeature(user, 'mt5AutoExecution'),
    trailingStop: userHasTierFeature(user, 'trailingStop'),
    breakEvenAutomation: userHasTierFeature(user, 'breakEvenAutomation'),
    linked: isMt5Linked(mt5),
    enabled: mt5.enabled !== false,
    executionMode: resolveExecutionMode(user),
    /** Human-readable mode for dashboard (only two modes). */
    executionModeLabel:
      resolveExecutionMode(user) === 'auto'
        ? 'Automatic (Premium)'
        : 'Manual Confirmation (Pro)',
    manualConfirmSeconds: resolveConfirmSeconds(mt5),
    manualConfirmWindowLabel: formatConfirmWindowLabel(resolveConfirmSeconds(mt5)),
    accountBalance: mt5.accountBalance,
    accountCurrency: mt5.accountCurrency || 'USD',
    riskPercent: clampRiskPercent(mt5.riskPercent ?? 1),
    fixedLotSize: clampFixedLotSize(mt5.fixedLotSize ?? 0.01),
    symbolSuffix: mt5.symbolSuffix || '',
    lastSyncAt: mt5.lastSyncAt,
    linkedAt: mt5.linkedAt,
    pendingCount,
    recentExecutions,
    devices,
    deviceOnline: anyOnline
  };
}

function formatExecutionSummary(execution) {
  if (!execution) return '';
  const phase = formatManagementLabel(execution.managementState);
  const lines = [
    `Symbol: ${execution.symbol}`,
    `Direction: ${String(execution.direction).toUpperCase()}`,
    `Entry: ${formatTvPrice(execution.entry)}`,
    `SL: ${formatTvPrice(execution.stopLoss)}`,
    `TP1: ${formatTvPrice(execution.takeProfit1)}`,
    `Lot: ${Number(execution.lotSize).toFixed(2)}`
  ];
  if (phase) lines.push(`State: ${phase}`);
  if (execution.managementState?.remainingVolume != null) {
    lines.push(`Remaining: ${Number(execution.managementState.remainingVolume).toFixed(2)}`);
  }
  return lines.join('\n');
}

function _clearDevExecutions() {
  devExecutions.clear();
}

function _setDevExecution(execution) {
  const id = String(execution._id || execution.id);
  const row = { ...execution, _id: id, id };
  devExecutions.set(id, row);
  return row;
}

function _getDevExecution(id) {
  return devExecutions.get(String(id)) || null;
}

module.exports = {
  defaultMt5Config,
  resolveExecutionMode,
  attachPairMetadata,
  registerPairedDevice,
  refreshDeviceAccess,
  recordDeviceHeartbeat,
  listAuthorizedDevices,
  revokeDevice,
  resolveMt5Auth,
  isMt5Linked,
  updateSettings,
  syncAccountFromEa,
  queueExecutionForUser,
  getPendingExecutions,
  reportExecution,
  getPublicStatus,
  formatExecutionSummary,
  computeLotSize,
  buildTradeManagementParams,
  reclaimStaleSentClaims,
  findUserByMt5Token,
  HEARTBEAT_OFFLINE_MS,
  ACCESS_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  SENT_RECLAIM_MS,
  _clearDevExecutions,
  _setDevExecution,
  _getDevExecution
};
