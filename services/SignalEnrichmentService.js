const { computeRiskMetrics } = require('../utils/signalRisk');
const { generateTradeExplanation } = require('../utils/signalExplanation');
const { analyzeSignalFactors, normalizeCandles } = require('../utils/signalFactors');
const { enrichEntrySignal, isEntryAlert } = require('../utils/signalOutcome');
const { attachNewsFilterToSignal } = require('../utils/newsFilter');
const { attachTradeManagementToSignal } = require('../utils/tradeManagement');
const ChartDataService = require('../services/ChartDataService');
const PatternDetectionService = require('../services/PatternDetectionService');
const { getMarketDataHub } = require('../services/MarketDataHubService');
const { buildChartZones, flattenChartZonesForStorage } = require('../utils/smcZones');

const TRADINGVIEW_SOURCES = new Set(['tradingview', 'tradingview_webhook']);

function isTradingViewWebhookOrigin(signalData = {}, options = {}) {
  if (options.fromTradingViewWebhook || options.skipMarketData) return true;
  const source = String(signalData.source || options.source || '').toLowerCase();
  const origin = String(signalData.origin || options.origin || '').toLowerCase();
  return TRADINGVIEW_SOURCES.has(source) || origin === 'tradingview_webhook';
}

function preserveTradeLevels(original, payload) {
  return {
    ...payload,
    direction: original.direction,
    entry: original.entry,
    stop_loss: original.stop_loss,
    stop_loss_1: original.stop_loss_1 ?? original.stop_loss,
    take_profit_1: original.take_profit_1,
    take_profit_2: original.take_profit_2,
    take_profit_3: original.take_profit_3
  };
}

/**
 * Metadata-only enrichment for TradingView webhook signals.
 * Payload levels (entry / SL / TP / direction) are the source of truth — never modified.
 * Never resolves candles or calls hub.getCandles / fetchHistoricalData / ChartDataService.
 */
async function enrichFromTradingViewWebhook(signalData, options = {}) {
  const original = { ...signalData };
  const alertType = original.alertType || 'signal';
  let payload = {
    ...original,
    source: original.source || 'tradingview',
    origin: 'tradingview_webhook',
    strategy: original.strategy || original.patternLabel || original.pattern || 'TradingView',
    enrichedAt: new Date().toISOString(),
    enrichmentMode: 'tradingview_webhook_metadata'
  };

  if (options.userId != null && payload.userId == null) {
    payload.userId = options.userId;
  }
  if (options.subscriber) {
    payload.subscriber = {
      id: options.subscriber.id,
      email: options.subscriber.email,
      displayName: options.subscriber.displayName
    };
  }

  // Lifecycle metadata only (group id / open status) — does not touch price levels.
  if (isEntryAlert(alertType)) {
    payload = enrichEntrySignal(payload);
  }

  // Statistics derived from webhook levels (does not rewrite those levels).
  const riskMetrics = computeRiskMetrics(payload, options);
  if (riskMetrics) {
    payload.riskMetrics = riskMetrics;
  }

  payload.tradeExplanation = generateTradeExplanation(payload, riskMetrics);

  // Pro+ news filter metadata; Premium trade-management metadata for SL/TP alerts.
  payload = attachNewsFilterToSignal(payload);
  payload = attachTradeManagementToSignal(payload);

  return preserveTradeLevels(original, payload);
}

async function resolveCandles(signal, options = {}) {
  if (isTradingViewWebhookOrigin(signal, options)) {
    return normalizeCandles(options.candles || []);
  }

  if (options.candles?.length) {
    return normalizeCandles(options.candles);
  }

  const symbol = signal.symbol;
  if (!symbol) return [];

  const MarketScannerService = require('../services/MarketScannerService');
  const buffered = MarketScannerService.getCandles(symbol);
  if (buffered.length >= 14) {
    return normalizeCandles(buffered);
  }

  if (options.allowProviderFetch === false || options.cacheOnly) {
    return normalizeCandles(buffered);
  }

  try {
    const timeframe = options.timeframe || signal.timeframe || '1h';
    try {
      const hub = getMarketDataHub();
      const payload = await hub.getCandles(symbol, timeframe, 100, { allowProviderFetch: true });
      return (payload.candles || []).map(c => PatternDetectionService.normalizeCandle({
        time: Date.parse(c.timestamp),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume
      }));
    } catch {
      const historical = await ChartDataService.getHistoricalData(symbol, timeframe, 100);
      return historical.map(c => PatternDetectionService.normalizeCandle(c));
    }
  } catch {
    return normalizeCandles(buffered);
  }
}

/**
 * Full enrichment for scanner / dashboard / non-TV sources (may resolve candles + indicators).
 * TradingView webhook origins are routed to enrichFromTradingViewWebhook automatically.
 */
async function enrichSignal(signalData, options = {}) {
  if (isTradingViewWebhookOrigin(signalData, options)) {
    return enrichFromTradingViewWebhook(signalData, options);
  }

  const alertType = signalData.alertType || 'signal';
  let payload = { ...signalData };

  if (isEntryAlert(alertType)) {
    payload = enrichEntrySignal(payload);
  }

  const riskMetrics = computeRiskMetrics(payload, options);
  if (riskMetrics) {
    payload.riskMetrics = riskMetrics;
  }

  if (isEntryAlert(alertType)) {
    const candles = await resolveCandles(payload, options);
    const preservePipelineScore = payload.pattern === 'smc_pipeline' && payload.pipelineScore != null;

    if (!preservePipelineScore) {
      const aiFactors = analyzeSignalFactors(payload, candles, {
        timeframe: options.timeframe || payload.timeframe || '1h',
        rsiThreshold: options.rsiThreshold || 60
      });
      payload.aiFactors = aiFactors;
      payload.confidence = aiFactors.confidence / 100;
      payload.tradeExplanation = generateTradeExplanation(payload, riskMetrics, aiFactors);
    } else {
      payload.aiFactors = {
        items: (payload.pipelineScoreBreakdown || []).map(item => ({
          key: item.key,
          confirmed: item.factorScore >= 70,
          label: `${item.label}: ${item.factorScore}% (weight ${item.weight}%)`
        })),
        confidence: payload.pipelineScore,
        confirmedCount: (payload.pipelineScoreBreakdown || []).filter(item => item.factorScore >= 70).length,
        timeframe: options.timeframe || payload.timeframe || '1h',
        generatedAt: new Date().toISOString(),
        source: 'pipeline_scoring'
      };
      payload.tradeExplanation = generateTradeExplanation(payload, riskMetrics, payload.aiFactors);
    }

    const chartZones = buildChartZones(payload, candles);
    payload.chartZones = chartZones;
    Object.assign(payload, flattenChartZonesForStorage(chartZones));
  } else {
    payload.tradeExplanation = generateTradeExplanation(payload, riskMetrics);
  }

  return payload;
}

module.exports = {
  enrichSignal,
  enrichFromTradingViewWebhook,
  isTradingViewWebhookOrigin,
  resolveCandles
};
