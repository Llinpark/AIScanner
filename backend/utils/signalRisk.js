function isLongDirection(direction) {
  const d = String(direction || '').toLowerCase();
  return d === 'long' || d === 'buy';
}

function pipSize(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (s.includes('JPY')) return 0.01;
  return 0.0001;
}

function computeRiskMetrics(signal, options = {}) {
  const entry = Number(signal.entry);
  const stopLoss = Number(signal.stop_loss_1 ?? signal.stop_loss);
  const tp1 = Number(signal.take_profit_1);
  const tp2 = Number(signal.take_profit_2);
  const tp3 = Number(signal.take_profit_3);
  const pip = pipSize(signal.symbol);

  if (!entry || !stopLoss || !Number.isFinite(entry) || !Number.isFinite(stopLoss)) {
    return null;
  }

  const pipRisk = Math.abs(entry - stopLoss) / pip;
  const pipReward1 = Number.isFinite(tp1) ? Math.abs(tp1 - entry) / pip : 0;
  const pipReward2 = Number.isFinite(tp2) ? Math.abs(tp2 - entry) / pip : 0;
  const pipReward3 = Number.isFinite(tp3) ? Math.abs(tp3 - entry) / pip : 0;

  const riskReward1 = pipRisk > 0 ? Number((pipReward1 / pipRisk).toFixed(2)) : 0;
  const riskReward2 = pipRisk > 0 ? Number((pipReward2 / pipRisk).toFixed(2)) : 0;
  const riskReward3 = pipRisk > 0 ? Number((pipReward3 / pipRisk).toFixed(2)) : 0;

  const accountBalance = Number(options.accountBalance || options.account_balance || 0);
  const riskPercent = Number(options.riskPercent || options.risk_percent || 1);
  let suggestedLotSize = null;
  let riskAmount = null;

  if (accountBalance > 0 && pipRisk > 0) {
    riskAmount = accountBalance * (riskPercent / 100);
    const sym = String(signal.symbol || '').toUpperCase();
    const pipValuePerLot = sym.includes('JPY') ? 1000 / entry : 10;
    suggestedLotSize = Number((riskAmount / (pipRisk * pipValuePerLot)).toFixed(2));
    if (!Number.isFinite(suggestedLotSize) || suggestedLotSize <= 0) {
      suggestedLotSize = null;
    }
  }

  return {
    pipRisk: Number(pipRisk.toFixed(1)),
    pipReward1: Number(pipReward1.toFixed(1)),
    pipReward2: Number(pipReward2.toFixed(1)),
    pipReward3: Number(pipReward3.toFixed(1)),
    riskReward1,
    riskReward2,
    riskReward3,
    riskPercent: accountBalance > 0 ? riskPercent : null,
    riskAmount: riskAmount ? Number(riskAmount.toFixed(2)) : null,
    suggestedLotSize,
    direction: isLongDirection(signal.direction) ? 'long' : 'short'
  };
}

module.exports = {
  pipSize,
  computeRiskMetrics,
  isLongDirection
};
