const crypto = require('crypto');
const { PAYMENT_CONFIG, getTierPricing, TIERS } = require('../config/subscriptions');
const { FRONTEND_URL, PUBLIC_BACKEND_URL } = require('../config/appUrls');

const LIVE_BASE = 'https://bpay.binanceapi.com';
const TEST_BASE = 'https://bpay.binanceapi.com';

function getBaseUrl() {
  return PAYMENT_CONFIG.binance.environment === 'production' ? LIVE_BASE : TEST_BASE;
}

function isConfigured() {
  const { apiKey, apiSecret } = PAYMENT_CONFIG.binance;
  return Boolean(apiKey && apiSecret);
}

function buildNonce() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

function signPayload(timestamp, nonce, body) {
  const payload = `${timestamp}\n${nonce}\n${body}\n`;
  return crypto.createHmac('sha512', PAYMENT_CONFIG.binance.apiSecret).update(payload).digest('hex').toUpperCase();
}

function buildHeaders(bodyString) {
  const timestamp = Date.now();
  const nonce = buildNonce();
  return {
    'Content-Type': 'application/json',
    'BinancePay-Timestamp': String(timestamp),
    'BinancePay-Nonce': nonce,
    'BinancePay-Certificate-SN': PAYMENT_CONFIG.binance.apiKey,
    'BinancePay-Signature': signPayload(timestamp, nonce, bodyString)
  };
}

async function signedPost(path, body) {
  const bodyString = JSON.stringify(body);
  const response = await fetch(`${getBaseUrl()}${path}`, {
    method: 'POST',
    headers: buildHeaders(bodyString),
    body: bodyString
  });
  const data = await response.json();
  if (!response.ok || data.status === 'FAIL') {
    const message = data.errorMessage || data.message || JSON.stringify(data);
    throw new Error(`Binance Pay request failed: ${message}`);
  }
  return data;
}

function buildMerchantTradeNo() {
  return `kfx${Date.now()}${crypto.randomBytes(3).toString('hex')}`.slice(0, 32);
}

async function createOrder({ tier, userId, billingCycle = 'monthly' }) {
  if (!isConfigured()) {
    throw new Error('Binance Pay is not configured. Set BINANCE_PAY_API_KEY and BINANCE_PAY_API_SECRET in .env');
  }

  const pricing = getTierPricing(tier, billingCycle);
  const tierConfig = TIERS[tier];
  if (!tierConfig) {
    throw new Error('Invalid subscription tier');
  }

  const merchantTradeNo = buildMerchantTradeNo();
  const amount = Number((pricing.priceCents / 100).toFixed(2));
  const passThroughInfo = `${userId}:${tier}:${pricing.billingCycle}`;

  const payload = {
    env: { terminalType: 'WEB' },
    merchantTradeNo,
    orderAmount: amount,
    currency: pricing.currencyBinance || 'USDT',
    goodsDetails: [
      {
        goodsType: '01',
        goodsCategory: 'Z000',
        referenceGoodsId: tier,
        goodsName: `KachingFx ${tierConfig.name} (${pricing.periodLabel})`,
        goodsDetail: 'Subscription payment'
      }
    ],
    returnUrl: `${PUBLIC_BACKEND_URL}/api/payments/binance/return?merchantTradeNo=${encodeURIComponent(merchantTradeNo)}`,
    cancelUrl: `${FRONTEND_URL}?binance=cancelled`,
    webhookUrl: PAYMENT_CONFIG.binance.webhookUrl,
    passThroughInfo
  };

  const data = await signedPost('/binancepay/openapi/v3/order', payload);
  const checkoutUrl = data.data?.checkoutUrl || data.data?.deeplink || data.data?.universalUrl;

  return {
    merchantTradeNo,
    prepayId: data.data?.prepayId,
    checkoutUrl,
    amount,
    currency: pricing.currencyBinance || 'USDT'
  };
}

async function queryOrder(merchantTradeNo) {
  const data = await signedPost('/binancepay/openapi/v2/order/query', { merchantTradeNo });
  return data.data || data;
}

function verifyWebhookSignature(rawBody, headers = {}) {
  if (!PAYMENT_CONFIG.binance.apiSecret) return false;
  const timestamp = headers['binancepay-timestamp'] || headers['BinancePay-Timestamp'];
  const nonce = headers['binancepay-nonce'] || headers['BinancePay-Nonce'];
  const signature = headers['binancepay-signature'] || headers['BinancePay-Signature'];
  if (!timestamp || !nonce || !signature) return false;

  const expected = signPayload(String(timestamp), String(nonce), rawBody);
  const provided = String(signature).toUpperCase();
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

function parseWebhookEvent(body) {
  const bizStatus = body?.bizStatus;
  const bizType = body?.bizType;
  let data = {};

  if (body?.data) {
    try {
      data = typeof body.data === 'string' ? JSON.parse(body.data) : body.data;
    } catch {
      data = {};
    }
  }

  return {
    bizType,
    bizStatus,
    merchantTradeNo: data.merchantTradeNo,
    transactionId: data.transactionId,
    totalFee: data.totalFee,
    currency: data.currency,
    passThroughInfo: data.passThroughInfo,
    rawData: data
  };
}

function isPaidStatus(orderData) {
  const status = String(orderData?.status || orderData?.orderStatus || '').toUpperCase();
  return status === 'PAID' || status === 'SUCCESS' || orderData?.bizStatus === 'PAY_SUCCESS';
}

module.exports = {
  isConfigured,
  createOrder,
  queryOrder,
  verifyWebhookSignature,
  parseWebhookEvent,
  isPaidStatus
};
