const { PAYMENT_CONFIG } = require('../config/subscriptions');
const MpesaService = require('./MpesaService');

function getBaseUrl() {
  return PAYMENT_CONFIG.sasapay.baseUrl.replace(/\/$/, '');
}

function isConfigured() {
  const { clientId, clientSecret, merchantCode } = PAYMENT_CONFIG.sasapay;
  return Boolean(clientId && clientSecret && merchantCode);
}

async function getAccessToken() {
  const { clientId, clientSecret } = PAYMENT_CONFIG.sasapay;
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch(`${getBaseUrl()}/auth/token/?grant_type=client_credentials`, {
    method: 'GET',
    headers: {
      Authorization: `Basic ${credentials}`,
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SasaPay OAuth failed: ${text}`);
  }

  const data = await response.json();
  const token = data.access_token || data.accessToken || data.token;
  if (!token) {
    throw new Error('SasaPay OAuth response did not include an access token');
  }
  return token;
}

async function initiateRequestPayment({ phone, amount, accountReference, description }) {
  if (!isConfigured()) {
    throw new Error('SasaPay is not configured. Set SASAPAY_CLIENT_ID, SASAPAY_CLIENT_SECRET, and SASAPAY_MERCHANT_CODE in .env');
  }

  const { merchantCode, networkCode, callbackUrl, currency } = PAYMENT_CONFIG.sasapay;
  const phoneNumber = MpesaService.normalizePhone(phone);
  const token = await getAccessToken();

  const payload = {
    MerchantCode: merchantCode,
    NetworkCode: networkCode,
    Currency: currency,
    Amount: Number(amount).toFixed(2),
    PhoneNumber: phoneNumber,
    AccountReference: String(accountReference).slice(0, 20),
    TransactionDesc: String(description || 'KachingFx Subscription').slice(0, 50),
    CallBackURL: callbackUrl
  };

  const response = await fetch(`${getBaseUrl()}/payments/request-payment/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  const responseCode = String(
    data.responseCode ?? data.ResponseCode ?? data.statusCode ?? data.status ?? ''
  );

  if (!response.ok || (responseCode && responseCode !== '0' && responseCode.toLowerCase() !== 'success')) {
    const message =
      data.detail ||
      data.message ||
      data.ResponseDescription ||
      data.responseDescription ||
      JSON.stringify(data);
    throw new Error(`SasaPay request payment failed: ${message}`);
  }

  const checkoutRequestId =
    data.CheckoutRequestID ||
    data.checkoutRequestID ||
    data.checkoutRequestId ||
    data.TransactionReference ||
    data.transactionReference;

  const merchantRequestId =
    data.MerchantRequestID ||
    data.merchantRequestID ||
    data.merchantRequestId ||
    data.requestId;

  return {
    checkoutRequestId,
    merchantRequestId,
    customerMessage:
      data.CustomerMessage ||
      data.customerMessage ||
      data.detail ||
      'SasaPay payment request sent. Check your phone to approve the payment.',
    raw: data
  };
}

function parseCallback(body) {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const resultCode = String(
    body.ResultCode ?? body.resultCode ?? body.responseCode ?? body.ResponseCode ?? ''
  );
  const checkoutRequestId =
    body.CheckoutRequestID ||
    body.checkoutRequestID ||
    body.checkoutRequestId ||
    body.TransactionReference ||
    body.transactionReference;

  return {
    checkoutRequestId,
    merchantRequestId: body.MerchantRequestID || body.merchantRequestID || body.merchantRequestId,
    resultCode,
    resultDesc: body.ResultDesc || body.resultDesc || body.detail || body.message,
    transactionCode:
      body.TransactionCode ||
      body.transactionCode ||
      body.ThirdPartyTransID ||
      body.thirdPartyTransID,
    amount: body.Amount || body.amount,
    phoneNumber: body.PhoneNumber || body.phoneNumber,
    success: resultCode === '0' || String(body.status || '').toLowerCase() === 'success'
  };
}

module.exports = {
  isConfigured,
  initiateRequestPayment,
  parseCallback
};
