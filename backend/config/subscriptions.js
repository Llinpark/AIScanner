// Subscription tier definitions and pricing
const {
  WEBHOOK_MPESA_URL,
  WEBHOOK_BINANCE_URL,
  WEBHOOK_PAYPAL_URL,
  PAYPAL_RETURN_URL
} = require('./appUrls');
const { ALL_CURRENCY_PAIRS } = require('./symbols');

const ALL_TIMEFRAMES = ['1M', '1W', '1D', '4h', '1h', '30m', '15m', '5m', '3m', '1m'];

const TIERS = {
  basic: {
    name: 'Basic',
    monthlyPrice: 5000,
    priceCents: 5500,
    currency: 'KES',
    currencyPayPal: 'USD',
    currencyBinance: 'USDT',
    description: 'Essential AI and TradingView alerts with in-app and email delivery',
    features: [
      'AI Alerts',
      'TradingView Alerts',
      'In-app live alerts',
      'Email alert notifications',
      'Entry, SL & TP1–3 overlays on your TradingView chart',
      '5 chart-catalog markets (EUR/USD, GBP/USD, XAU/USD, BTC/USD, USD/JPY)',
      'TradingView alerts on any chart symbol your script is attached to',
      '4 timeframes (1h, 15m, 3m, 1m)',
      '7-day signal history'
    ]
  },
  professional: {
    name: 'Pro',
    monthlyPrice: 12000,
    priceCents: 13882,
    currency: 'KES',
    currencyPayPal: 'USD',
    currencyBinance: 'USDT',
    description: 'Advanced alerts with confidence, Telegram notifications, and manual MT5 execution',
    features: [
      'Everything in Basic',
      'Most major chart-catalog markets (9 symbols incl. gold & indices)',
      'TradingView alerts on any instrument (forex, metals, indices, crypto, stocks)',
      '6 timeframes (4h, 1h, 30m, 15m, 5m, 1m)',
      'Confidence score',
      'News filter',
      'Performance dashboard',
      'Trade journal',
      'Risk analysis (R:R, position sizing)',
      'Telegram notifications',
      'Manual MT5 execution (Execute button)',
      'Trailing stop',
      'Break-even automation',
      '30-day signal history'
    ]
  },
  premium: {
    name: 'Premium',
    monthlyPrice: 25000,
    priceCents: 31250,
    currency: 'KES',
    currencyPayPal: 'USD',
    currencyBinance: 'USDT',
    description: 'All-market TradingView signal distribution with automatic MT5 execution and SMC overlays',
    features: [
      'Everything in Pro',
      'Any TradingView instrument (webhook pass-through — not limited to a forex list)',
      'All chart timeframes',
      'Multi-market distribution (all webhook symbols from TradingView)',
      'Smart Money Concepts chart overlays (FVG / zones from signal metadata)',
      'Trade management alerts',
      'AI trade explanation',
      'Advanced analytics',
      'Automatic MT5 execution (Telegram remains notification-only)',
      'Auto lot sizing based on synced MT5 account balance',
      '90-day signal history'
    ]
  }
};

