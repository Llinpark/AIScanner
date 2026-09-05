const { TRADINGVIEW_CONFIG, MOCK_HISTORICAL_DATA } = require('../config/tradingview');
const { getBasePrice, normalizeSymbol } = require('../config/symbols');
const { fetchHistoricalData } = require('../utils/marketData');
const { getMarketDataHub } = require('./MarketDataHubService');
const PatternDetectionService = require('./PatternDetectionService');

/**
 * Chart / market-history candle access.
 * Sole owner of historical OHLCV retrieval for charts and non-webhook enrichment.
 * TradingView webhook signal path must never call this.
 */
class ChartDataService {
  static buildDemoPatternCandles(basePrice = 1.085) {
    const t = Date.now();
    const base = basePrice;
    const step = base >= 1000 ? base * 0.0015 : base >= 100 ? base * 0.002 : 0.0035;
    return [
      { time: t - 10800000, open: base - step, high: base - step * 0.4, low: base - step * 1.2, close: base - step * 0.7, volume: 850000 },
      { time: t - 7200000, open: base - step * 0.8, high: base - step * 0.2, low: base - step, close: base - step * 0.5, volume: 820000 },
      { time: t - 3600000, open: base - step * 0.2, high: base + step * 1.1, low: base - step * 0.1, close: base + step, volume: 1650000 },
      { time: t, open: base + step * 0.8, high: base + step * 1.2, low: base + step * 0.7, close: base + step * 1.1, volume: 1200000 }
    ];
  }

  static getMockHistoricalData(symbol, limit = 100) {
    const normalized = normalizeSymbol(symbol);
    const seed = MOCK_HISTORICAL_DATA[normalized] || MOCK_HISTORICAL_DATA[symbol] || [];
    const data = [...seed];
    const basePrice = getBasePrice(normalized);
    const lastCandle = data[data.length - 1] || { close: basePrice, time: Date.now() };

    while (data.length < Math.max(limit - 4, 20)) {
      const i = data.length;
      const randomChange =
        (Math.random() - 0.5) *
        (basePrice >= 1000 ? basePrice * 0.0002 : basePrice >= 100 ? basePrice * 0.0005 : 0.001);
      data.push({
        time: lastCandle.time - i * 3600000,
        open: lastCandle.close,
        high: lastCandle.close + randomChange + Math.abs(randomChange) * 0.5,
        low: lastCandle.close + randomChange - Math.abs(randomChange) * 0.5,
        close: lastCandle.close + randomChange,
        volume: Math.floor(900000 + Math.random() * 200000)
      });
    }

    const demo = ChartDataService.buildDemoPatternCandles(lastCandle.close);
    const merged = data.slice(0, -demo.length).concat(demo);
    return merged.slice(-limit).sort((a, b) => a.time - b.time);
  }

  static normalizeProviderCandles(candles = []) {
    return candles
      .map(c =>
        PatternDetectionService.normalizeCandle({
          time: c.time != null ? c.time : Date.parse(c.timestamp),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume
        })
      )
      .filter(c => Number.isFinite(c.time) && Number.isFinite(c.close))
      .sort((a, b) => a.time - b.time);
  }

  /**
   * Fetch historical OHLCV for charts.
   * Prefers MarketDataHub; falls back to provider chain; mock only when configured.
   */
  static async getHistoricalData(symbol, interval = '1h', limit = 100, options = {}) {
    const parsedLimit = Math.max(1, parseInt(limit, 10) || 100);

    if (TRADINGVIEW_CONFIG.dataProvider === 'mock' || options.forceMock) {
      return ChartDataService.getMockHistoricalData(symbol, parsedLimit);
    }

    try {
      const hub = getMarketDataHub();
      let payload = await hub.getCandles(symbol, interval, parsedLimit, { cacheOnly: true });
      if (!payload?.candles?.length) {
        payload = await hub.getCandles(symbol, interval, parsedLimit, {
          allowProviderFetch: options.allowProviderFetch !== false
        });
      } else if (
        options.allowProviderFetch !== false &&
        !hub.isFresh(payload, interval) &&
        hub.canFetchFromProvider({ bypassGap: true })
      ) {
        try {
          payload = await hub.getCandles(symbol, interval, parsedLimit, { allowProviderFetch: true });
        } catch (refreshError) {
          console.warn('[ChartData] Hub refresh failed, using cached candles:', refreshError.message);
        }
      }

      if (payload?.candles?.length) {
        return ChartDataService.normalizeProviderCandles(payload.candles).slice(-parsedLimit);
      }
    } catch (hubError) {
      console.warn('[ChartData] Hub path failed, trying provider chain:', hubError.message);
    }

    try {
      const candles = await fetchHistoricalData(TRADINGVIEW_CONFIG, symbol, interval, parsedLimit);
      return ChartDataService.normalizeProviderCandles(candles).slice(-parsedLimit);
    } catch (error) {
      console.error('[ChartData] Provider chain failed, falling back to mock:', error.message);
      return ChartDataService.getMockHistoricalData(symbol, parsedLimit);
    }
  }

  static calculateIndicators(data) {
    if (!data || data.length < 14) return { sma: null, rsi: null };

    const closes = data.map(d => d.close);
    const sma14 = closes.slice(-14).reduce((a, b) => a + b, 0) / 14;

    const gains = [];
    const losses = [];
    for (let i = 1; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) gains.push(change);
      else losses.push(Math.abs(change));
    }
    const avgGain = gains.reduce((a, b) => a + b, 0) / 14;
    const avgLoss = losses.reduce((a, b) => a + b, 0) / 14;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    const rsi = 100 - 100 / (1 + rs);

    return {
      sma: sma14.toFixed(5),
      rsi: rsi.toFixed(2),
      currentClose: closes[closes.length - 1]
    };
  }
}

module.exports = ChartDataService;
