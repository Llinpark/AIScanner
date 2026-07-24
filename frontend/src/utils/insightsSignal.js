/** Legacy internal scanner / SMC pipeline sources — excluded from Dashboard & Insights. */
const LEGACY_SOURCES = new Set([
  'live_scan',
  'scanner',
  'pipeline',
  'pipeline_scoring',
  'auto_scan',
  'internal',
  'internal_scan',
  'pattern_scanner',
  'twelve_data',
  'eodhd',
  'smc_pipeline'
]);

const TRADINGVIEW_SOURCES = new Set(['tradingview', 'tradingview_webhook', 'tv', 'webhook']);

function collectSourceTokens(signal) {
  return [signal?.signalSource, signal?.source, signal?.origin, signal?.aiFactors?.source]
    .map(v => String(v || '').toLowerCase().trim())
    .filter(Boolean);
}

function isLegacyToken(raw) {
  if (!raw) return false;
  if (LEGACY_SOURCES.has(raw)) return true;
  if (raw.includes('live_scan') || raw.includes('auto_scan')) return true;
  if (raw.includes('smc_pipeline')) return true;
  if (raw.includes('pipeline') && !raw.includes('tradingview')) return true;
  return false;
}

function isTradingViewToken(raw) {
  if (!raw) return false;
  if (TRADINGVIEW_SOURCES.has(raw)) return true;
  return raw.includes('tradingview');
}

function hasLegacyPipelineFingerprint(signal) {
  if (!signal) return false;
  const pattern = String(signal.pattern || '').toLowerCase();
  if (pattern === 'smc_pipeline' || pattern.includes('smc_pipeline')) return true;

  const label = String(signal.patternLabel || signal.pattern_label || '');
  if (/smc\s*pipeline|pipeline\s*signal|pipeline\s*score/i.test(label)) return true;

  const notes = String(signal.notes || signal.message || signal.tradeExplanation || '');
  if (/pipeline\s*score|premium\s*smc\s*pipeline|threshold\s*\d+\s*%/i.test(notes)) return true;

  if (signal.pipelineScore != null && signal.pipelineScoreBreakdown != null) return true;
  if (String(signal.aiFactors?.source || '').includes('pipeline')) return true;

  return false;
}

export function isLegacySignal(signal) {
  if (!signal) return true;
  if (hasLegacyPipelineFingerprint(signal)) return true;
  return collectSourceTokens(signal).some(isLegacyToken);
}

/**
 * Dashboard / Insights signals only — TradingView webhook distribution.
 * Checks ALL source fields + pipeline fingerprints.
 */
export function isInsightsSignal(signal) {
  if (!signal) return false;
  if (isLegacySignal(signal)) return false;
  const tokens = collectSourceTokens(signal);
  if (tokens.some(isTradingViewToken)) return true;
  return false;
}

export function formatSignalSource() {
  return 'TradingView Pine Strategy';
}

export function formatStrategyName(signal) {
  const name =
    signal?.strategyName ||
    signal?.strategy ||
    null;
  if (name && !/smc\s*pipeline|pipeline\s*signal/i.test(String(name))) {
    return name;
  }
  return 'TradingView Pine Strategy';
}

export function formatConfidence(signal, showConfidence) {
  if (!showConfidence || signal?.confidence == null) return '—';
  const value = Number(signal.confidence);
  if (!Number.isFinite(value)) return '—';
  const pct = value <= 1 ? Math.round(value * 100) : Math.round(value);
  return `${pct}%`;
}

export function formatDeliveryStatus(signal) {
  if (signal?.deliveryStatus) return String(signal.deliveryStatus).replace(/_/g, ' ');
  if (signal?.telegramSent || signal?.mt5Sent) return 'delivered';
  return '—';
}

export function formatExecutionStatus(signal) {
  if (!signal?.executionStatus) return '—';
  return String(signal.executionStatus).replace(/_/g, ' ');
}
