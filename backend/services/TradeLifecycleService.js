/**
 * TradeLifecycleService — SINGLE source of truth for TradingView signal state transitions.
 *
 * Flow: create → confirm → active → TP1/TP2 → TP3 | SL | EXPIRED | CANCELLED
 *
 * All consumers (webhook, dashboard/WebSocket, Telegram, MT5, MongoDB) derive
 * lifecycle state through this service. Confidence / later scans cannot invalidate
 * a confirmed trade; only terminal outcomes free the ActiveSignalRegistry slot.
 */

const ActiveSignalRegistry = require('../utils/activeSignalRegistry');
const {
  isEntryAlert,
  isOutcomeAlert,
  isTerminalAlert,
  isPartialAlert,
  enrichEntrySignal,
  applyOutcomeUpdate,
  outcomeFromAlertType,
  lifecycleStageFromOutcome,
  parseExpiryBars,
  computeExpiresAt
} = require('../utils/signalOutcome');
const SignalOutcomeService = require('./SignalOutcomeService');

const STAGES = Object.freeze({
  DETECTED: 'DETECTED',
  CONFIRMED: 'CONFIRMED',
  ACTIVE: 'ACTIVE',
  TP1: 'TP1',
  TP2: 'TP2',
  TP3: 'TP3',
  SL: 'SL',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED'
});

const FROZEN_LEVEL_KEYS = [
  'entry',
  'stop_loss',
  'stop_loss_1',
  'take_profit_1',
  'take_profit_2',
  'take_profit_3',
  'direction',
  'signalUuid',
  'signalId',
  'signalGroupId',
  'symbol',
  'timeframe'
];

function normalizeTradeTimeframe(timeframe) {
  return ActiveSignalRegistry.normalizeTimeframe(timeframe);
}

/**
 * Reject chart-reset / "No Signal" style webhooks. Confirmed trades must never be
 * wiped because a later scan finds no setup.
 */
function isForbiddenResetPayload(body) {
  if (!body || typeof body !== 'object') return false;
  if (body.active === false || body.active === 'false' || body.active === 0) return true;
  if (body.delete === true || body.reset === true || body.clear === true) return true;

  const message = String(body.message || body.notes || body.note || '').toLowerCase();
  if (
    message.includes('no signal') ||
    message.includes('nosignal') ||
    message.includes('clear signal') ||
    message.includes('remove signal')
  ) {
    return true;
  }

  const alertType = String(body.alertType || body.alert_type || body.type || '').toLowerCase();
  if (['none', 'no_signal', 'nosignal', 'clear', 'reset', 'delete'].includes(alertType)) {
    return true;
  }

  return false;
}

function logLifecycleEvent(event, details = {}) {
  const ts = new Date().toISOString();
  const uuid = details.signalUuid || details.signalId || details.signalGroupId || '-';
  console.log(
    `[TradeLifecycle] ${ts} event=${event} uuid=${uuid} symbol=${details.symbol || '-'} ` +
      `tf=${details.timeframe || '-'} alert=${details.alertType || '-'} ` +
      `stage=${details.lifecycleStage || details.stage || '-'} ` +
      `reason=${details.closedReason || details.reason || '-'}`
  );
}

/** @deprecated alias — prefer logLifecycleEvent */
const logLifecycle = logLifecycleEvent;

function freezeConfirmedLevels(signal) {
  const frozen = {};
  for (const key of FROZEN_LEVEL_KEYS) {
    if (signal[key] !== undefined) frozen[key] = signal[key];
  }
  return {
    ...signal,
    ...frozen,
    lifecycleStage: signal.lifecycleStage || STAGES.CONFIRMED,
    levelsFrozen: true
  };
}

function attachExpiryFields(signalData) {
  const expiryBars = parseExpiryBars(signalData.expiryBars ?? signalData.expiry_bars);
  const enableDisabled =
    signalData.enableTradeExpiry === false ||
    signalData.enableTradeExpiry === 'false' ||
    signalData.enable_trade_expiry === false ||
    signalData.enable_trade_expiry === 'false';
  const enableTradeExpiry = !enableDisabled;

  let expiresAt = null;
  if (signalData.expiresAt || signalData.expires_at) {
    const parsed = new Date(signalData.expiresAt || signalData.expires_at);
    if (!Number.isNaN(parsed.getTime())) expiresAt = parsed;
  } else if (enableTradeExpiry && expiryBars != null) {
    expiresAt = computeExpiresAt(signalData.timeframe, expiryBars);
  }

  return {
    ...signalData,
    expiryBars: expiryBars ?? undefined,
    enableTradeExpiry,
    expiresAt: expiresAt || undefined
  };
}

