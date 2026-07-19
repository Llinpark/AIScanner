const crypto = require('crypto');
const { isSubscriptionActive } = require('./subscriptionAccess');

const LICENSE_PREFIX = 'kls_v1';

function getSigningSecret() {
  const secret = process.env.WEBHOOK_SIGNING_SECRET || process.env.TRADINGVIEW_WEBHOOK_SECRET || '';
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') return '';
  return process.env.JWT_SECRET || '';
}

function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function generateLicenseToken(userId) {
  const signingSecret = getSigningSecret();
  if (!signingSecret || !userId) {
    throw new Error('Cannot generate license token without signing secret and user id');
  }

  const payload = {
    uid: String(userId),
    v: 1,
    iat: Math.floor(Date.now() / 1000)
  };

  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', signingSecret).update(encoded).digest('base64url');
  return `${LICENSE_PREFIX}.${encoded}.${signature}`;
}

function verifyLicenseToken(token) {
  const signingSecret = getSigningSecret();
  if (!signingSecret || !token) return null;

  const parts = String(token).split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) return null;

  const [, encoded, signature] = parts;
  const expected = crypto.createHmac('sha256', signingSecret).update(encoded).digest('base64url');
  if (!timingSafeEqualString(signature, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload?.uid) return null;
    return payload;
  } catch {
    return null;
  }
}

function signRequestBody(rawBody) {
  const signingSecret = getSigningSecret();
  if (!signingSecret) return null;

  const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  const digest = crypto.createHmac('sha256', signingSecret).update(bodyBuffer).digest('hex');
  return `sha256=${digest}`;
}

function verifyRequestSignature(rawBody, headerValue) {
  const signingSecret = getSigningSecret();
  if (!signingSecret || !headerValue) return false;

  const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  const expectedDigest = crypto.createHmac('sha256', signingSecret).update(bodyBuffer).digest('hex');
  const provided = String(headerValue).trim().replace(/^sha256=/i, '');

  return timingSafeEqualString(provided, expectedDigest);
}

function parseWebhookBody(req) {
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  if (req.body && typeof req.body === 'object') {
    return req.body;
  }

  return {};
}

function verifyGlobalWebhookSecret(req, body) {
  const globalSecret = process.env.TRADINGVIEW_WEBHOOK_SECRET || '';
  if (!globalSecret) return false;

  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_LEGACY_WEBHOOK_SECRET !== 'true') {
    return false;
  }

  const headerSecret = req.headers['x-tradingview-secret'];
  const bodySecret = body.secret;
  return (
    timingSafeEqualString(String(headerSecret || ''), globalSecret) ||
    timingSafeEqualString(String(bodySecret || ''), globalSecret)
  );
}

async function verifyTradingViewWebhook(req, resolveUserById) {
  const body = parseWebhookBody(req);
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(body), 'utf8');
  const bodyUserId = body.userId || body.user_id;

  const signatureHeader = req.headers['x-kaching-signature'] || req.headers['x-webhook-signature'];
  if (signatureHeader && verifyRequestSignature(rawBody, signatureHeader)) {
    return { ok: true, mode: 'signature', body, userId: bodyUserId || null };
  }

  const licenseToken = body.licenseToken || body.license_token;
  if (licenseToken) {
    const claims = verifyLicenseToken(licenseToken);
    if (!claims) {
      return { ok: false, reason: 'invalid_license_token', body };
    }

    if (bodyUserId && String(bodyUserId) !== String(claims.uid)) {
      return { ok: false, reason: 'license_user_mismatch', body };
    }

    if (resolveUserById) {
      const user = await resolveUserById(claims.uid);
      if (!user || !isSubscriptionActive(user.subscription)) {
        return { ok: false, reason: 'inactive_subscription', body };
      }
    }

    return { ok: true, mode: 'license', body, userId: claims.uid };
  }

  if (bodyUserId) {
    return { ok: false, reason: 'license_required_for_user_payload', body };
  }

  if (verifyGlobalWebhookSecret(req, body)) {
    return { ok: true, mode: 'global_secret', body, userId: null };
  }

  return { ok: false, reason: 'unauthorized', body };
}

module.exports = {
  generateLicenseToken,
  verifyLicenseToken,
  signRequestBody,
  verifyRequestSignature,
  verifyTradingViewWebhook,
  parseWebhookBody
};
