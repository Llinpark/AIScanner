// Subscription tier definitions and pricing
const {
  WEBHOOK_MPESA_URL,
  WEBHOOK_BINANCE_URL,
  WEBHOOK_SASAPAY_URL,
  WEBHOOK_PAYSTACK_URL,
  PAYSTACK_CALLBACK_URL,
  FRONTEND_URL
} = require('./appUrls');
const { ALL_CURRENCY_PAIRS } = require('./symbols');

const ALL_TIMEFRAMES = ['1M', '1W', '1D', '4h', '1h', '30m', '15m', '5m', '1m'];

const TIERS = {
  basic: {
    name: 'Basic',
    weeklyPrice: 1500,
    weeklyPriceCents: 1650,
    monthlyPrice: 5000,
    priceCents: 5500,
    currency: 'KES',
    currencyPayPal: 'USD',
    currencyBinance: 'USDT',
    description: 'Essential AI and TradingView alerts',
    features: [
      'AI Alerts',
      'TradingView Alerts',
      '5 markets (EUR/USD, GBP/USD, XAU/USD, BTC/USD, USD/JPY)',
      '4 timeframes (1h, 15m, 3m, 1m)',
      '7-day signal history'
    ]
  },
  professional: {
    name: 'Pro',
    weeklyPrice: 4000,
    weeklyPriceCents: 4627,
    monthlyPrice: 12000,
    priceCents: 13882,
    currency: 'KES',
    currencyPayPal: 'USD',
    currencyBinance: 'USDT',
    description: 'Advanced alerts with confidence, Telegram copier, and trade automation',
    features: [
      'Everything in Basic',
      'Most major markets (9 symbols incl. gold & indices)',
      '6 timeframes (4h, 1h, 30m, 15m, 5m, 1m)',
      'Confidence score',
      'News filter',
      'Performance dashboard',
      'Trade journal',
      'Risk analysis (R:R, position sizing)',
      'Telegram alerts',
      'One-click MT5 execution via Telegram',
      'Trailing stop',
      'Break-even automation',
      '30-day signal history'
    ]
  },
  premium: {
    name: 'Premium',
    weeklyPrice: 13000,
    weeklyPriceCents: 16250,
    monthlyPrice: 50000,
    priceCents: 62500,
    currency: 'KES',
    currencyPayPal: 'USD',
    currencyBinance: 'USDT',
    description: 'Full multi-market scanner with MT5 automation and SMC',
    features: [
      'Everything in Pro',
      'All markets (15+ symbols)',
      'All timeframes',
      'Multi-market scanner',
      'Smart Money Concepts',
      'Trade management alerts',
      'AI trade explanation',
      'Advanced analytics',
      'Telegram trade copier (auto entry, SL, TP, lot)',
      'Auto lot sizing based on account balance',
      '90-day signal history'
    ]
  }
};

// Enforceable limits per tier
const TIER_FEATURES = {
  basic: {
    aiAlerts: true,
    tradingViewAlerts: true,
    currencyPairs: ['EUR/USD', 'GBP/USD', 'XAU/USD', 'BTC/USD', 'USD/JPY'],
    timeframes: ['1h', '15m', '3m', '1m'],
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
    mt5Execution: false,
    trailingStop: false,
    breakEvenAutomation: false,
    autoLotSizing: false,
    historyDays: 7,
    maxSignals: 50
  },
  professional: {
    aiAlerts: true,
    tradingViewAlerts: true,
    currencyPairs: [
      'EUR/USD',
      'GBP/USD',
      'XAU/USD',
      'XAG/USD',
      'AUD/USD',
      'USD/JPY',
      'US30',
      'US100',
      'BTC/USD'
    ],
    timeframes: ['4h', '1h', '30m', '15m', '5m', '1m'],
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
    mt5Execution: true,
    trailingStop: true,
    breakEvenAutomation: true,
    autoLotSizing: false,
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
    mt5Execution: true,
    trailingStop: true,
    breakEvenAutomation: true,
    autoLotSizing: true,
    historyDays: 90,
    maxSignals: 500
  }
};

