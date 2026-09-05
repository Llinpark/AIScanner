const mongoose = require('mongoose');
const Signal = require('../models/Signal');
const {
  isEntryAlert,
  isOutcomeAlert,
  findEntryBySignalUuid,
  applyOutcomeUpdate,
  highestTargetReached,
  WIN_OUTCOMES
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
 * findOpenEntryInDb is NOT used on the outcome path.
 */
async function findEntryByUuidInDb(signalUuid) {
  const id = String(signalUuid || '').trim();
  if (!id || !isDbConnected()) return null;
  return Signal.findOne({
    $or: [{ signalUuid: id }, { signalId: id }, { signalGroupId: id }],
    alertType: { $in: ['entry', 'signal'] }
  }).lean();
}

/** @deprecated Slot hydrate only — NEVER use for outcome linking. Prefer findEntryByUuidInDb. */
async function findOpenEntryInDb(symbol, timeframe) {
  if (!isDbConnected()) return null;
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

function attachEphemeralFlags(doc, updated) {
  if (!doc || !updated) return doc;
  doc._outcomeIgnored = Boolean(updated._outcomeIgnored);
  doc._suppressDelivery = Boolean(updated._suppressDelivery);
  doc._outcomeIgnoreReason = updated._outcomeIgnoreReason || null;
  return doc;
}

function outcomePersistFields(updated) {
  return {
    outcome: updated.outcome,
    outcomeR: updated.outcomeR,
    tradeStatus: updated.tradeStatus,
    closedAt: updated.closedAt,
    lifecycleStage: updated.lifecycleStage,
    closedReason: updated.closedReason,
    highestMilestone: updated.highestMilestone
  };
}

function slLossFilter(entryId) {
  return {
    _id: entryId,
    $and: [
      { $or: [{ outcome: 'pending' }, { outcome: null }, { outcome: { $exists: false } }] },
      {
        $or: [
          { highestMilestone: 'pending' },
          { highestMilestone: null },
          { highestMilestone: { $exists: false } }
        ]
      }
    ]
  };
}

function tpUpgradeFilter(entryId, targetOutcome) {
  const allowed = {
    tp1: ['pending', 'sl'],
    tp2: ['pending', 'sl', 'tp1'],
    tp3: ['pending', 'sl', 'tp1', 'tp2']
  };
  const outcomes = allowed[targetOutcome] || ['pending', 'sl'];
  return {
    _id: entryId,
    $or: [{ outcome: { $in: outcomes } }, { outcome: null }, { outcome: { $exists: false } }]
  };
}

function cloneEntry(entry) {
  if (!entry) return {};
  if (typeof entry.toObject === 'function') return entry.toObject();
  return { ...entry };
}

function syncInMemory(inMemorySignals, entryId, fields, flags) {
  if (!inMemorySignals || !entryId) return;
  const idx = inMemorySignals.findIndex(s => String(s._id) === String(entryId));
  if (idx < 0) return;
  if (fields) Object.assign(inMemorySignals[idx], fields);
  attachEphemeralFlags(inMemorySignals[idx], flags);
}

async function updateEntryOutcome(entry, alertType, inMemorySignals, closedReason) {
  const entryId = entry._id || entry.id;
  let current = entry;
  if (inMemorySignals && entryId) {
    const live = inMemorySignals.find(s => String(s._id) === String(entryId));
    if (live) current = live;
  } else if (isDbConnected() && entryId && !String(entryId).startsWith('mem_')) {
    try {
      const live = await Signal.findById(entryId).lean();
      if (live) current = live;
    } catch {
      /* use caller snapshot */
    }
  }

  // In-memory: apply in-place so concurrent calls serialize on the live object.
  if (inMemorySignals && entryId && (!isDbConnected() || String(entryId).startsWith('mem_'))) {
    const idx = inMemorySignals.findIndex(s => String(s._id) === String(entryId));
    if (idx >= 0) {
      const live = inMemorySignals[idx];
      applyOutcomeUpdate(live, alertType, closedReason);
      if (!live._outcomeIgnored || live._suppressDelivery) {
        try {
          if (
            !live._suppressDelivery &&
            live.outcome &&
            ['tp1', 'tp2', 'tp3', 'sl', 'expired', 'cancelled'].includes(live.outcome)
          ) {
            scheduleRetrainOnOutcome(live.outcome);
          }
        } catch (error) {
          console.error('[SignalOutcome] scheduleRetrainOnOutcome error:', error.message);
        }
      }
      return live;
    }
  }

  const updated = cloneEntry(current);
  applyOutcomeUpdate(updated, alertType, closedReason);

  if (updated._outcomeIgnored && !updated._suppressDelivery) {
    syncInMemory(inMemorySignals, entryId, null, updated);
    return attachEphemeralFlags(cloneEntry(current), updated);
  }

  const update = outcomePersistFields(updated);
  let saved = null;

  if (isDbConnected() && entryId && !String(entryId).startsWith('mem_')) {
    if (updated._suppressDelivery && WIN_OUTCOMES.has(String(updated.outcome || ''))) {
      saved = await Signal.findOneAndUpdate(
        {
          _id: entryId,
          $or: [
            { outcome: { $in: ['tp1', 'tp2', 'tp3'] } },
            { highestMilestone: { $in: ['tp1', 'tp2', 'tp3'] } }
          ]
        },
        { $set: update },
        { new: true }
      );
      if (!saved) {
        const raced = await Signal.findById(entryId).lean();
        if (raced) {
          const closed = cloneEntry(raced);
          applyOutcomeUpdate(closed, 'stop_loss', closedReason);
          if (closed._suppressDelivery && WIN_OUTCOMES.has(String(closed.outcome || ''))) {
            saved = await Signal.findOneAndUpdate(
              {
                _id: entryId,
                $or: [
                  { outcome: { $in: ['tp1', 'tp2', 'tp3'] } },
                  { highestMilestone: { $in: ['tp1', 'tp2', 'tp3'] } }
                ]
              },
              { $set: outcomePersistFields(closed) },
              { new: true }
            );
            if (saved) {
              attachEphemeralFlags(saved, closed);
              syncInMemory(inMemorySignals, entryId, outcomePersistFields(saved), closed);
              return saved;
            }
          }
          saved = raced;
          attachEphemeralFlags(saved, closed);
        }
      } else {
        attachEphemeralFlags(saved, updated);
      }
    } else if (updated.outcome === 'sl') {
      saved = await Signal.findOneAndUpdate(slLossFilter(entryId), { $set: update }, { new: true });
      if (!saved) {
        const raced = await Signal.findById(entryId).lean();
        if (raced && highestTargetReached(raced) !== 'none') {
          const closed = cloneEntry(raced);
          applyOutcomeUpdate(closed, 'stop_loss', closedReason);
          saved = await Signal.findOneAndUpdate(
            {
              _id: entryId,
              $or: [
                { outcome: { $in: ['tp1', 'tp2', 'tp3'] } },
                { highestMilestone: { $in: ['tp1', 'tp2', 'tp3'] } }
              ]
            },
            { $set: outcomePersistFields(closed) },
            { new: true }
          );
          if (saved) {
            attachEphemeralFlags(saved, closed);
            syncInMemory(inMemorySignals, entryId, outcomePersistFields(saved), closed);
            return saved;
          }
        }
        saved = raced;
        if (saved) attachEphemeralFlags(saved, updated);
      } else {
        attachEphemeralFlags(saved, updated);
      }
    } else if (WIN_OUTCOMES.has(String(updated.outcome || ''))) {
      saved = await Signal.findOneAndUpdate(
        tpUpgradeFilter(entryId, updated.outcome),
        { $set: update },
        { new: true }
      );
      if (!saved) {
        const raced = await Signal.findById(entryId).lean();
        saved = raced;
        if (saved) attachEphemeralFlags(saved, updated);
      } else {
        attachEphemeralFlags(saved, updated);
      }
    } else {
      saved = await Signal.findByIdAndUpdate(entryId, { $set: update }, { new: true });
      if (saved) attachEphemeralFlags(saved, updated);
    }
  }

  if (saved) {
    syncInMemory(inMemorySignals, entryId, outcomePersistFields(saved), updated);
  }

  try {
    if (
      saved?.outcome &&
      !updated._suppressDelivery &&
      ['tp1', 'tp2', 'tp3', 'sl', 'expired', 'cancelled'].includes(saved.outcome)
    ) {
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

/**
 * Mark an open entry cancelled/replaced by UUID (replacement lifecycle).
 * Does not create a new document; preserves audit history.
 */
async function closeEntryAsCancelled(signalUuid, meta = {}) {
  const entry = await findEntryByUuidInDb(signalUuid);
  if (!entry) return null;
  const saved = await updateEntryOutcome(
    entry,
    'cancelled',
    null,
    meta.closedReason || 'new_confirmed_setup'
  );
  if (saved && meta.replacedBySignalUuid && isDbConnected() && (entry._id || entry.id)) {
    try {
      await Signal.findByIdAndUpdate(entry._id || entry.id, {
        replacedBySignalUuid: String(meta.replacedBySignalUuid),
        replacementReason: meta.closedReason || 'new_confirmed_setup'
      });
    } catch (err) {
      console.warn('[SignalOutcome] replacedBySignalUuid update failed:', err.message);
    }
  }
  return saved;
}

module.exports = {
  processSignalLifecycle,
  findOpenEntryInDb,
  findEntryByUuidInDb,
  updateEntryOutcome,
  closeEntryAsCancelled
};
