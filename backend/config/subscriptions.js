// Subscription tier definitions and pricing
const TIERS = {
  basic: {
    name: 'Basic',
    price: 900, // KES or in USD converted to cents for PayPal
    priceCents: 1000, // PayPal price in cents (USD)
    currency: 'KES',
    currencyPayPal: 'USD',
    duration: 'monthly',
    description: 'Essential trading signals',
    features: [
      'Live signal dashboard (web)',
      'TradingView alert setup guide',
      'Live Entry / SL / TP1–TP3 alerts',
      'Real-time WebSocket updates',
      '7-day signal history',
      'Community support'
    ]
  },
  professional: {
    name: 'Professional',
    price: 3900, // KES
    priceCents: 4500, // PayPal price in cents (USD)
    currency: 'KES',
    currencyPayPal: 'USD',
    duration: 'monthly',
    description: 'Advanced signals with API access',
    features: [
      'All Basic features',
      'Advanced indicators (RSI, MACD, Bollinger)',
      'Confidence score visibility',
      'REST API access (last 100 signals)',
      'Webhook forwarding',
      'Priority processing',
      '30-day signal history',
      'Priority email support'
    ]
  },
  premium: {
    name: 'Premium',
    price: 10000, // KES
    priceCents: 12500, // PayPal price in cents (USD)
    currency: 'KES',
    currencyPayPal: 'USD',
    duration: 'monthly',
    description: 'Full-featured with ML and custom integrations',
    features: [
      'All Professional features',
      'ML model-driven signals',
      'Risk-point tuning',
      '90+ day signal storage',
      'Export signals (CSV/JSON)',
      'Custom webhook targets',
      'Guaranteed delivery (SLA)',
      'Dedicated support channel',
      'Preference/profile customization',
      'White-glove onboarding'
    ]
  }
};

const TRIAL_DAYS = 7; // 7-day free trial

const PAYMENT_CONFIG = {
  mode: process.env.PAYMENTS_MODE || 'mock', // 'mock', 'mpesa', 'paypal', or 'live'
  mpesa: {
    consumerKey: process.env.MPESA_CONSUMER_KEY,
    consumerSecret: process.env.MPESA_CONSUMER_SECRET,
    shortcode: process.env.MPESA_SHORTCODE,
    passkey: process.env.MPESA_PASSKEY,
    callbackUrl: process.env.MPESA_CALLBACK_URL || 'http://localhost:4000/api/webhook/mpesa'
  },
  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID,
    clientSecret: process.env.PAYPAL_CLIENT_SECRET,
    mode: process.env.PAYPAL_MODE || 'sandbox', // 'sandbox' or 'live'
    webhookId: process.env.PAYPAL_WEBHOOK_ID
  }
};

module.exports = {
  TIERS,
  TRIAL_DAYS,
  PAYMENT_CONFIG
};
