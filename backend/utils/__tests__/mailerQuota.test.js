/**
 * Mailer quota / trade-alert gating. Mocks Resend; never sends real email.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const originalFetch = global.fetch;
const originalResend = process.env.RESEND_API_KEY;
const originalSmtpHost = process.env.SMTP_HOST;
const originalTradeAlerts = process.env.EMAIL_TRADE_ALERTS_ENABLED;

const {
  sendVerificationEmail,
  sendTradeAlertEmail,
  isQuotaError,
  resetMailerStateForTests
} = require('../mailer');

function eurusdBuy() {
  return {
    symbol: 'EURUSD',
    alertType: 'entry',
    direction: 'long',
    entry: 1.1,
    stopLoss: 1.09,
    takeProfit1: 1.12,
    strategyName: 'test'
  };
}

describe('mailer quota circuit', () => {
  let fetchCalls;

  beforeEach(() => {
    fetchCalls = [];
    resetMailerStateForTests();
    process.env.RESEND_API_KEY = 'test-not-real';
    delete process.env.SMTP_HOST;
    delete process.env.EMAIL_TRADE_ALERTS_ENABLED;
    global.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        async json() {
          return { id: `email_${fetchCalls.length}` };
        }
      };
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    resetMailerStateForTests();
    if (originalResend === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalResend;
    if (originalSmtpHost === undefined) delete process.env.SMTP_HOST;
    else process.env.SMTP_HOST = originalSmtpHost;
    if (originalTradeAlerts === undefined) delete process.env.EMAIL_TRADE_ALERTS_ENABLED;
    else process.env.EMAIL_TRADE_ALERTS_ENABLED = originalTradeAlerts;
  });

  it('skips trade-alert email when EMAIL_TRADE_ALERTS_ENABLED=false', async () => {
    process.env.EMAIL_TRADE_ALERTS_ENABLED = 'false';
    const result = await sendTradeAlertEmail({
      to: 'quota-test@example.com',
      signal: eurusdBuy()
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'trade_alerts_disabled');
    assert.equal(fetchCalls.length, 0);
  });

  it('still sends transactional verification email when trade alerts are disabled', async () => {
    process.env.EMAIL_TRADE_ALERTS_ENABLED = 'false';
    const info = await sendVerificationEmail({
      to: 'quota-test@example.com',
      token: 'verify-token-test',
      displayName: 'Quota'
    });
    assert.equal(info.provider, 'resend_api');
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].body.subject, /Verify/);
  });

  it('pauses bulk email after Resend 429 but keeps throwing for verification', async () => {
    global.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), body: JSON.parse(init.body) });
      return {
        ok: false,
        status: 429,
        headers: { get: name => (String(name).toLowerCase() === 'retry-after' ? '3600' : null) },
        async json() {
          return { name: 'daily_quota_exceeded', message: 'You have reached your daily email sending quota.' };
        }
      };
    };

    await assert.rejects(
      () => sendVerificationEmail({ to: 'quota-test@example.com', token: 't1' }),
      err => {
        assert.equal(err.status, 429);
        assert.equal(isQuotaError(err), true);
        return true;
      }
    );
    assert.equal(fetchCalls.length, 1);

    global.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        async json() {
          return { id: 'should-not-send' };
        }
      };
    };

    const bulk = await sendTradeAlertEmail({
      to: 'quota-test@example.com',
      signal: eurusdBuy()
    });
    assert.equal(bulk.ok, false);
    assert.equal(bulk.reason, 'quota_circuit_open');
    assert.equal(fetchCalls.length, 1);
  });
});
