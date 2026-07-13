// Subscription tier definitions and pricing
const ALL_CURRENCY_PAIRS = [
  'EUR/USD',
  'GBP/USD',
  'AUD/USD',
  'USD/JPY',
  'USD/CAD',
  'NZD/USD',
  'USD/CHF',
  'EUR/GBP',
  'EUR/JPY',
  'GBP/JPY'
];

const ALL_TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1D', '1W'];

const TIERS = {
  basic: {
    name: 'Basic',
    price: 5000,
    priceCents: 5500,
    currency: 'KES',
    currencyPayPal: 'USD',
    duration: 'monthly',
    description: 'Essential AI and TradingView alerts',
    features: [
      'AI Alerts',
      'TradingView Alerts',
      '2 currency pairs (EUR/USD, GBP/USD)',
      '1 timeframe (1h)',
      '7-day signal history'
    ]
  },
  professional: {
    name: 'Pro',
    price: 8500,
    priceCents: 9800,
    currency: 'KES',
    currencyPayPal: 'USD',
    duration: 'monthly',
    description: 'Advanced alerts with confidence and performance tools',
    features: [
      'Everything in Basic',
      'Most major currency pairs (4 pairs)',
      '3 timeframes (15m, 1h, 4h)',
      'Confidence score',
      'News filter',
      'Performance dashboard',
      'Trade journal',
      'Risk analysis (R:R, position sizing)',
      'Telegram alerts',
      '30-day signal history'
    ]
  },
  premium: {
    name: 'Premium',
    price: 50000,
    priceCents: 62500,
    currency: 'KES',
    currencyPayPal: 'USD',
    duration: 'monthly',
    description: 'Full multi-market scanner with SMC and API access',
    features: [
      'Everything in Pro',
      'All currency pairs (10+ markets)',
      'All timeframes',
      'Multi-market scanner',
      'Smart Money Concepts',
      'Trade management alerts',
      'AI trade explanation',
      'Advanced analytics',
      'Prop firm mode',
      'REST API access',
      '90-day signal history'
    ]
  }
};

// Enforceable limits per tier
const TIER_FEATURES = {
  basic: {
    aiAlerts: true,
    tradingViewAlerts: true,
    currencyPairs: ['EUR/USD', 'GBP/USD'],
    timeframes: ['1h'],
    showConfidence: false,
    newsFilter: false,
    performanceDashboard: false,
    tradeJournal: false,
    riskAnalysis: false,
    telegramAlerts: false,
    multiMarketScanner: false,
    smartMoneyConcepts: false,
    tradeManagementAlerts: false,
    aiTradeExplanation: false,
    propFirmMode: false,
    apiAccess: false,
    historyDays: 7,
    maxSignals: 50
  },
  professional: {
    aiAlerts: true,
    tradingViewAlerts: true,
    currencyPairs: ['EUR/USD', 'GBP/USD', 'AUD/USD', 'USD/JPY'],
    timeframes: ['15m', '1h', '4h'],
    showConfidence: true,
    newsFilter: true,
    performanceDashboard: true,
    tradeJournal: true,
    riskAnalysis: true,
    telegramAlerts: true,
    multiMarketScanner: false,
    smartMoneyConcepts: false,
    tradeManagementAlerts: false,
    aiTradeExplanation: false,
    propFirmMode: false,
    apiAccess: false,
    historyDays: 30,
    maxSignals: 100
  },
  premium: {
    aiAlerts: true,
    tradingViewAlerts: true,
    currencyPairs: ALL_CURRENCY_PAIRS,
    timeframes: ALL_TIMEFRAMES,
    showConfidence: true,
    newsFilter: true,
    performanceDashboard: true,
    tradeJournal: true,
    riskAnalysis: true,
    telegramAlerts: true,
    multiMarketScanner: true,
    smartMoneyConcepts: true,
    tradeManagementAlerts: true,
    aiTradeExplanation: true,
    propFirmMode: true,
    apiAccess: true,
    historyDays: 90,
    maxSignals: 500
  }
};

const FEATURE_MATRIX = [
  { key: 'aiAlerts', label: 'AI Alerts', basic: true, professional: true, premium: true },
  { key: 'tradingViewAlerts', label: 'TradingView Alerts', basic: true, professional: true, premium: true },
  { key: 'currencyPairs', label: 'Currency Pairs', basic: 'Limited', professional: 'Most', premium: 'All' },
  { key: 'timeframes', label: 'Timeframes', basic: '1', professional: '3', premium: 'All' },
  { key: 'showConfidence', label: 'Confidence Score', basic: false, professional: true, premium: true },
  { key: 'newsFilter', label: 'News Filter', basic: false, professional: true, premium: true },
  { key: 'performanceDashboard', label: 'Performance Dashboard', basic: false, professional: true, premium: true },
  { key: 'tradeJournal', label: 'Trade Journal', basic: false, professional: true, premium: true },
  { key: 'riskAnalysis', label: 'Risk Analysis', basic: false, professional: true, premium: true },
  { key: 'telegramAlerts', label: 'Telegram Alerts', basic: false, professional: true, premium: true },
  { key: 'multiMarketScanner', label: 'Multi-Market Scanner', basic: false, professional: false, premium: true },
  { key: 'smartMoneyConcepts', label: 'Smart Money Concepts', basic: false, professional: false, premium: true },
  { key: 'tradeManagementAlerts', label: 'Trade Management Alerts', basic: false, professional: false, premium: true },
  { key: 'aiTradeExplanation', label: 'AI Trade Explanation', basic: false, professional: false, premium: true },
  { key: 'propFirmMode', label: 'Prop Firm Mode', basic: false, professional: false, premium: true },
  { key: 'apiAccess', label: 'API Access', basic: false, professional: false, premium: true }
];

const TIER_ORDER = ['basic', 'professional', 'premium'];

const TIER_DISPLAY_NAMES = {
  basic: 'Basic',
  professional: 'Pro',
  premium: 'Premium'
};

const PAYMENT_CONFIG = {
  mode: process.env.PAYMENTS_MODE || 'mock',
  mpesa: {
    consumerKey: process.env.MPESA_CONSUMER_KEY,
    consumerSecret: process.env.MPESA_CONSUMER_SECRET,
    shortcode: process.env.MPESA_SHORTCODE || '5337170',
    passkey: process.env.MPESA_PASSKEY,
    callbackUrl: process.env.MPESA_CALLBACK_URL || `${process.env.PUBLIC_BACKEND_URL || 'http://localhost:4000'}/api/webhook/mpesa`,
    environment: process.env.MPESA_ENVIRONMENT || 'sandbox',
    transactionType: 'CustomerBuyGoodsOnline'
  },
  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID,
    clientSecret: process.env.PAYPAL_CLIENT_SECRET,
    mode: process.env.PAYPAL_MODE || 'sandbox',
    webhookId: process.env.PAYPAL_WEBHOOK_ID
  }
};

function getPublicTiers() {
  const publicTiers = {};
  for (const [key, tier] of Object.entries(TIERS)) {
    publicTiers[key] = {
      ...tier,
      limits: TIER_FEATURES[key] || TIER_FEATURES.basic
    };
  }
  return publicTiers;
}

module.exports = {
  TIERS,
  TIER_FEATURES,
  TIER_ORDER,
  TIER_DISPLAY_NAMES,
  FEATURE_MATRIX,
  ALL_CURRENCY_PAIRS,
  ALL_TIMEFRAMES,
  PAYMENT_CONFIG,
  getPublicTiers
};
