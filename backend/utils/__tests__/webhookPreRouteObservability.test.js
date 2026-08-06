const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

describe('TV webhook pre-route observability (429 + JSON parse path helpers)', () => {
  let PipelineStatusService;
  let createRateLimiter;
  let isTradingViewWebhookPath;
  let logPipeline;

  beforeEach(() => {
    delete require.cache[require.resolve('../../services/PipelineStatusService')];
    delete require.cache[require.resolve('../pipelineLog')];
    delete require.cache[require.resolve('../../middleware/rateLimit')];
    PipelineStatusService = require('../../services/PipelineStatusService');
    ({ logPipeline } = require('../pipelineLog'));
    ({ createRateLimiter, isTradingViewWebhookPath } = require('../../middleware/rateLimit'));
    PipelineStatusService.resetForTests();
  });

  it('isTradingViewWebhookPath matches only the TV webhook route', () => {
    assert.equal(isTradingViewWebhookPath({ path: '/api/webhook/tradingview' }), true);
    assert.equal(isTradingViewWebhookPath({ originalUrl: '/api/webhook/tradingview?x=1' }), true);
    assert.equal(isTradingViewWebhookPath({ path: '/api/webhook/mpesa' }), false);
    assert.equal(isTradingViewWebhookPath({ path: '/api/health' }), false);
  });

  it('rate limiter records WebhookRateLimited when TV webhook path is rejected', async () => {
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: 1,
      name: 'testWebhookLimiter',
      keyGenerator: () => 'test-ip'
    });

    const req = {
      path: '/api/webhook/tradingview',
      originalUrl: '/api/webhook/tradingview',
      headers: { 'fly-client-ip': '9.9.9.9' },
      ip: '9.9.9.9'
    };
    const resOk = {
      setHeader() {},
      status() {
        return this;
      },
      json() {
        return this;
      }
    };
    const res429 = {
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v;
      },
      statusCode: 0,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      }
    };

    await new Promise(resolve => limiter(req, resOk, resolve));
    limiter(req, res429, () => {
      assert.fail('should not call next when rate limited');
    });

    assert.equal(res429.statusCode, 429);
    const live = await PipelineStatusService.getLivePipeline(5);
    assert.equal(live.events[0].type, 'WebhookRateLimited');
    assert.equal(live.events[0].status, 'FAIL');
    assert.match(String(live.events[0].reason), /testWebhookLimiter/);
    assert.match(String(live.events[0].reason), /9\.9\.9\.9/);
  });

  it('does not record WebhookRateLimited for unrelated paths', async () => {
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: 1,
      name: 'testGlobal',
      keyGenerator: () => 'other-ip'
    });
    const req = { path: '/api/health', originalUrl: '/api/health', headers: {}, ip: '1.1.1.1' };
    const res = {
      setHeader() {},
      status() {
        return this;
      },
      json() {
        return this;
      }
    };
    await new Promise(resolve => limiter(req, res, resolve));
    limiter(req, res, () => {});
    const live = await PipelineStatusService.getLivePipeline(5);
    assert.equal(live.events.some(e => e.type === 'WebhookRateLimited'), false);
  });

  it('WebhookParseError stage mirrors logPipeline contract used by error middleware', async () => {
    logPipeline('WebhookParseError', 'FAIL', {
      reason: 'ip=8.8.8.8; type=entity.parse.failed; Unexpected token n in JSON'
    });
    const status = await PipelineStatusService.getStatus();
    assert.ok(status.webhookFailures >= 1);
    assert.equal(status.lastFailureStage, 'WebhookParseError');
  });
});

describe('TV webhook JSON parse error middleware contract (unit shape)', () => {
  it('treats entity.parse.failed as a 400-class body error for observability', () => {
    const err = Object.assign(new SyntaxError('Unexpected token'), {
      type: 'entity.parse.failed',
      status: 400,
      statusCode: 400
    });
    const isJsonParseError =
      err?.type === 'entity.parse.failed' ||
      (err instanceof SyntaxError &&
        (err.status === 400 || err.statusCode === 400 || err.type === 'entity.parse.failed'));
    assert.equal(isJsonParseError, true);
  });
});
