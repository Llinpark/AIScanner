const { randomUUID } = require('crypto');
const { normalizeSymbol } = require('../config/symbols');

const OUTCOME_R = {
  tp1: 1,
  tp2: 2,
  tp3: 3,
  sl: -1,
  breakeven: 0,
  expired: 0,
  cancelled: 0
};

/** Any TP hit counts as a win — never TP3-only. */
const WIN_OUTCOMES = new Set(['tp1', 'tp2', 'tp3']);
const PARTIAL_OUTCOMES = new Set(['tp1', 'tp2']);
const TERMINAL_OUTCOMES = new Set(['tp3', 'sl', 'breakeven', 'expired', 'cancelled']);
/** Latest non-pending outcome used for distinct outcome analytics. */
const DECIDED_OUTCOMES = new Set(['tp1', 'tp2', 'tp3', 'sl', 'breakeven', 'expired', 'cancelled']);
const OUTCOME_KEYS = ['tp1', 'tp2', 'tp3', 'sl', 'expired', 'cancelled'];

function isEntryAlert(alertType) {
  return alertType === 'entry' || alertType === 'signal';
}

function isOutcomeAlert(alertType) {
  return [
    'stop_loss',
    'take_profit_1',
    'take_profit_2',
    'take_profit_3',
    'expired',
    'cancelled'
  ].includes(alertType);
}

function isTerminalAlert(alertType) {
  return ['stop_loss', 'take_profit_3', 'expired', 'cancelled'].includes(alertType);
}

function isPartialAlert(alertType) {
  return alertType === 'take_profit_1' || alertType === 'take_profit_2';
}

function outcomeFromAlertType(alertType) {
  if (alertType === 'stop_loss') return 'sl';
  if (alertType === 'take_profit_1') return 'tp1';
  if (alertType === 'take_profit_2') return 'tp2';
  if (alertType === 'take_profit_3') return 'tp3';
  if (alertType === 'expired') return 'expired';
  if (alertType === 'cancelled') return 'cancelled';
  return 'pending';
}

function lifecycleStageFromOutcome(outcome) {
  if (outcome === 'tp1') return 'TP1';
  if (outcome === 'tp2') return 'TP2';
  if (outcome === 'tp3') return 'TP3';
  if (outcome === 'sl') return 'SL';
  if (outcome === 'expired') return 'EXPIRED';
  if (outcome === 'cancelled') return 'CANCELLED';
  return 'ACTIVE';
}

function isOpenTradeStatus(tradeStatus) {
  return tradeStatus === 'open' || tradeStatus === 'partial' || !tradeStatus;
}

function isOpenOutcome(outcome) {
  return (
    !outcome ||
    outcome === 'pending' ||
    PARTIAL_OUTCOMES.has(outcome)
  );
}

/**
 * Parse TradingView / human timeframe strings to milliseconds per bar.
 * Supports: 1m, 3m, 15m, 1h, 4h, 1d, and TV shorthand (1, 3, 15, 60, 240, D, W).
 */
function timeframeToMs(timeframe) {
  const raw = String(timeframe || '1h').trim().toLowerCase();
  if (!raw) return 3600000;
  if (raw === 'd' || raw === '1d' || raw === 'day') return 86400000;
  if (raw === 'w' || raw === '1w' || raw === 'week') return 604800000;
  const match = raw.match(/^(\d+)\s*([smhdw])$/);
  if (match) {
    const n = Number(match[1]);
    const unit = match[2];
    const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[unit];
    return n * mult;
  }
  const minutes = Number(raw);
  if (Number.isFinite(minutes) && minutes > 0) return minutes * 60000;
  return 3600000;
}

