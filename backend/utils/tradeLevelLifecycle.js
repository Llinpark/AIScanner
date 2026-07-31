function chartLevelKey(symbol, interval) {
  return `${String(symbol || '').toUpperCase()}:${String(interval || '1h').toLowerCase()}`;
}

function isLongDirection(direction) {
  const d = String(direction || '').toLowerCase();
  return d === 'long' || d === 'buy';
}

function normalizeBarTime(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed > 1e12 ? parsed : parsed * 1000;
}

function candlesAfterActivation(candles = [], activatedAtBarTime) {
  const activationMs = normalizeBarTime(activatedAtBarTime);
  if (!activationMs) return candles;

  return candles.filter(candle => {
    const time = normalizeBarTime(candle.time ?? candle.timestamp);
    return time != null && time > activationMs;
  });
}

const TERMINAL_OUTCOMES = new Set(['tp3', 'sl', 'expired', 'cancelled']);
const PARTIAL_OUTCOMES = new Set(['tp1', 'tp2']);

/**
 * Highest milestone reached across candles after activation.
 * Partial (tp1/tp2) does NOT mean the trade should be removed from the chart.
 */
function detectTradeOutcome(level, candles = []) {
  if (!level) return null;

  const sl = Number(level.stop_loss_1 ?? level.stop_loss);
  const tp1 = Number(level.take_profit_1);
  const tp2 = Number(level.take_profit_2);
  const tp3 = Number(level.take_profit_3);
  if (!Number.isFinite(sl)) return null;

  const long = isLongDirection(level.direction);
  const relevant = candlesAfterActivation(candles, level.activatedAtBarTime);

  let best = null;
  for (const candle of relevant) {
    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

    if (long) {
      const hitSl = low <= sl;
      const hitTp3 = Number.isFinite(tp3) && high >= tp3;
      // Same-bar SL+TP3: resolve by close when both wicks print.
      if (hitSl && hitTp3) {
        if (Number.isFinite(close)) {
          if (close <= sl) return { outcome: 'sl', outcomeR: -1, terminal: true };
          if (close >= tp3) return { outcome: 'tp3', outcomeR: 3, terminal: true };
        } else {
          return { outcome: 'sl', outcomeR: -1, terminal: true };
        }
      } else if (hitSl) {
        return { outcome: 'sl', outcomeR: -1, terminal: true };
      } else if (hitTp3) {
        return { outcome: 'tp3', outcomeR: 3, terminal: true };
      }
      if (Number.isFinite(tp2) && high >= tp2) best = { outcome: 'tp2', outcomeR: 2, terminal: false };
      else if (Number.isFinite(tp1) && high >= tp1 && (!best || best.outcome === 'tp1')) {
        best = best || { outcome: 'tp1', outcomeR: 1, terminal: false };
      }
    } else {
      const hitSl = high >= sl;
      const hitTp3 = Number.isFinite(tp3) && low <= tp3;
      if (hitSl && hitTp3) {
        if (Number.isFinite(close)) {
          if (close >= sl) return { outcome: 'sl', outcomeR: -1, terminal: true };
          if (close <= tp3) return { outcome: 'tp3', outcomeR: 3, terminal: true };
        } else {
          return { outcome: 'sl', outcomeR: -1, terminal: true };
        }
      } else if (hitSl) {
        return { outcome: 'sl', outcomeR: -1, terminal: true };
      } else if (hitTp3) {
        return { outcome: 'tp3', outcomeR: 3, terminal: true };
      }
      if (Number.isFinite(tp2) && low <= tp2) best = { outcome: 'tp2', outcomeR: 2, terminal: false };
      else if (Number.isFinite(tp1) && low <= tp1 && (!best || best.outcome === 'tp1')) {
        best = best || { outcome: 'tp1', outcomeR: 1, terminal: false };
      }
    }
  }

  return best;
}

/** Only SL / TP3 / expired / cancelled — used to remove chart overlays. */
function detectTradeClose(level, candles = []) {
  const hit = detectTradeOutcome(level, candles);
  if (!hit || !hit.terminal) return null;
  return hit;
}

function isTerminalOutcome(outcome) {
  return TERMINAL_OUTCOMES.has(String(outcome || '').toLowerCase());
}

function isPartialOutcome(outcome) {
  return PARTIAL_OUTCOMES.has(String(outcome || '').toLowerCase());
}

function attachActivation(level, barTime) {
  return {
    ...level,
    activatedAtBarTime: barTime,
    tradeStatus: level.tradeStatus || 'open',
    outcome: level.outcome || 'pending',
    lifecycleStage: level.lifecycleStage || 'ACTIVE'
  };
}

module.exports = {
  chartLevelKey,
  isLongDirection,
  detectTradeOutcome,
  detectTradeClose,
  isTerminalOutcome,
  isPartialOutcome,
  attachActivation,
  candlesAfterActivation,
  TERMINAL_OUTCOMES,
  PARTIAL_OUTCOMES
};
