const mongoose = require('mongoose');
const Signal = require('../models/Signal');
const {
  isEntryAlert,
  isOutcomeAlert,
  findEntryBySignalUuid,
  applyOutcomeUpdate
} = require('../utils/signalOutcome');
const {
  enrichSignal,
  enrichFromTradingViewWebhook
} = require('../services/SignalEnrichmentService');
const { scheduleRetrainOnOutcome } = require('./WeightLearningService');

function isDbConnected() {
  return mongoose.connection.readyState === 1;
}

/**
 * Outcome linking is UUID-only (spec). Never match by symbol/timeframe/latest.
 */
async function findEntryByUuidInDb(signalUuid) {
  const id = String(signalUuid || '').trim();
  if (!id || !isDbConnected()) return null;
  return Signal.findOne({
    $or: [{ signalUuid: id }, { signalId: id }, { signalGroupId: id }],
    alertType: { $in: ['entry', 'signal'] }
  }).lean();
}

/** @deprecated Prefer findEntryByUuidInDb — kept for registry hydrate only. */
async function findOpenEntryInDb(symbol, timeframe) {
  const { normalizeSymbol } = require('../utils/signalOutcome');
  const { normalizeTimeframe } = require('../utils/activeSignalRegistry');
  const normalized = normalizeSymbol(symbol);
  const compact = normalized.replace('/', '');
  const tf =
    timeframe != null && timeframe !== '' ? normalizeTimeframe(timeframe) : null;

  const query = {
    alertType: { $in: ['entry', 'signal'] },
    tradeStatus: { $in: ['open', 'partial'] },
    symbol: { $regex: compact.replace('/', ''), $options: 'i' }
  };
  if (tf) query.timeframe = { $regex: new RegExp(`^${tf}$`, 'i') };

  return Signal.findOne(query).sort({ createdAt: -1 }).lean();
}

async function updateEntryOutcome(entry, alertType, inMemorySignals, closedReason) {
  const entryId = entry._id || entry.id;
  const updated = { ...entry };
  applyOutcomeUpdate(updated, alertType, closedReason);
  const update = {
    outcome: updated.outcome,
    outcomeR: updated.outcomeR,
    tradeStatus: updated.tradeStatus,
    closedAt: updated.closedAt,
    lifecycleStage: updated.lifecycleStage,
    closedReason: updated.closedReason,
    highestMilestone: updated.highestMilestone
  };

  let saved = null;
  if (isDbConnected() && entryId) {
    saved = await Signal.findByIdAndUpdate(entryId, update, { new: true });
  } else if (inMemorySignals && entryId) {
    const idx = inMemorySignals.findIndex(s => String(s._id) === String(entryId));
    if (idx >= 0) {
      Object.assign(inMemorySignals[idx], update);
      saved = inMemorySignals[idx];
    }
  }

  try {
    if (saved?.outcome && ['tp1', 'tp2', 'tp3', 'sl', 'expired', 'cancelled'].includes(saved.outcome)) {
      scheduleRetrainOnOutcome(saved.outcome);
    }
  } catch (error) {
    console.error('[SignalOutcome] scheduleRetrainOnOutcome error:', error.message);
  }

  return saved;
}

async function processSignalLifecycle(rawSignalData, inMemorySignals = [], options = {}) {
  const fromTradingViewWebhook = Boolean(
    options.fromTradingViewWebhook || options.skipMarketData
  );
  const signalData = fromTradingViewWebhook
    ? await enrichFromTradingViewWebhook(rawSignalData, {
        fromTradingViewWebhook: true,
        ...options
      })
    : await enrichSignal(rawSignalData, options);
  const alertType = signalData.alertType || 'signal';

  if (isOutcomeAlert(alertType)) {
    const uuid = signalData.signalUuid || signalData.signalId || signalData.signalGroupId;
    if (!uuid) {
      console.warn(
        '[SignalOutcome] Outcome alert missing signalUuid/signalId — ignored (UUID-only linking)'
      );
      return { signalData, updatedEntry: null, outcomeLinked: false };
    }

    let entry = null;
    if (isDbConnected()) {
      entry = await findEntryByUuidInDb(uuid);
    } else {
      entry = findEntryBySignalUuid(inMemorySignals, uuid);
    }

    if (!entry) {
      console.warn(`[SignalOutcome] No parent entry for signalUuid=${uuid}`);
      return { signalData, updatedEntry: null, outcomeLinked: false };
    }

    const entryId = entry._id || entry.id;
    signalData.parentSignalId = entryId;
    signalData.signalGroupId = entry.signalGroupId || entry.signalUuid || uuid;
    signalData.signalUuid = entry.signalUuid || uuid;
    signalData.signalId = signalData.signalUuid;
    signalData.timeframe = signalData.timeframe || entry.timeframe;
    signalData.symbol = entry.symbol || signalData.symbol;

    const updatedEntry = await updateEntryOutcome(
      entry,
      alertType,
      inMemorySignals,
      signalData.closedReason
    );
    return { signalData, updatedEntry, outcomeLinked: true };
  }

  if (isEntryAlert(alertType)) {
    return { signalData, updatedEntry: null, outcomeLinked: false };
  }

  return { signalData, updatedEntry: null, outcomeLinked: false };
}

module.exports = {
  processSignalLifecycle,
  findOpenEntryInDb,
  findEntryByUuidInDb,
  updateEntryOutcome
};
