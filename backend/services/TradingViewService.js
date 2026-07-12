// TradingView Service - handles OAuth, data fetching, and API calls
const { TRADINGVIEW_CONFIG, MOCK_HISTORICAL_DATA } = require('../config/tradingview');

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
   * Supports mock, Alpha Vantage, EODHD, Polygon
   */
  static async getHistoricalData(symbol, interval = '1h', limit = 100) {
    try {
      if (TRADINGVIEW_CONFIG.dataProvider === 'mock') {
        return TradingViewService.getMockHistoricalData(symbol, limit);
      }

      if (TRADINGVIEW_CONFIG.dataProvider === 'alpha_vantage') {
        return await TradingViewService.fetchFromAlphaVantage(symbol, interval, limit);
      }

      if (TRADINGVIEW_CONFIG.dataProvider === 'eodhd') {
        return await TradingViewService.fetchFromEODHD(symbol, interval, limit);
      }

      if (TRADINGVIEW_CONFIG.dataProvider === 'polygon') {
        return await TradingViewService.fetchFromPolygon(symbol, interval, limit);
      }

      return TradingViewService.getMockHistoricalData(symbol, limit);
    } catch (error) {
      console.error('Error fetching historical data:', error);
      return TradingViewService.getMockHistoricalData(symbol, limit);
    }
  }

  /**
   * Get mock historical data (for testing)
   */
  static buildDemoPatternCandles(basePrice = 1.0850) {
    const t = Date.now();
    const base = basePrice;
    return [
      { time: t - 10800000, open: base - 0.001, high: base - 0.0004, low: base - 0.0012, close: base - 0.0007, volume: 850000 },
      { time: t - 7200000, open: base - 0.0008, high: base - 0.0002, low: base - 0.001, close: base - 0.0005, volume: 820000 },
      { time: t - 3600000, open: base - 0.0002, high: base + 0.0038, low: base - 0.0001, close: base + 0.0035, volume: 1650000 },
      { time: t, open: base + 0.0028, high: base + 0.0042, low: base + 0.0025, close: base + 0.0039, volume: 1200000 }
    ];
  }

  static getMockHistoricalData(symbol, limit = 100) {
    const seed = MOCK_HISTORICAL_DATA[symbol] || [];
    const data = [...seed];
    const lastCandle = data[data.length - 1] || { close: 1.0850, time: Date.now() };

    while (data.length < Math.max(limit - 4, 20)) {
      const i = data.length;
      const randomChange = (Math.random() - 0.5) * 0.001;
      data.push({
        time: lastCandle.time - i * 3600000,
        open: lastCandle.close,
        high: lastCandle.close + randomChange + 0.0005,
        low: lastCandle.close + randomChange - 0.0005,
        close: lastCandle.close + randomChange,
        volume: Math.floor(900000 + Math.random() * 200000)
      });
    }

    const demo = TradingViewService.buildDemoPatternCandles(lastCandle.close);
    const merged = data.slice(0, -demo.length).concat(demo);
    return merged.slice(-limit).sort((a, b) => a.time - b.time);
  }

  /**
   * Fetch from Alpha Vantage API
   */
  static async fetchFromAlphaVantage(symbol, interval, limit) {
    const apiKey = TRADINGVIEW_CONFIG.providers.alpha_vantage.apiKey;
    if (!apiKey) throw new Error('Alpha Vantage API key not configured');

    // Mock implementation
    console.log(`Fetching from Alpha Vantage: ${symbol}`);
    return TradingViewService.getMockHistoricalData(symbol, limit);
  }

  /**
   * Fetch from EODHD API
   */
  static async fetchFromEODHD(symbol, interval, limit) {
    const apiKey = TRADINGVIEW_CONFIG.providers.eodhd.apiKey;
    if (!apiKey) throw new Error('EODHD API key not configured');

    // Mock implementation
    console.log(`Fetching from EODHD: ${symbol}`);
    return TradingViewService.getMockHistoricalData(symbol, limit);
  }

  /**
   * Fetch from Polygon API
   */
  static async fetchFromPolygon(symbol, interval, limit) {
    const apiKey = TRADINGVIEW_CONFIG.providers.polygon.apiKey;
    if (!apiKey) throw new Error('Polygon API key not configured');

    // Mock implementation
    console.log(`Fetching from Polygon: ${symbol}`);
    return TradingViewService.getMockHistoricalData(symbol, limit);
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
