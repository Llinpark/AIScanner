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
  const strategy =
    signal.strategyName || signal.strategy || signal.patternLabel || signal.pattern || 'TradingView Pine Strategy';
  const timeframe = signal.timeframe || '1h';

  if (alertType !== 'entry' && alertType !== 'signal') {
    const label = KACHING_ALERT_NAMES[alertType] || alertType;
    return `${label} received from TradingView for ${symbol}. Manage the open ${direction} position according to your plan.`;
  }

  if (aiFactors?.items?.length) {
    return formatFactorChecklist(aiFactors);
  }

  const rr = riskMetrics
    ? ` Stored R:R is 1:${riskMetrics.riskReward1} (TP1), 1:${riskMetrics.riskReward2} (TP2), 1:${riskMetrics.riskReward3} (TP3) with ~${riskMetrics.pipRisk} pips at risk.`
    : '';

  return (
    `Signal Source: TradingView Pine Strategy. Strategy: ${strategy} on ${timeframe}. ` +
    `This ${direction} setup on ${symbol} was distributed by Kaching — levels are as published by the alert.` +
    rr +
    ` Respect Kaching SL at ${Number(signal.stop_loss_1 ?? signal.stop_loss).toFixed(5)} and scale out at TP1–TP3.`
  );
}

module.exports = {
  generateTradeExplanation,
  formatFactorChecklist
};
