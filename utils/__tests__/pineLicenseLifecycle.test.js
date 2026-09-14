/**
 * License token lifecycle: Pine generation → buildPayload embed → verify.
 * Does not weaken auth. Never prints full tokens.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const SIGNING = 'lifecycle-signing-secret-abcdefghijklmnopqrstuvwxyz';

describe('Pine license token lifecycle (e–i)', () => {
  let previousEnv;
  let generateForUser;
  let generateLicenseToken;
  let verifyLicenseToken;
  let verifyTradingViewWebhook;
  let assertProductionSafePineMint;

  before(() => {
    previousEnv = {
      NODE_ENV: process.env.NODE_ENV,
      WEBHOOK_SIGNING_SECRET: process.env.WEBHOOK_SIGNING_SECRET,
      TRADINGVIEW_WEBHOOK_SECRET: process.env.TRADINGVIEW_WEBHOOK_SECRET,
      ALLOW_LEGACY_WEBHOOK_SECRET: process.env.ALLOW_LEGACY_WEBHOOK_SECRET
    };
    process.env.NODE_ENV = 'test';
    process.env.WEBHOOK_SIGNING_SECRET = SIGNING;
    delete process.env.TRADINGVIEW_WEBHOOK_SECRET;
    delete process.env.ALLOW_LEGACY_WEBHOOK_SECRET;
    delete require.cache[require.resolve('../webhookSecurity')];
    delete require.cache[require.resolve('../../services/PineScriptGeneratorService')];
    ({ generateLicenseToken, verifyLicenseToken, verifyTradingViewWebhook } = require('../webhookSecurity'));
    ({ generateForUser, assertProductionSafePineMint } = require('../../services/PineScriptGeneratorService'));
  });

  after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[require.resolve('../webhookSecurity')];
    delete require.cache[require.resolve('../../services/PineScriptGeneratorService')];
  });

  const user = {
    _id: '64b0f0f0f0f0f0f0f0f0aa01',
    email: 'lifecycle@example.com',
    tradingviewUsername: 'lifecycle_tv',
    subscription: { tier: 'professional', status: 'active' }
  };

  it('e. generated Pine contains a verifiable production token', () => {
    const generated = generateForUser(user, { strategy: 'scalping' });
    assert.equal(Boolean(verifyLicenseToken(generated.licenseToken)), true);
    assert.match(generated.licenseToken, /^kls_v2\./);
    assert.match(generated.script, /^LICENSE_TOKEN = str\.trim\("/m);
    const embedded = generated.script.match(/^LICENSE_TOKEN = str\.trim\("([^"]+)"\)/m);
    assert.ok(embedded);
    assert.equal(embedded[1], generated.licenseToken);
    assert.equal(verifyLicenseToken(embedded[1])?.uid, String(user._id));
    assert.doesNotMatch(generated.script, /smoke-optiona-local|smoke-test-license|127\.0\.0\.1/);
    assert.doesNotMatch(generated.script, /kls_v1/);
    assert.doesNotMatch(generated.script, /str\.from_code/);
    const day = generateForUser(user, { strategy: 'daytrading' });
    assert.doesNotMatch(day.script, /str\.from_code/);
    assert.equal(Boolean(verifyLicenseToken(day.licenseToken)), true);
  });

  it('f. buildPayload preserves the exact token via LICENSE_TOKEN variable', () => {
    const generated = generateForUser(user, { strategy: 'scalping' });
    assert.match(
      generated.script,
      /"licenseToken":"'\s*\+\s*jsonEsc\(str\.trim\(LICENSE_TOKEN\)\)\s*\+/
    );
    assert.equal(generated.script.includes(generated.licenseToken), true);
    const payloadLine = generated.script.split(/\r?\n/).find(l => l.includes('"licenseToken":"'));
    assert.ok(payloadLine);
    assert.ok(payloadLine.length < 4096, 'buildPayload source line must stay under Pine 4096');
    assert.equal(payloadLine.includes(generated.licenseToken), false, 'payload must not inline a second copy');
  });

  it('g. webhook using the generated token passes Auth', async () => {
    const generated = generateForUser(user, { strategy: 'scalping' });
    const auth = await verifyTradingViewWebhook(
      {
        body: {
          symbol: 'XAUUSD',
          alertType: 'entry',
          userId: String(user._id),
          tradingviewUsername: user.tradingviewUsername,
          licenseToken: generated.licenseToken
        },
        headers: {}
      },
      async () => ({
        _id: user._id,
        tradingviewUsername: user.tradingviewUsername,
        subscription: user.subscription
      })
    );
    assert.equal(auth.ok, true);
    assert.equal(auth.mode, 'license');
  });

  it('h. invalid token stops before persist (auth fails, no Mongo path)', async () => {
    const auth = await verifyTradingViewWebhook(
      {
        body: {
          symbol: 'XAUUSD',
          alertType: 'entry',
          userId: String(user._id),
          tradingviewUsername: user.tradingviewUsername,
          licenseToken: 'kls_v1.not-a-real-payload.not-a-real-signature'
        },
        headers: {}
      },
      async () => ({
        _id: user._id,
        tradingviewUsername: user.tradingviewUsername,
        subscription: user.subscription
      })
    );
    assert.equal(auth.ok, false);
    assert.equal(auth.reason, 'invalid_license_token');
  });

  it('i. valid generated token is accepted so persist can proceed', async () => {
    const token = generateLicenseToken(String(user._id), user.tradingviewUsername);
    assert.equal(Boolean(verifyLicenseToken(token)), true);
    const auth = await verifyTradingViewWebhook(
      {
        body: {
          symbol: 'XAUUSD',
          alertType: 'entry',
          userId: String(user._id),
          tradingviewUsername: user.tradingviewUsername,
          licenseToken: token
        },
        headers: {}
      },
      async () => ({
        _id: user._id,
        tradingviewUsername: user.tradingviewUsername,
        subscription: user.subscription
      })
    );
    assert.equal(auth.ok, true);
  });

  it('jsonEsc is Pine v5-safe: escapes quotes/backslashes, no from_code, no letter-r CR bug', () => {
    const scalp = require('fs').readFileSync(
      require('path').join(__dirname, '../../templates/kaching-sweep-fvg-scalp.pine.template'),
      'utf8'
    );
    const day = require('fs').readFileSync(
      require('path').join(__dirname, '../../templates/kaching-sweep-fvg-daytrading.pine.template'),
      'utf8'
    );
    for (const src of [scalp, day]) {
      assert.match(src, /^\/\/@version=5\b/m);
      assert.doesNotMatch(src, /kls_v1/);
      assert.doesNotMatch(src, /str\.from_code/);
      const jsonEscLine = (src.match(/jsonEsc\(string s\) =>\s*\r?\n\s*(.+)/) || [])[1] || '';
      assert.match(jsonEscLine, /str\.replace_all\(str\.replace_all\(s,/);
      assert.match(jsonEscLine, /"\\\\"/);
      // Old bug: Pine "\r"/"\n" literals are letters r/n, not CR/LF.
      assert.equal(/"[\\]r"/.test(jsonEscLine), false);
      assert.equal(/"[\\]n"/.test(jsonEscLine), false);
    }
  });

  it('production mint rejects smoke user ids', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.throws(
        () =>
          assertProductionSafePineMint({
            userId: 'smoke-optiona-local',
            webhookUrl: 'https://api.kachingscanner.com/api/webhook/tradingview',
            licenseToken: generateLicenseToken(String(user._id), user.tradingviewUsername)
          }),
        /smoke\/dev user/
      );
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
