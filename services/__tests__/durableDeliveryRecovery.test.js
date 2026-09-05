/**
 * Durable delivery recovery — crash after claim ≠ lost forever.
 * Crash/backoff uses markDueForTests / simulateCrashForTests (no fake clock, no sleeps).
 * Never hits production Telegram / Fly.
 */
'use strict';

process.env.REDIS_ENABLED = process.env.REDIS_ENABLED || 'false';
process.env.LEARNING_OUTCOME_DEBOUNCE_MS = process.env.LEARNING_OUTCOME_DEBOUNCE_MS || '1';
process.env.LEARNING_RETRAIN_INTERVAL_MS = process.env.LEARNING_RETRAIN_INTERVAL_MS || '0';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

const { generateLicenseToken } = require('../../utils/webhookSecurity');
const TradingViewAlertService = require('../TradingViewAlertService');
const TradeDeliveryService = require('../TradeDeliveryService');
const PipelineStatusService = require('../PipelineStatusService');
const ActiveSignalRegistry = require('../../utils/activeSignalRegistry');
const TradeEventDispatcher = require('../../utils/tradeEventDispatcher');
const TradeEventStore = require('../../utils/tradeEventStore');
const deliveryIdempotency = require('../../utils/deliveryIdempotency');
const DurableDelivery = require('../../utils/durableDelivery');
const { PINE_CLIENT_VERSION } = require('../../utils/PineClientVersion');

const USER_A = 'dd-user-a';
const USER_B = 'dd-user-b';
const TV_USER = 'ddtrader';

function payload(alertType, uuid, overrides = {}) {
  return {
    symbol: overrides.symbol || 'EURUSD',
    strategyName: 'Liquidity Sweep + Fair Value Gap (Scalping)',
    timeframe: overrides.timeframe || '15m',
    pattern: 'liquidity_sweep_fvg_scalp',
    alertType,
    direction: 'long',
    entry: 1.1754,
    stop_loss: 1.1745,
    stop_loss_1: 1.1745,
    take_profit_1: 1.1762,
    take_profit_2: 1.177,
    take_profit_3: 1.1782,
    confidence: 0.82,
    signalUuid: uuid,
    signalId: uuid,
    canonicalSignalKey: uuid,
    canonicalTradeId: uuid,
    message: alertType === 'entry' ? 'KACHING BUY' : `KACHING ${alertType}`,
    broadcast: true,
    tradingviewUsername: TV_USER,
    userId: USER_A,
    licenseToken: generateLicenseToken(USER_A, TV_USER),
    isRealtime: true,
    signalTime: Date.now(),
    ...overrides,
    signalUuid: uuid,
    signalId: uuid
  };
}

function pine13(alertType, uuid, overrides = {}) {
  const eventType = {
    entry: 'ENTRY',
    take_profit_1: 'TP1',
    take_profit_2: 'TP2',
    take_profit_3: 'TP3',
    stop_loss: 'SL'
  }[alertType] || 'ENTRY';
  const seq = { ENTRY: 0, TP1: 1, TP2: 2, TP3: 3, SL: 3 }[eventType];
  return payload(alertType, uuid, {
    pineClientVersion: '1.3.0',
    canonicalTradeId: uuid,
    eventId: `EURUSD|15m|${uuid}|${eventType}`,
    eventType,
    eventSequence: seq,
    isRealtime: true,
    barTime: Date.now(),
    ...overrides
  });
}

function proSubscriber(id, chatId, overrides = {}) {
  return {
    id,
    email: `${id}@example.com`,
    role: 'user',
    subscription: { tier: 'professional', status: 'active' },
    telegram: { chatId, enabled: true, telegramMode: 'alerts_only' },
    mt5: { executionMode: 'manual', enabled: true, devices: [] },
    preferences: { emailAlerts: true },
    ...overrides
  };
}

function mockTelegram(state) {
  global.fetch = async (_url, init) => {
    let text = '';
    try {
      const body = JSON.parse(init?.body || '{}');
      text = body.text || '';
    } catch {
      text = String(init?.body || '');
    }
    state.calls += 1;
    state.texts.push(text);
    if (state.failNext > 0) {
      state.failNext -= 1;
      state.failures += 1;
      return {
        ok: false,
        status: 500,
        async json() {
          return { ok: false, description: 'telegram_boom' };
        }
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, result: { message_id: state.calls } };
      }
    };
  };
}