const FEATURE_MATRIX = [
  { key: 'aiAlerts', label: 'AI Alerts', basic: true, professional: true, premium: true },
  { key: 'tradingViewAlerts', label: 'TradingView Alerts', basic: true, professional: true, premium: true },
  { key: 'currencyPairs', label: 'Currency Pairs', basic: 'Limited', professional: 'Most', premium: 'All' },
  { key: 'timeframes', label: 'Timeframes', basic: '4', professional: '6', premium: 'All' },
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
  { key: 'mt5Execution', label: 'One-click MT5 Execution', basic: false, professional: true, premium: true },
  { key: 'trailingStop', label: 'Trailing Stop', basic: false, professional: true, premium: true },
  { key: 'breakEvenAutomation', label: 'Break-even Automation', basic: false, professional: true, premium: true },
  { key: 'autoLotSizing', label: 'Auto Lot Sizing', basic: false, professional: false, premium: true }
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
    callbackUrl: process.env.MPESA_CALLBACK_URL || WEBHOOK_MPESA_URL,
    environment: process.env.MPESA_ENVIRONMENT || 'sandbox',
    transactionType: 'CustomerBuyGoodsOnline'
  },
  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID,
    clientSecret: process.env.PAYPAL_CLIENT_SECRET,
    mode: process.env.PAYPAL_MODE || 'sandbox',
    webhookId: process.env.PAYPAL_WEBHOOK_ID
  },
  binance: {
    apiKey: process.env.BINANCE_PAY_API_KEY,
    apiSecret: process.env.BINANCE_PAY_API_SECRET,
    merchantId: process.env.BINANCE_PAY_MERCHANT_ID,
    environment: process.env.BINANCE_PAY_ENVIRONMENT || 'sandbox',
    webhookUrl: process.env.BINANCE_PAY_WEBHOOK_URL || WEBHOOK_BINANCE_URL
  },
  sasapay: {
    clientId: process.env.SASAPAY_CLIENT_ID,
    clientSecret: process.env.SASAPAY_CLIENT_SECRET,
    merchantCode: process.env.SASAPAY_MERCHANT_CODE,
    networkCode: process.env.SASAPAY_NETWORK_CODE || '63902',
    currency: process.env.SASAPAY_CURRENCY || 'KES',
    callbackUrl: process.env.SASAPAY_CALLBACK_URL || WEBHOOK_SASAPAY_URL,
    baseUrl: process.env.SASAPAY_BASE_URL || 'https://sandbox.sasapay.app/api/v1'
  },
  paystack: {
    secretKey: process.env.PAYSTACK_SECRET_KEY,
    publicKey: process.env.PAYSTACK_PUBLIC_KEY,
    // User browser return after checkout (server verifies, then redirects to frontend)
    callbackUrl: process.env.PAYSTACK_CALLBACK_URL || PAYSTACK_CALLBACK_URL,
    webhookUrl: process.env.PAYSTACK_WEBHOOK_URL || WEBHOOK_PAYSTACK_URL,
    // Optional marketing/site URL shown in Paystack dashboard (not used for API verify)
    siteCallbackUrl: process.env.PAYSTACK_SITE_CALLBACK_URL || FRONTEND_URL
  }
};

function normalizeBillingCycle(billingCycle) {
  return billingCycle === 'weekly' ? 'weekly' : 'monthly';
}

function getTierPricing(tierKey, billingCycle = 'monthly') {
  const tier = TIERS[tierKey];
  if (!tier) {
    throw new Error(`Invalid tier: ${tierKey}`);
  }

  const cycle = normalizeBillingCycle(billingCycle);
  if (cycle === 'weekly') {
    return {
      price: tier.weeklyPrice,
      priceCents: tier.weeklyPriceCents,
      currency: tier.currency,
      currencyPayPal: tier.currencyPayPal,
      currencyBinance: tier.currencyBinance,
      periodDays: 7,
      billingCycle: 'weekly',
      periodLabel: 'week'
    };
  }

  return {
    price: tier.monthlyPrice,
    priceCents: tier.priceCents,
    currency: tier.currency,
    currencyPayPal: tier.currencyPayPal,
    currencyBinance: tier.currencyBinance,
    periodDays: 30,
    billingCycle: 'monthly',
    periodLabel: 'month'
  };
}

function getPublicTiers() {
  const publicTiers = {};
  for (const [key, tier] of Object.entries(TIERS)) {
    const weekly = getTierPricing(key, 'weekly');
    const monthly = getTierPricing(key, 'monthly');
    publicTiers[key] = {
      name: tier.name,
      description: tier.description,
      features: tier.features,
      currency: tier.currency,
      currencyPayPal: tier.currencyPayPal,
      pricing: {
        weekly,
        monthly
      },
      // Default display price (monthly) for backward compatibility
      price: monthly.price,
      priceCents: monthly.priceCents,
      duration: monthly.billingCycle,
      limits: TIER_FEATURES[key] || TIER_FEATURES.basic
    };
  }
  return publicTiers;
}

function getPublicPaymentMethods() {
  let mockPaymentsAllowed = false;
  try {
    mockPaymentsAllowed = require('../utils/security').isMockPaymentsAllowed();
  } catch {
    mockPaymentsAllowed = false;
  }

  const methods = {
    paystack: {
      currency: 'KES',
      publicKey: PAYMENT_CONFIG.paystack.publicKey || null,
      configured: Boolean(PAYMENT_CONFIG.paystack.secretKey)
    },
    mpesa: {
      tillNumber: PAYMENT_CONFIG.mpesa.shortcode || '5337170',
      currency: 'KES'
    },
    sasapay: {
      currency: PAYMENT_CONFIG.sasapay.currency || 'KES'
    },
    binance: {
      merchantId: PAYMENT_CONFIG.binance.merchantId || null,
      currency: 'USDT'
    },
    paypal: {
      currency: 'USD'
    },
    // Frontend must hide mock when this is false (always false in production)
    mockPaymentsAllowed,
    defaultProvider: 'paystack'
  };

  return methods;
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
  normalizeBillingCycle,
  getTierPricing,
  getPublicTiers,
  getPublicPaymentMethods
};
