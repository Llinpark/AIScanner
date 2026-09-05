/**
 * Trading style classification from chart timeframe (frontend mirror).
 * Keep in sync with backend/utils/TradingStyleClassifier.js
 *
 * Advisory / UI only — does not gate strategy evaluation.
 */

/** Local aliases — keep aligned with backend TradingStyleClassifier / marketIntervals. */
const INTERVAL_ALIASES = Object.freeze({
  '1m': '1m',
  '1min': '1m',
  M1: '1m',
  '3m': '3m',
  '3min': '3m',
  M3: '3m',
  '5m': '5m',
  '5min': '5m',
  M5: '5m',
  '15m': '15m',
  '15min': '15m',
  M15: '15m',
  '30m': '30m',
  '30min': '30m',
  M30: '30m',
  '1h': '1h',
  '60min': '1h',
  H1: '1h',
  '4h': '4h',
  H4: '4h',
  '1D': '1d',
  '1d': '1d',
  '1day': '1d',
  D1: '1d',
  '1W': '1w',
  '1w': '1w',
  '1week': '1w',
  W1: '1w',
  '1M': '1M',
  '1month': '1M'
});

function normalizeInterval(interval) {
  const raw = String(interval || '').trim();
  return INTERVAL_ALIASES[raw] || INTERVAL_ALIASES[raw.toLowerCase()] || raw;
}

export const TRADING_STYLES = Object.freeze({
  ULTRA_SCALPING: 'Ultra Scalping',
  SCALPING: 'Scalping',
  DAY_TRADING: 'Day Trading',
  SWING_TRADING: 'Swing Trading',
  POSITION_TRADING: 'Position Trading',
  UNKNOWN: 'Unknown'
});

export const STYLE_BY_TF = Object.freeze({
  '1m': TRADING_STYLES.ULTRA_SCALPING,
  '3m': TRADING_STYLES.SCALPING,
  '5m': TRADING_STYLES.SCALPING,
  '15m': TRADING_STYLES.DAY_TRADING,
  '30m': TRADING_STYLES.DAY_TRADING,
  '1h': TRADING_STYLES.SWING_TRADING,
  '4h': TRADING_STYLES.SWING_TRADING,
  '1d': TRADING_STYLES.POSITION_TRADING,
  '1w': TRADING_STYLES.POSITION_TRADING,
  '1M': TRADING_STYLES.POSITION_TRADING
});

export function normalizeChartTimeframe(tf) {
  if (tf == null || tf === '') return '';
  const raw = String(tf).trim();
  if (!raw) return '';
  const aliased = normalizeInterval(raw);
  if (STYLE_BY_TF[aliased]) return aliased;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return aliased || raw;
    if (n < 60) return normalizeInterval(`${n}m`);
    if (n % 1440 === 0) return normalizeInterval(`${n / 1440}d`);
    if (n % 60 === 0) return normalizeInterval(`${n / 60}h`);
    return normalizeInterval(`${n}m`);
  }
  const lower = raw.toLowerCase();
  if (lower === 'daily' || lower === 'day' || lower === 'd') return '1d';
  if (lower === 'weekly' || lower === 'week' || lower === 'w') return '1w';
  if (lower === 'monthly' || lower === 'month') return '1M';
  return aliased || raw;
}

export function styleForTimeframe(chartTimeframe) {
  const canonical = normalizeChartTimeframe(chartTimeframe);
  return STYLE_BY_TF[canonical] || TRADING_STYLES.UNKNOWN;
}

export function detect(chartTimeframe, options = {}) {
  const chartTf = normalizeChartTimeframe(chartTimeframe);
  const entryTf = normalizeChartTimeframe(
    options.entryTimeframe != null && options.entryTimeframe !== ''
      ? options.entryTimeframe
      : chartTimeframe
  );
  const higherTf =
    options.higherTimeframe != null && options.higherTimeframe !== ''
      ? normalizeChartTimeframe(options.higherTimeframe)
      : null;
  const preferred = Array.isArray(options.preferredEntryTimeframes)
    ? options.preferredEntryTimeframes.map(normalizeChartTimeframe).filter(Boolean)
    : [];

  return {
    tradingStyle: styleForTimeframe(chartTf),
    chartTimeframe: chartTf || String(chartTimeframe || ''),
    entryTimeframe: entryTf || chartTf || String(chartTimeframe || ''),
    higherTimeframe: higherTf,
    preferredEntryTimeframes: preferred,
    isPreferredEntryTf: preferred.length ? preferred.includes(chartTf) : null,
    advisoryOnly: true
  };
}
