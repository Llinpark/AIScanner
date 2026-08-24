const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

describe('verifyTradingViewWebhook', () => {
  let generateLicenseToken;
  let verifyTradingViewWebhook;
  let diagnoseLicenseToken;
  let verifyLicenseToken;
  let previousEnv;

  before(() => {
    previousEnv = {
      NODE_ENV: process.env.NODE_ENV,
      WEBHOOK_SIGNING_SECRET: process.env.WEBHOOK_SIGNING_SECRET,
      TRADINGVIEW_WEBHOOK_SECRET: process.env.TRADINGVIEW_WEBHOOK_SECRET,
      ALLOW_LEGACY_WEBHOOK_SECRET: process.env.ALLOW_LEGACY_WEBHOOK_SECRET
    };
    process.env.NODE_ENV = 'production';
    process.env.WEBHOOK_SIGNING_SECRET = 'test-signing-secret-abcdefghijklmnopqrstuvwxyz';
    process.env.TRADINGVIEW_WEBHOOK_SECRET = 'test-tv-webhook-secret';
    delete process.env.ALLOW_LEGACY_WEBHOOK_SECRET;

    // Re-require after env is set so getSigningSecret sees test values.
    delete require.cache[require.resolve('../webhookSecurity')];
    delete require.cache[require.resolve('../subscriptionAccess')];
    ({ generateLicenseToken, verifyTradingViewWebhook, diagnoseLicenseToken, verifyLicenseToken } = require('../webhookSecurity'));
  });

  after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[require.resolve('../webhookSecurity')];
  });

  function reqWithBody(body, headers = {}) {
    return { body, headers, rawBody: Buffer.from(JSON.stringify(body), 'utf8') };
  }

  it('accepts admin publishers via effective subscription (raw sub may be inactive)', async () => {
    const userId = '64b0f0f0f0f0f0f0f0f0f0f0';
    const tvu = 'admintrader';
    const licenseToken = generateLicenseToken(userId, tvu);

    const auth = await verifyTradingViewWebhook(
      reqWithBody({
        symbol: 'XAUUSD',
        alertType: 'entry',
        userId,
        tradingviewUsername: tvu,
        licenseToken,
        secret: 'wrong-secret'
      }),
      async () => ({
        _id: userId,
        role: 'admin',
        email: 'admin@example.com',
        tradingviewUsername: tvu,
        subscription: { status: 'inactive', tier: 'basic' }
      })
    );

    assert.equal(auth.ok, true);
    assert.equal(auth.mode, 'license');
    assert.equal(auth.userId, userId);
  });

  it('rejects non-admin with inactive raw subscription', async () => {
    const userId = '64b0f0f0f0f0f0f0f0f0f0f1';
    const tvu = 'paidtrader';
    const licenseToken = generateLicenseToken(userId, tvu);

    const auth = await verifyTradingViewWebhook(
      reqWithBody({
        symbol: 'XAUUSD',
        alertType: 'entry',
        userId,
        tradingviewUsername: tvu,
        licenseToken
      }),
      async () => ({
        _id: userId,
        role: 'user',
        tradingviewUsername: tvu,
        subscription: { status: 'inactive', tier: 'basic' }
      })
    );

    assert.equal(auth.ok, false);
    assert.equal(auth.reason, 'inactive_subscription');
  });

  it('rejects stale licenseToken without ALLOW_LEGACY even if secret is present', async () => {
    const auth = await verifyTradingViewWebhook(
      reqWithBody({
        symbol: 'XAUUSD',
        alertType: 'entry',
        userId: '64b0f0f0f0f0f0f0f0f0f0f2',
        tradingviewUsername: 'someone',
        licenseToken: 'kls_v1.invalid.token',
        secret: 'test-tv-webhook-secret'
      }),
      async () => null
    );

    assert.equal(auth.ok, false);
    assert.equal(auth.reason, 'invalid_license_token');
  });

  it('allows legacy global-secret fallback when ALLOW_LEGACY is enabled', async () => {
    process.env.ALLOW_LEGACY_WEBHOOK_SECRET = 'true';
    delete require.cache[require.resolve('../webhookSecurity')];
    ({ generateLicenseToken, verifyTradingViewWebhook } = require('../webhookSecurity'));

    try {
      const auth = await verifyTradingViewWebhook(
        reqWithBody({
          symbol: 'XAUUSD',
          alertType: 'entry',
          userId: '64b0f0f0f0f0f0f0f0f0f0f2',
          tradingviewUsername: 'someone',
          licenseToken: 'kls_v1.invalid.token',
          secret: 'test-tv-webhook-secret'
        }),
        async () => null
      );

      assert.equal(auth.ok, true);
      assert.equal(auth.mode, 'global_secret_fallback');
    } finally {
      delete process.env.ALLOW_LEGACY_WEBHOOK_SECRET;
      delete require.cache[require.resolve('../webhookSecurity')];
      ({ generateLicenseToken, verifyTradingViewWebhook } = require('../webhookSecurity'));
    }
  });

  it('does not accept anonymous global secret in production without ALLOW_LEGACY', async () => {
    const auth = await verifyTradingViewWebhook(
      reqWithBody({
        symbol: 'XAUUSD',
        alertType: 'entry',
        secret: 'test-tv-webhook-secret'
      }),
      async () => null
    );

    assert.equal(auth.ok, false);
    assert.equal(auth.reason, 'unauthorized');
  });

  it('a. production-generated token verifies successfully', () => {
    const token = generateLicenseToken('64b0f0f0f0f0f0f0f0f0f0f3', 'prodtrader');
    assert.equal(Boolean(verifyLicenseToken(token)), true);
    const diag = diagnoseLicenseToken(token);
    assert.equal(diag.prefix, 'kls_v2');
    assert.equal(diag.tokenEnvironment, 'production');
    assert.equal(diag.parts, 3);
    assert.equal(diag.hmacMatch, 'webhook_signing_secret');
    assert.equal(diag.hasCR, false);
  });

  it('b. token for user A cannot authenticate as user B', async () => {
    const userA = '64b0f0f0f0f0f0f0f0f0f0a1';
    const userB = '64b0f0f0f0f0f0f0f0f0f0b2';
    const tvu = 'samechartuser';
    const tokenA = generateLicenseToken(userA, tvu);
    const auth = await verifyTradingViewWebhook(
      reqWithBody({
        symbol: 'XAUUSD',
        alertType: 'entry',
        userId: userB,
        tradingviewUsername: tvu,
        licenseToken: tokenA
      }),
      async id => ({
        _id: id,
        tradingviewUsername: tvu,
        subscription: { status: 'active', tier: 'professional' }
      })
    );
    assert.equal(auth.ok, false);
    assert.equal(auth.reason, 'license_user_mismatch');
  });

  it('c. different signing secret is rejected', () => {
    const token = generateLicenseToken('64b0f0f0f0f0f0f0f0f0f0c3', 'secrettrader');
    const prev = process.env.WEBHOOK_SIGNING_SECRET;
    process.env.WEBHOOK_SIGNING_SECRET = 'totally-different-signing-secret-xyz';
    delete require.cache[require.resolve('../webhookSecurity')];
    const { verifyLicenseToken: verifyOther, diagnoseLicenseToken: diagOther } = require('../webhookSecurity');
    try {
      assert.equal(verifyOther(token), null);
      const diag = diagOther(token);
      assert.equal(diag.reason, 'hmac_mismatch');
      assert.equal(diag.hmacMatch, 'none');
      assert.equal(diag.decodeOk, true);
    } finally {
      process.env.WEBHOOK_SIGNING_SECRET = prev;
      delete require.cache[require.resolve('../webhookSecurity')];
      ({ generateLicenseToken, verifyTradingViewWebhook, diagnoseLicenseToken, verifyLicenseToken } = require('../webhookSecurity'));
    }
  });

  it('CR injected into an otherwise valid token fails HMAC (Pine jsonEsc regression)', () => {
    const token = generateLicenseToken('64b0f0f0f0f0f0f0f0f0f0d4', 'faithkinyori2023');
    assert.equal(Boolean(token && token.length > 20), true);
    const corrupted = `${token.slice(0, 12)}\r${token.slice(12)}`;
    assert.equal(corrupted.includes('\r'), true);
    assert.equal(verifyLicenseToken(corrupted), null);
    const diag = diagnoseLicenseToken(corrupted);
    assert.equal(diag.hasCR, true);
    assert.equal(diag.reason, 'hmac_mismatch');
  });

  it('d. smoke/dev token is rejected under production verifier', () => {
    const prevEnv = process.env.NODE_ENV;
    const prevSecret = process.env.WEBHOOK_SIGNING_SECRET;
    const LicenseTokenService = require('../../services/LicenseTokenService');
    process.env.NODE_ENV = 'test';
    process.env.WEBHOOK_SIGNING_SECRET = 'smoke-test-license-signing-secret';
    const smokeToken = LicenseTokenService.generateLicenseToken('smoke-optiona-local', 'smoke_optiona_tv');
    process.env.NODE_ENV = 'production';
    process.env.WEBHOOK_SIGNING_SECRET = 'test-signing-secret-abcdefghijklmnopqrstuvwxyz';
    try {
      const verified = LicenseTokenService.verifyLicenseTokenDetailed(smokeToken);
      assert.equal(verified.ok, false);
      assert.equal(verified.reason, 'non_production_license_token');
      assert.equal(LicenseTokenService.verifyLicenseToken(smokeToken), null);
    } finally {
      process.env.NODE_ENV = prevEnv;
      process.env.WEBHOOK_SIGNING_SECRET = prevSecret;
    }
  });
});

describe('isStructuredEntryAlert candle classification', () => {
  const { isStructuredEntryAlert } = require('../kachingSignalLevels');

  it('treats liquidity_sweep patterns as structured entries even with OHLC present', () => {
    assert.equal(
      isStructuredEntryAlert({
        alertType: 'entry',
        pattern: 'liquidity_sweep_fvg_daytrading',
        open: 1,
        high: 2,
        low: 0.5,
        close: 1.5
      }),
      true
    );
    assert.equal(
      isStructuredEntryAlert({
        alertType: 'signal',
        pattern: 'liquidity_sweep_fvg_scalp',
        open: 1,
        high: 2,
        low: 0.5,
        close: 1.5
      }),
      true
    );
  });

  it('does not treat pure candle feeds as structured entries', () => {
    assert.equal(
      isStructuredEntryAlert({
        alertType: 'candle',
        pattern: 'feed',
        open: 1,
        high: 2,
        low: 0.5,
        close: 1.5
      }),
      false
    );
  });
});