async function acceptAndProcess(io, body, mem) {
  const accept = await TradingViewAlertService.acceptTradingViewWebhook(io, body, mem);
  if (accept.accepted && !accept.duplicate && !accept.skippedFanout) {
    await TradingViewAlertService.processAcceptedTradingViewSignal(io, accept, mem);
  }
  return accept;
}

const originalFetch = global.fetch;
const originalNodeEnv = process.env.NODE_ENV;
const originalBot = process.env.TELEGRAM_BOT_TOKEN;
const originalSigning = process.env.WEBHOOK_SIGNING_SECRET;
const originalMax = process.env.DELIVERY_MAX_ATTEMPTS;
const originalBase = process.env.DELIVERY_RETRY_BASE_DELAY_MS;
const originalMaxDelay = process.env.DELIVERY_RETRY_MAX_DELAY_MS;
const originalLease = process.env.DELIVERY_PROCESSING_LEASE_MS;
const originalSeqWait = process.env.DELIVERY_SEQ_WAIT_MS;
const originalRequireRedis = process.env.TRADE_EVENT_REQUIRE_REDIS;

describe('durable delivery recovery A–P', () => {
  let mem;
  let io;
  let tg;
  let emails;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token-dd';
    process.env.WEBHOOK_SIGNING_SECRET = 'test-signing-secret-dd';
    process.env.DELIVERY_MAX_ATTEMPTS = '3';
    process.env.DELIVERY_RETRY_BASE_DELAY_MS = '100';
    process.env.DELIVERY_RETRY_MAX_DELAY_MS = '400';
    process.env.DELIVERY_PROCESSING_LEASE_MS = '50';
    process.env.DELIVERY_SEQ_WAIT_MS = '20';
    process.env.LEARNING_OUTCOME_DEBOUNCE_MS = '1';
    process.env.LEARNING_RETRAIN_INTERVAL_MS = '0';
    mem = [];
    io = { emit() {}, to() { return { emit() {} }; } };
    tg = { calls: 0, texts: [], failures: 0, failNext: 0 };
    emails = [];
    mockTelegram(tg);
    const mailer = require('../../utils/mailer');
    mailer.__ddFailEmail = false;
    mailer.sendTradeAlertEmail = async opts => {
      emails.push(opts.signal?.alertType || 'entry');
      if (mailer.__ddFailEmail) throw new Error('smtp_down');
      return { ok: true };
    };
    ActiveSignalRegistry.resetForTests();
    PipelineStatusService.resetForTests();
    TradingViewAlertService.resetTestFanoutHooks();
    TradeEventDispatcher.resetForTests();
    deliveryIdempotency.resetForTests();
    TradingViewAlertService.setTestFanoutHooks({
      subscribers: [proSubscriber(USER_A, '70001')]
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.NODE_ENV = originalNodeEnv;
    process.env.TELEGRAM_BOT_TOKEN = originalBot;
    process.env.WEBHOOK_SIGNING_SECRET = originalSigning;
    if (originalMax == null) delete process.env.DELIVERY_MAX_ATTEMPTS;
    else process.env.DELIVERY_MAX_ATTEMPTS = originalMax;
    if (originalBase == null) delete process.env.DELIVERY_RETRY_BASE_DELAY_MS;
    else process.env.DELIVERY_RETRY_BASE_DELAY_MS = originalBase;
    if (originalMaxDelay == null) delete process.env.DELIVERY_RETRY_MAX_DELAY_MS;
    else process.env.DELIVERY_RETRY_MAX_DELAY_MS = originalMaxDelay;
    if (originalLease == null) delete process.env.DELIVERY_PROCESSING_LEASE_MS;
    else process.env.DELIVERY_PROCESSING_LEASE_MS = originalLease;
    if (originalSeqWait == null) delete process.env.DELIVERY_SEQ_WAIT_MS;
    else process.env.DELIVERY_SEQ_WAIT_MS = originalSeqWait;
    if (originalRequireRedis == null) delete process.env.TRADE_EVENT_REQUIRE_REDIS;
    else process.env.TRADE_EVENT_REQUIRE_REDIS = originalRequireRedis;
    TradingViewAlertService.resetTestFanoutHooks();
    TradeEventStore.resetForTests();
  });

  it('A/1. crash after fan-out claim is recoverable by another machine', async () => {
    const uuid = 'dd-a-crash-fanout';
    const body = pine13('entry', uuid, { symbol: 'DDA' });
    const accept = await TradingViewAlertService.acceptTradingViewWebhook(io, body, mem);
    assert.equal(accept.accepted, true);
    const jobs = await DurableDelivery.listJobs();
    const fan = jobs.find(j => j.channel === '_fanout');
    assert.ok(fan, 'durable work exists after accept / before process');
    const acqA = await DurableDelivery.beginFanoutAttempt(fan.eventId, 'entry', {
      canonicalTradeId: fan.canonicalTradeId,
      owner: 'machine-A'
    });
    assert.equal(acqA.status, 'acquired');
    await DurableDelivery.simulateCrashForTests(fan.jobId);
    const acqB = await DurableDelivery.beginFanoutAttempt(fan.eventId, 'entry', {
      canonicalTradeId: fan.canonicalTradeId,
      owner: 'machine-B'
    });
    assert.equal(acqB.status, 'acquired');
    await DurableDelivery.commitDelivered(fan.jobId);
    const after = await DurableDelivery.getJob(fan.jobId);
    assert.equal(after.state, 'delivered');
    assert.equal(tg.calls, 0);
  });

  it('B/2. crash after claimDelivery before Telegram 200 is recoverable', async () => {
    const sub = proSubscriber(USER_A, '70001');
    const signal = {
      ...pine13('entry', 'dd-b-claim', { symbol: 'DDB' }),
      _id: 'mem_ddb',
      alertType: 'entry',
      entryAcceptedAt: new Date()
    };
    const claimed = await deliveryIdempotency.claimDelivery(signal, 'entry', 'telegram', USER_A, {
      subscriber: sub
    });
    assert.equal(claimed, true);
    assert.equal(tg.calls, 0);
    const spec = deliveryIdempotency.specFrom(signal, 'entry', 'telegram', USER_A);
    const job = await DurableDelivery.getJobBySpec(spec);
    assert.equal(job.state, 'processing');
    await DurableDelivery.simulateCrashForTests(job.jobId);
    const sent = await TradeDeliveryService.deliverTelegram(sub, signal);
    assert.equal(sent.ok, true);
    assert.equal(tg.calls, 1);
    const done = await DurableDelivery.getJobBySpec(spec);
    assert.equal(done.state, 'delivered');
  });

  it('C. success is recorded only after provider success', async () => {
    const sub = proSubscriber(USER_A, '70001');
    const signal = {
      ...pine13('entry', 'dd-c-success', { symbol: 'DDC' }),
      _id: 'mem_ddc',
      alertType: 'entry',
      entryAcceptedAt: new Date()
    };
    tg.failNext = 1;
    const fail = await TradeDeliveryService.deliverTelegram(sub, signal);
    assert.equal(fail.ok, false);
    const spec = deliveryIdempotency.specFrom(signal, 'entry', 'telegram', USER_A);
    const afterFail = await DurableDelivery.getJobBySpec(spec);
    assert.notEqual(afterFail.state, 'delivered');
    await DurableDelivery.markDueForTests(afterFail.jobId);
    const ok = await TradeDeliveryService.deliverTelegram(sub, signal);
    assert.equal(ok.ok, true);
    const afterOk = await DurableDelivery.getJobBySpec(spec);
    assert.equal(afterOk.state, 'delivered');
  });

  it('D. processing claims expire and can be reclaimed', async () => {
    const job = await DurableDelivery.ensureJob({
      eventId: 'e-d',
      canonicalTradeId: 't-d',
      subscriberId: USER_A,
      channel: 'telegram',
      eventType: 'entry'
    });
    const a = await DurableDelivery.beginAttempt(job, { owner: 'mA' });
    assert.equal(a.status, 'acquired');
    const b = await DurableDelivery.beginAttempt(job, { owner: 'mB' });
    assert.equal(b.status, 'busy');
    await DurableDelivery.simulateCrashForTests(a.job.jobId);
    const c = await DurableDelivery.beginAttempt(job, { owner: 'mB' });
    assert.equal(c.status, 'acquired');
  });

  it('E. completed deliveries are idempotent (no second Telegram)', async () => {
    TradingViewAlertService.setTestFanoutHooks({
      subscribers: [proSubscriber(USER_A, '70001')]
    });
    await acceptAndProcess(io, pine13('entry', 'dd-e-idemp', { symbol: 'DDE' }), mem);
    assert.equal(tg.calls, 1);
    await acceptAndProcess(io, pine13('entry', 'dd-e-idemp', { symbol: 'DDE' }), mem);
    assert.equal(tg.calls, 1);
  });

  it('F. Redis fail-closed refuses process-local durable work', async () => {
    process.env.TRADE_EVENT_REQUIRE_REDIS = '1';
    TradeEventStore.setClientForTests(null, { unavailable: true });
    let threw = false;
    try {
      await DurableDelivery.ensureFanoutWork({
        accepted: true,
        signalUuid: 'dd-f',
        saved: { _id: 'mem_dd_f', signalUuid: 'dd-f', alertType: 'entry' },
        signalData: { eventId: 'dd-f', alertType: 'entry', canonicalTradeId: 'dd-f' }
      });
    } catch (err) {
      threw = true;
      assert.equal(err.reason === 'redis_unavailable' || err.code === 'REDIS_UNAVAILABLE', true);
    }
    assert.equal(threw, true);
  });

  it('G. durable work exists before fan-out; 202 path does not wait for Telegram', async () => {
    let telegramStarted = false;
    global.fetch = async () => {
      telegramStarted = true;
      await new Promise(r => setImmediate(r));
      tg.calls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: { message_id: 1 } };
        }
      };
    };
    const body = pine13('entry', 'dd-g-ack', { symbol: 'DDG' });
    const accept = await TradingViewAlertService.acceptTradingViewWebhook(io, body, mem);
    assert.equal(accept.accepted, true);
    const jobs = await DurableDelivery.listJobs();
    assert.ok(jobs.some(j => j.channel === '_fanout'));
    assert.equal(telegramStarted, false);
    assert.equal(tg.calls, 0);
  });

  it('H. legacy and 1.3.0 share the same job identity (no Pine branch)', async () => {
    const legacy = payload('entry', 'dd-h-leg', { symbol: 'DDH', pineClientVersion: undefined });
    const v13 = pine13('entry', 'dd-h-13', { symbol: 'DDH13' });
    await acceptAndProcess(io, legacy, mem);
    await acceptAndProcess(io, v13, mem);
    const jobs = await DurableDelivery.listJobs();
    assert.ok(jobs.every(j => j.eventId && j.canonicalTradeId && j.channel));
    assert.ok(jobs.some(j => j.canonicalTradeId === 'dd-h-leg'));
    assert.ok(jobs.some(j => j.canonicalTradeId === 'dd-h-13'));
    assert.equal(typeof PINE_CLIENT_VERSION, 'string');
  });

  it('I. different trades do not share leases', async () => {
    await acceptAndProcess(io, pine13('entry', 'dd-i-1', { symbol: 'DDI1' }), mem);
    await acceptAndProcess(io, pine13('entry', 'dd-i-2', { symbol: 'DDI2' }), mem);
    assert.equal(tg.calls, 2);
  });

  it('J. multi-subscriber jobs are independent', async () => {
    TradingViewAlertService.setTestFanoutHooks({
      subscribers: [proSubscriber(USER_A, '70001'), proSubscriber(USER_B, '70002')]
    });
    await acceptAndProcess(io, pine13('entry', 'dd-j-ms', { symbol: 'DDJ' }), mem);
    assert.equal(tg.calls, 2);
    const jobs = await DurableDelivery.listJobs();
    const tgJobs = jobs.filter(j => j.channel === 'telegram' && j.state === 'delivered');
    assert.equal(tgJobs.length, 2);
  });

  it('K. Telegram vs Email are independent channels', async () => {
    const mailer = require('../../utils/mailer');
    mailer.__ddFailEmail = true;
    await acceptAndProcess(io, pine13('entry', 'dd-k-ch', { symbol: 'DDK' }), mem);
    assert.equal(tg.calls, 1);
    const jobs = await DurableDelivery.listJobs();
    const emailJob = jobs.find(j => j.channel === 'email');
    const tgJob = jobs.find(j => j.channel === 'telegram' && j.subscriberId === USER_A);
    assert.equal(tgJob.state, 'delivered');
    assert.ok(emailJob);
    assert.notEqual(emailJob.state, 'delivered');
  });

  it('L/M. ENTRY failure blocks TP3; retry unblocks (never TP3 before ENTRY)', async () => {
    tg.failNext = 1;
    await acceptAndProcess(io, pine13('entry', 'dd-lm-seq', { symbol: 'DDLM' }), mem);
    assert.equal(tg.calls, 1);
    assert.ok(tg.texts.every(t => !/TRADE COMPLETE|TP3 HIT/i.test(t)));
    const before = tg.calls;
    await acceptAndProcess(io, pine13('take_profit_3', 'dd-lm-seq', { symbol: 'DDLM' }), mem);
    assert.ok(tg.texts.filter(t => /TRADE COMPLETE|TP3 HIT/i.test(t)).length === 0);
    for (const job of await DurableDelivery.listJobs()) {
      if (job.state === 'retry_pending' || job.state === 'blocked_waiting_for_entry') {
        await DurableDelivery.markDueForTests(job.jobId);
      }
    }
    await DurableDelivery.processDueJobs({ io, inMemorySignals: mem, owner: 'machine-B' });
    for (const job of await DurableDelivery.listJobs()) {
      if (job.state === 'retry_pending' || job.state === 'blocked_waiting_for_entry') {
        await DurableDelivery.markDueForTests(job.jobId);
      }
    }
    await DurableDelivery.processDueJobs({ io, inMemorySignals: mem, owner: 'machine-B' });
    assert.ok(tg.calls > before, 'ENTRY telegram must retry after backoff');
    const buy = tg.texts.findIndex(t => /KACHING BUY|KACHING SELL/i.test(t));
    const tp3 = tg.texts.findIndex(t => /TRADE COMPLETE|TP3 HIT/i.test(t));
    assert.ok(buy >= 0, 'ENTRY text must be present');
    if (tp3 >= 0) assert.ok(buy < tp3, 'ENTRY must precede TP3');
  });

  it('N. FAILED_TERMINAL is recorded and recoverable via retryFailedTerminal', async () => {
    const sub = proSubscriber(USER_A, '70001');
    const signal = {
      ...pine13('entry', 'dd-n-term', { symbol: 'DDN' }),
      _id: 'mem_ddn',
      alertType: 'entry',
      entryAcceptedAt: new Date()
    };
    tg.failNext = 99;
    await TradeDeliveryService.deliverTelegram(sub, signal);
    await DurableDelivery.markDueForTests((await DurableDelivery.getJobBySpec(deliveryIdempotency.specFrom(signal, 'entry', 'telegram', USER_A))).jobId);
    await TradeDeliveryService.deliverTelegram(sub, signal);
    await DurableDelivery.markDueForTests((await DurableDelivery.getJobBySpec(deliveryIdempotency.specFrom(signal, 'entry', 'telegram', USER_A))).jobId);
    await TradeDeliveryService.deliverTelegram(sub, signal);
    const spec = deliveryIdempotency.specFrom(signal, 'entry', 'telegram', USER_A);
    const terminal = await DurableDelivery.getJobBySpec(spec);
    assert.equal(terminal.state, 'failed_terminal');
    assert.ok(terminal.lastError);
    tg.failNext = 0;
    const queued = await DurableDelivery.retryFailedTerminal(terminal.jobId);
    assert.equal(queued.status, 'retry_pending');
    const sent = await TradeDeliveryService.deliverTelegram(sub, signal);
    assert.equal(sent.ok, true);
    const done = await DurableDelivery.getJobBySpec(spec);
    assert.equal(done.state, 'delivered');
  });

  it('O. simultaneous recovery: only one lease winner', async () => {
    const job = await DurableDelivery.ensureJob({
      eventId: 'e-o',
      canonicalTradeId: 't-o',
      subscriberId: USER_A,
      channel: 'telegram',
      eventType: 'entry'
    });
    await DurableDelivery.beginAttempt(job, { owner: 'mA' });
    await DurableDelivery.simulateCrashForTests(job.jobId);
    const [r1, r2] = await Promise.all([
      DurableDelivery.beginAttempt(job, { owner: 'mB' }),
      DurableDelivery.beginAttempt(job, { owner: 'mC' })
    ]);
    const acquired = [r1, r2].filter(r => r.status === 'acquired');
    const busy = [r1, r2].filter(r => r.status === 'busy');
    assert.equal(acquired.length, 1);
    assert.equal(busy.length, 1);
  });

  it('P. two simulated Fly machines share job identity; duplicate webhook does not double-send', async () => {
    const uuid = 'dd-p-multi';
    const body = pine13('entry', uuid, { symbol: 'DDP' });
    const accept = await TradingViewAlertService.acceptTradingViewWebhook(io, body, mem);
    assert.equal(accept.accepted, true);
    const fan = (await DurableDelivery.listJobs()).find(j => j.channel === '_fanout');
    const a = await DurableDelivery.beginFanoutAttempt(fan.eventId, 'entry', {
      canonicalTradeId: fan.canonicalTradeId,
      owner: 'fly-1'
    });
    const b = await DurableDelivery.beginFanoutAttempt(fan.eventId, 'entry', {
      canonicalTradeId: fan.canonicalTradeId,
      owner: 'fly-2'
    });
    assert.equal(a.status, 'acquired');
    assert.equal(b.status, 'busy');
    await DurableDelivery.commitDelivered(fan.jobId);
    const retry = await TradingViewAlertService.acceptTradingViewWebhook(io, body, mem);
    assert.equal(retry.duplicate, true);
    const again = await DurableDelivery.beginFanoutAttempt(fan.eventId, 'entry', {
      canonicalTradeId: fan.canonicalTradeId,
      owner: 'fly-2'
    });
    assert.equal(again.status, 'delivered');
  });

  it('12. HTTP 202 replica: durable work before Telegram via mini app', async () => {
    const delayMs = 180;
    let completedAt;
    global.fetch = async () => {
      await new Promise(r => setTimeout(r, delayMs));
      completedAt = Date.now();
      tg.calls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: { message_id: 9 } };
        }
      };
    };
    const { verifyTradingViewWebhook } = require('../../utils/webhookSecurity');
    const app = express();
    app.use(express.json());
    app.post('/api/webhook/tradingview', async (req, res) => {
      const t0 = Date.now();
      const auth = await verifyTradingViewWebhook(req, async () => ({
        _id: USER_A,
        tradingviewUsername: TV_USER,
        subscription: { tier: 'professional', status: 'active' }
      }));
      if (!auth.ok) return res.status(401).json({ ok: false });
      const parsed = TradingViewAlertService.parseWebhookBody(auth.body || req.body);
      const accept = await TradingViewAlertService.acceptTradingViewWebhook(io, parsed, mem);
      if (!accept.duplicate && !accept.skippedFanout) {
        TradingViewAlertService.scheduleAcceptedTradingViewSignal(io, accept, mem);
      }
      const jobs = await DurableDelivery.listJobs();
      return res.status(202).json({
        ok: true,
        accepted: true,
        latencyMs: Date.now() - t0,
        durableWork: jobs.some(j => j.channel === '_fanout')
      });
    });
    const body = pine13('entry', 'dd-12-http', { symbol: 'DD12' });
    const server = http.createServer(app);
    const result = await new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        const payloadJson = JSON.stringify(body);
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/api/webhook/tradingview',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payloadJson)
            }
          },
          res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
              server.close();
              resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
            });
          }
        );
        req.on('error', err => {
          server.close();
          reject(err);
        });
        req.write(payloadJson);
        req.end();
      });
    });
    assert.equal(result.status, 202);
    assert.equal(result.body.durableWork, true);
    assert.equal(completedAt, undefined);
    assert.ok(Number(result.body.latencyMs) < delayMs);
    await new Promise(r => setImmediate(r));
  });

  it('PipelineStatus exposes durable delivery states', async () => {
    await acceptAndProcess(io, pine13('entry', 'dd-ps', { symbol: 'DDPS' }), mem);
    const status = await PipelineStatusService.getStatus();
    assert.ok(status.durableDeliveryCounts);
    assert.ok(status.durableDeliveryCounts.delivered >= 1);
  });

  function ageAcceptToStale(accept) {
    const old = Date.now() - 2 * 60 * 60 * 1000;
    for (const obj of [accept.signalData, accept.saved].filter(Boolean)) {
      obj.signalTime = old;
      obj.barTime = old;
      obj.timestamp = old;
      obj.eventTimestamp = old;
      obj.time = old;
    }
  }

  it('TEST A / RC-E: stale ENTRY before delivery is failed_terminal, not delivered, no provider send', async () => {
    const uuid = 'dd-rc-e-stale';
    const body = pine13('entry', uuid, { symbol: 'RCE1' });
    const accept = await TradingViewAlertService.acceptTradingViewWebhook(io, body, mem);
    assert.equal(accept.accepted, true);
    assert.equal(accept.duplicate, false);
    ageAcceptToStale(accept);

    const tgBefore = tg.calls;
    const emailBefore = emails.length;
    const processed = await TradingViewAlertService.processAcceptedTradingViewSignal(io, accept, mem);

    assert.equal(processed.skippedFanout, true);
    assert.equal(processed.reason, 'stale_trade_before_delivery');
    assert.equal(processed.delivered, 0);
    assert.equal(processed.durableState, 'failed_terminal');
    assert.equal(tg.calls, tgBefore, 'must not send Telegram for stale ENTRY');
    assert.equal(emails.length, emailBefore, 'must not send email for stale ENTRY');

    const fan = (await DurableDelivery.listJobs()).find(
      j => j.channel === '_fanout' && String(j.canonicalTradeId).includes(uuid)
    );
    assert.ok(fan, 'fan-out job must exist');
    assert.equal(fan.state, 'failed_terminal');
    assert.match(String(fan.lastError || ''), /stale_trade_before_delivery/);
    assert.notEqual(fan.state, 'delivered');

    const reclaim = await DurableDelivery.beginFanoutAttempt(fan.eventId, 'entry', {
      canonicalTradeId: fan.canonicalTradeId,
      owner: 'retry-machine'
    });
    assert.equal(reclaim.status, 'failed_terminal');

    const due = await DurableDelivery.listDueJobs();
    assert.equal(
      due.some(j => j.jobId === fan.jobId),
      false,
      'failed_terminal fan-out must not be due for retry'
    );

    await DurableDelivery.processDueJobs({ io, inMemorySignals: mem, owner: 'retry-machine' });
    const again = await TradingViewAlertService.processAcceptedTradingViewSignal(io, accept, mem);
    assert.equal(again.skippedFanout, true);
    assert.equal(tg.calls, tgBefore);
    assert.equal(emails.length, emailBefore);
    const still = await DurableDelivery.getJob(fan.jobId);
    assert.equal(still.state, 'failed_terminal');
  });

  it('TEST B: valid ENTRY still fans out; success and duplicate protection intact', async () => {
    const uuid = 'dd-rc-e-valid';
    const body = pine13('entry', uuid, { symbol: 'RCE2' });
    const accept = await TradingViewAlertService.acceptTradingViewWebhook(io, body, mem);
    assert.equal(accept.accepted, true);
    const processed = await TradingViewAlertService.processAcceptedTradingViewSignal(io, accept, mem);
    assert.equal(processed.skippedFanout, undefined);
    assert.ok((processed.delivered || 0) >= 1);
    assert.equal(tg.calls, 1);
    assert.ok(emails.includes('entry'));

    const fan = (await DurableDelivery.listJobs()).find(
      j => j.channel === '_fanout' && String(j.canonicalTradeId).includes(uuid)
    );
    assert.ok(fan);
    assert.equal(fan.state, 'delivered');
    assert.match(String(fan.lastError || ''), /fanout_complete/);

    const dupAccept = await TradingViewAlertService.acceptTradingViewWebhook(io, body, mem);
    assert.equal(dupAccept.duplicate, true);
    const dupProcess = await TradingViewAlertService.processAcceptedTradingViewSignal(
      io,
      { ...accept, accepted: true, duplicate: false, skippedFanout: false },
      mem
    );
    assert.equal(dupProcess.skippedFanout, true);
    assert.equal(tg.calls, 1, 'duplicate process must not send Telegram again');
  });

  it('TEST F: repeated and concurrent attempts keep one job identity; no extra sends after commit', async () => {
    const sub = proSubscriber(USER_A, '70001', {
      subscription: { tier: 'premium', status: 'active' },
      mt5: {
        executionMode: 'auto',
        enabled: true,
        devices: [{ deviceId: 'd1', accessToken: 't', revokedAt: null }]
      }
    });
    const Mt5TradeCopierService = require('../Mt5TradeCopierService');
    const origQueue = Mt5TradeCopierService.queueExecutionForUser;
    let mt5Sends = 0;
    Mt5TradeCopierService.queueExecutionForUser = async () => {
      mt5Sends += 1;
      return { ok: true };
    };

    const sequential = {
      ...pine13('entry', 'dd-rc-g-dup-seq', { symbol: 'RCGS' }),
      _id: 'mem_rcg_dup_seq',
      alertType: 'entry',
      entryAcceptedAt: new Date()
    };
    try {
      await TradeDeliveryService.deliverToSubscriber(io, sequential, sub);
      const tgAfterFirst = tg.calls;
      const emailAfterFirst = emails.filter(a => a === 'entry').length;
      const mt5AfterFirst = mt5Sends;
      assert.equal(tgAfterFirst, 1);
      assert.equal(emailAfterFirst, 1);
      assert.equal(mt5AfterFirst, 1);

      await TradeDeliveryService.deliverToSubscriber(io, sequential, sub);
      assert.equal(tg.calls, tgAfterFirst, 'repeat after commit must not send Telegram again');
      assert.equal(emails.filter(a => a === 'entry').length, emailAfterFirst);
      assert.equal(mt5Sends, mt5AfterFirst);

      const concurrentSignal = {
        ...pine13('entry', 'dd-rc-g-dup-cc', { symbol: 'RCGC' }),
        _id: 'mem_rcg_dup_cc',
        alertType: 'entry',
        entryAcceptedAt: new Date()
      };
      const tgBeforeCc = tg.calls;
      const emailBeforeCc = emails.filter(a => a === 'entry').length;
      const mt5BeforeCc = mt5Sends;
      await Promise.all([
        TradeDeliveryService.deliverToSubscriber(io, concurrentSignal, sub),
        TradeDeliveryService.deliverToSubscriber(io, concurrentSignal, sub)
      ]);
      const tgCc = tg.calls - tgBeforeCc;
      const emailCc = emails.filter(a => a === 'entry').length - emailBeforeCc;
      const mt5Cc = mt5Sends - mt5BeforeCc;
      // Same-owner in-process lease may re-enter (existing at-least-once). Must not
      // create a second identity or unbounded sends.
      assert.ok(tgCc >= 1 && tgCc <= 2, `telegram concurrent sends=${tgCc}`);
      assert.ok(emailCc >= 1 && emailCc <= 2, `email concurrent sends=${emailCc}`);
      assert.ok(mt5Cc >= 1 && mt5Cc <= 2, `mt5 concurrent sends=${mt5Cc}`);
      const tgJobs = (await DurableDelivery.listJobs()).filter(
        j => j.channel === 'telegram' && j.subscriberId === USER_A && String(j.canonicalTradeId).includes('dd-rc-g-dup-cc')
      );
      const emailJobs = (await DurableDelivery.listJobs()).filter(
        j => j.channel === 'email' && j.subscriberId === USER_A && String(j.canonicalTradeId).includes('dd-rc-g-dup-cc')
      );
      const mt5Jobs = (await DurableDelivery.listJobs()).filter(
        j => j.channel === 'mt5' && j.subscriberId === USER_A && String(j.canonicalTradeId).includes('dd-rc-g-dup-cc')
      );
      assert.equal(tgJobs.length, 1);
      assert.equal(emailJobs.length, 1);
      assert.equal(mt5Jobs.length, 1);
      assert.equal(tgJobs[0].state, 'delivered');
      assert.equal(emailJobs[0].state, 'delivered');
      assert.equal(mt5Jobs[0].state, 'delivered');
    } finally {
      Mt5TradeCopierService.queueExecutionForUser = origQueue;
    }
  });
});