// Enforceable limits per tier
const TIER_FEATURES = {
  basic: {
    aiAlerts: true,
    tradingViewAlerts: true,
    // Pine draws Entry/SL/TP1–3 on the user's TradingView chart (all paid tiers).
    tradingViewLevelOverlays: true,
    // Supported Admin Scanner assets only (platform invariant).
    currencyPairs: ['EUR/USD', 'GBP/USD', 'XAU/USD', 'USD/JPY', 'AUD/USD'],
    anyTradingViewInstrument: false,
    timeframes: ['1h', '15m', '3m', '1m'],
    showConfidence: false,
    newsFilter: false,
    performanceDashboard: false,
    tradeJournal: false,
    riskAnalysis: false,
    telegramAlerts: false,
    emailAlerts: true,
    multiMarketScanner: false,
    smartMoneyConcepts: false,
    tradeManagementAlerts: false,
    aiTradeExplanation: false,
    advancedAnalytics: false,
    mt5Execution: false,
    mt5AutoExecution: false,
    trailingStop: false,
    breakEvenAutomation: false,
    autoLotSizing: false,
    historyDays: 7,
    maxSignals: 50
  },
  professional: {
    aiAlerts: true,
    tradingViewAlerts: true,
    tradingViewLevelOverlays: true,
    currencyPairs: [
      'EUR/USD',
      'GBP/USD',
      'XAU/USD',
      'AUD/USD',
      'USD/JPY',
      'USD/CAD',
      'US30',
      'US100'
    ],
    anyTradingViewInstrument: false,
    timeframes: ['4h', '1h', '30m', '15m', '5m', '1m'],
    showConfidence: true,
    newsFilter: true,
    performanceDashboard: true,
    tradeJournal: true,
    riskAnalysis: true,
    telegramAlerts: true,
    emailAlerts: true,
    multiMarketScanner: false,
    smartMoneyConcepts: false,
    tradeManagementAlerts: false,
    aiTradeExplanation: false,
    advancedAnalytics: false,
    mt5Execution: true,
    mt5AutoExecution: false,
    trailingStop: true,
    breakEvenAutomation: true,
    autoLotSizing: false,
    historyDays: 30,
    maxSignals: 100
  },
  premium: {
    aiAlerts: true,
    tradingViewAlerts: true,
    tradingViewLevelOverlays: true,
    // Full supported Admin Scanner catalog only.
    currencyPairs: ALL_CURRENCY_PAIRS,
    anyTradingViewInstrument: false,
    timeframes: ALL_TIMEFRAMES,
    showConfidence: true,
    newsFilter: true,
    performanceDashboard: true,
    tradeJournal: true,
    riskAnalysis: true,
    telegramAlerts: true,
    emailAlerts: true,
    multiMarketScanner: true,
    smartMoneyConcepts: true,
    tradeManagementAlerts: true,
    aiTradeExplanation: true,
    // Same performance dashboard as Pro, with the 90-day window + extended breakdowns.
    advancedAnalytics: true,
    mt5Execution: true,
    mt5AutoExecution: true,
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
  { key: 'tradingViewLevelOverlays', label: 'TV Entry / SL / TP Overlays', basic: true, professional: true, premium: true },
  { key: 'currencyPairs', label: 'Chart Markets', basic: 'Core FX + gold', professional: 'All 8 supported', premium: 'All 8 supported' },
  { key: 'timeframes', label: 'Timeframes', basic: '4', professional: '6', premium: 'All' },
  { key: 'showConfidence', label: 'Confidence Score', basic: false, professional: true, premium: true },
  { key: 'newsFilter', label: 'News Filter', basic: false, professional: true, premium: true },
  { key: 'performanceDashboard', label: 'Performance Dashboard', basic: false, professional: true, premium: true },
  { key: 'advancedAnalytics', label: 'Advanced Analytics', basic: false, professional: false, premium: true },
  { key: 'tradeJournal', label: 'Trade Journal', basic: false, professional: true, premium: true },
  { key: 'riskAnalysis', label: 'Risk Analysis', basic: false, professional: true, premium: true },
  { key: 'telegramAlerts', label: 'Telegram Notifications', basic: false, professional: true, premium: true },
  { key: 'emailAlerts', label: 'Email Alerts', basic: true, professional: true, premium: true },
  { key: 'multiMarketScanner', label: 'Multi-Market Distribution', basic: false, professional: false, premium: true },
  { key: 'smartMoneyConcepts', label: 'Smart Money Concepts', basic: false, professional: false, premium: true },
  { key: 'tradeManagementAlerts', label: 'Trade Management Alerts', basic: false, professional: false, premium: true },
  { key: 'aiTradeExplanation', label: 'AI Trade Explanation', basic: false, professional: false, premium: true },
  { key: 'mt5Execution', label: 'MT5 Execution', basic: false, professional: true, premium: true },
  { key: 'mt5AutoExecution', label: 'Automatic MT5 Execution', basic: false, professional: false, premium: true },
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
    webhookId: process.env.PAYPAL_WEBHOOK_ID,
    // Browser return after PayPal approval (API captures, then redirects to frontend)
    returnUrlBase: process.env.PAYPAL_RETURN_URL || PAYPAL_RETURN_URL,
    webhookUrl: process.env.PAYPAL_WEBHOOK_URL || WEBHOOK_PAYPAL_URL
  },
  binance: {
    apiKey: process.env.BINANCE_PAY_API_KEY,
    apiSecret: process.env.BINANCE_PAY_API_SECRET,
    merchantId: process.env.BINANCE_PAY_MERCHANT_ID,
    environment: process.env.BINANCE_PAY_ENVIRONMENT || 'sandbox',
    webhookUrl: process.env.BINANCE_PAY_WEBHOOK_URL || WEBHOOK_BINANCE_URL
  }
};

