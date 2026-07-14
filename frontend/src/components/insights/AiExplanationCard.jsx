export default function AiExplanationCard({ aiFactors, tradeExplanation }) {
  if (aiFactors?.items?.length) {
    return (
      <div className="ai-explanation">
        <h4 className="ai-explanation-title">AI Explanation</h4>
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
        <p className="ai-confidence">AI Confidence: {aiFactors.confidence}%</p>
      </div>
    );
  }

  if (!tradeExplanation) return null;

  return <p className="ai-explanation">{tradeExplanation}</p>;
}
