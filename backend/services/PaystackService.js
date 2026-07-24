const crypto = require('crypto');
const { PAYMENT_CONFIG, getTierPricing } = require('../config/subscriptions');

const PAYSTACK_API = 'https://api.paystack.co';

function isConfigured() {
  const { secretKey } = PAYMENT_CONFIG.paystack;
  return Boolean(secretKey);
}

function getPublicKey() {
  return PAYMENT_CONFIG.paystack.publicKey || null;
}

function authHeaders() {
  return {
    Authorization: `Bearer ${PAYMENT_CONFIG.paystack.secretKey}`,
    'Content-Type': 'application/json'
  };
}

/**
 * Paystack amounts are in the smallest currency unit (e.g. kobo/cents).
 * KES prices in config are whole shillings → multiply by 100.
 */
function toMinorUnits(amountKes) {
  return Math.round(Number(amountKes) * 100);
}

async function initializeTransaction({
  tier,
  userId,
  email,
  billingCycle = 'monthly',
  callbackUrl,
  reference
}) {
  if (!isConfigured()) {
    throw new Error('Paystack is not configured. Set PAYSTACK_SECRET_KEY in .env');
  }

  const pricing = getTierPricing(tier, billingCycle);
  const tierConfig = require('../config/subscriptions').TIERS[tier];
  if (!tierConfig) {
    throw new Error('Invalid subscription tier');
  }

  if (!email) {
    throw new Error('Customer email is required for Paystack');
  }

  const payload = {
    email: String(email).trim().toLowerCase(),
    amount: toMinorUnits(pricing.price),
    currency: pricing.currency || 'KES',
    callback_url: callbackUrl,
    reference: reference || undefined,
    metadata: {
      userId: String(userId),
      tier,
      billingCycle: pricing.billingCycle,
      periodLabel: pricing.periodLabel,
      custom_fields: [
        {
          display_name: 'Plan',
          variable_name: 'plan',
          value: `KachingFx ${tierConfig.name} (${pricing.periodLabel})`
        }
      ]
    }
  };

  const response = await fetch(`${PAYSTACK_API}/transaction/initialize`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload)
  });

  const data = await response.json();

  if (!response.ok || !data.status) {
    const message = data.message || JSON.stringify(data);
    throw new Error(`Paystack initialize failed: ${message}`);
  }

  return {
    reference: data.data.reference,
    accessCode: data.data.access_code,
    authorizationUrl: data.data.authorization_url,
    amount: pricing.price,
    currency: pricing.currency || 'KES'
  };
}

async function verifyTransaction(reference) {
  if (!isConfigured()) {
    throw new Error('Paystack is not configured');
  }

  const response = await fetch(
    `${PAYSTACK_API}/transaction/verify/${encodeURIComponent(reference)}`,
    {
      method: 'GET',
      headers: authHeaders()
    }
  );

  const data = await response.json();

  if (!response.ok || !data.status) {
    const message = data.message || JSON.stringify(data);
    throw new Error(`Paystack verify failed: ${message}`);
  }

  return data.data;
}

function isSuccessful(transaction) {
  return String(transaction?.status || '').toLowerCase() === 'success';
}

function parseMetadata(transaction) {
  const meta = transaction?.metadata || {};
  return {
    userId: meta.userId || null,
    tier: meta.tier || null,
    billingCycle: meta.billingCycle || 'monthly'
  };
}

function verifyWebhookSignature(req) {
  if (!isConfigured()) {
    return { ok: false, reason: 'paystack_not_configured' };
  }

  const signature =
    req.headers['x-paystack-signature'] ||
    req.headers['X-Paystack-Signature'];

  if (!signature) {
    return { ok: false, reason: 'missing_paystack_signature' };
  }

  const rawBody = req.rawBody
    ? req.rawBody.toString('utf8')
    : JSON.stringify(req.body || {});

  const hash = crypto
    .createHmac('sha512', PAYMENT_CONFIG.paystack.secretKey)
    .update(rawBody)
    .digest('hex');

  const a = Buffer.from(String(hash));
  const b = Buffer.from(String(signature));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'paystack_signature_invalid' };
  }

  return { ok: true };
}

function parseWebhookEvent(body) {
  const event = body?.event;
  const data = body?.data || {};
  const reference = data.reference;
  const metadata = data.metadata || {};

  return {
    event,
    reference,
    status: data.status,
    userId: metadata.userId || null,
    tier: metadata.tier || null,
    billingCycle: metadata.billingCycle || 'monthly',
    customerCode: data.customer?.customer_code || null,
    amount: data.amount,
    currency: data.currency,
    data
  };
}

module.exports = {
  isConfigured,
  getPublicKey,
  initializeTransaction,
  verifyTransaction,
  isSuccessful,
  parseMetadata,
  verifyWebhookSignature,
  parseWebhookEvent,
  toMinorUnits
};
