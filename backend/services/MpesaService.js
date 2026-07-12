const { PAYMENT_CONFIG } = require('../config/subscriptions');

const SANDBOX_BASE = 'https://sandbox.safaricom.co.ke';
const LIVE_BASE = 'https://api.safaricom.co.ke';

function getBaseUrl() {
  return PAYMENT_CONFIG.mpesa.environment === 'production' ? LIVE_BASE : SANDBOX_BASE;
}

function normalizePhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('0')) {
    digits = `254${digits.slice(1)}`;
  } else if (digits.startsWith('7') || digits.startsWith('1')) {
    digits = `254${digits}`;
  } else if (!digits.startsWith('254')) {
    digits = `254${digits}`;
  }
  if (digits.length !== 12) {
    throw new Error('Invalid phone number. Use format 2547XXXXXXXX or 07XXXXXXXX');
  }
  return digits;
}

function isConfigured() {
  const { consumerKey, consumerSecret, passkey, shortcode } = PAYMENT_CONFIG.mpesa;
  return Boolean(consumerKey && consumerSecret && passkey && shortcode);
}

async function getAccessToken() {
  const { consumerKey, consumerSecret } = PAYMENT_CONFIG.mpesa;
  const credentials = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

  const response = await fetch(`${getBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`M-Pesa OAuth failed: ${text}`);
  }

  const data = await response.json();
  return data.access_token;
}

function buildPassword(shortcode, passkey) {
  const timestamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, '')
    .slice(0, 14);
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
  return { password, timestamp };
}

async function initiateStkPush({ phone, amount, accountReference, description }) {
  if (!isConfigured()) {
    throw new Error('M-Pesa is not configured. Set MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_PASSKEY, and MPESA_SHORTCODE in .env');
  }

  const { shortcode, passkey, callbackUrl, transactionType } = PAYMENT_CONFIG.mpesa;
  const phoneNumber = normalizePhone(phone);
  const token = await getAccessToken();
  const { password, timestamp } = buildPassword(shortcode, passkey);

  const payload = {
    BusinessShortCode: shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: transactionType,
    Amount: Math.round(amount),
    PartyA: phoneNumber,
    PartyB: shortcode,
    PhoneNumber: phoneNumber,
    CallBackURL: callbackUrl,
    AccountReference: String(accountReference).slice(0, 12),
    TransactionDesc: String(description || 'KachingFx Subscription').slice(0, 13)
  };

  const response = await fetch(`${getBaseUrl()}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();

  if (!response.ok || data.errorCode || data.ResponseCode !== '0') {
    const message = data.errorMessage || data.ResponseDescription || JSON.stringify(data);
    throw new Error(`M-Pesa STK Push failed: ${message}`);
  }

  return {
    checkoutRequestId: data.CheckoutRequestID,
    merchantRequestId: data.MerchantRequestID,
    responseDescription: data.ResponseDescription,
    customerMessage: data.CustomerMessage
  };
}

function parseStkCallback(body) {
  const callback = body?.Body?.stkCallback;
  if (!callback) {
    return null;
  }

  const result = {
    merchantRequestId: callback.MerchantRequestID,
    checkoutRequestId: callback.CheckoutRequestID,
    resultCode: callback.ResultCode,
    resultDesc: callback.ResultDesc,
    amount: null,
    mpesaReceiptNumber: null,
    phoneNumber: null,
    transactionDate: null
  };

  const items = callback.CallbackMetadata?.Item || [];
  for (const item of items) {
    if (item.Name === 'Amount') result.amount = item.Value;
    if (item.Name === 'MpesaReceiptNumber') result.mpesaReceiptNumber = item.Value;
    if (item.Name === 'PhoneNumber') result.phoneNumber = item.Value;
    if (item.Name === 'TransactionDate') result.transactionDate = item.Value;
  }

  return result;
}

module.exports = {
  isConfigured,
  normalizePhone,
  initiateStkPush,
  parseStkCallback
};
