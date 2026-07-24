/**
 * Descriptive AI commentary for distributed TradingView signals.
 * Does not recalculate indicators — displays strategy metadata + commentary only.
 * Never shows legacy pipeline weighted checklists / threshold scoring.
 */
export default function AiExplanationCard({
  signal,
  aiFactors,
  tradeExplanation,
  strategyName,
  timeframe,
  signalSource
}) {
  const rawSource = signalSource || signal?.signalSource || signal?.source || 'tradingview';
  const sourceLabel =
    String(rawSource).toLowerCase().includes('tradingview') || rawSource === 'webhook'
      ? 'TradingView Pine Strategy'
      : 'TradingView Pine Strategy';

  const rawStrategy =
    strategyName || signal?.strategyName || signal?.strategy || null;
  const strategy =
    rawStrategy && !/smc\s*pipeline|pipeline\s*signal/i.test(String(rawStrategy))
      ? rawStrategy
      : 'TradingView Pine Strategy';

  const tf = timeframe || signal?.timeframe || '—';

  let commentary = tradeExplanation || signal?.tradeExplanation || '';
  // Strip leftover pipeline scoring language if present in stored commentary.
  if (/pipeline\s*score|premium\s*smc\s*pipeline|threshold\s*\d+\s*%/i.test(commentary)) {
    commentary = '';
  }
  if (!commentary && signal?.notes && !/pipeline\s*score|premium\s*smc/i.test(String(signal.notes))) {
    commentary = signal.notes;
  }

  // Never render weighted pipeline checklists (legacy SMC architecture).
  const isPipelineChecklist =
    String(aiFactors?.source || '').includes('pipeline') ||
    Boolean(signal?.pipelineScoreBreakdown) ||
    (Array.isArray(aiFactors?.items) &&
      aiFactors.items.some(item =>
        /liquidity|fvg|expansion|htf|mss|sweep|retrace|pipeline/i.test(
          String(item?.key || item?.label || '')
        )
      ));

  if (!commentary && !strategy) return null;

  return (
    <div className="ai-explanation">
      <h4 className="ai-explanation-title">Signal Context</h4>
      <dl className="signal-meta-grid">
        <div>
          <dt>Signal Source</dt>
          <dd>{sourceLabel}</dd>
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

      {commentary && (
        <>
          <h5 className="ai-commentary-heading">AI Commentary</h5>
          <p className="ai-commentary-body">{commentary}</p>
        </>
      )}

      {!commentary && !isPipelineChecklist && (
        <p className="ai-commentary-body ai-commentary-muted">
          Levels and direction came from your TradingView alert. Open the chart on TradingView for full strategy
          context.
        </p>
      )}
    </div>
  );
}
