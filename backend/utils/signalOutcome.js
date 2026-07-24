const { randomUUID } = require('crypto');
const { normalizeSymbol } = require('../config/symbols');

const OUTCOME_R = {
  tp1: 1,
  tp2: 2,
  tp3: 3,
  sl: -1,
  breakeven: 0
};

const WIN_OUTCOMES = new Set(['tp1', 'tp2', 'tp3']);

function isEntryAlert(alertType) {
  return alertType === 'entry' || alertType === 'signal';
}

function isOutcomeAlert(alertType) {
  return ['stop_loss', 'take_profit_1', 'take_profit_2', 'take_profit_3'].includes(alertType);
}

function outcomeFromAlertType(alertType) {
  if (alertType === 'stop_loss') return 'sl';
  if (alertType === 'take_profit_1') return 'tp1';
  if (alertType === 'take_profit_2') return 'tp2';
  if (alertType === 'take_profit_3') return 'tp3';
  return 'pending';
}

function findOpenEntry(signals, symbol) {
  const normalized = normalizeSymbol(symbol);
  const candidates = signals
    .filter(
      s =>
        normalizeSymbol(s.symbol) === normalized &&
        isEntryAlert(s.alertType || 'signal') &&
        (s.tradeStatus === 'open' || !s.tradeStatus) &&
        (s.outcome === 'pending' || !s.outcome)
    )
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return candidates[0] || null;
}

function applyOutcomeUpdate(entrySignal, alertType) {
  const outcome = outcomeFromAlertType(alertType);
  const outcomeR = OUTCOME_R[outcome] ?? 0;
  const tradeStatus = WIN_OUTCOMES.has(outcome) ? 'won' : outcome === 'sl' ? 'lost' : 'closed';

  entrySignal.outcome = outcome;
  entrySignal.outcomeR = outcomeR;
  entrySignal.tradeStatus = tradeStatus;
  entrySignal.closedAt = new Date();

  return entrySignal;
}

function enrichEntrySignal(signalData) {
  return {
    ...signalData,
    signalGroupId: signalData.signalGroupId || randomUUID(),
    tradeStatus: 'open',
    outcome: 'pending',
    outcomeR: null,
    closedAt: null
  };
}

function buildAnalytics(signals) {
  const entries = signals.filter(s => isEntryAlert(s.alertType || 'signal'));
  const closed = entries.filter(s => s.outcome && s.outcome !== 'pending');
  const wins = closed.filter(s => WIN_OUTCOMES.has(s.outcome));
  const losses = closed.filter(s => s.outcome === 'sl');
  const totalR = closed.reduce((sum, s) => sum + (Number(s.outcomeR) || 0), 0);

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
    for (const signal of closed) {
      const key = keyFn(signal) || 'unknown';
      if (!map[key]) {
        map[key] = { key, label: labelFn(signal, key), total: 0, wins: 0, losses: 0, totalR: 0 };
      }
      map[key].total += 1;
      if (WIN_OUTCOMES.has(signal.outcome)) map[key].wins += 1;
      if (signal.outcome === 'sl') map[key].losses += 1;
      map[key].totalR += Number(signal.outcomeR) || 0;
    }
    return Object.values(map).map(row => ({
      ...row,
      winRate: row.total ? Math.round((row.wins / row.total) * 100) : 0,
      avgR: row.total ? Number((row.totalR / row.total).toFixed(2)) : 0
    }));
  }

  const byPattern = {};
  for (const signal of closed) {
    const key = signal.strategyName || signal.pattern || 'unknown';
    if (!byPattern[key]) {
      byPattern[key] = {
        pattern: key,
        label: signal.strategyName || signal.patternLabel || key,
        total: 0,
        wins: 0,
        losses: 0,
        totalR: 0
      };
    }
    byPattern[key].total += 1;
    if (WIN_OUTCOMES.has(signal.outcome)) byPattern[key].wins += 1;
    if (signal.outcome === 'sl') byPattern[key].losses += 1;
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
  for (const signal of closed) {
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
  for (const signal of closed) {
    const day = new Date(signal.closedAt || signal.createdAt).toISOString().slice(0, 10);
    if (!byDay[day]) byDay[day] = { date: day, closed: 0, wins: 0, losses: 0, totalR: 0 };
    byDay[day].closed += 1;
    if (WIN_OUTCOMES.has(signal.outcome)) byDay[day].wins += 1;
    if (signal.outcome === 'sl') byDay[day].losses += 1;
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
    openTrades: entries.filter(s => !s.outcome || s.outcome === 'pending').length,
    closedTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? Math.round((wins.length / closed.length) * 100) : 0,
    totalR: Number(totalR.toFixed(2)),
    avgR: closed.length ? Number((totalR / closed.length).toFixed(2)) : 0,
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
  isEntryAlert,
  isOutcomeAlert,
  findOpenEntry,
  applyOutcomeUpdate,
  enrichEntrySignal,
  buildAnalytics,
  OUTCOME_R,
  WIN_OUTCOMES
};
