const crypto = require('crypto');
const { getEffectiveSubscription, isSubscriptionActive } = require('./subscriptionAccess');

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

function normalizeTradingViewUsername(value) {
  return String(value || '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase();
}

/**
 * @param {string} userId
 * @param {string} tradingviewUsername Required — bound into the HMAC payload (tvu).
 */
function generateLicenseToken(userId, tradingviewUsername) {
  const signingSecret = getSigningSecret();
  const tvu = normalizeTradingViewUsername(tradingviewUsername);
  if (!signingSecret || !userId) {
    throw new Error('Cannot generate license token without signing secret and user id');
  }
  if (!tvu) {
    throw new Error('Cannot generate license token without TradingView username');
  }

  const payload = {
    uid: String(userId),
    tvu,
    v: 2,
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
    if (payload.tvu) {
      payload.tvu = normalizeTradingViewUsername(payload.tvu);
    }
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
    const raw = String(req.body || '').replace(/^\uFEFF/, '').trim();
    // Empty body must NOT silently become {} — that collapses to opaque unauthorized.
    if (!raw) {
      return { __parseError: true, __rawPreview: '', __parseReason: 'empty_body' };
    }
    try {
      return JSON.parse(raw);
    } catch {
      // TradingView sometimes wraps JSON in quotes or sends human text — try unwrap once.
      if (
        (raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))
      ) {
        try {
          const unwrapped = JSON.parse(raw);
          if (typeof unwrapped === 'string') {
            const inner = unwrapped.replace(/^\uFEFF/, '').trim();
            if (!inner) {
              return { __parseError: true, __rawPreview: '', __parseReason: 'empty_body' };
            }
            return JSON.parse(inner);
          }
        } catch {
          /* fall through */
        }
      }
      return {
        __parseError: true,
        __rawPreview: raw.slice(0, 80),
        __parseReason: 'invalid_json'
      };
    }
  }

  if (req.body && typeof req.body === 'object') {
    // Express may give {} for truly empty JSON bodies — treat as empty intake.
    if (
      !Array.isArray(req.body) &&
      Object.keys(req.body).length === 0 &&
      !(Buffer.isBuffer(req.rawBody) && req.rawBody.length > 2)
    ) {
      return { __parseError: true, __rawPreview: '', __parseReason: 'empty_body' };
    }
    return req.body;
  }

  return { __parseError: true, __rawPreview: '', __parseReason: 'empty_body' };
}

function verifyGlobalWebhookSecret(req, body, { allowInProduction = false } = {}) {
  const globalSecret = process.env.TRADINGVIEW_WEBHOOK_SECRET || '';
  if (!globalSecret) return false;

  // Primary anonymous secret auth stays gated in production. Callers may opt into
  // allowInProduction for Pine fallback after a stale/invalid licenseToken.
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.ALLOW_LEGACY_WEBHOOK_SECRET !== 'true' &&
    !allowInProduction
  ) {
    return false;
  }

  const headerSecret = req.headers['x-tradingview-secret'];
  const bodySecret = body.secret;
  return (
    timingSafeEqualString(String(headerSecret || ''), globalSecret) ||
    timingSafeEqualString(String(bodySecret || ''), globalSecret)
  );
}

function extractBodyTradingViewUsername(body) {
  return normalizeTradingViewUsername(
    body.tradingviewUsername || body.tradingview_username || body.username || body.user || body.trader || ''
  );
}

async function verifyTradingViewWebhook(req, resolveUserById) {
  /**
   * Auth order (harden server-side without mass-breaking Pine scripts):
   * 1) HMAC body signature (x-kaching-signature) — preferred for server-to-server
   * 2) Per-user licenseToken (kls_v1.*) — preferred for TradingView alert JSON
   * 3) Legacy global TRADINGVIEW_WEBHOOK_SECRET — anonymous use disabled in production
   *    unless ALLOW_LEGACY_WEBHOOK_SECRET=true; Pine scripts that embed both a
   *    licenseToken and secret may fall back to the secret when the token is stale
   *
   * License tokens (v2) bind uid + TradingView username (tvu). Payload must include
   * the same tradingviewUsername, and the subscriber account must still store that
   * username with an active (or admin-effective) subscription.
   *
   * Rotation: rotate WEBHOOK_SIGNING_SECRET carefully — regenerating signing secret
   * invalidates all existing licenseTokens; users must re-copy Pine / alert JSON.
   * Prefer rotating TRADINGVIEW_WEBHOOK_SECRET first (legacy only), then schedule
   * license re-issue. Auth failures are rate-limited in server.js.
   */
  const body = parseWebhookBody(req);
  if (body && body.__parseError) {
    return {
      ok: false,
      reason: body.__parseReason === 'empty_body' ? 'empty_body' : 'invalid_json',
      body: {},
      parseError: true,
      rawPreview: body.__rawPreview || null
    };
  }
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(body), 'utf8');
  const bodyUserId = body.userId || body.user_id;
  const bodyTvUsername = extractBodyTradingViewUsername(body);

  const signatureHeader =
    req.headers?.['x-kaching-signature'] || req.headers?.['x-webhook-signature'];
  if (signatureHeader && verifyRequestSignature(rawBody, signatureHeader)) {
    return { ok: true, mode: 'signature', body, userId: bodyUserId || null };
  }

  const licenseToken = body.licenseToken || body.license_token;
  if (licenseToken) {
    const claims = verifyLicenseToken(licenseToken);
    if (claims) {
      if (bodyUserId && String(bodyUserId) !== String(claims.uid)) {
        return { ok: false, reason: 'license_user_mismatch', body };
      }

      // v2+ tokens bind TradingView username; reject legacy tokens and mismatches.
      if (!claims.tvu) {
        return { ok: false, reason: 'license_requires_tv_username', body };
      }
      if (!bodyTvUsername || bodyTvUsername !== claims.tvu) {
        return { ok: false, reason: 'license_tv_username_mismatch', body };
      }

      if (resolveUserById) {
        const user = await resolveUserById(claims.uid);
        // Admins get an effective active premium sub — never check raw DB subscription alone.
        if (!user || !isSubscriptionActive(getEffectiveSubscription(user))) {
          return { ok: false, reason: 'inactive_subscription', body };
        }

        const storedTv = normalizeTradingViewUsername(
          user.tradingviewUsername || user.preferences?.tradingviewUsername || ''
        );
        if (!storedTv || storedTv !== claims.tvu) {
          return { ok: false, reason: 'stored_tv_username_mismatch', body };
        }
      }

      return {
        ok: true,
        mode: 'license',
        body,
        userId: claims.uid,
        tradingviewUsername: claims.tvu
      };
    }

    // New Pine scripts do not embed a global webhook secret (licenseToken only).
    // Legacy scripts may still send secret — allow only when explicitly enabled.
    if (
      process.env.ALLOW_LEGACY_WEBHOOK_SECRET === 'true' &&
      verifyGlobalWebhookSecret(req, body, { allowInProduction: true })
    ) {
      return {
        ok: true,
        mode: 'global_secret_fallback',
        body,
        userId: bodyUserId || null
      };
    }

    return { ok: false, reason: 'invalid_license_token', body };
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
  parseWebhookBody,
  normalizeTradingViewUsername
};
