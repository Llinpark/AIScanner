const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRateLimiter,
  authAttemptLimiter,
  authEmailLimiter,
  authTokenLimiter
} = require('../rateLimit');

function mockReq(ip = '1.2.3.4') {
  return {
    headers: {},
    ip,
    socket: { remoteAddress: ip }
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
  return res;
}

function runLimiter(limiter, req) {
  const res = mockRes();
  let nextCalled = false;
  limiter(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

test('createRateLimiter blocks after max hits in window', () => {
  const limiter = createRateLimiter({
    windowMs: 60_000,
    max: 2,
    message: 'Too many authentication attempts. Please wait and try again.'
  });
  const req = mockReq('10.0.0.1');

  assert.equal(runLimiter(limiter, req).nextCalled, true);
  assert.equal(runLimiter(limiter, req).nextCalled, true);

  const blocked = runLimiter(limiter, req);
  assert.equal(blocked.nextCalled, false);
  assert.equal(blocked.res.statusCode, 429);
  assert.match(blocked.res.body.message, /authentication attempts/i);
});

test('auth attempt / email / token limiters use independent buckets', () => {
  const req = mockReq('10.0.0.9');

  for (let i = 0; i < 30; i += 1) {
    assert.equal(runLimiter(authAttemptLimiter, req).nextCalled, true);
  }
  const attemptBlocked = runLimiter(authAttemptLimiter, req);
  assert.equal(attemptBlocked.nextCalled, false);
  assert.equal(attemptBlocked.res.statusCode, 429);
  assert.match(attemptBlocked.res.body.message, /authentication attempts/i);

  // Exhausting login/register must not block verify-email or email sends.
  assert.equal(runLimiter(authTokenLimiter, req).nextCalled, true);
  assert.equal(runLimiter(authEmailLimiter, req).nextCalled, true);
});

test('authTokenLimiter uses verification messaging, not auth attempts', () => {
  const limiter = createRateLimiter({
    windowMs: 60_000,
    max: 1,
    message: 'Too many verification attempts. Please wait and try again.'
  });
  const req = mockReq('10.0.0.2');

  assert.equal(runLimiter(limiter, req).nextCalled, true);
  const blocked = runLimiter(limiter, req);
  assert.equal(blocked.res.statusCode, 429);
  assert.match(blocked.res.body.message, /verification attempts/i);
  assert.doesNotMatch(blocked.res.body.message, /authentication attempts/i);
});
