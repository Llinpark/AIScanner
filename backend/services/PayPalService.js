const { PAYMENT_CONFIG, getTierPricing } = require('../config/subscriptions');

function getBaseUrl() {
  return PAYMENT_CONFIG.paypal.mode === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

function isConfigured() {
  const { clientId, clientSecret } = PAYMENT_CONFIG.paypal;
  return Boolean(clientId && clientSecret);
}

async function getAccessToken() {
  const { clientId, clientSecret } = PAYMENT_CONFIG.paypal;
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch(`${getBaseUrl()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`PayPal OAuth failed: ${text}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function createOrder({ tier, userId, returnUrl, cancelUrl, billingCycle = 'monthly' }) {
  if (!isConfigured()) {
    throw new Error('PayPal is not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env');
  }

  const pricing = getTierPricing(tier, billingCycle);
  const tierConfig = require('../config/subscriptions').TIERS[tier];
  if (!tierConfig) {
    throw new Error('Invalid subscription tier');
  }

  const amount = (pricing.priceCents / 100).toFixed(2);
  const token = await getAccessToken();

  const payload = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: userId,
        description: `KachingFx ${tierConfig.name} (${pricing.periodLabel})`,
        custom_id: `${userId}:${tier}:${pricing.billingCycle}`,
        amount: {
          currency_code: pricing.currencyPayPal || 'USD',
          value: amount
        }
      }
    ],
    application_context: {
      brand_name: 'KachingFx',
      landing_page: 'NO_PREFERENCE',
      user_action: 'PAY_NOW',
      return_url: returnUrl,
      cancel_url: cancelUrl
    }
  };

  const response = await fetch(`${getBaseUrl()}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();

  if (!response.ok) {
    const message = data.message || JSON.stringify(data);
    throw new Error(`PayPal order creation failed: ${message}`);
  }

  const approveLink = (data.links || []).find(link => link.rel === 'approve');

  return {
    orderId: data.id,
    status: data.status,
    approveUrl: approveLink?.href
  };
}

async function captureOrder(orderId) {
  const token = await getAccessToken();

  const response = await fetch(`${getBaseUrl()}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  const data = await response.json();

  if (!response.ok) {
    const message = data.message || JSON.stringify(data);
    throw new Error(`PayPal capture failed: ${message}`);
  }

  return data;
}

function parseWebhookEvent(body) {
  const eventType = body?.event_type;
  const resource = body?.resource || {};

  if (eventType === 'CHECKOUT.ORDER.APPROVED' || eventType === 'PAYMENT.CAPTURE.COMPLETED') {
    const customId = resource.purchase_units?.[0]?.custom_id || resource.custom_id;
    const orderId = resource.id || resource.supplementary_data?.related_ids?.order_id;
    return { eventType, customId, orderId, resource };
  }

  return { eventType, resource };
}

module.exports = {
  isConfigured,
  createOrder,
  captureOrder,
  parseWebhookEvent
};
