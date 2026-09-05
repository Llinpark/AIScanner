function sma(values, period) {
  if (!values.length || values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((sum, v) => sum + v, 0) / period;
}

function computeRsi(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;

  const closes = candles.map(c => Number(c.close));
  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i += 1) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function findSwingLow(candles) {
  if (!candles.length) return null;
  return Math.min(...candles.map(c => c.low));
}

function findSwingHigh(candles) {
  if (!candles.length) return null;
  return Math.max(...candles.map(c => c.high));
}

module.exports = {
  sma,
  computeRsi,
  findSwingLow,
  findSwingHigh
};
