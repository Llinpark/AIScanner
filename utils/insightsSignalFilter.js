/**
 * Insights / dashboard: only TradingView webhook distribution signals.
 *
 * Legacy live-scanner rows often have source: 'live_scan' while Mongoose also
 * applied signalSource: 'tradingview' (schema default). Preferring signalSource
 * alone incorrectly treats those as current-architecture signals.
 *
 * Also treat smc_pipeline pattern / "Pipeline score" notes as legacy even when
 * source fields were overwritten.
 */

const LEGACY_SIGNAL_SOURCES = [
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
];

const LEGACY_SIGNAL_SOURCE_SET = new Set(LEGACY_SIGNAL_SOURCES);

const LEGACY_PATTERNS = new Set(['smc_pipeline', 'pipeline', 'pipeline_scoring']);

const TRADINGVIEW_SOURCES = new Set([
  'tradingview',
  'tradingview_webhook',
  'tv',
  'webhook'
]);

function normalizeSourceToken(value) {
  return String(value || '')
    .toLowerCase()
    .trim();
}

function collectSourceTokens(signal) {
  return [
    signal?.signalSource,
    signal?.source,
    signal?.origin,
    signal?.aiFactors?.source
  ]
    .map(normalizeSourceToken)
    .filter(Boolean);
}

function isLegacySourceToken(raw) {
  if (!raw) return false;
  if (LEGACY_SIGNAL_SOURCE_SET.has(raw)) return true;
  if (raw.includes('live_scan') || raw.includes('auto_scan')) return true;
  if (raw.includes('smc_pipeline')) return true;
  if (raw.includes('pipeline') && !raw.includes('tradingview')) return true;
  return false;
}

function isTradingViewSourceToken(raw) {
  if (!raw) return false;
  if (TRADINGVIEW_SOURCES.has(raw)) return true;
  return raw.includes('tradingview');
}

/** Pattern / label / notes fingerprints from the old computational SMC pipeline. */
function hasLegacyPipelineFingerprint(signal) {
  if (!signal) return false;

  const pattern = normalizeSourceToken(signal.pattern);
  if (LEGACY_PATTERNS.has(pattern) || pattern.includes('smc_pipeline')) return true;

  const label = String(signal.patternLabel || signal.pattern_label || '');
  if (/smc\s*pipeline|pipeline\s*signal|pipeline\s*score/i.test(label)) return true;

  const notes = String(signal.notes || signal.message || signal.tradeExplanation || '');
  if (/pipeline\s*score|premium\s*smc\s*pipeline|threshold\s*\d+\s*%/i.test(notes)) return true;

  if (signal.pipelineScore != null && signal.pipelineScoreBreakdown != null) return true;
  if (normalizeSourceToken(signal.aiFactors?.source) === 'pipeline_scoring') return true;

  return false;
}

/**
 * True when the signal belongs to the old scanner / SMC pipeline architecture.
 */
function isLegacySignal(signal) {
  if (!signal) return true;
  if (hasLegacyPipelineFingerprint(signal)) return true;
  const tokens = collectSourceTokens(signal);
  return tokens.some(isLegacySourceToken);
}

/**
 * True when the signal should appear in Dashboard / Insights / performance.
 * Excludes legacy scanner rows even if signalSource defaulted to tradingview.
 */
function isWebhookInsightsSignal(signal) {
  if (!signal) return false;
  if (isLegacySignal(signal)) return false;

  const tokens = collectSourceTokens(signal);
  // Explicit TradingView webhook / distribution markers.
  if (tokens.some(isTradingViewSourceToken)) return true;

  // No usable source metadata — do not count as current-architecture metrics.
  return false;
}

/** Mongo match fragment: drop known legacy sources / pipeline patterns. */
function legacySourceMongoExclusion() {
  return {
    $and: [
      {
        $or: [
          { source: { $exists: false } },
          { source: null },
          { source: { $nin: LEGACY_SIGNAL_SOURCES } }
        ]
      },
      {
        $or: [
          { signalSource: { $exists: false } },
          { signalSource: null },
          { signalSource: { $nin: LEGACY_SIGNAL_SOURCES } }
        ]
      },
      {
        $or: [
          { origin: { $exists: false } },
          { origin: null },
          { origin: { $nin: LEGACY_SIGNAL_SOURCES } }
        ]
      },
      {
        $or: [
          { pattern: { $exists: false } },
          { pattern: null },
          { pattern: { $nin: [...LEGACY_PATTERNS] } }
        ]
      },
      {
        source: { $not: /live_scan|auto_scan|smc_pipeline|pipeline_scoring/i }
      },
      {
        signalSource: { $not: /live_scan|auto_scan|smc_pipeline|pipeline_scoring/i }
      },
      {
        patternLabel: { $not: /smc\s*pipeline|pipeline\s*signal/i }
      },
      {
        notes: { $not: /pipeline\s*score|premium\s*smc\s*pipeline/i }
      }
    ]
  };
}

function filterOutLegacySignals(signals) {
  if (!Array.isArray(signals)) return [];
  return signals.filter(s => !isLegacySignal(s) && isWebhookInsightsSignal(s));
}

module.exports = {
  LEGACY_SIGNAL_SOURCES,
  LEGACY_SIGNAL_SOURCE_SET,
  LEGACY_PATTERNS,
  TRADINGVIEW_SOURCES,
  isWebhookInsightsSignal,
  isLegacySignal,
  hasLegacyPipelineFingerprint,
  legacySourceMongoExclusion,
  filterOutLegacySignals,
  isLegacySourceToken,
  collectSourceTokens
};
