const { KACHING_ALERT_NAMES } = require('./kachingSignalLevels');

function patternSummary(signal) {
  if (signal.patternLabel) return signal.patternLabel;
  if (signal.pattern === 'perfect_fvg') return 'Pattern A: Perfect Fair Value Gap';
  if (signal.pattern === 'breakaway_gap') return 'Pattern B: Breakaway Gap';
  return 'Structural scanner setup';
}

function confidencePhrase(confidence) {
  const pct = Math.round((Number(confidence) || 0) * 100);
  if (pct >= 85) return 'high conviction';
  if (pct >= 70) return 'solid probability';
  if (pct >= 55) return 'moderate confidence';
  return 'lower confidence';
}

function generateTradeExplanation(signal, riskMetrics) {
  const direction = String(signal.direction || 'neutral').toUpperCase();
  const symbol = signal.symbol || 'UNKNOWN';
  const pattern = patternSummary(signal);
  const conf = confidencePhrase(signal.confidence);
  const alertType = signal.alertType || 'entry';

  if (alertType !== 'entry' && alertType !== 'signal') {
    const label = KACHING_ALERT_NAMES[alertType] || alertType;
    return `${label} triggered on ${symbol}. Manage the open ${direction} position according to your plan.`;
  }

  const rr = riskMetrics
    ? ` Target R:R is 1:${riskMetrics.riskReward1} (TP1), 1:${riskMetrics.riskReward2} (TP2), 1:${riskMetrics.riskReward3} (TP3) with ~${riskMetrics.pipRisk} pips at risk.`
    : '';

  const gapNote =
    signal.gapTop && signal.gapBottom
      ? ` Price left a gap between ${Number(signal.gapBottom).toFixed(5)} and ${Number(signal.gapTop).toFixed(5)}, supporting the ${direction.toLowerCase()} bias.`
      : '';

  return (
    `AI analysis: ${pattern} on ${symbol} suggests a ${direction} entry with ${conf} ` +
    `(score ${Math.round((Number(signal.confidence) || 0) * 100)}%).` +
    gapNote +
    rr +
    ` Use Kaching SL at ${Number(signal.stop_loss_1 ?? signal.stop_loss).toFixed(5)} and scale out at TP1–TP3.`
  );
}

module.exports = {
  generateTradeExplanation
};
