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

/**
 * Shared secret for payment completion webhooks that lack native signatures
 * (M-Pesa Daraja). Prefer header; query is supported because those
 * providers only POST to CallBackURL and cannot send custom headers.
 */
function resolvePaymentWebhookSecret(provider) {
  const key = String(provider || '').toLowerCase();
  if (key === 'mpesa' && process.env.MPESA_WEBHOOK_SECRET) {
    return process.env.MPESA_WEBHOOK_SECRET;
  }
  return process.env.PAYMENT_WEBHOOK_SECRET || '';
}

function extractProvidedWebhookSecret(req) {
  return (
    req.headers['x-payment-webhook-secret'] ||
    req.headers['x-webhook-secret'] ||
    req.query?.webhook_secret ||
    req.query?.secret ||
    req.body?.secret ||
    ''
  );
}

function verifyPaymentWebhookSecret(req, provider) {
  const expected = resolvePaymentWebhookSecret(provider);
  if (!expected) return !IS_PRODUCTION;
  return timingSafeEqualString(String(extractProvidedWebhookSecret(req)), expected);
}

/** Embed shared secret in CallBackURL so Daraja can authenticate without custom headers. */
function appendWebhookSecretToUrl(url, provider) {
  const secret = resolvePaymentWebhookSecret(provider);
  if (!url || !secret) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.get('webhook_secret') && !parsed.searchParams.get('secret')) {
      parsed.searchParams.set('webhook_secret', secret);
    }
    return parsed.toString();
  } catch {
    const sep = String(url).includes('?') ? '&' : '?';
    return `${url}${sep}webhook_secret=${encodeURIComponent(secret)}`;
  }
}

function ipv4ToInt(ip) {
  const parts = String(ip || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function ipMatchesCidr(ip, cidr) {
  const [range, bitsRaw] = String(cidr || '').split('/');
  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(range);
  if (ipInt == null || rangeInt == null) {
    return String(ip) === String(cidr);
  }
  const bits = bitsRaw == null ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

function getClientIp(req) {
  return (
    req.headers['fly-client-ip'] ||
    (String(req.headers['x-forwarded-for'] || '').split(',')[0] || '').trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    ''
  );
}

/** Default Safaricom Daraja egress ranges (override via MPESA_WEBHOOK_IP_ALLOWLIST). */
const DEFAULT_MPESA_IP_ALLOWLIST = ['196.201.214.0/24', '196.201.213.0/24'];

function parseIpAllowlist(raw, fallback = []) {
  const list = String(raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return list.length ? list : fallback;
}

function isClientIpAllowed(req, allowlist) {
  if (!allowlist?.length) return true;
  const ip = String(getClientIp(req)).replace(/^::ffff:/, '');
  return allowlist.some(entry => ipMatchesCidr(ip, entry));
}

/**
 * Verify M-Pesa (and generic payment) webhooks before activating subscriptions.
 * Fail closed in production when secret is missing or wrong.
 * Optional IP allowlist is additive — never a substitute for the shared secret.
 */
function verifyProviderPaymentWebhook(req, provider) {
  const key = String(provider || '').toLowerCase();
  if (!verifyPaymentWebhookSecret(req, key)) {
    return { ok: false, reason: 'invalid_webhook_secret' };
  }

  // Optional IP allowlist (opt-in). Shared secret is the primary control — Safaricom
  // IP ranges change and Fly's Fly-Client-IP must be trusted before enabling this.
  const verifyIpFlag =
    key === 'mpesa'
      ? process.env.MPESA_WEBHOOK_VERIFY_IP
      : process.env.PAYMENT_WEBHOOK_VERIFY_IP;

  if (verifyIpFlag === 'true') {
    const allowlist =
      key === 'mpesa'
        ? parseIpAllowlist(process.env.MPESA_WEBHOOK_IP_ALLOWLIST, DEFAULT_MPESA_IP_ALLOWLIST)
        : parseIpAllowlist(process.env.PAYMENT_WEBHOOK_IP_ALLOWLIST, []);

    if (allowlist.length && !isClientIpAllowed(req, allowlist)) {
      return { ok: false, reason: 'ip_not_allowed', ip: getClientIp(req) };
    }
  }

  return { ok: true };
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
    if (!process.env.PAYMENT_WEBHOOK_SECRET) {
      issues.push('PAYMENT_WEBHOOK_SECRET must be set in production (M-Pesa callback auth).');
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

  if (IS_PRODUCTION && process.env.PYTHON_SERVICE_URL && !process.env.PYTHON_SERVICE_API_KEY) {
    console.warn(
      '[Security] PYTHON_SERVICE_API_KEY is unset while PYTHON_SERVICE_URL is set — FastAPI /signal should require a shared key.'
    );
  }

  // Soft notice only — PayPal is the primary card checkout path
  if (IS_PRODUCTION && (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET)) {
    console.warn('[Security] PayPal live checkout disabled until PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are set.');
  }
}

module.exports = {
  IS_PRODUCTION,
  escapeRegex,
  safeErrorMessage,
  timingSafeEqualString,
  sanitizeMongoInput,
  isMockPaymentsAllowed,
  resolvePaymentWebhookSecret,
  appendWebhookSecretToUrl,
  verifyPaymentWebhookSecret,
  verifyProviderPaymentWebhook,
  getClientIp,
  assertProductionSecurityConfig
};
