/**
 * Descriptive AI commentary for distributed TradingView signals.
 * Does not recalculate indicators — displays stored strategy metadata + commentary.
 */
export default function AiExplanationCard({
  signal,
  aiFactors,
  tradeExplanation,
  strategyName,
  timeframe,
  signalSource
}) {
  const source = signalSource || signal?.signalSource || signal?.source || 'tradingview';
  const strategy =
    strategyName ||
    signal?.strategyName ||
    signal?.strategy ||
    signal?.patternLabel ||
    signal?.pattern ||
    'TradingView Pine Strategy';
  const tf = timeframe || signal?.timeframe || '1h';
  const commentary = tradeExplanation || signal?.tradeExplanation || signal?.notes || '';

  const hasChecklist = Boolean(aiFactors?.items?.length);
  if (!hasChecklist && !commentary && !strategy) return null;

  return (
    <div className="ai-explanation">
      <h4 className="ai-explanation-title">Signal Context</h4>
      <dl className="signal-meta-grid">
        <div>
          <dt>Signal Source</dt>
          <dd>{source === 'tradingview' ? 'TradingView Pine Strategy' : source}</dd>
        </div>
        <div>
          <dt>Strategy</dt>
          <dd>{strategy}</dd>
        </div>
        <div>
          <dt>Timeframe</dt>
          <dd>{tf}</dd>
        </div>
      </dl>

      {hasChecklist && (
        <>
          <h5 className="ai-commentary-heading">Stored checklist</h5>
          <ul className="ai-factor-list">
            {aiFactors.items.map(item => (
              <li key={item.key} className={item.confirmed ? 'confirmed' : 'unconfirmed'}>
                <span className="ai-factor-marker">{item.confirmed ? '✓' : '✗'}</span>
                <span>
                  {item.label}
                  {item.key === 'rsi' && item.value != null && item.confirmed
                    ? ` (${Math.round(item.value)})`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
          {aiFactors.confidence != null && (
            <p className="ai-confidence">Stored confidence: {aiFactors.confidence}%</p>
          )}
        </>
      )}

      {commentary && (
        <>
          <h5 className="ai-commentary-heading">AI Commentary</h5>
          <p className="ai-commentary-body">{commentary}</p>
        </>
      )}
    </div>
  );
}