const YEARLY_DISCOUNT = 0.95; // 5% cheaper than 12× monthly

function normalizeBillingCycle(billingCycle) {
  // Weekly billing has been retired. New flows: monthly or yearly only.
  // Legacy `weekly` (and unknown values) normalize to monthly.
  return billingCycle === 'yearly' ? 'yearly' : 'monthly';
}

function applyYearlyDiscount(amount) {
  return Math.round(Number(amount || 0) * 12 * YEARLY_DISCOUNT);
}

function getTierPricing(tierKey, billingCycle = 'monthly') {
  const tier = TIERS[tierKey];
  if (!tier) {
    throw new Error(`Invalid tier: ${tierKey}`);
  }

  const cycle = normalizeBillingCycle(billingCycle);
  if (cycle === 'yearly') {
    return {
      price: applyYearlyDiscount(tier.monthlyPrice),
      priceCents: applyYearlyDiscount(tier.priceCents),
      currency: tier.currency,
      currencyPayPal: tier.currencyPayPal,
      currencyBinance: tier.currencyBinance,
      periodDays: 365,
      billingCycle: 'yearly',
      periodLabel: 'year'
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
    const monthly = getTierPricing(key, 'monthly');
    const yearly = getTierPricing(key, 'yearly');
    publicTiers[key] = {
      name: tier.name,
      description: tier.description,
      features: tier.features,
      currency: tier.currency,
      currencyPayPal: tier.currencyPayPal,
      pricing: {
        monthly,
        yearly
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
    mpesa: {
      tillNumber: PAYMENT_CONFIG.mpesa.shortcode || '5337170',
      businessName: 'KachingFx Official',
      currency: 'KES',
      mode: 'manual_till'
    },
    manualMpesa: {
      tillNumber: PAYMENT_CONFIG.mpesa.shortcode || '5337170',
      businessName: 'KachingFx Official',
      currency: 'KES'
    },
    binance: {
      merchantId: PAYMENT_CONFIG.binance.merchantId || null,
      binanceId: '484947783',
      currency: 'USDT'
    },
    paypal: {
      currency: 'USD',
      mode: PAYMENT_CONFIG.paypal.mode || 'sandbox',
      configured: Boolean(
        PAYMENT_CONFIG.paypal.clientId && PAYMENT_CONFIG.paypal.clientSecret
      )
    },
    // Frontend must hide mock when this is false (always false in production)
    mockPaymentsAllowed,
    // Primary checkout is manual M-Pesa Till until automated gateways are re-enabled.
    defaultProvider: 'manual_mpesa'
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
  YEARLY_DISCOUNT,
  normalizeBillingCycle,
  applyYearlyDiscount,
  getTierPricing,
  getPublicTiers,
  getPublicPaymentMethods
};
