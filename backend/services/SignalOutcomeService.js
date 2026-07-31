const mongoose = require('mongoose');
const Signal = require('../models/Signal');
const {
  isEntryAlert,
  isOutcomeAlert,
  findOpenEntry,
  applyOutcomeUpdate,
  normalizeSymbol
} = require('../utils/signalOutcome');
const {
  enrichSignal,
  enrichFromTradingViewWebhook
} = require('../services/SignalEnrichmentService');
const { scheduleRetrainOnOutcome } = require('./WeightLearningService');

function isDbConnected() {
  return mongoose.connection.readyState === 1;
}

async function findOpenEntryInDb(symbol, timeframe) {
  const normalized = normalizeSymbol(symbol);
  const compact = normalized.replace('/', '');
  const tf = timeframe != null && timeframe !== ''
    ? String(timeframe).trim().toLowerCase()
    : null;

  const query = {
    alertType: { $in: ['entry', 'signal'] },
    tradeStatus: { $in: ['open', 'partial'] },
    $or: [
      { outcome: 'pending' },
      { outcome: { $exists: false } },
      { outcome: null },
      { outcome: 'tp1' },
      { outcome: 'tp2' }
    ],
    symbol: { $regex: compact.replace('/', ''), $options: 'i' }
  };

  if (tf) {
    query.timeframe = { $regex: new RegExp(`^${tf}$`, 'i') };
  }

  const signals = await Signal.find(query)
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  return findOpenEntry(signals, symbol, timeframe);
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

  // Debounced weight retrain on terminal closes (never throws into scanner path).
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
    let entry = null;

    if (isDbConnected()) {
      entry = await findOpenEntryInDb(signalData.symbol, signalData.timeframe);
    } else {
      entry = findOpenEntry(inMemorySignals, signalData.symbol, signalData.timeframe);
    }

    if (entry) {
      const entryId = entry._id || entry.id;
      signalData.parentSignalId = entryId;
      signalData.signalGroupId = entry.signalGroupId || entry.signalUuid || signalData.signalGroupId;
      signalData.signalUuid = entry.signalUuid || signalData.signalUuid || signalData.signalId;
      signalData.signalId = signalData.signalUuid;
      // Never rewrite frozen levels from an outcome webhook onto the parent entry.
      signalData.timeframe = signalData.timeframe || entry.timeframe;

      const updatedEntry = await updateEntryOutcome(
        entry,
        alertType,
        inMemorySignals,
        signalData.closedReason
      );
      return { signalData, updatedEntry, outcomeLinked: true };
    }
  }

  if (isEntryAlert(alertType)) {
    return { signalData, updatedEntry: null, outcomeLinked: false };
  }

  return { signalData, updatedEntry: null, outcomeLinked: false };
}

module.exports = {
  processSignalLifecycle,
  findOpenEntryInDb,
  updateEntryOutcome
};
