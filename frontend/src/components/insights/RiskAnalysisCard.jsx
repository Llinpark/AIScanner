function OutcomeBadge({ outcome, tradeStatus }) {
  const value = outcome || tradeStatus || 'pending';
  const className = `outcome-badge outcome-${value}`;
  const label =
    value === 'tp1'
      ? 'TP1'
      : value === 'tp2'
        ? 'TP2'
        : value === 'tp3'
          ? 'TP3'
          : value === 'sl'
            ? 'SL'
            : value === 'pending' || value === 'open'
              ? 'Open'
              : value.toUpperCase();
  return <span className={className}>{label}</span>;
}

function pipValuePerLot(symbol, entry) {
  const sym = String(symbol || '').toUpperCase();
  if (sym.includes('JPY') && Number.isFinite(entry) && entry > 0) {
    return 1000 / entry;
  }
  return 10;
}

/** Client-side lot suggestion so changing balance updates immediately. */
export function suggestLotSize(riskMetrics, accountBalance, riskPercent = 1, symbol) {
  const pipRisk = Number(riskMetrics?.pipRisk);
  const balance = Number(accountBalance);
  if (!Number.isFinite(pipRisk) || pipRisk <= 0 || !Number.isFinite(balance) || balance <= 0) {
    return null;
  }
  const riskAmount = balance * (Number(riskPercent) || 1) / 100;
  const pipValue = pipValuePerLot(symbol, null);
  const lots = riskAmount / (pipRisk * pipValue);
  if (!Number.isFinite(lots) || lots <= 0) return null;
  return Number(lots.toFixed(2));
}

export function RiskAnalysisCard({
  riskMetrics,
  accountBalance,
  onAccountBalanceChange,
  locked,
  symbol
}) {
  if (locked) {
    return <div className="feature-lock">Risk analysis (R:R, pip risk, lot sizing) requires Pro or Premium.</div>;
  }

  if (!riskMetrics) {
    return <div className="risk-panel-empty">Risk metrics unavailable for this signal.</div>;
  }

  const suggested =
    suggestLotSize(riskMetrics, accountBalance, 1, symbol) ?? riskMetrics.suggestedLotSize;

  return (
    <div className="risk-panel">
      <h4>Risk Analysis</h4>
      <div className="risk-grid">
        <div><span>Pip risk</span><strong>{riskMetrics.pipRisk}</strong></div>
        <div><span>R:R TP1</span><strong>1:{riskMetrics.riskReward1}</strong></div>
        <div><span>R:R TP2</span><strong>1:{riskMetrics.riskReward2}</strong></div>
        <div><span>R:R TP3</span><strong>1:{riskMetrics.riskReward3}</strong></div>
        <div><span>Pip reward TP1</span><strong>{riskMetrics.pipReward1}</strong></div>
        <div><span>Pip reward TP2</span><strong>{riskMetrics.pipReward2}</strong></div>
        <div><span>Pip reward TP3</span><strong>{riskMetrics.pipReward3}</strong></div>
      </div>
      <div className="risk-sizing">
        <label htmlFor="account-balance">Account balance (for lot sizing)</label>
        <input
          id="account-balance"
          type="number"
          min="0"
          step="100"
          value={accountBalance}
          onChange={e => onAccountBalanceChange?.(Number(e.target.value) || 0)}
          placeholder="e.g. 10000"
        />
        {accountBalance > 0 && suggested != null && (
          <p className="lot-hint">
            Suggested lot size at 1% risk: <strong>{suggested}</strong> lots
          </p>
        )}
      </div>
    </div>
  );
}

export default OutcomeBadge;
