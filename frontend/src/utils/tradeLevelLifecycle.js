export function isLongDirection(direction) {
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
 * Partial (tp1/tp2) keeps the trade overlay alive until a terminal close.
 */
export function detectTradeOutcome(level, candles = []) {
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
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

    if (long) {
      if (low <= sl) return { outcome: 'sl', outcomeR: -1, terminal: true };
      if (Number.isFinite(tp3) && high >= tp3) return { outcome: 'tp3', outcomeR: 3, terminal: true };
      if (Number.isFinite(tp2) && high >= tp2) best = { outcome: 'tp2', outcomeR: 2, terminal: false };
      else if (Number.isFinite(tp1) && high >= tp1 && (!best || best.outcome === 'tp1')) {
        best = best || { outcome: 'tp1', outcomeR: 1, terminal: false };
      }
    } else {
      if (high >= sl) return { outcome: 'sl', outcomeR: -1, terminal: true };
      if (Number.isFinite(tp3) && low <= tp3) return { outcome: 'tp3', outcomeR: 3, terminal: true };
      if (Number.isFinite(tp2) && low <= tp2) best = { outcome: 'tp2', outcomeR: 2, terminal: false };
      else if (Number.isFinite(tp1) && low <= tp1 && (!best || best.outcome === 'tp1')) {
        best = best || { outcome: 'tp1', outcomeR: 1, terminal: false };
      }
    }
  }

  return best;
}

/** Only SL / TP3 / expired / cancelled — removes chart overlays. */
export function detectTradeClose(level, candles = []) {
  const hit = detectTradeOutcome(level, candles);
  if (!hit || !hit.terminal) return null;
  return hit;
}

export function isTerminalOutcome(outcome) {
  return TERMINAL_OUTCOMES.has(String(outcome || '').toLowerCase());
}

export function isPartialOutcome(outcome) {
  return PARTIAL_OUTCOMES.has(String(outcome || '').toLowerCase());
}

export function attachActivation(level, barTime) {
  return {
    ...level,
    activatedAtBarTime: barTime,
    tradeStatus: level.tradeStatus || 'open',
    outcome: level.outcome || 'pending',
    lifecycleStage: level.lifecycleStage || 'ACTIVE'
  };
}
