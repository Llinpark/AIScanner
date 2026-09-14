/**
 * Mailer bulk/quota gating for SMTP2GO. Mocks fetch; never sends real email.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const originalFetch = global.fetch;
const originalKey = process.env.SMTP2GO_API_KEY;
const originalFrom = process.env.EMAIL_FROM;
const originalTradeAlerts = process.env.EMAIL_TRADE_ALERTS_ENABLED;

const {
  sendVerificationEmail,
  sendTradeAlertEmail,
  isQuotaError,
  classifyEmailProviderError,
  classifyResendError,
  isBulkPaused,
  getBulkPausedUntilMsForTests,
  resetMailerStateForTests,
  EMAIL_PROVIDER_ERROR
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

function smtp2goOk(id = 'email_ok') {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    async json() {
      return {
        request_id: 'req-ok',
        data: { succeeded: 1, failed: 0, failures: [], email_id: id }
      };
    }
  };
}

function smtp2goHttpError({ status = 429, retryAfter = null, body = {} } = {}) {
  return {
    ok: false,
    status,
    headers: {
      get: name =>
        String(name).toLowerCase() === 'retry-after' && retryAfter != null ? String(retryAfter) : null
    },
    async json() {
      return body;
    }
  };
}

describe('mailer quota circuit (SMTP2GO)', () => {
  let fetchCalls;

  beforeEach(() => {
    fetchCalls = [];
    resetMailerStateForTests();
    process.env.SMTP2GO_API_KEY = 'smtp2go-test-key-not-real';
    process.env.EMAIL_FROM = 'KachingScanner <noreply@kachingscanner.com>';
    delete process.env.EMAIL_TRADE_ALERTS_ENABLED;
    global.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), body: JSON.parse(init.body) });
      return smtp2goOk(`email_${fetchCalls.length}`);
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    resetMailerStateForTests();
    if (originalKey === undefined) delete process.env.SMTP2GO_API_KEY;
    else process.env.SMTP2GO_API_KEY = originalKey;
    if (originalFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = originalFrom;
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
    assert.equal(info.provider, 'smtp2go');
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].body.subject, /Verify/);
  });

  it('healthy trade-alert email sends once and does not open the circuit', async () => {
    const result = await sendTradeAlertEmail({
      to: 'healthy@example.com',
      signal: eurusdBuy()
    });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'smtp2go');
    assert.equal(fetchCalls.length, 1);
    assert.equal(isBulkPaused(), false);
    assert.equal(getBulkPausedUntilMsForTests(), 0);
  });

  it('SMTP2GO 429 opens bulk circuit; later trade alerts skip', async () => {
    global.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), body: JSON.parse(init.body) });
      return smtp2goHttpError({
        status: 429,
        retryAfter: '60',
        body: { request_id: 'r429', data: { error: 'rate limited' } }
      });
    };

    await assert.rejects(
      () => sendTradeAlertEmail({ to: 'quota-a@example.com', signal: eurusdBuy() }),
      err => {
        assert.equal(err.status, 429);
        assert.equal(err.classification.type, EMAIL_PROVIDER_ERROR.RATE_LIMIT);
        assert.equal(isQuotaError(err), true);
        return true;
      }
    );
    assert.equal(isBulkPaused(), true);
    assert.equal(fetchCalls.length, 1);

    const later = await sendTradeAlertEmail({ to: 'healthy@example.com', signal: eurusdBuy() });
    assert.equal(later.ok, false);
    assert.equal(later.reason, 'quota_circuit_open');
    assert.equal(fetchCalls.length, 1);
  });

  it('HTTP 200 with failed=1 does not open bulk circuit', async () => {
    global.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), body: JSON.parse(init.body) });
      const to = JSON.parse(init.body).to[0];
      if (to === 'bad@example.com') {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          async json() {
            return {
              request_id: 'rej',
              data: { succeeded: 0, failed: 1, failures: ['bad'], email_id: null }
            };
          }
        };
      }
      return smtp2goOk('other_ok');
    };

    await assert.rejects(() =>
      sendTradeAlertEmail({ to: 'bad@example.com', signal: eurusdBuy() })
    );
    assert.equal(isBulkPaused(), false);
    const other = await sendTradeAlertEmail({ to: 'other@example.com', signal: eurusdBuy() });
    assert.equal(other.ok, true);
    assert.equal(other.id, 'other_ok');
  });

  it('classifies 401/403 as permanent non-quota; 5xx as other', () => {
    const auth = classifyEmailProviderError({ status: 401, body: { data: { error: 'bad key' } } });
    assert.equal(auth.type, EMAIL_PROVIDER_ERROR.UNAUTHORIZED);
    assert.equal(isQuotaError(auth), false);

    const forbidden = classifyEmailProviderError({ status: 403, body: {} });
    assert.equal(forbidden.type, EMAIL_PROVIDER_ERROR.FORBIDDEN);

    const five = classifyEmailProviderError({ status: 500, body: {} });
    assert.equal(five.type, EMAIL_PROVIDER_ERROR.OTHER);

    // Back-compat alias still works
    assert.equal(classifyResendError({ status: 401 }).type, EMAIL_PROVIDER_ERROR.UNAUTHORIZED);
  });
});
