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

export function RiskAnalysisCard({ riskMetrics, accountBalance, onAccountBalanceChange, locked }) {
  if (locked) {
    return <div className="feature-lock">Risk analysis (R:R, pip risk, lot sizing) requires Pro or Premium.</div>;
  }

  if (!riskMetrics) {
    return <div className="risk-panel-empty">Risk metrics unavailable for this signal.</div>;
  }

  return (
    <div className="risk-panel">
      <h4>Risk Analysis</h4>
      <div className="risk-grid">
        <div><span>Pip risk</span><strong>{riskMetrics.pipRisk}</strong></div>
        <div><span>R:R TP1</span><strong>1:{riskMetrics.riskReward1}</strong></div>
        <div><span>R:R TP2</span><strong>1:{riskMetrics.riskReward2}</strong></div>
        <div><span>R:R TP3</span><strong>1:{riskMetrics.riskReward3}</strong></div>
        <div><span>Pip reward TP1</span><strong>{riskMetrics.pipReward1}</strong></div>
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
        {accountBalance > 0 && riskMetrics.suggestedLotSize != null && (
          <p className="lot-hint">
            Suggested lot size at 1% risk: <strong>{riskMetrics.suggestedLotSize}</strong> lots
          </p>
        )}
      </div>
    </div>
  );
}

export function SignalHistoryRow({ signal, tierLimits, accountBalance, onAddToJournal }) {
  const sl = signal.stop_loss_1 ?? signal.stop_loss;

  return (
    <tr>
      <td>{signal.createdAt ? new Date(signal.createdAt).toLocaleString() : '—'}</td>
      <td>{signal.symbol}</td>
      <td>{signal.direction?.toUpperCase()}</td>
      <td>{signal.alertType || 'entry'}</td>
      <td>
        <OutcomeBadge outcome={signal.outcome} tradeStatus={signal.tradeStatus} />
      </td>
      <td>{signal.outcomeR != null ? `${signal.outcomeR}R` : '—'}</td>
      <td>
        {tierLimits.showConfidence && signal.confidence != null
          ? `${Math.round(signal.confidence * 100)}%`
          : '—'}
      </td>
      <td className="levels-cell">
        E {Number(signal.entry).toFixed(5)} · SL {Number(sl).toFixed(5)}
      </td>
      <td>
        {tierLimits.tradeJournal && onAddToJournal && (
          <button type="button" className="btn-small" onClick={() => onAddToJournal(signal)}>
            + Journal
          </button>
        )}
      </td>
    </tr>
  );
}

export default OutcomeBadge;
