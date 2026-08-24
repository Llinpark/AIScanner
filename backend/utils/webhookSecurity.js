const crypto = require('crypto');
const { getEffectiveSubscription, isSubscriptionActive } = require('./subscriptionAccess');
const LicenseTokenService = require('../services/LicenseTokenService');

const {
  generateLicenseToken,
  verifyLicenseToken,
  verifyLicenseTokenDetailed,
  diagnoseLicenseToken,
  getLicenseSigningSecret,
  isSmokeOrDevSigningSecret,
  normalizeTradingViewUsername,
  timingSafeEqualString
} = LicenseTokenService;

function getSigningSecret() {
  return getLicenseSigningSecret();
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
  const { diagnoseTradingViewWebhookBody } = require('./webhookPipelineDiag');

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
      const diagnosed = diagnoseTradingViewWebhookBody(raw);
      return {
        __parseError: true,
        __rawPreview: raw.slice(0, 80),
        __parseReason: diagnosed.reason,
        __parseKind: diagnosed.kind,
        __parseHint: diagnosed.hint,
        __placeholder: diagnosed.placeholder || null
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
   * 2) Per-user licenseToken (kls_v2.* / legacy kls_v1.*) — preferred for TradingView alert JSON
   * 3) Legacy global TRADINGVIEW_WEBHOOK_SECRET — anonymous use disabled in production
   *    unless ALLOW_LEGACY_WEBHOOK_SECRET=true; Pine scripts that embed both a
   *    licenseToken and secret may fall back to the secret when the token is stale
   *
   * License tokens bind uid + TradingView username (tvu) + env. Payload must include
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
      reason:
        body.__parseReason === 'empty_body'
          ? 'empty_body'
          : body.__parseReason === 'unexpanded_tv_placeholder'
            ? 'unexpanded_tv_placeholder'
            : 'invalid_json',
      body: {},
      parseError: true,
      rawPreview: body.__rawPreview || null,
      parseKind: body.__parseKind || null,
      parseHint: body.__parseHint || null,
      placeholder: body.__placeholder || null
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
    const verified = verifyLicenseTokenDetailed(licenseToken);
    const claims = verified.ok ? verified.claims : null;
    if (claims) {
      const licenseDiagnostics = verified.diagnostics || diagnoseLicenseToken(licenseToken);
      if (bodyUserId && String(bodyUserId) !== String(claims.uid)) {
        return { ok: false, reason: 'license_user_mismatch', licenseDiagnostics, body };
      }

      // v2+ tokens bind TradingView username; reject legacy tokens and mismatches.
      if (!claims.tvu) {
        return { ok: false, reason: 'license_requires_tv_username', licenseDiagnostics, body };
      }
      if (!bodyTvUsername || bodyTvUsername !== claims.tvu) {
        return { ok: false, reason: 'license_tv_username_mismatch', licenseDiagnostics, body };
      }

      if (resolveUserById) {
        const user = await resolveUserById(claims.uid);
        // Admins get an effective active premium sub — never check raw DB subscription alone.
        if (!user || !isSubscriptionActive(getEffectiveSubscription(user))) {
          return { ok: false, reason: 'inactive_subscription', licenseDiagnostics, body };
        }

        const storedTv = normalizeTradingViewUsername(
          user.tradingviewUsername || user.preferences?.tradingviewUsername || ''
        );
        if (!storedTv || storedTv !== claims.tvu) {
          return { ok: false, reason: 'stored_tv_username_mismatch', licenseDiagnostics, body };
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

    return {
      ok: false,
      reason: verified.reason || 'invalid_license_token',
      licenseDiagnostics: verified.diagnostics || null,
      body
    };
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
  verifyLicenseTokenDetailed,
  diagnoseLicenseToken,
  getSigningSecret,
  isSmokeOrDevSigningSecret,
  signRequestBody,
  verifyRequestSignature,
  verifyTradingViewWebhook,
  parseWebhookBody,
  normalizeTradingViewUsername
};
