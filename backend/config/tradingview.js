// TradingView OAuth and API Configuration
const TRADINGVIEW_CONFIG = {
  oauth: {
    clientId: process.env.TRADINGVIEW_CLIENT_ID || 'demo_client_id',
    clientSecret: process.env.TRADINGVIEW_CLIENT_SECRET || 'demo_secret',
    redirectUri: process.env.TRADINGVIEW_REDIRECT_URI || 'http://localhost:4000/api/tradingview/oauth-callback',
    authUrl: 'https://www.tradingview.com/accounts/signin/',
    tokenUrl: 'https://www.tradingview.com/accounts/oauth-token/',
    apiBaseUrl: 'https://api.tradingview.com'
  },
  dataProvider: process.env.DATA_PROVIDER || 'mock', // 'mock', 'alpha_vantage', 'eodhd', 'polygon'
  providers: {
    alpha_vantage: {
      apiKey: process.env.ALPHA_VANTAGE_API_KEY,
      baseUrl: 'https://www.alphavantage.co'
    },
    eodhd: {
      apiKey: process.env.EODHD_API_KEY,
      baseUrl: 'https://eodhd.com/api'
    },
    polygon: {
      apiKey: process.env.POLYGON_API_KEY,
      baseUrl: 'https://api.polygon.io'
    }
  },
  symbols: {
    eurusd: { symbol: 'EUR/USD', exchange: 'FOREX' },
    gbpusd: { symbol: 'GBP/USD', exchange: 'FOREX' },
    audusd: { symbol: 'AUD/USD', exchange: 'FOREX' },
    usdjpy: { symbol: 'USD/JPY', exchange: 'FOREX' }
  }
};

// Mock historical data for testing
const MOCK_HISTORICAL_DATA = {
  'EUR/USD': [
    { time: Date.now() - 3600000, open: 1.0850, high: 1.0865, low: 1.0840, close: 1.0860, volume: 1000000 },
    { time: Date.now() - 7200000, open: 1.0840, high: 1.0855, low: 1.0835, close: 1.0850, volume: 950000 },
    { time: Date.now() - 10800000, open: 1.0835, high: 1.0850, low: 1.0825, close: 1.0840, volume: 1100000 }
  ],
  'GBP/USD': [
    { time: Date.now() - 3600000, open: 1.2650, high: 1.2665, low: 1.2640, close: 1.2660, volume: 950000 },
    { time: Date.now() - 7200000, open: 1.2640, high: 1.2655, low: 1.2635, close: 1.2650, volume: 920000 }
  ]
};

module.exports = {
  TRADINGVIEW_CONFIG,
  MOCK_HISTORICAL_DATA
};
