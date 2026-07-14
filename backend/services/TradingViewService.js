// TradingView Service - handles OAuth, data fetching, and API calls
const { TRADINGVIEW_CONFIG, MOCK_HISTORICAL_DATA } = require('../config/tradingview');
const { getBasePrice, normalizeSymbol } = require('../config/symbols');
const { fetchHistoricalData } = require('../utils/marketData');

// Mock OAuth token manager (in production, use encryption)
const tokenCache = {};

class TradingViewService {
  /**
   * Generate OAuth authorization URL
   */
  static getOAuthUrl(state) {
    const params = new URLSearchParams({
      client_id: TRADINGVIEW_CONFIG.oauth.clientId,
      redirect_uri: TRADINGVIEW_CONFIG.oauth.redirectUri,
      response_type: 'code',
      scope: 'read_history',
      state: state || 'random_state'
    });
    return `${TRADINGVIEW_CONFIG.oauth.authUrl}?${params}`;
  }

  /**
   * Exchange OAuth code for access token (mock)
   */
  static async exchangeCodeForToken(code) {
    try {
      console.log('Exchanging OAuth code for token:', code);
      
      // In production: make actual OAuth token request
      // For now: mock token generation
      const mockToken = `tv_token_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const mockUserId = `tv_user_${Math.random().toString(36).substr(2, 9)}`;
      
      return {
        access_token: mockToken,
        user_id: mockUserId,
        expires_in: 86400,
        token_type: 'Bearer'
      };
    } catch (error) {
      throw new Error('OAuth token exchange failed: ' + error.message);
    }
  }

  /**
   * Fetch historical OHLCV data for a symbol
   * Primary: Twelve Data. Automatic fallback: EODHD. Dev fallback: mock.
   */
  static async getHistoricalData(symbol, interval = '1h', limit = 100) {
    if (TRADINGVIEW_CONFIG.dataProvider === 'mock') {
      return TradingViewService.getMockHistoricalData(symbol, limit);
    }

    try {
      return await fetchHistoricalData(TRADINGVIEW_CONFIG, symbol, interval, limit);
    } catch (error) {
      console.error('[MarketData] Provider chain failed, falling back to mock:', error.message);
      return TradingViewService.getMockHistoricalData(symbol, limit);
    }
  }

  /**
   * Get mock historical data (for testing)
   */
  static buildDemoPatternCandles(basePrice = 1.0850) {
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
      const randomChange = (Math.random() - 0.5) * (basePrice >= 1000 ? basePrice * 0.0002 : basePrice >= 100 ? basePrice * 0.0005 : 0.001);
      data.push({
        time: lastCandle.time - i * 3600000,
        open: lastCandle.close,
        high: lastCandle.close + randomChange + Math.abs(randomChange) * 0.5,
        low: lastCandle.close + randomChange - Math.abs(randomChange) * 0.5,
        close: lastCandle.close + randomChange,
        volume: Math.floor(900000 + Math.random() * 200000)
      });
    }

    const demo = TradingViewService.buildDemoPatternCandles(lastCandle.close);
    const merged = data.slice(0, -demo.length).concat(demo);
    return merged.slice(-limit).sort((a, b) => a.time - b.time);
  }

  /**
   * Calculate simple indicators from OHLCV data
   */
  static calculateIndicators(data) {
    if (data.length < 14) return { sma: null, rsi: null };

    // Simple Moving Average (14 period)
    const closes = data.map(d => d.close);
    const sma14 = closes.slice(-14).reduce((a, b) => a + b, 0) / 14;

    // RSI (14 period)
    const gains = [];
    const losses = [];
    for (let i = 1; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) gains.push(change);
      else losses.push(Math.abs(change));
    }
    const avgGain = gains.reduce((a, b) => a + b, 0) / 14;
    const avgLoss = losses.reduce((a, b) => a + b, 0) / 14;
    const rs = avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));

    return {
      sma: sma14.toFixed(5),
      rsi: rsi.toFixed(2),
      currentClose: closes[closes.length - 1]
    };
  }

  /**
   * Send alert back to TradingView (mock - would use webhooks in production)
   */
  static async sendAlertToTradingView(userId, symbol, message) {
    console.log(`Sending alert to TradingView user ${userId}: ${symbol} - ${message}`);
    
    // In production: POST to TradingView webhook or use their alert service
    // For now: log and return success
    return {
      success: true,
      message: 'Alert queued for TradingView user',
      timestamp: new Date()
    };
  }

  /**
   * Verify TradingView token validity
   */
  static async verifyToken(token) {
    // In production: verify with TradingView API
    return token && token.startsWith('tv_token_');
  }
}

module.exports = TradingViewService;
