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
  CREATED: 'CREATED',
  CONFIRMED: 'CONFIRMED',
  ACTIVE: 'ACTIVE',
  TP1: 'TP1',
  TP2: 'TP2',
  TP3: 'TP3',
  SL: 'SL',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
  COMPLETED: 'COMPLETED'
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
 * Gate new entries for the same symbol:timeframe.
 * Same UUID → idempotent replay (ignore).
 * Different UUID while active → REPLACE: close/clear old slot, allow new entry.
 * Different timeframes never block each other.
 */
async function assertCanOpenEntry(signalData) {
  let active = await ActiveSignalRegistry.getActive(signalData);
  if (!active) {
    try {
      const openEntry = await SignalOutcomeService.findOpenEntryInDb(
        signalData.symbol,
        signalData.timeframe
      );
      if (openEntry) {
        active = await ActiveSignalRegistry.registerActive(openEntry);
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
    const incomingUuid = signalData.signalUuid || signalData.signalId || signalData.signalGroupId;
    if (incomingUuid && active.signalUuid && String(incomingUuid) === String(active.signalUuid)) {
      // Option A: same canonical UUID from another allowed chartTf is still idempotent replay.
      const chartTf = signalData.chartTf || null;
      const crossTf =
        chartTf &&
        String(chartTf) !== String(signalData.timeframe || '') &&
        String(chartTf) !== String(signalData.canonicalSignalTf || '');
      const replayReason = crossTf ? 'CROSS_TF_CANONICAL_DUPLICATE' : 'same_uuid_replay';
      logLifecycleEvent('duplicate_webhook_replay', {
        symbol: signalData.symbol,
        timeframe: signalData.timeframe,
        signalUuid: incomingUuid,
        alertType: signalData.alertType,
        stage: active.stage || active.lifecycleStage,
        reason: replayReason,
        chartTf: chartTf || undefined,
        canonicalSignalTf: signalData.canonicalSignalTf || undefined,
        canonicalSignalKey: signalData.canonicalSignalKey || undefined
      });
      return {
        allowed: false,
        active,
        reason: 'duplicate_webhook_replay',
        message: `Duplicate webhook for active signalUuid ${incomingUuid}; ignored.`,
        detail: replayReason
      };
    }

    // Replace active trade with the new confirmed entry (one-trade-at-a-time preserved).
    const oldUuid = active.signalUuid || active.signalId || null;
    try {
      if (oldUuid) {
        await SignalOutcomeService.closeEntryAsCancelled(oldUuid, {
          closedReason: 'new_confirmed_setup',
          replacedBySignalUuid: incomingUuid || null
        });
      }
    } catch (err) {
      console.warn('[TradeLifecycle] replace close old entry failed:', err.message);
    }
    try {
      await ActiveSignalRegistry.clearActive(signalData);
    } catch (err) {
      console.warn('[TradeLifecycle] replace clear registry failed:', err.message);
    }

    logLifecycleEvent('replaced', {
      symbol: signalData.symbol,
      timeframe: signalData.timeframe,
      signalUuid: oldUuid,
      alertType: 'cancelled',
      lifecycleStage: STAGES.CANCELLED || 'CANCELLED',
      reason: 'new_confirmed_setup',
      replacedBySignalUuid: incomingUuid || null
    });

    return {
      allowed: true,
      replaced: true,
      previousActive: active,
      reason: 'replaced_active_trade',
      message:
        `Replaced active trade for ${signalData.symbol}` +
        (signalData.timeframe ? `:${signalData.timeframe}` : '') +
        (oldUuid ? ` (${oldUuid})` : '') +
        ' with new confirmed setup.'
    };
  }

  return { allowed: true };
}

async function syncRegistryAfterTransition(signalData, updatedEntry, alertType) {
  if (isEntryAlert(alertType)) {
    const confirmed = freezeConfirmedLevels({
      ...signalData,
      lifecycleStage: STAGES.CONFIRMED
    });
    Object.assign(signalData, confirmed);
    signalData.lifecycleStage = STAGES.ACTIVE;
    const record = await ActiveSignalRegistry.registerActive(signalData);
    logLifecycleEvent('created', {
      symbol: signalData.symbol,
      timeframe: signalData.timeframe,
      signalUuid: signalData.signalUuid || signalData.signalId,
      alertType,
      lifecycleStage: STAGES.CREATED,
      reason: 'entry_received'
    });
    logLifecycleEvent('confirmed', {
      symbol: signalData.symbol,
      timeframe: signalData.timeframe,
      signalUuid: signalData.signalUuid || signalData.signalId,
      alertType,
      lifecycleStage: STAGES.CONFIRMED,
      reason: 'levels_frozen'
    });
    logLifecycleEvent('persisted', {
      symbol: signalData.symbol,
      timeframe: signalData.timeframe,
      signalUuid: signalData.signalUuid || signalData.signalId,
      alertType,
      lifecycleStage: STAGES.ACTIVE,
      reason: `registry=${record ? 'registered' : 'skipped'}`
    });
    return { signalData, updatedEntry, stage: STAGES.ACTIVE };
  }

  if (isPartialAlert(alertType) && updatedEntry) {
    if (updatedEntry._outcomeIgnored) {
      logLifecycleEvent('outcome_ignored', {
        symbol: signalData.symbol,
        timeframe: signalData.timeframe || updatedEntry.timeframe,
        signalUuid: updatedEntry.signalUuid || signalData.signalUuid,
        alertType,
        lifecycleStage: updatedEntry.lifecycleStage,
        reason: updatedEntry._outcomeIgnoreReason || 'same_stage_replay'
      });
      return {
        signalData,
        updatedEntry,
        stage: updatedEntry.lifecycleStage
      };
    }
    const stage =
      signalData.lifecycleStage ||
      updatedEntry.lifecycleStage ||
      lifecycleStageFromOutcome(updatedEntry.outcome);
    await ActiveSignalRegistry.updateActiveStage(
      {
        symbol: signalData.symbol || updatedEntry.symbol,
        timeframe: signalData.timeframe || updatedEntry.timeframe
      },
      stage,
      {
        signalUuid: updatedEntry.signalUuid || signalData.signalUuid,
        timeframe: signalData.timeframe || updatedEntry.timeframe
      }
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
    // Conflicting/duplicate terminal webhook after lock — do not re-log a new terminal path.
    if (updatedEntry?._outcomeIgnored) {
      logLifecycleEvent('outcome_ignored', {
        symbol: signalData.symbol,
        timeframe: signalData.timeframe || updatedEntry?.timeframe,
        signalUuid: updatedEntry?.signalUuid || signalData.signalUuid,
        alertType,
        lifecycleStage: updatedEntry?.lifecycleStage || signalData.lifecycleStage,
        reason: updatedEntry._outcomeIgnoreReason || 'already_terminal',
        closedReason: updatedEntry?.closedReason || signalData.closedReason
      });
      return {
        signalData,
        updatedEntry,
        stage: updatedEntry?.lifecycleStage || signalData.lifecycleStage
      };
    }
    const stage =
      updatedEntry?.lifecycleStage ||
      signalData.lifecycleStage ||
      lifecycleStageFromOutcome(outcomeFromAlertType(alertType));
    await ActiveSignalRegistry.clearActive(
      {
        symbol: signalData.symbol,
        timeframe: signalData.timeframe || updatedEntry?.timeframe
      },
      signalData.closedReason || alertType
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
    logLifecycleEvent('completed', {
      symbol: signalData.symbol,
      timeframe: signalData.timeframe || updatedEntry?.timeframe,
      signalUuid: updatedEntry?.signalUuid || signalData.signalUuid,
      alertType,
      lifecycleStage: STAGES.COMPLETED,
      closedReason: signalData.closedReason || alertType,
      reason: `terminal=${eventName}`
    });
    if (updatedEntry) {
      updatedEntry.lifecycleStage = stage;
    }
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

  const sync = await syncRegistryAfterTransition(signalData, updatedEntry, alertType);

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
  if (entrySignal._outcomeIgnored) {
    logLifecycleEvent('outcome_ignored', {
      symbol: entrySignal.symbol,
      timeframe: entrySignal.timeframe,
      signalUuid: entrySignal.signalUuid || entrySignal.signalId,
      alertType,
      lifecycleStage: entrySignal.lifecycleStage,
      reason: entrySignal._outcomeIgnoreReason || 'already_terminal',
      closedReason: entrySignal.closedReason
    });
    return entrySignal;
  }
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

async function getActiveTrade(symbol, timeframe) {
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
