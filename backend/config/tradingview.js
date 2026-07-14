// TradingView OAuth and API Configuration
const { TRADINGVIEW_OAUTH_CALLBACK_URL } = require('./appUrls');

const TRADINGVIEW_CONFIG = {
  oauth: {
    clientId: process.env.TRADINGVIEW_CLIENT_ID || 'demo_client_id',
    clientSecret: process.env.TRADINGVIEW_CLIENT_SECRET || 'demo_secret',
    redirectUri: process.env.TRADINGVIEW_REDIRECT_URI || TRADINGVIEW_OAUTH_CALLBACK_URL,
    authUrl: 'https://www.tradingview.com/accounts/signin/',
    tokenUrl: 'https://www.tradingview.com/accounts/oauth-token/',
    apiBaseUrl: 'https://api.tradingview.com'
  },
  dataProvider: process.env.DATA_PROVIDER || process.env.MARKET_DATA_PRIMARY || 'twelve_data',
  primaryProvider: process.env.MARKET_DATA_PRIMARY || process.env.DATA_PROVIDER || 'twelve_data',
  fallbackProvider: process.env.MARKET_DATA_FALLBACK || 'eodhd',
  providers: {
    twelve_data: {
      apiKey: process.env.TWELVE_DATA_API_KEY,
      baseUrl: process.env.TWELVE_DATA_BASE_URL || 'https://api.twelvedata.com'
    },
    eodhd: {
      apiKey: process.env.EODHD_API_KEY,
      baseUrl: process.env.EODHD_BASE_URL || 'https://eodhd.com/api'
    }
  },
  symbols: {
    eurusd: { symbol: 'EUR/USD', exchange: 'FOREX' },
    gbpusd: { symbol: 'GBP/USD', exchange: 'FOREX' },
    xauusd: { symbol: 'XAU/USD', exchange: 'FOREX' },
    xagusd: { symbol: 'XAG/USD', exchange: 'FOREX' },
    us30: { symbol: 'US30', exchange: 'INDEX' },
    us100: { symbol: 'US100', exchange: 'INDEX' },
    usdbtc: { symbol: 'USD/BTC', exchange: 'CRYPTO' },
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

const ALERT_DISPLAY_NAMES = {
  entry: 'Kaching Entry',
  stop_loss: 'Kaching SL',
  take_profit_1: 'Kaching TP1',
  take_profit_2: 'Kaching TP2',
  take_profit_3: 'Kaching TP3',
  signal: 'Kaching Signal'
};

module.exports = {
  TRADINGVIEW_CONFIG,
  MOCK_HISTORICAL_DATA,
  ALERT_DISPLAY_NAMES
};
