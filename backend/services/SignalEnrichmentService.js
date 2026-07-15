const { computeRiskMetrics } = require('../utils/signalRisk');
const { generateTradeExplanation } = require('../utils/signalExplanation');
const { analyzeSignalFactors, normalizeCandles } = require('../utils/signalFactors');
const { enrichEntrySignal, isEntryAlert } = require('../utils/signalOutcome');
const TradingViewService = require('../services/TradingViewService');
const PatternDetectionService = require('../services/PatternDetectionService');
const { getMarketDataHub } = require('../services/MarketDataHubService');
const { buildChartZones, flattenChartZonesForStorage } = require('../utils/smcZones');

async function resolveCandles(signal, options = {}) {
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
      const historical = await TradingViewService.getHistoricalData(symbol, timeframe, 100);
      return historical.map(c => PatternDetectionService.normalizeCandle(c));
    }
  } catch {
    return normalizeCandles(buffered);
  }
}

async function enrichSignal(signalData, options = {}) {
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
  resolveCandles
};
