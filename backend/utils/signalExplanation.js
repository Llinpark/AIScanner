const { KACHING_ALERT_NAMES } = require('./kachingSignalLevels');

function formatFactorChecklist(aiFactors) {
  if (!aiFactors?.items?.length) return '';

  const lines = aiFactors.items.map(item => {
    const marker = item.confirmed ? '✓' : '✗';
    const rsiSuffix =
      item.key === 'rsi' && item.value != null && item.confirmed ? ` (${Math.round(item.value)})` : '';
    return `${marker} ${item.label}${rsiSuffix}`;
  });

  lines.push(`AI Confidence: ${aiFactors.confidence}%`);
  return lines.join('\n');
}

function generateTradeExplanation(signal, riskMetrics, aiFactors) {
  const direction = String(signal.direction || 'neutral').toUpperCase();
  const symbol = signal.symbol || 'UNKNOWN';
  const alertType = signal.alertType || 'entry';

  if (alertType !== 'entry' && alertType !== 'signal') {
    const label = KACHING_ALERT_NAMES[alertType] || alertType;
    return `${label} triggered on ${symbol}. Manage the open ${direction} position according to your plan.`;
  }

  if (aiFactors?.items?.length) {
    return formatFactorChecklist(aiFactors);
  }

  const rr = riskMetrics
    ? ` Target R:R is 1:${riskMetrics.riskReward1} (TP1), 1:${riskMetrics.riskReward2} (TP2), 1:${riskMetrics.riskReward3} (TP3) with ~${riskMetrics.pipRisk} pips at risk.`
    : '';

  return (
    `AI analysis on ${symbol} suggests a ${direction} entry.` +
    rr +
    ` Use Kaching SL at ${Number(signal.stop_loss_1 ?? signal.stop_loss).toFixed(5)} and scale out at TP1–TP3.`
  );
}

module.exports = {
  generateTradeExplanation,
  formatFactorChecklist
};
