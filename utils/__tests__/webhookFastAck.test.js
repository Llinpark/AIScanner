/**
 * TradingView webhook fast-ack (Option B: durable Signal save → HTTP ack → async fan-out).
 * Covers the 15 spec scenarios. Never hits production Telegram/Mongo/Fly.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');

const originalFetch = global.fetch;
const originalSigning = process.env.WEBHOOK_SIGNING_SECRET;
const originalTvSecret = process.env.TRADINGVIEW_WEBHOOK_SECRET;
const originalBot = process.env.TELEGRAM_BOT_TOKEN;
const originalNodeEnv = process.env.NODE_ENV;

const { generateLicenseToken, verifyTradingViewWebhook } = require('../webhookSecurity');
const TradingViewAlertService = require('../../services/TradingViewAlertService');
const TradeDeliveryService = require('../../services/TradeDeliveryService');
const PipelineStatusService = require('../../services/PipelineStatusService');
const ActiveSignalRegistry = require('../activeSignalRegistry');
const DurableDelivery = require('../durableDelivery');
const { ensureRequestId } = require('../webhookPipelineDiag');
const { logPipeline } = require('../pipelineLog');
const { percent } = require('../pipelineObservability');

const USER_ID = 'fastack-user-1';
const TV_USER = 'fastacktrader';

function validEntry(overrides = {}) {
  const uuid = overrides.signalUuid || `fastack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    symbol: overrides.symbol || `FA${String(Date.now()).slice(-6)}`,
    strategyName: 'Liquidity Sweep + Fair Value Gap (Scalping)',
    timeframe: '15m',
    pattern: 'liquidity_sweep_fvg_scalp',
    alertType: 'entry',
    direction: 'long',
    entry: 1.1,
    stop_loss: 1.09,
    stop_loss_1: 1.09,
    take_profit_1: 1.11,
    take_profit_2: 1.12,
    take_profit_3: 1.13,
    confidence: 0.82,
    signalUuid: uuid,
    signalId: uuid,
    message: 'KACHING BUY',
    broadcast: true,
    tradingviewUsername: TV_USER,
    userId: USER_ID,
    licenseToken: generateLicenseToken(USER_ID, TV_USER),
    ...overrides,
    signalUuid: uuid,
    signalId: uuid
  };
}

function proSubscriber(overrides = {}) {
  return {
    id: USER_ID,
    email: 'pro-fastack@example.com',
    role: 'user',
    subscription: { tier: 'professional', status: 'active' },
    telegram: { chatId: '111001', enabled: true, telegramMode: 'alerts_only' },
    mt5: { executionMode: 'manual', enabled: true, devices: [] },
    ...overrides
  };
}

function premiumSubscriber(overrides = {}) {
  return {
    id: 'premium-fastack',
    email: 'premium-fastack@example.com',
    role: 'user',
    subscription: { tier: 'premium', status: 'active' },
    telegram: { chatId: '222001', enabled: true },
    mt5: { executionMode: 'auto', enabled: false, devices: [] },
    ...overrides
  };
}

function mockTelegramDelayed(delayMs, counter) {
  global.fetch = async () => {
    counter.calls += 1;
    counter.startedAt = Date.now();
    await new Promise(r => setTimeout(r, delayMs));
    counter.completedAt = Date.now();
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, result: { message_id: 77 } };
      }
    };
  };
}

function mockTelegramOk(counter) {
  global.fetch = async () => {
    counter.calls += 1;
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, result: { message_id: 42 } };
      }
    };
  };
}

function resolveUser() {
  return {
    _id: USER_ID,
    tradingviewUsername: TV_USER,
    subscription: { tier: 'professional', status: 'active' }
  };
}

function createFastAckApp({ inMemorySignals, io }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.text({ type: 'text/*', limit: '1mb' }));
  app.post('/api/webhook/tradingview', async (req, res) => {
    const t0 = Date.now();
    const requestId = ensureRequestId(req);
    const auth = await verifyTradingViewWebhook(req, async () => resolveUser());
    if (!auth.ok) {
      const status =
        auth.parseError ||
        auth.reason === 'invalid_json' ||
        auth.reason === 'empty_body' ||
        auth.reason === 'unexpanded_tv_placeholder'
          ? 400
          : 401;
      return res.status(status).json({
        ok: false,
        accepted: false,
        reason: auth.reason,
        requestId
      });
    }
    const parsed = TradingViewAlertService.parseWebhookBody(auth.body || req.body);
    if (parsed?.__parseError) {
      return res.status(400).json({
        ok: false,
        accepted: false,
        reason: parsed.__parseReason || 'invalid_json',
        requestId
      });
    }
    parsed.pipelineRequestId = requestId;
    try {
      const timings = { webhookReceivedAt: t0 };
      const accept = await TradingViewAlertService.acceptTradingViewWebhook(
        io,
        parsed,
        inMemorySignals,
        { timings }
      );
      if (accept?.rejected) {
        const status =
          accept.httpStatus ||
          TradingViewAlertService.rejectedWebhookHttpStatus(accept.reason);
        return res.status(status).json({
          ok: false,
          accepted: false,
          rejected: true,
          reason: accept.reason,
          requestId
        });
      }
      if (!accept.duplicate && !accept.skippedFanout) {
        TradingViewAlertService.scheduleAcceptedTradingViewSignal(io, accept, inMemorySignals);
      }
      return res.status(202).json({
        ok: true,
        accepted: true,
        success: true,
        requestId,
        signalUuid: accept.signalUuid,
        latencyMs: Date.now() - t0,
        duplicate: Boolean(accept.duplicate),
        deferredFanout: !accept.duplicate
      });
    } catch (error) {
      const isPersist = /mongo|persist/i.test(String(error.message || ''));
      return res.status(isPersist ? 500 : 400).json({
        ok: false,
        accepted: false,
        error: error.message,
        requestId
      });
    }
  });
  return app;
}

function postToApp(app, body, { contentType = 'application/json', raw } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const payload = raw != null ? raw : JSON.stringify(body);
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/webhook/tradingview',
          method: 'POST',
          headers: {
            'content-type': contentType,
            'content-length': Buffer.byteLength(payload)
          }
        },
        res => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            server.close();
            const text = Buffer.concat(chunks).toString('utf8');
            let json = {};
            try {
              json = JSON.parse(text);
            } catch {
              json = { raw: text };
            }
            resolve({ status: res.statusCode, body: json });
          });
        }
      );
      req.on('error', err => {
        server.close();
        reject(err);
      });
      req.write(payload);
      req.end();
    });
  });
}

describe('TradingView webhook fast-ack architecture', () => {
  let inMemorySignals;
  let io;
  let telegramCalls;

  beforeEach(() => {
    assert.notEqual(mongoose.connection.readyState, 1);
    mongoose.set('bufferCommands', false);
    process.env.NODE_ENV = 'test';
    process.env.WEBHOOK_SIGNING_SECRET = 'test-signing-secret-fastack';
    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token-fastack';
    delete process.env.TRADINGVIEW_WEBHOOK_SECRET;
    delete process.env.PIPELINE_SELF_TEST_ACTIVE;
    inMemorySignals = [];
    io = { emit() {}, to() { return { emit() {} }; } };
    telegramCalls = { calls: 0 };
    ActiveSignalRegistry.resetForTests();
    PipelineStatusService.resetForTests();
    TradingViewAlertService.resetTestFanoutHooks();
    require('../tradeEventDispatcher').resetForTests();
    require('../deliveryIdempotency').resetForTests();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.WEBHOOK_SIGNING_SECRET = originalSigning;
    process.env.TRADINGVIEW_WEBHOOK_SECRET = originalTvSecret;
    process.env.TELEGRAM_BOT_TOKEN = originalBot;
    process.env.NODE_ENV = originalNodeEnv;
    delete process.env.PIPELINE_SELF_TEST_ACTIVE;
    TradingViewAlertService.resetTestFanoutHooks();
  });

  it('1. valid webhook → Auth/Validation/Accepted → persist → fan-out', async () => {
    mockTelegramOk(telegramCalls);
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const payload = validEntry({ signalUuid: 'fastack-1' });
    const timings = { webhookReceivedAt: Date.now() };
    const accept = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload,
      inMemorySignals,
      { timings }
    );
    assert.equal(accept.accepted, true);
    assert.equal(accept.rejected, false);
    assert.ok(accept.saved);
    assert.ok(inMemorySignals.length >= 1);
    assert.ok(timings.acceptedAt);
    assert.ok(timings.mongoCompletedAt);
    assert.ok(timings.acceptedAt >= timings.mongoCompletedAt);

    const delivery = await TradingViewAlertService.processAcceptedTradingViewSignal(
      io,
      accept,
      inMemorySignals
    );
    assert.ok((delivery.delivered || 0) >= 1);
    assert.equal(telegramCalls.calls, 1);
  });

  it('2. slow Telegram mock → HTTP ack returns before Telegram completes', async () => {
    const delayMs = 250;
    mockTelegramDelayed(delayMs, telegramCalls);
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const app = createFastAckApp({ inMemorySignals, io });
    const t0 = Date.now();
    const res = await postToApp(app, validEntry({ signalUuid: 'fastack-2' }));
    const returnedAt = Date.now();
    assert.equal(res.status, 202);
    assert.equal(res.body.accepted, true);
    assert.equal(res.body.ok, true);
    const durableJobs = await DurableDelivery.listJobs();
    assert.ok(
      durableJobs.some(j => j.channel === '_fanout' && j.state !== 'delivered'),
      'durable fan-out work must exist at HTTP 202, before Telegram completes'
    );
    // Invariant: HTTP returned before the delayed Telegram fetch finished.
    // Do not time server.listen() — that bind is not part of the webhook ack path
    // and can exceed 250ms on a loaded Windows box.
    assert.equal(telegramCalls.completedAt, undefined);
    assert.ok(
      Number(res.body.latencyMs) < delayMs,
      `handler latencyMs=${res.body.latencyMs} must be < Telegram delay ${delayMs}`
    );
    await new Promise(r => setTimeout(r, delayMs + 80));
    assert.equal(telegramCalls.calls, 1);
    assert.ok(telegramCalls.completedAt);
    assert.ok(telegramCalls.completedAt >= returnedAt);
    assert.ok(telegramCalls.completedAt - t0 >= delayMs);
  });

  it('3. slow MT5 mock → HTTP ack returns before MT5 completes', async () => {
    const Mt5TradeCopierService = require('../../services/Mt5TradeCopierService');
    let mt5Done = false;
    const origQueue = Mt5TradeCopierService.queueExecutionForUser;
    Mt5TradeCopierService.queueExecutionForUser = async () => {
      await new Promise(r => setTimeout(r, 250));
      mt5Done = true;
      return { ok: true, reason: 'queued' };
    };
    try {
      mockTelegramOk(telegramCalls);
      TradingViewAlertService.setTestFanoutHooks({
        subscribers: [
          premiumSubscriber({
            mt5: {
              executionMode: 'auto',
              enabled: true,
              devices: [{ deviceId: 'd1', accessToken: 't', revokedAt: null }],
              accountBalance: 1000
            }
          })
        ]
      });
      const app = createFastAckApp({ inMemorySignals, io });
      const res = await postToApp(app, validEntry({ signalUuid: 'fastack-3' }));
      assert.equal(res.status, 202);
      assert.equal(res.body.accepted, true);
      assert.equal(mt5Done, false);
      assert.ok(
        Number(res.body.latencyMs) < 250,
        `handler latencyMs=${res.body.latencyMs} must be < MT5 delay 250`
      );
      await new Promise(r => setTimeout(r, 320));
      assert.equal(mt5Done, true);
    } finally {
      Mt5TradeCopierService.queueExecutionForUser = origQueue;
    }
  });

  it('4. Mongo failure before ack → must not claim durable success', async () => {
    TradingViewAlertService.setTestFanoutHooks({
      persistError: new Error('mongo persist failed')
    });
    const app = createFastAckApp({ inMemorySignals, io });
    const res = await postToApp(app, validEntry({ signalUuid: 'fastack-4' }));
    assert.ok(res.status >= 400);
    assert.notEqual(res.body.accepted, true);
    assert.equal(inMemorySignals.length, 0);
  });

  it('5. async failure after durable accept → Broadcast FAIL, no second Signal on retry', async () => {
    TradingViewAlertService.setTestFanoutHooks({
      subscribers: [proSubscriber()],
      fanoutError: new Error('async telegram boom')
    });
    const payload = validEntry({ signalUuid: 'fastack-5' });
    const accept = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload,
      inMemorySignals
    );
    assert.equal(accept.accepted, true);
    assert.equal(inMemorySignals.length, 1);

    const asyncResult = await TradingViewAlertService.processAcceptedTradingViewSignal(
      io,
      accept,
      inMemorySignals
    );
    assert.equal(asyncResult.asyncFailed, true);
    const status = await PipelineStatusService.getStatus();
    assert.equal(status.lastFailureStage, 'Broadcast');

    TradingViewAlertService.resetTestFanoutHooks();
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    mockTelegramOk(telegramCalls);
    const retry = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload,
      inMemorySignals
    );
    assert.equal(retry.duplicate, true);
    assert.equal(retry.skippedFanout, true);
    assert.equal(inMemorySignals.length, 1);
    assert.equal(telegramCalls.calls, 0);
  });

  it('6. invalid licenseToken → HTTP failure, background processing does not start', async () => {
    let scheduled = 0;
    const orig = TradingViewAlertService.scheduleAcceptedTradingViewSignal;
    TradingViewAlertService.scheduleAcceptedTradingViewSignal = () => {
      scheduled += 1;
    };
    try {
      const app = createFastAckApp({ inMemorySignals, io });
      const res = await postToApp(
        app,
        validEntry({
          signalUuid: 'fastack-6',
          licenseToken: 'kls_v1.invalid.token'
        })
      );
      assert.equal(res.status, 401);
      assert.notEqual(res.body.accepted, true);
      assert.equal(scheduled, 0);
      assert.equal(inMemorySignals.length, 0);
    } finally {
      TradingViewAlertService.scheduleAcceptedTradingViewSignal = orig;
    }
  });

  it('7. malformed JSON → HTTP failure, background processing does not start', async () => {
    const app = createFastAckApp({ inMemorySignals, io });
    const res = await postToApp(app, null, { raw: '{not-json', contentType: 'text/plain' });
    assert.equal(res.status, 400);
    assert.notEqual(res.body.accepted, true);
    assert.equal(inMemorySignals.length, 0);
  });

  it('8. validation failure → HTTP failure, background processing does not start', async () => {
    const payload = validEntry({ signalUuid: 'fastack-8' });
    delete payload.stop_loss;
    delete payload.stop_loss_1;
    await assert.rejects(
      () => TradingViewAlertService.acceptTradingViewWebhook(io, payload, inMemorySignals),
      /Invalid Kaching entry signal|missing/i
    );
    assert.equal(inMemorySignals.length, 0);
  });

  it('9. duplicate signalUuid → one Signal, no duplicate Telegram/Email/MT5', async () => {
    mockTelegramOk(telegramCalls);
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const payload = validEntry({ signalUuid: 'fastack-9' });
    const first = await TradingViewAlertService.processTradingViewWebhook(
      io,
      payload,
      inMemorySignals
    );
    assert.ok(!first.rejected);
    assert.equal(inMemorySignals.length, 1);
    assert.equal(telegramCalls.calls, 1);

    const second = await TradingViewAlertService.processTradingViewWebhook(
      io,
      payload,
      inMemorySignals
    );
    assert.equal(second.duplicate, true);
    assert.equal(second.delivered, 0);
    assert.equal(inMemorySignals.length, 1);
    assert.equal(telegramCalls.calls, 1);
  });

  it('10. Telegram-only subscriber → Telegram PASS, MT5 SKIP, delivery delivered', async () => {
    mockTelegramOk(telegramCalls);
    const subscriber = proSubscriber({
      telegram: { chatId: '111001', enabled: true, telegramMode: 'alerts_only' },
      mt5: { executionMode: 'manual', enabled: false, devices: [] }
    });
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [subscriber] });
    const result = await TradingViewAlertService.processTradingViewWebhook(
      io,
      validEntry({ signalUuid: 'fastack-10' }),
      inMemorySignals
    );
    assert.ok((result.delivered || 0) >= 1);
    assert.equal(telegramCalls.calls, 1);
    const mt5 = await TradeDeliveryService.deliverMt5Auto(subscriber, inMemorySignals[0]);
    assert.equal(mt5.ok, false);
    assert.equal(TradeDeliveryService.isExpectedMt5Skip(mt5.reason), true);
    assert.equal(
      TradeDeliveryService.resolveDeliveryStatus({
        telegramSent: true,
        mt5Sent: false,
        tgPipelineStatus: 'PASS',
        mt5PipelineStatus: 'SKIP'
      }),
      'delivered'
    );
  });

  it('11. Pro subscriber → eligible Telegram independent of MT5', async () => {
    mockTelegramOk(telegramCalls);
    const subscriber = proSubscriber();
    const signal = validEntry({ signalUuid: 'fastack-11', _id: 'mem-11' });
    const tg = await TradeDeliveryService.deliverTelegram(subscriber, signal);
    const mt5 = await TradeDeliveryService.deliverMt5Auto(subscriber, signal);
    assert.equal(tg.ok, true);
    assert.equal(mt5.ok, false);
    assert.equal(mt5.reason, 'manual_mode');
    assert.equal(TradeDeliveryService.isExpectedMt5Skip('manual_mode'), true);
  });

  it('12. Premium MT5 not linked → Telegram can succeed, MT5 SKIP, no false FAIL', async () => {
    mockTelegramOk(telegramCalls);
    PipelineStatusService.resetForTests();
    const Mt5TradeCopierService = require('../../services/Mt5TradeCopierService');
    const subscriber = premiumSubscriber();
    const signal = validEntry({ signalUuid: 'fastack-12', _id: 'mem-12' });
    const tg = await TradeDeliveryService.deliverTelegram(subscriber, signal);
    assert.equal(tg.ok, true);
    assert.equal(Mt5TradeCopierService.isMt5Linked(subscriber.mt5), false);
    assert.equal(TradeDeliveryService.isExpectedMt5Skip('mt5_not_linked'), true);
    logPipeline('DeliveryMT5', 'SKIP', {
      symbol: signal.symbol,
      signalUuid: signal.signalUuid,
      reason: 'mt5_not_linked'
    });
    const status = await PipelineStatusService.getStatus();
    assert.notEqual(status.lastFailureStage, 'DeliveryMT5');
  });

  it('13. self-test isolation → no production PipelineStatus Redis pollution', async () => {
    logPipeline('Accepted', 'PASS', {
      symbol: 'STESTISO',
      signalUuid: 'selftest_fastack_13',
      selfTest: true,
      reason: 'self_test isolation'
    });
    const status = await PipelineStatusService.getStatus();
    assert.equal(status.lastAccepted?.selfTest, true);
    assert.equal(status.lastAccepted?.telemetrySource, 'non_production');
  });

  it('14. Admin counters increment only after durable Mongo Signal (not Accepted-only)', async () => {
    const PipelineDeliveryStatsService = require('../../services/PipelineDeliveryStatsService');
    logPipeline('Accepted', 'PASS', {
      symbol: 'EURUSD',
      signalUuid: 'fastack-14-ack-only',
      reason: 'http_ack_without_mongo'
    });
    const stats = await PipelineDeliveryStatsService.computeDeliveryStatistics();
    assert.equal(stats.signalsToday, 0);
    assert.equal(percent(0, 0), null);
  });

  it('15. async exception → no unhandled rejection, Pipeline FAIL recorded', async () => {
    const unhandled = [];
    const onUnhandled = err => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    try {
      TradingViewAlertService.setTestFanoutHooks({
        subscribers: [proSubscriber()],
        fanoutError: new Error('boom-unhandled-check')
      });
      const accept = await TradingViewAlertService.acceptTradingViewWebhook(
        io,
        validEntry({ signalUuid: 'fastack-15' }),
        inMemorySignals
      );
      assert.equal(accept.accepted, true);
      TradingViewAlertService.scheduleAcceptedTradingViewSignal(io, accept, inMemorySignals);
      await new Promise(r => setTimeout(r, 50));
      assert.equal(unhandled.length, 0);
      const status = await PipelineStatusService.getStatus();
      assert.equal(status.lastFailureStage, 'Broadcast');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('16. TP3 delivery on a closed Mongo entry is not treated as a stale BUY', async () => {
    mockTelegramOk(telegramCalls);
    const closedEntry = {
      ...validEntry({ signalUuid: 'fastack-16-tp3', symbol: 'FA16TE' }),
      _id: 'mem_fastack16',
      tradeStatus: 'won',
      outcome: 'tp3',
      lifecycleStage: 'TP3',
      closedAt: new Date(),
      alertType: 'entry'
    };
    const skippedEntry = await TradeDeliveryService.deliverTelegram(proSubscriber(), closedEntry);
    assert.equal(skippedEntry.ok, false);
    assert.equal(skippedEntry.reason, 'terminal_before_entry_delivery');
    assert.equal(telegramCalls.calls, 0);

    const prevWait = process.env.DELIVERY_SEQ_WAIT_MS;
    process.env.DELIVERY_SEQ_WAIT_MS = '80';
    try {
      const tp3WithoutEntry = await TradeDeliveryService.deliverTelegram(proSubscriber(), {
        ...closedEntry,
        alertType: 'take_profit_3'
      });
      assert.equal(tp3WithoutEntry.ok, false);
      assert.equal(tp3WithoutEntry.reason, 'delivery_sequence_wait');
      assert.equal(telegramCalls.calls, 0);
    } finally {
      if (prevWait == null) delete process.env.DELIVERY_SEQ_WAIT_MS;
      else process.env.DELIVERY_SEQ_WAIT_MS = prevWait;
    }

    const liveEntry = {
      ...validEntry({ signalUuid: 'fastack-16-live', symbol: 'FA16TL' }),
      _id: 'mem_fastack16b',
      alertType: 'entry',
      entryAcceptedAt: new Date()
    };
    const entrySent = await TradeDeliveryService.deliverTelegram(proSubscriber(), liveEntry);
    assert.equal(entrySent.ok, true);
    const tp3AfterEntry = await TradeDeliveryService.deliverTelegram(proSubscriber(), {
      ...liveEntry,
      alertType: 'take_profit_3',
      tradeStatus: 'won',
      outcome: 'tp3',
      lifecycleStage: 'TP3',
      closedAt: new Date()
    });
    assert.equal(tp3AfterEntry.ok, true);
    assert.equal(telegramCalls.calls, 2);
  });

  it('17. EMAIL_TRADE_ALERTS_ENABLED=false is DeliveryEmail SKIP not FAIL', async () => {
    const prev = process.env.EMAIL_TRADE_ALERTS_ENABLED;
    process.env.EMAIL_TRADE_ALERTS_ENABLED = 'false';
    PipelineStatusService.resetForTests();
    try {
      const email = await TradeDeliveryService.deliverEmail(proSubscriber(), validEntry({ symbol: 'FA17EM' }));
      assert.equal(email.ok, false);
      assert.equal(email.reason, 'trade_alerts_disabled');
      logPipeline('DeliveryEmail', 'SKIP', {
        symbol: 'EUR/USD',
        signalUuid: 'fastack-17-email-skip',
        reason: 'trade_alerts_disabled'
      });
      const status = await PipelineStatusService.getStatus();
      assert.notEqual(status.lastFailureStage, 'DeliveryEmail');
    } finally {
      if (prev === undefined) delete process.env.EMAIL_TRADE_ALERTS_ENABLED;
      else process.env.EMAIL_TRADE_ALERTS_ENABLED = prev;
    }
  });
});