/**
 * Reject new entries while an open trade exists for the same symbol:timeframe.
 * Different timeframes never block each other; nothing globally blocks the system.
 */
async function assertCanOpenEntry(signalData) {
  let active = ActiveSignalRegistry.getActive(signalData.symbol, signalData.timeframe);
  if (!active) {
    try {
      const openEntry = await SignalOutcomeService.findOpenEntryInDb(
        signalData.symbol,
        signalData.timeframe
      );
      if (openEntry) {
        active = ActiveSignalRegistry.registerActive(openEntry);
        logLifecycleEvent('registry_hydrate', {
          symbol: openEntry.symbol,
          timeframe: openEntry.timeframe,
          signalUuid: openEntry.signalUuid || openEntry.signalId,
          lifecycleStage: openEntry.lifecycleStage || 'ACTIVE',
          reason: 'hydrated_from_db'
        });
      }
    } catch (err) {
      console.warn('[TradeLifecycle] active-trade DB lookup failed:', err.message);
    }
  }

  if (active) {
    logLifecycleEvent('reject_duplicate_entry', {
      symbol: signalData.symbol,
      timeframe: signalData.timeframe,
      signalUuid: signalData.signalUuid,
      alertType: signalData.alertType,
      stage: active.stage || active.lifecycleStage,
      reason: 'active_trade_exists'
    });
    return {
      allowed: false,
      active,
      reason: 'active_trade_exists',
      message:
        `Active trade already open for ${signalData.symbol}` +
        (signalData.timeframe ? `:${signalData.timeframe}` : '') +
        '; new entry ignored until TP3/SL/expiry/cancel.'
    };
  }

  return { allowed: true };
}

function syncRegistryAfterTransition(signalData, updatedEntry, alertType) {
  if (isEntryAlert(alertType)) {
    const confirmed = freezeConfirmedLevels({
      ...signalData,
      lifecycleStage: signalData.lifecycleStage || STAGES.CONFIRMED
    });
    Object.assign(signalData, confirmed);
    const record = ActiveSignalRegistry.registerActive(signalData);
    logLifecycleEvent('created', {
      symbol: signalData.symbol,
      timeframe: signalData.timeframe,
      signalUuid: signalData.signalUuid || signalData.signalId,
      alertType,
      lifecycleStage: signalData.lifecycleStage,
      reason: 'entry_confirmed'
    });
    logLifecycleEvent('persisted', {
      symbol: signalData.symbol,
      timeframe: signalData.timeframe,
      signalUuid: signalData.signalUuid || signalData.signalId,
      alertType,
      lifecycleStage: signalData.lifecycleStage,
      reason: `registry=${record ? 'registered' : 'skipped'}`
    });
    return { signalData, updatedEntry, stage: signalData.lifecycleStage };
  }

  if (isPartialAlert(alertType) && updatedEntry) {
    const stage =
      signalData.lifecycleStage ||
      updatedEntry.lifecycleStage ||
      lifecycleStageFromOutcome(updatedEntry.outcome);
    ActiveSignalRegistry.updateActiveStage(
      signalData.symbol,
      stage,
      {
        signalUuid: updatedEntry.signalUuid || signalData.signalUuid,
        timeframe: signalData.timeframe || updatedEntry.timeframe
      },
      signalData.timeframe || updatedEntry.timeframe
    );
    logLifecycleEvent('updated', {
      symbol: signalData.symbol,
      timeframe: signalData.timeframe || updatedEntry.timeframe,
      signalUuid: updatedEntry.signalUuid || signalData.signalUuid,
      alertType,
      lifecycleStage: stage,
      closedReason: signalData.closedReason || outcomeFromAlertType(alertType)
    });
    return { signalData, updatedEntry, stage };
  }

  if (isTerminalAlert(alertType)) {
    const stage =
      updatedEntry?.lifecycleStage ||
      signalData.lifecycleStage ||
      lifecycleStageFromOutcome(outcomeFromAlertType(alertType));
    ActiveSignalRegistry.clearActive(
      signalData.symbol,
      signalData.closedReason || alertType,
      signalData.timeframe || updatedEntry?.timeframe
    );
    const eventName =
      alertType === 'expired'
        ? 'expired'
        : alertType === 'cancelled'
          ? 'cancelled'
          : alertType === 'stop_loss'
            ? 'sl'
            : 'tp3';
    logLifecycleEvent(eventName, {
      symbol: signalData.symbol,
      timeframe: signalData.timeframe || updatedEntry?.timeframe,
      signalUuid: updatedEntry?.signalUuid || signalData.signalUuid,
      alertType,
      lifecycleStage: stage,
      closedReason: signalData.closedReason || alertType
    });
    return { signalData, updatedEntry, stage };
  }

  if (isOutcomeAlert(alertType)) {
    logLifecycleEvent('updated', {
      symbol: signalData.symbol,
      timeframe: signalData.timeframe,
      signalUuid: signalData.signalUuid,
      alertType,
      lifecycleStage: signalData.lifecycleStage,
      reason: 'outcome_without_open_entry'
    });
  }

  return { signalData, updatedEntry, stage: signalData.lifecycleStage };
}

