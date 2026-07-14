const mongoose = require('mongoose');
const Signal = require('../models/Signal');
const {
  isEntryAlert,
  isOutcomeAlert,
  findOpenEntry,
  applyOutcomeUpdate,
  normalizeSymbol
} = require('../utils/signalOutcome');
const { enrichSignal } = require('../services/SignalEnrichmentService');

function isDbConnected() {
  return mongoose.connection.readyState === 1;
}

async function findOpenEntryInDb(symbol) {
  const normalized = normalizeSymbol(symbol);
  const compact = normalized.replace('/', '');

  const signals = await Signal.find({
    alertType: { $in: ['entry', 'signal'] },
    $or: [{ outcome: 'pending' }, { outcome: { $exists: false } }],
    symbol: { $regex: compact.replace('/', ''), $options: 'i' }
  })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  return findOpenEntry(signals, symbol);
}

async function updateEntryOutcome(entry, alertType, inMemorySignals) {
  const entryId = entry._id || entry.id;
  const updated = { ...entry };
  applyOutcomeUpdate(updated, alertType);
  const update = {
    outcome: updated.outcome,
    outcomeR: updated.outcomeR,
    tradeStatus: updated.tradeStatus,
    closedAt: updated.closedAt
  };

  if (isDbConnected() && entryId) {
    return Signal.findByIdAndUpdate(entryId, update, { new: true });
  }

  if (inMemorySignals && entryId) {
    const idx = inMemorySignals.findIndex(s => String(s._id) === String(entryId));
    if (idx >= 0) {
      Object.assign(inMemorySignals[idx], update);
      return inMemorySignals[idx];
    }
  }

  return null;
}

async function processSignalLifecycle(rawSignalData, inMemorySignals = []) {
  const signalData = await enrichSignal(rawSignalData);
  const alertType = signalData.alertType || 'signal';

  if (isOutcomeAlert(alertType)) {
    let entry = null;

    if (isDbConnected()) {
      entry = await findOpenEntryInDb(signalData.symbol);
    } else {
      entry = findOpenEntry(inMemorySignals, signalData.symbol);
    }

    if (entry) {
      const entryId = entry._id || entry.id;
      signalData.parentSignalId = entryId;
      signalData.signalGroupId = entry.signalGroupId || signalData.signalGroupId;

      const updatedEntry = await updateEntryOutcome(entry, alertType, inMemorySignals);
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
