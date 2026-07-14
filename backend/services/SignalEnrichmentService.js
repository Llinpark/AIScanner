const { computeRiskMetrics } = require('../utils/signalRisk');
const { generateTradeExplanation } = require('../utils/signalExplanation');
const { analyzeSignalFactors, normalizeCandles } = require('../utils/signalFactors');
const { enrichEntrySignal, isEntryAlert } = require('../utils/signalOutcome');
const TradingViewService = require('../services/TradingViewService');
const PatternDetectionService = require('../services/PatternDetectionService');
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
    const historical = await TradingViewService.getHistoricalData(symbol, timeframe, 100);
    return historical.map(c => PatternDetectionService.normalizeCandle(c));
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
    const aiFactors = analyzeSignalFactors(payload, candles, {
      timeframe: options.timeframe || payload.timeframe || '1h',
      rsiThreshold: options.rsiThreshold || 60
    });
    payload.aiFactors = aiFactors;
    payload.confidence = aiFactors.confidence / 100;
    payload.tradeExplanation = generateTradeExplanation(payload, riskMetrics, aiFactors);

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