/**
 * Process a validated webhook signal through enrich → outcome link → registry sync.
 * Callers must still broadcast / deliver; this owns state transitions only.
 */
async function processIncomingTradeAlert(baseData, inMemorySignals = [], options = {}) {
  let signalInput = attachExpiryFields({
    ...baseData,
    timeframe: normalizeTradeTimeframe(baseData.timeframe) || baseData.timeframe || '1h'
  });
  const alertType = signalInput.alertType || 'signal';

  if (isEntryAlert(alertType)) {
    const gate = await assertCanOpenEntry(signalInput);
    if (!gate.allowed) {
      return {
        rejected: true,
        reason: gate.reason,
        message: gate.message,
        activeSignal: gate.active,
        signalData: signalInput,
        updatedEntry: null
      };
    }
  }

  const { signalData, updatedEntry, outcomeLinked } =
    await SignalOutcomeService.processSignalLifecycle(signalInput, inMemorySignals, {
      fromTradingViewWebhook: true,
      skipMarketData: true,
      ...options
    });

  // Ensure entry path always carries permanent UUID + expiry fields.
  if (isEntryAlert(alertType)) {
    const withIdentity = enrichEntrySignal(attachExpiryFields(signalData));
    Object.assign(signalData, withIdentity);
  }

  const sync = syncRegistryAfterTransition(signalData, updatedEntry, alertType);

  return {
    rejected: false,
    signalData: sync.signalData,
    updatedEntry: sync.updatedEntry,
    outcomeLinked: Boolean(outcomeLinked),
    stage: sync.stage
  };
}

/** Alias used by older call sites / tests. */
const processWebhookLifecycle = processIncomingTradeAlert;

function applyLocalOutcome(entrySignal, alertType, closedReason) {
  applyOutcomeUpdate(entrySignal, alertType, closedReason);
  logLifecycleEvent('updated', {
    symbol: entrySignal.symbol,
    timeframe: entrySignal.timeframe,
    signalUuid: entrySignal.signalUuid || entrySignal.signalId,
    alertType,
    lifecycleStage: entrySignal.lifecycleStage,
    closedReason: entrySignal.closedReason
  });
  return entrySignal;
}

function getActiveTrade(symbol, timeframe) {
  return ActiveSignalRegistry.getActive(symbol, timeframe);
}

function listActiveTrades() {
  return ActiveSignalRegistry.listActive();
}

module.exports = {
  STAGES,
  FROZEN_LEVEL_KEYS,
  isEntryAlert,
  isOutcomeAlert,
  isTerminalAlert,
  isPartialAlert,
  isForbiddenResetPayload,
  normalizeTradeTimeframe,
  logLifecycleEvent,
  logLifecycle,
  freezeConfirmedLevels,
  attachExpiryFields,
  assertCanOpenEntry,
  syncRegistryAfterTransition,
  processIncomingTradeAlert,
  processWebhookLifecycle,
  applyLocalOutcome,
  getActiveTrade,
  listActiveTrades
};
