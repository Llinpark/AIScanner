const Signal = require('../models/Signal');
const { isEntryAlert } = require('./signalOutcome');

function buildEntryFingerprint(signal) {
  return [
    String(signal.symbol || '').toUpperCase(),
    String(signal.direction || '').toLowerCase(),
    Number(signal.entry || 0).toFixed(5),
    Number(signal.stop_loss || 0).toFixed(5),
    Number(signal.take_profit_1 || 0).toFixed(5)
  ].join('|');
}

async function findDuplicateEntries({ limit = 5000 } = {}) {
  const entries = await Signal.find({
    alertType: { $in: ['entry', 'signal'] }
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

  const groups = new Map();
  for (const signal of entries) {
    const key = buildEntryFingerprint(signal);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(signal);
  }

  const duplicateGroups = [];
  let duplicateCount = 0;

  for (const [key, items] of groups) {
    if (items.length <= 1) continue;
    duplicateGroups.push({
      key,
      total: items.length,
      keepId: items[0]._id.toString(),
      removeIds: items.slice(1).map(item => item._id.toString()),
      sample: {
        symbol: items[0].symbol,
        direction: items[0].direction,
        createdAt: items[0].createdAt
      }
    });
    duplicateCount += items.length - 1;
  }

  return { duplicateGroups, duplicateCount, scanned: entries.length };
}

async function dedupeEntries({ dryRun = true, limit = 5000 } = {}) {
  const { duplicateGroups, duplicateCount, scanned } = await findDuplicateEntries({ limit });
  const removeIds = duplicateGroups.flatMap(group => group.removeIds);

  if (!dryRun && removeIds.length) {
    await Signal.deleteMany({ _id: { $in: removeIds } });
  }

  return {
    dryRun,
    scanned,
    duplicateCount,
    removed: dryRun ? 0 : removeIds.length,
    groups: duplicateGroups.length
  };
}

async function closeStaleOpenEntries({ olderThanDays = 30, dryRun = true, limit = 5000 } = {}) {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const filter = {
    alertType: { $in: ['entry', 'signal'] },
    $or: [{ outcome: 'pending' }, { outcome: { $exists: false } }],
    createdAt: { $lt: cutoff }
  };

  const stale = await Signal.find(filter)
    .select('_id symbol createdAt outcome')
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

  if (!dryRun && stale.length) {
    await Signal.updateMany(
      { _id: { $in: stale.map(item => item._id) } },
      {
        $set: {
          outcome: 'breakeven',
          outcomeR: 0,
          tradeStatus: 'closed',
          closedAt: new Date(),
          notes: '[admin] Auto-closed stale open entry'
        }
      }
    );
  }

  return {
    dryRun,
    olderThanDays,
    matched: stale.length,
    closed: dryRun ? 0 : stale.length,
    sample: stale.slice(0, 5).map(item => ({
      id: item._id.toString(),
      symbol: item.symbol,
      createdAt: item.createdAt
    }))
  };
}

function buildSignalFilter(query = {}) {
  const filter = {};

  if (query.symbol) {
    filter.symbol = { $regex: String(query.symbol).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  }

  if (query.pattern) {
    filter.pattern = query.pattern;
  }

  if (query.outcome) {
    if (query.outcome === 'open') {
      filter.$or = [{ outcome: 'pending' }, { outcome: { $exists: false } }];
    } else {
      filter.outcome = query.outcome;
    }
  }

  if (query.alertType) {
    filter.alertType = query.alertType;
  } else if (query.entriesOnly === 'true' || query.entriesOnly === true) {
    filter.alertType = { $in: ['entry', 'signal'] };
  }

  if (query.source) {
    filter.source = query.source;
  }

  return filter;
}

function serializeSignal(signal) {
  return {
    id: signal._id?.toString(),
    symbol: signal.symbol,
    direction: signal.direction,
    entry: signal.entry,
    stop_loss: signal.stop_loss,
    take_profit_1: signal.take_profit_1,
    confidence: signal.confidence,
    pipelineScore: signal.pipelineScore,
    alertType: signal.alertType,
    pattern: signal.pattern,
    patternLabel: signal.patternLabel,
    source: signal.source,
    outcome: signal.outcome || 'pending',
    tradeStatus: signal.tradeStatus || 'open',
    isBroadcast: Boolean(signal.isBroadcast),
    signalGroupId: signal.signalGroupId,
    userId: signal.userId,
    createdAt: signal.createdAt,
    closedAt: signal.closedAt
  };
}

function applyManualOutcomeUpdate(outcome) {
  const allowed = new Set(['pending', 'tp1', 'tp2', 'tp3', 'sl', 'breakeven']);
  if (!allowed.has(outcome)) {
    throw new Error('Invalid outcome value.');
  }

  if (outcome === 'pending') {
    return {
      outcome: 'pending',
      outcomeR: null,
      tradeStatus: 'open',
      closedAt: null
    };
  }

  const outcomeR = { tp1: 1, tp2: 2, tp3: 3, sl: -1, breakeven: 0 }[outcome];
  const tradeStatus = ['tp1', 'tp2', 'tp3'].includes(outcome) ? 'won' : outcome === 'sl' ? 'lost' : 'closed';

  return {
    outcome,
    outcomeR,
    tradeStatus,
    closedAt: new Date()
  };
}

module.exports = {
  buildSignalFilter,
  serializeSignal,
  findDuplicateEntries,
  dedupeEntries,
  closeStaleOpenEntries,
  applyManualOutcomeUpdate,
  isEntryAlert
};