function parseExpiryBars(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function computeExpiresAt(timeframe, expiryBars, from = new Date()) {
  const bars = parseExpiryBars(expiryBars);
  if (bars == null) return null;
  const start = from instanceof Date ? from : new Date(from);
  if (Number.isNaN(start.getTime())) return null;
  return new Date(start.getTime() + bars * timeframeToMs(timeframe));
}

function normalizeTradeTimeframe(timeframe) {
  // Keep in sync with ActiveSignalRegistry TV period map.
  const raw = String(timeframe || '').trim();
  if (!raw) return '';
  const map = {
    '1': '1m',
    '3': '3m',
    '5': '5m',
    '15': '15m',
    '30': '30m',
    '45': '45m',
    '60': '1h',
    '120': '2h',
    '240': '4h',
    D: '1d',
    '1D': '1d',
    d: '1d',
    '1d': '1d',
    W: '1w',
    '1W': '1w',
    w: '1w',
    '1w': '1w'
  };
  if (map[raw] || map[raw.toUpperCase()] || map[raw.toLowerCase()]) {
    return map[raw] || map[raw.toUpperCase()] || map[raw.toLowerCase()];
  }
  return raw.toLowerCase();
}

function timeframesMatch(a, b) {
  const left = normalizeTradeTimeframe(a);
  const right = normalizeTradeTimeframe(b);
  if (!left || !right) return true;
  return left === right;
}

function milestoneRank(value) {
  const v = String(value || 'pending').toLowerCase();
  if (v === 'tp3') return 3;
  if (v === 'tp2') return 2;
  if (v === 'tp1') return 1;
  return 0;
}

function maxMilestone(a, b) {
  return milestoneRank(a) >= milestoneRank(b) ? a || 'pending' : b || 'pending';
}

function strategiesMatch(a, b) {
  const left = String(a || '').trim().toLowerCase();
  const right = String(b || '').trim().toLowerCase();
  if (!left || !right) return true;
  const norm = value => {
    if (value.includes('scalp')) return 'scalping';
    if (value.includes('day') || value.includes('fvg')) return 'daytrading';
    return value;
  };
  return norm(left) === norm(right);
}

function findOpenEntry(signals, symbol, timeframe, strategy) {
  const normalized = normalizeSymbol(symbol);
  const tf = timeframe != null && timeframe !== '' ? normalizeTradeTimeframe(timeframe) : null;
  const candidates = signals
    .filter(
      s =>
        normalizeSymbol(s.symbol) === normalized &&
        (!tf || timeframesMatch(s.timeframe, tf)) &&
        (!strategy ||
          strategiesMatch(
            strategy,
            s.strategyId || s.strategyName || s.strategy || s.pattern
          )) &&
        isEntryAlert(s.alertType || 'signal') &&
        isOpenTradeStatus(s.tradeStatus) &&
        isOpenOutcome(s.outcome)
    )
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return candidates[0] || null;
}

/** Prefer permanent UUID match for outcome linking (TV → backend → dashboard sync). */
function findEntryBySignalUuid(signals, signalUuid) {
  const id = String(signalUuid || '').trim();
  if (!id) return null;
  return (
    signals.find(
      s =>
        String(s.signalUuid || '') === id ||
        String(s.signalId || '') === id ||
        String(s.signalGroupId || '') === id
    ) || null
  );
}

function applyOutcomeUpdate(entrySignal, alertType, closedReason) {
  const outcome = outcomeFromAlertType(alertType);
  const outcomeR = OUTCOME_R[outcome] ?? 0;
  const terminal = TERMINAL_OUTCOMES.has(outcome) && !PARTIAL_OUTCOMES.has(outcome);

  entrySignal.outcome = outcome;
  entrySignal.outcomeR = outcomeR;
  entrySignal.lifecycleStage = lifecycleStageFromOutcome(outcome);
  entrySignal.closedReason = closedReason || outcome;

  if (WIN_OUTCOMES.has(outcome) || outcome === 'pending') {
    entrySignal.highestMilestone = maxMilestone(entrySignal.highestMilestone, outcome);
  }

  if (PARTIAL_OUTCOMES.has(outcome) && !terminal) {
    // TP1/TP2 update stage only — trade stays live until TP3/SL/expiry/cancel.
    entrySignal.tradeStatus = 'partial';
    entrySignal.closedAt = null;
  } else if (outcome === 'tp3') {
    entrySignal.tradeStatus = 'won';
    entrySignal.closedAt = new Date();
  } else if (outcome === 'sl') {
    entrySignal.tradeStatus = 'lost';
    entrySignal.closedAt = new Date();
  } else if (outcome === 'expired') {
    // Expiry after a printed TP resolves as that distinct TP outcome (not TP3-only wins).
    const hi = String(entrySignal.highestMilestone || '').toLowerCase();
    if (WIN_OUTCOMES.has(hi)) {
      entrySignal.outcome = hi;
      entrySignal.outcomeR = OUTCOME_R[hi] ?? 0;
      entrySignal.lifecycleStage = lifecycleStageFromOutcome(hi);
      // Preserve distinct TP bucket; reason records expiry provenance.
      entrySignal.closedReason = `expired_after_${hi}`;
      entrySignal.tradeStatus = 'won';
    } else {
      entrySignal.tradeStatus = 'expired';
    }
    entrySignal.closedAt = new Date();
  } else if (outcome === 'cancelled') {
    entrySignal.tradeStatus = 'cancelled';
    entrySignal.closedAt = new Date();
  } else {
    entrySignal.tradeStatus = 'closed';
    entrySignal.closedAt = new Date();
  }

  return entrySignal;
}

/**
 * Freeze permanent identity + open-trade fields on confirm.
 * Entry/SL/TPs/direction/signalId are never rewritten after this.
 */
function enrichEntrySignal(signalData) {
  const permanentId =
    signalData.signalUuid || signalData.signalId || signalData.signalGroupId || randomUUID();
  const expiryBars = parseExpiryBars(signalData.expiryBars ?? signalData.expiry_bars);
  const enableTradeExpiry =
    signalData.enableTradeExpiry === false ||
    signalData.enableTradeExpiry === 'false' ||
    signalData.enable_trade_expiry === false
      ? false
      : true;
  let expiresAt = null;
  if (signalData.expiresAt || signalData.expires_at) {
    const parsed = new Date(signalData.expiresAt || signalData.expires_at);
    if (!Number.isNaN(parsed.getTime())) expiresAt = parsed;
  } else if (enableTradeExpiry && expiryBars != null) {
    expiresAt = computeExpiresAt(signalData.timeframe, expiryBars);
  }

  const timeframe = normalizeTradeTimeframe(signalData.timeframe) || signalData.timeframe;
  return {
    ...signalData,
    signalUuid: permanentId,
    signalId: signalData.signalId || permanentId,
    signalGroupId: signalData.signalGroupId || permanentId,
    timeframe,
    lifecycleStage: signalData.lifecycleStage || 'CONFIRMED',
    highestMilestone: signalData.highestMilestone || 'pending',
    levelsFrozen: true,
    tradeStatus: 'open',
    outcome: 'pending',
    outcomeR: null,
    closedAt: null,
    closedReason: null,
    expiryBars: expiryBars ?? undefined,
    enableTradeExpiry,
    expiresAt: expiresAt || undefined
  };
}

function emptyOutcomeCounts() {
  return OUTCOME_KEYS.reduce((acc, key) => {
    acc[key] = 0;
    return acc;
  }, {});
}

function buildAnalytics(signals) {
  const entries = signals.filter(s => isEntryAlert(s.alertType || 'signal'));
  // Resolved results only — open TP1/TP2 partials are milestones, not final outcomes.
  const decided = entries.filter(s => {
    if (!DECIDED_OUTCOMES.has(s.outcome)) return false;
    if (PARTIAL_OUTCOMES.has(s.outcome) && isOpenTradeStatus(s.tradeStatus) && !s.closedAt) {
      return false;
    }
    return true;
  });
  const closed = entries.filter(s => s.outcome && TERMINAL_OUTCOMES.has(s.outcome));
  const wins = decided.filter(s => WIN_OUTCOMES.has(s.outcome));
  const losses = decided.filter(s => s.outcome === 'sl');
  const fullWins = decided.filter(s => s.outcome === 'tp3');
  const partialWins = decided.filter(s => PARTIAL_OUTCOMES.has(s.outcome));
  const totalR = decided.reduce((sum, s) => sum + (Number(s.outcomeR) || 0), 0);

  const outcomeCounts = emptyOutcomeCounts();
  for (const signal of decided) {
    if (Object.prototype.hasOwnProperty.call(outcomeCounts, signal.outcome)) {
      outcomeCounts[signal.outcome] += 1;
    }
  }
  const outcomeRates = {};
  for (const key of OUTCOME_KEYS) {
    outcomeRates[key] = decided.length
      ? Math.round((outcomeCounts[key] / decided.length) * 100)
      : 0;
  }

  const holdTimes = closed
    .map(s => {
      if (!s.closedAt || !s.createdAt) return null;
      const ms = new Date(s.closedAt) - new Date(s.createdAt);
      return Number.isFinite(ms) && ms >= 0 ? ms : null;
    })
    .filter(v => v != null);
  const avgHoldTimeMs = holdTimes.length
    ? Math.round(holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length)
    : null;

  function groupStats(keyFn, labelFn) {
    const map = {};
    for (const signal of decided) {
      const key = keyFn(signal) || 'unknown';
      if (!map[key]) {
        map[key] = {
          key,
          label: labelFn(signal, key),
          total: 0,
          wins: 0,
          losses: 0,
          tp1: 0,
          tp2: 0,
          tp3: 0,
          sl: 0,
          expired: 0,
          cancelled: 0,
          totalR: 0
        };
      }
      map[key].total += 1;
      if (WIN_OUTCOMES.has(signal.outcome)) map[key].wins += 1;
      if (signal.outcome === 'sl') map[key].losses += 1;
      if (Object.prototype.hasOwnProperty.call(map[key], signal.outcome)) {
        map[key][signal.outcome] += 1;
      }
      map[key].totalR += Number(signal.outcomeR) || 0;
    }
    return Object.values(map).map(row => ({
      ...row,
      winRate: row.total ? Math.round((row.wins / row.total) * 100) : 0,
      avgR: row.total ? Number((row.totalR / row.total).toFixed(2)) : 0
    }));
  }

  const byPattern = {};
  for (const signal of decided) {
    const key = signal.strategyName || signal.pattern || 'unknown';
    if (!byPattern[key]) {
      byPattern[key] = {
        pattern: key,
        label: signal.strategyName || signal.patternLabel || key,
        total: 0,
        wins: 0,
        losses: 0,
        tp1: 0,
        tp2: 0,
        tp3: 0,
        sl: 0,
        expired: 0,
        cancelled: 0,
        totalR: 0
      };
    }
    byPattern[key].total += 1;
    if (WIN_OUTCOMES.has(signal.outcome)) byPattern[key].wins += 1;
    if (signal.outcome === 'sl') byPattern[key].losses += 1;
    if (Object.prototype.hasOwnProperty.call(byPattern[key], signal.outcome)) {
      byPattern[key][signal.outcome] += 1;
    }
    byPattern[key].totalR += Number(signal.outcomeR) || 0;
  }

  const patternStats = Object.values(byPattern).map(row => ({
    ...row,
    winRate: row.total ? Math.round((row.wins / row.total) * 100) : 0,
    avgR: row.total ? Number((row.totalR / row.total).toFixed(2)) : 0
  }));

  const byPair = groupStats(
    s => s.symbol,
    (s, key) => key
  );
  const byTimeframe = groupStats(
    s => s.timeframe || '1h',
    (s, key) => key
  );
  const byStrategy = groupStats(
    s => s.strategyName || s.strategy || s.pattern || 'TradingView',
    (s, key) => s.strategyName || s.patternLabel || key
  );

  const sessionOf = createdAt => {
    const hour = new Date(createdAt).getUTCHours();
    if (hour >= 0 && hour < 7) return 'Asia';
    if (hour >= 7 && hour < 12) return 'London';
    if (hour >= 12 && hour < 17) return 'New York';
    return 'Late';
  };
  const bySession = groupStats(
    s => sessionOf(s.createdAt),
    (s, key) => key
  );

  const confidenceBuckets = {};
  for (const signal of decided) {
    const pct = Math.round((Number(signal.confidence) || 0) * 100);
    const bucket = pct >= 80 ? '80-100' : pct >= 60 ? '60-79' : pct >= 40 ? '40-59' : '0-39';
    if (!confidenceBuckets[bucket]) {
      confidenceBuckets[bucket] = { bucket, total: 0, wins: 0 };
    }
    confidenceBuckets[bucket].total += 1;
    if (WIN_OUTCOMES.has(signal.outcome)) confidenceBuckets[bucket].wins += 1;
  }
  const confidenceVsWinRate = Object.values(confidenceBuckets)
    .map(row => ({
      ...row,
      winRate: row.total ? Math.round((row.wins / row.total) * 100) : 0
    }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));

  const byDay = {};
  for (const signal of decided) {
    const day = new Date(signal.closedAt || signal.createdAt).toISOString().slice(0, 10);
    if (!byDay[day]) {
      byDay[day] = {
        date: day,
        closed: 0,
        wins: 0,
        losses: 0,
        tp1: 0,
        tp2: 0,
        tp3: 0,
        sl: 0,
        expired: 0,
        cancelled: 0,
        totalR: 0
      };
    }
    byDay[day].closed += 1;
    if (WIN_OUTCOMES.has(signal.outcome)) byDay[day].wins += 1;
    if (signal.outcome === 'sl') byDay[day].losses += 1;
    if (Object.prototype.hasOwnProperty.call(byDay[day], signal.outcome)) {
      byDay[day][signal.outcome] += 1;
    }
    byDay[day].totalR += Number(signal.outcomeR) || 0;
  }

  const timeseries = Object.values(byDay)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(row => ({
      ...row,
      winRate: row.closed ? Math.round((row.wins / row.closed) * 100) : 0
    }));

  let cumulativeR = 0;
  const equityCurve = timeseries.map(row => {
    cumulativeR += row.totalR;
    return { date: row.date, cumulativeR: Number(cumulativeR.toFixed(2)) };
  });

  return {
    focus: 'signal_performance',
    totalEntries: entries.length,
    openTrades: entries.filter(s => isOpenTradeStatus(s.tradeStatus) && isOpenOutcome(s.outcome)).length,
    closedTrades: closed.length,
    decidedTrades: decided.length,
    wins: wins.length,
    losses: losses.length,
    expired: outcomeCounts.expired,
    cancelled: outcomeCounts.cancelled,
    tp1: outcomeCounts.tp1,
    tp2: outcomeCounts.tp2,
    tp3: outcomeCounts.tp3,
    fullWins: fullWins.length,
    partialWins: partialWins.length,
    outcomeCounts,
    /** Alias — TP1/TP2/TP3/SL/Expired/Cancelled are counted distinctly. */
    outcomeBreakdown: outcomeCounts,
    outcomeRates,
    // Win rate among decided trades; wins = any TP hit (tp1|tp2|tp3), not TP3-only.
    winRate: decided.length ? Math.round((wins.length / decided.length) * 100) : 0,
    totalR: Number(totalR.toFixed(2)),
    avgR: decided.length ? Number((totalR / decided.length).toFixed(2)) : 0,
    avgHoldTimeMs,
    patternStats,
    byPair,
    byTimeframe,
    byStrategy,
    bySession,
    confidenceVsWinRate,
    successByDay: timeseries,
    timeseries,
    equityCurve
  };
}

module.exports = {
  normalizeSymbol,
  normalizeTradeTimeframe,
  timeframesMatch,
  isEntryAlert,
  isOutcomeAlert,
  isTerminalAlert,
  isPartialAlert,
  outcomeFromAlertType,
  findOpenEntry,
  findEntryBySignalUuid,
  strategiesMatch,
  applyOutcomeUpdate,
  enrichEntrySignal,
  buildAnalytics,
  lifecycleStageFromOutcome,
  timeframeToMs,
  parseExpiryBars,
  computeExpiresAt,
  OUTCOME_R,
  WIN_OUTCOMES,
  PARTIAL_OUTCOMES,
  TERMINAL_OUTCOMES,
  DECIDED_OUTCOMES,
  OUTCOME_KEYS
};
