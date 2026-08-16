/**
 * Canonical Strategy Architecture (frontend mirror).
 * Keep in sync with backend/strategies/config/strategyArchitecture.js
 *
 * Single source of truth for Entry Timeframes + HTF Confirmation labels.
 * Does not include sweep/FVG/BOS math — architecture/layout only.
 */

export const STRATEGY_ARCHITECTURE = Object.freeze({
  scalping: Object.freeze({
    key: 'scalping',
    id: 'liquidity_sweep_fvg_scalp',
    name: 'Liquidity Sweep + Fair Value Gap (Scalping)',
    shortLabel: 'Scalping',
    entryTimeframes: Object.freeze(['1m', '3m', '5m']),
    defaultEntryTimeframe: '3m',
    canonicalSignalTimeframe: '3m',
    htfTimeframes: Object.freeze(['15m']),
    defaultHtfTimeframe: '15m',
    /** UX copy for TradingView / admin */
    entrySummary: '1m, 3m, or 5m',
    htfSummary: '15m',
    chartHint:
      'Scalping (Option A): allowed display charts are 1m, 3m, or 5m. Signals evaluate on canonical 3m with an event-safe bridge (same UUID/Entry/SL/TP/lifecycle on every allowed chart). Prefer ONE TradingView alert on 3m. 15m is HTF Confirmation via request.security. Prefer Day Trading for 15m profile settings.'
  }),
  daytrading: Object.freeze({
    key: 'daytrading',
    id: 'liquidity_sweep_fvg_daytrading',
    name: 'Liquidity Sweep + Fair Value Gap (Day Trading)',
    shortLabel: 'Day Trading',
    entryTimeframes: Object.freeze(['5m', '15m']),
    defaultEntryTimeframe: '15m',
    canonicalSignalTimeframe: '5m',
    htfTimeframes: Object.freeze(['1h', '4h']),
    defaultHtfTimeframe: '1h',
    refineHtfTimeframes: Object.freeze(['1h', '4h']),
    defaultRefineHtfTimeframe: '1h',
    entrySummary: '5m or 15m',
    htfSummary: '1H or 4H',
    chartHint:
      'Day Trading (Option A): allowed display charts are 5m or 15m. Signals evaluate on canonical 5m with an event-safe bridge (same UUID/Entry/SL/TP/lifecycle on every allowed chart; 15m does not collapse multiple 5m events). Prefer ONE TradingView alert on 5m. HTF Confirmation is 1H or 4H via request.security.'
  })
});

/** Reserved for future strategies — architecture slots only. */
export const FUTURE_STRATEGY_KEYS = Object.freeze(['swing', 'position', 'crypto', 'gold']);

export function getStrategyArchitecture(key) {
  const k = String(key || '')
    .toLowerCase()
    .trim();
  if (k === 'scalp' || k === 'liquidity_sweep_fvg_scalp') return STRATEGY_ARCHITECTURE.scalping;
  if (k === 'day' || k === 'liquidity_sweep_fvg_daytrading') {
    return STRATEGY_ARCHITECTURE.daytrading;
  }
  return STRATEGY_ARCHITECTURE[k] || null;
}

export function formatEntryHtfLine(key) {
  const arch = getStrategyArchitecture(key);
  if (!arch) return '';
  return `Entry Timeframe: ${arch.entrySummary} · HTF Confirmation: ${arch.htfSummary}`;
}
