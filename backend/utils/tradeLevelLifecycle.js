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

function detectTradeOutcome(level, candles = []) {
  if (!level) return null;

  const sl = Number(level.stop_loss_1 ?? level.stop_loss);
  const tp1 = Number(level.take_profit_1);
  const tp2 = Number(level.take_profit_2);
  const tp3 = Number(level.take_profit_3);
  if (!Number.isFinite(sl)) return null;

  const long = isLongDirection(level.direction);
  const relevant = candlesAfterActivation(candles, level.activatedAtBarTime);

  for (const candle of relevant) {
    const high = Number(candle.high);
    const low = Number(candle.low);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

    if (long) {
      if (low <= sl) return { outcome: 'sl', outcomeR: -1 };
      if (Number.isFinite(tp3) && high >= tp3) return { outcome: 'tp3', outcomeR: 3 };
      if (Number.isFinite(tp2) && high >= tp2) return { outcome: 'tp2', outcomeR: 2 };
      if (Number.isFinite(tp1) && high >= tp1) return { outcome: 'tp1', outcomeR: 1 };
    } else {
      if (high >= sl) return { outcome: 'sl', outcomeR: -1 };
      if (Number.isFinite(tp3) && low <= tp3) return { outcome: 'tp3', outcomeR: 3 };
      if (Number.isFinite(tp2) && low <= tp2) return { outcome: 'tp2', outcomeR: 2 };
      if (Number.isFinite(tp1) && low <= tp1) return { outcome: 'tp1', outcomeR: 1 };
    }
  }

  return null;
}

function attachActivation(level, barTime) {
  return {
    ...level,
    activatedAtBarTime: barTime,
    tradeStatus: level.tradeStatus || 'open',
    outcome: level.outcome || 'pending'
  };
}

module.exports = {
  chartLevelKey,
  isLongDirection,
  detectTradeOutcome,
  attachActivation,
  candlesAfterActivation
};
