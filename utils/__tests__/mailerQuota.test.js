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
  classifyResendError,
  isBulkPaused,
  getBulkPausedUntilMsForTests,
  resetMailerStateForTests,
  RESEND_ERROR
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

function mockResendResponse({ ok = true, status = 200, body = { id: 'email_ok' }, retryAfter = null } = {}) {
  return {
    ok,
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

  it('TEST A: healthy trade-alert email sends once and does not open the circuit', async () => {
    const result = await sendTradeAlertEmail({
      to: 'healthy@example.com',
      signal: eurusdBuy()
    });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'resend_api');
    assert.equal(fetchCalls.length, 1);
    assert.equal(isBulkPaused(), false);
    assert.equal(getBulkPausedUntilMsForTests(), 0);
  });

  it('TEST B: daily_quota_exceeded is global quota and opens the bulk circuit', async () => {
    // Downstream (unchanged in Slice 1): TradeDeliveryService treats the throwing
    // send as recordDeliveryFailure (retry_pending). Later sendTradeAlertEmail
    // calls while isBulkPaused() return quota_circuit_open, which is in
    // EMAIL_EXPECTED_SKIP_REASONS → recordChannelSkip (terminal SKIPPED).
    // That skip-not-defer behavior is a remaining design issue, not changed here.
    global.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), body: JSON.parse(init.body) });
      return mockResendResponse({
        ok: false,
        status: 429,
        retryAfter: '3600',
        body: {
          statusCode: 429,
          name: 'daily_quota_exceeded',
          message: 'You have exceeded your daily email sending quota.'
        }
      });
    };

    let caught;
    await assert.rejects(
      () => sendTradeAlertEmail({ to: 'quota-a@example.com', signal: eurusdBuy() }),
      err => {
        caught = err;
        return true;
      }
    );
    assert.equal(caught.status, 429);
    assert.equal(caught.body.name, 'daily_quota_exceeded');
    assert.equal(caught.classification.type, RESEND_ERROR.DAILY_QUOTA);
    assert.equal(caught.classification.isGlobalQuota, true);
    assert.equal(isQuotaError(caught), true);
    assert.equal(isBulkPaused(), true);
    assert.equal(fetchCalls.length, 1);

    const later = await sendTradeAlertEmail({ to: 'healthy@example.com', signal: eurusdBuy() });
    assert.equal(later.ok, false);
    assert.equal(later.reason, 'quota_circuit_open');
    assert.equal(fetchCalls.length, 1, 'healthy recipient must not call Resend while daily quota circuit is open');
  });

  it('TEST C: monthly_quota_exceeded is global quota and opens the bulk circuit', async () => {
    global.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), body: JSON.parse(init.body) });
      return mockResendResponse({
        ok: false,
        status: 429,
        body: {
          statusCode: 429,
          name: 'monthly_quota_exceeded',
          message: 'You have exceeded your monthly email sending quota.'
        }
      });
    };

    await assert.rejects(
      () => sendTradeAlertEmail({ to: 'quota-b@example.com', signal: eurusdBuy() }),
      err => {
        assert.equal(err.classification.type, RESEND_ERROR.MONTHLY_QUOTA);
        assert.equal(err.classification.isGlobalQuota, true);
        assert.equal(isQuotaError(err), true);
        return true;
      }
    );
    assert.equal(isBulkPaused(), true);
    const later = await sendTradeAlertEmail({ to: 'healthy@example.com', signal: eurusdBuy() });
    assert.equal(later.reason, 'quota_circuit_open');
    assert.equal(fetchCalls.length, 1);
  });

  it('TEST D: rate_limit_exceeded does not open a global quota circuit', async () => {
    global.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), body: JSON.parse(init.body) });
      const to = JSON.parse(init.body).to[0];
      if (to === 'rate-limited@example.com') {
        return mockResendResponse({
          ok: false,
          status: 429,
          retryAfter: '2',
          body: {
            statusCode: 429,
            name: 'rate_limit_exceeded',
            message: 'Too many requests. Please limit the number of requests per second.'
          }
        });
      }
      return mockResendResponse({ ok: true, status: 200, body: { id: 'healthy_ok' } });
    };

    let caught;
    await assert.rejects(
      () => sendTradeAlertEmail({ to: 'rate-limited@example.com', signal: eurusdBuy() }),
      err => {
        caught = err;
        return true;
      }
    );
    assert.equal(caught.status, 429);
    assert.equal(caught.classification.type, RESEND_ERROR.RATE_LIMIT);
    assert.equal(caught.classification.isGlobalQuota, false);
    assert.equal(caught.classification.retryAfterMs, 2000);
    assert.equal(isQuotaError(caught), false);
    assert.equal(isBulkPaused(), false);
    assert.equal(getBulkPausedUntilMsForTests(), 0);
    assert.equal(fetchCalls.length, 1);

    const healthy = await sendTradeAlertEmail({ to: 'healthy@example.com', signal: eurusdBuy() });
    assert.equal(healthy.ok, true);
    assert.equal(healthy.id, 'healthy_ok');
    assert.equal(fetchCalls.length, 2);
  });

  it('TEST E: unknown 429 without body.name does not open the global circuit', async () => {
    global.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), body: JSON.parse(init.body) });
      const to = JSON.parse(init.body).to[0];
      if (to === 'unknown-429@example.com') {
        return mockResendResponse({
          ok: false,
          status: 429,
          body: { message: 'Too Many Requests' }
        });
      }
      return mockResendResponse({ ok: true, status: 200, body: { id: 'after_unknown' } });
    };

    await assert.rejects(
      () => sendTradeAlertEmail({ to: 'unknown-429@example.com', signal: eurusdBuy() }),
      err => {
        assert.equal(err.status, 429);
        assert.equal(err.classification.type, RESEND_ERROR.UNKNOWN_429);
        assert.equal(err.classification.isGlobalQuota, false);
        assert.equal(isQuotaError(err), false);
        return true;
      }
    );
    assert.equal(isBulkPaused(), false);
    const healthy = await sendTradeAlertEmail({ to: 'healthy@example.com', signal: eurusdBuy() });
    assert.equal(healthy.ok, true);
    assert.equal(fetchCalls.length, 2);
  });

  it('TEST F: recipient-shaped 429 does not block another subscriber', async () => {
    global.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), body: JSON.parse(init.body) });
      const to = JSON.parse(init.body).to[0];
      if (to === 'full-inbox@example.com') {
        return mockResendResponse({
          ok: false,
          status: 429,
          body: {
            message: 'The recipient mailbox is full and cannot currently receive mail.'
          }
        });
      }
      return mockResendResponse({ ok: true, status: 200, body: { id: 'other_ok' } });
    };

    await assert.rejects(() =>
      sendTradeAlertEmail({ to: 'full-inbox@example.com', signal: eurusdBuy() })
    );
    assert.equal(isBulkPaused(), false);
    const other = await sendTradeAlertEmail({ to: 'other@example.com', signal: eurusdBuy() });
    assert.equal(other.ok, true);
    assert.equal(other.id, 'other_ok');
    assert.equal(fetchCalls.length, 2);
  });

  it('TEST G: mixed fan-out — non-global 429 on A does not stop 200 on B', async () => {
    global.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), body: JSON.parse(init.body) });
      const to = JSON.parse(init.body).to[0];
      if (to === 'subscriber-a@example.com') {
        return mockResendResponse({
          ok: false,
          status: 429,
          body: { statusCode: 429, message: 'recipient rejected' }
        });
      }
      if (to === 'subscriber-b@example.com') {
        return mockResendResponse({ ok: true, status: 200, body: { id: 'sub_b' } });
      }
      throw new Error(`unexpected recipient ${to}`);
    };

    const [aSettled, bSettled] = await Promise.allSettled([
      sendTradeAlertEmail({ to: 'subscriber-a@example.com', signal: eurusdBuy() }),
      sendTradeAlertEmail({ to: 'subscriber-b@example.com', signal: eurusdBuy() })
    ]);
    assert.equal(aSettled.status, 'rejected');
    assert.equal(aSettled.reason.classification.isGlobalQuota, false);
    assert.equal(bSettled.status, 'fulfilled');
    assert.equal(bSettled.value.ok, true);
    assert.equal(bSettled.value.id, 'sub_b');
    assert.equal(isBulkPaused(), false);
    assert.equal(fetchCalls.length, 2);
  });

  it('TEST H: generic quota/rate-limit message without a confirmed name does not open the circuit', async () => {
    const classifiedFromMessage = classifyResendError({
      status: 500,
      message: 'provider quota / rate limit exceeded',
      body: { message: 'provider quota / rate limit exceeded' }
    });
    assert.equal(classifiedFromMessage.isGlobalQuota, false);
    assert.equal(classifiedFromMessage.type, RESEND_ERROR.OTHER);
    assert.equal(isQuotaError({ status: 500, message: 'quota' }), false);
    assert.equal(isQuotaError({ status: 429, message: 'rate limit', body: {} }), false);

    global.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), body: JSON.parse(init.body) });
      return mockResendResponse({
        ok: false,
        status: 429,
        body: { message: 'quota and rate limit — try later' }
      });
    };
    await assert.rejects(() =>
      sendTradeAlertEmail({ to: 'msg-only@example.com', signal: eurusdBuy() })
    );
    assert.equal(isBulkPaused(), false);
    assert.equal(getBulkPausedUntilMsForTests(), 0);
  });

  it('TEST I: rate_limit Retry-After is parsed and must not extend pause to midnight', async () => {
    const before = Date.now();
    global.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), body: JSON.parse(init.body) });
      return mockResendResponse({
        ok: false,
        status: 429,
        retryAfter: '5',
        body: {
          name: 'rate_limit_exceeded',
          message: 'Too many requests. Please limit the number of requests per second.'
        }
      });
    };

    await assert.rejects(
      () => sendTradeAlertEmail({ to: 'rl@example.com', signal: eurusdBuy() }),
      err => {
        assert.equal(err.classification.type, RESEND_ERROR.RATE_LIMIT);
        assert.equal(err.classification.retryAfterMs, 5000);
        assert.equal(err.classification.isGlobalQuota, false);
        return true;
      }
    );
    assert.equal(getBulkPausedUntilMsForTests(), 0);
    assert.equal(isBulkPaused(), false);
    const midnightMs = Date.UTC(
      new Date(before).getUTCFullYear(),
      new Date(before).getUTCMonth(),
      new Date(before).getUTCDate() + 1
    );
    assert.ok(
      getBulkPausedUntilMsForTests() < midnightMs,
      'rate_limit must not arm a midnight bulk pause'
    );

    global.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), body: JSON.parse(init.body) });
      return mockResendResponse({ ok: true, status: 200, body: { id: 'after_rl' } });
    };
    const later = await sendTradeAlertEmail({ to: 'healthy@example.com', signal: eurusdBuy() });
    assert.equal(later.ok, true);
    assert.notEqual(later.reason, 'quota_circuit_open');
  });

  it('classifies ordinary 4xx as other / non-global, and 5xx as other', () => {
    const invalid = classifyResendError({
      status: 422,
      body: { name: 'validation_error', message: 'Invalid `to` field' }
    });
    assert.equal(invalid.type, RESEND_ERROR.OTHER);
    assert.equal(invalid.isGlobalQuota, false);

    const auth = classifyResendError({
      status: 401,
      body: { name: 'missing_api_key', message: 'Missing API key' }
    });
    assert.equal(auth.type, RESEND_ERROR.OTHER);
    assert.equal(isQuotaError(auth), false);

    const five = classifyResendError({
      status: 500,
      body: { name: 'application_error', message: 'An unexpected error occurred.' }
    });
    assert.equal(five.type, RESEND_ERROR.OTHER);
    assert.equal(five.isGlobalQuota, false);
  });
});
