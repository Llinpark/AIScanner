/**
 * TradingStyleClassifier — chart timeframe → trading style metadata.
 *
 * Advisory / UI / recommendations only. MUST NOT be used as a hard reject
 * gate for strategy evaluation, sweep/FVG/entry math, confidence, or risk.
 */

const { normalizeInterval } = require('./marketIntervals');

const TRADING_STYLES = Object.freeze({
  ULTRA_SCALPING: 'Ultra Scalping',
  SCALPING: 'Scalping',
  DAY_TRADING: 'Day Trading',
  SWING_TRADING: 'Swing Trading',
  POSITION_TRADING: 'Position Trading',
  UNKNOWN: 'Unknown'
});

/** Canonical app TF → trading style (single source for style mapping). */
const STYLE_BY_TF = Object.freeze({
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

/**
 * Normalize chart TF to app canonical form (1m, 15m, 1h, 1d, …).
 * Accepts Pine-style minutes ("15", "60") and common aliases.
 * @param {string|number} tf
 * @returns {string}
 */
function normalizeChartTimeframe(tf) {
  if (tf == null || tf === '') return '';
  const raw = String(tf).trim();
  if (!raw) return '';

  const aliased = normalizeInterval(raw);
  if (STYLE_BY_TF[aliased]) return aliased;

  // Pine numeric minutes / hours
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

/**
 * @param {string|number} chartTimeframe
 * @returns {string} trading style label
 */
function styleForTimeframe(chartTimeframe) {
  const canonical = normalizeChartTimeframe(chartTimeframe);
  return STYLE_BY_TF[canonical] || TRADING_STYLES.UNKNOWN;
}

/**
 * Classify chart TF into trading-style metadata (never a reject decision).
 *
 * @param {string|number} chartTimeframe - current chart / analysis TF
 * @param {object} [options]
 * @param {string} [options.entryTimeframe]
 * @param {string} [options.higherTimeframe]
 * @param {string[]} [options.preferredEntryTimeframes] - profile preferred entries (advisory)
 * @returns {{
 *   tradingStyle: string,
 *   chartTimeframe: string,
 *   entryTimeframe: string,
 *   higherTimeframe: string|null,
 *   preferredEntryTimeframes: string[],
 *   isPreferredEntryTf: boolean|null,
 *   advisoryOnly: true
 * }}
 */
function detect(chartTimeframe, options = {}) {
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

  let isPreferredEntryTf = null;
  if (preferred.length) {
    isPreferredEntryTf = preferred.includes(chartTf);
  }

  return {
    tradingStyle: styleForTimeframe(chartTf),
    chartTimeframe: chartTf || String(chartTimeframe || ''),
    entryTimeframe: entryTf || chartTf || String(chartTimeframe || ''),
    higherTimeframe: higherTf,
    preferredEntryTimeframes: preferred,
    isPreferredEntryTf,
    advisoryOnly: true
  };
}

/**
 * Classify for a live strategy profile (Scalping / Day Trading).
 * Uses profile preferred entry/HTF lists for advisory flags only.
 *
 * @param {string|number} chartTimeframe
 * @param {string} strategyKey - 'scalping' | 'daytrading'
 * @param {object} [config] - resolved strategy config
 */
function classifyForStrategy(chartTimeframe, strategyKey, config = {}) {
  let preferredEntry = Array.isArray(config.entryTimeframes) ? [...config.entryTimeframes] : [];
  let higher =
    config.htfTimeframe ||
    (Array.isArray(config.htfTimeframes) && config.htfTimeframes[0]) ||
    null;

  if (!preferredEntry.length || !higher) {
    try {
      const { getStrategyArchitecture } = require('../strategies/config/strategyArchitecture');
      const arch = getStrategyArchitecture(strategyKey);
      if (arch) {
        if (!preferredEntry.length) preferredEntry = [...arch.entryTimeframes];
        if (!higher) higher = arch.defaultHtfTimeframe;
      }
    } catch {
      /* architecture optional for pure style detect */
    }
  }

  return detect(chartTimeframe, {
    entryTimeframe: chartTimeframe,
    higherTimeframe: higher,
    preferredEntryTimeframes: preferredEntry
  });
}

/**
 * Pine expression classifying chart TF → trading style (advisory metadata only).
 * Injected into templates so style mapping stays centralized in JS.
 * @returns {string}
 */
function buildPineTradingStyleExpression() {
  return [
    'timeframe.isweekly ? "Position Trading"',
    'timeframe.isdaily ? "Position Trading"',
    'timeframe.isminutes and timeframe.multiplier == 1 ? "Ultra Scalping"',
    'timeframe.isminutes and (timeframe.multiplier == 3 or timeframe.multiplier == 5) ? "Scalping"',
    'timeframe.isminutes and (timeframe.multiplier == 15 or timeframe.multiplier == 30) ? "Day Trading"',
    'timeframe.isminutes and (timeframe.multiplier == 60 or timeframe.multiplier == 240) ? "Swing Trading"',
    '"Unknown"'
  ].join(' : ');
}

module.exports = {
  TRADING_STYLES,
  STYLE_BY_TF,
  normalizeChartTimeframe,
  styleForTimeframe,
  detect,
  classifyForStrategy,
  buildPineTradingStyleExpression
};
