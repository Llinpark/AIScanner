const crypto = require('crypto');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeErrorMessage(error, fallback = 'An unexpected error occurred.') {
  if (!IS_PRODUCTION && error?.message) {
    return error.message;
  }
  return fallback;
}

function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function sanitizeMongoInput(value) {
  if (value == null) return value;
  if (Array.isArray(value)) {
    return value.map(item => sanitizeMongoInput(item));
  }
  if (typeof value !== 'object') return value;

  const clean = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key.startsWith('$') || key.includes('.')) continue;
    clean[key] = sanitizeMongoInput(nested);
  }
  return clean;
}

function isMockPaymentsAllowed() {
  if (process.env.ALLOW_MOCK_PAYMENTS === 'true') return true;
  if (IS_PRODUCTION) return false;
  const { PAYMENT_CONFIG } = require('../config/subscriptions');
  return PAYMENT_CONFIG.mode === 'mock';
}

function verifyPaymentWebhookSecret(req) {
  const expected = process.env.PAYMENT_WEBHOOK_SECRET || '';
  if (!expected) return !IS_PRODUCTION;

  const provided =
    req.headers['x-payment-webhook-secret'] ||
    req.headers['x-webhook-secret'] ||
    req.body?.secret ||
    '';

  return timingSafeEqualString(String(provided), expected);
}

function assertProductionSecurityConfig() {
  const issues = [];

  if (IS_PRODUCTION) {
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'dev-secret-change-in-production') {
      issues.push('JWT_SECRET must be set to a strong value in production.');
    }
    if (!process.env.WEBHOOK_SIGNING_SECRET && !process.env.TRADINGVIEW_WEBHOOK_SECRET) {
      issues.push('WEBHOOK_SIGNING_SECRET (or TRADINGVIEW_WEBHOOK_SECRET) must be set in production.');
    }
    if (process.env.PAYMENTS_MODE === 'mock' || process.env.ALLOW_MOCK_PAYMENTS === 'true') {
      issues.push('Mock payments must be disabled in production (set PAYMENTS_MODE=live and unset ALLOW_MOCK_PAYMENTS).');
    }
    if (!process.env.PAYSTACK_SECRET_KEY) {
      issues.push('PAYSTACK_SECRET_KEY should be set in production for live checkout.');
    }
    if (!process.env.PAYMENT_WEBHOOK_SECRET) {
      issues.push('PAYMENT_WEBHOOK_SECRET should be set in production.');
    }
    if (process.env.ALLOW_LEGACY_WEBHOOK_SECRET === 'true') {
      issues.push('ALLOW_LEGACY_WEBHOOK_SECRET should not be enabled in production.');
    }
  }

  if (issues.length) {
    console.error('[Security] Production configuration issues:');
    issues.forEach(issue => console.error(`  - ${issue}`));
    if (IS_PRODUCTION) {
      process.exit(1);
    }
  }
}

module.exports = {
  IS_PRODUCTION,
  escapeRegex,
  safeErrorMessage,
  timingSafeEqualString,
  sanitizeMongoInput,
  isMockPaymentsAllowed,
  verifyPaymentWebhookSecret,
  assertProductionSecurityConfig
};
