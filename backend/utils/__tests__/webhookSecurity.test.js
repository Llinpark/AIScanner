const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

describe('verifyTradingViewWebhook', () => {
  let generateLicenseToken;
  let verifyTradingViewWebhook;
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
    ({ generateLicenseToken, verifyTradingViewWebhook } = require('../webhookSecurity'));
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

  it('falls back to embedded global secret when licenseToken is stale', async () => {
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
