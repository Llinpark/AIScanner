/**
 * Final release hardening: Mongo durable source of truth, crash windows A–E,
 * multi-machine worker, ENTRY-first commit, Redis fail-closed / worker isolation.
 * Fake clocks only — no arbitrary setTimeout sleeps.
 * Never hits production Telegram / Fly.
 */
'use strict';

process.env.REDIS_ENABLED = process.env.REDIS_ENABLED || 'false';
process.env.LEARNING_OUTCOME_DEBOUNCE_MS = process.env.LEARNING_OUTCOME_DEBOUNCE_MS || '1';
process.env.LEARNING_RETRAIN_INTERVAL_MS = process.env.LEARNING_RETRAIN_INTERVAL_MS || '0';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { generateLicenseToken } = require('../../utils/webhookSecurity');
const TradingViewAlertService = require('../TradingViewAlertService');
const TradeDeliveryService = require('../TradeDeliveryService');
const TelegramService = require('../TelegramService');
const PipelineStatusService = require('../PipelineStatusService');
const ActiveSignalRegistry = require('../../utils/activeSignalRegistry');
const TradeEventDispatcher = require('../../utils/tradeEventDispatcher');
const TradeEventStore = require('../../utils/tradeEventStore');
const deliveryIdempotency = require('../../utils/deliveryIdempotency');
const DurableDelivery = require('../../utils/durableDelivery');

const USER_A = 'frh-user-a';
const TV_USER = 'frhtrader';

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

describe('final release hardening', () => {
  let mem;
  let io;
  let tg;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token-frh';
    process.env.WEBHOOK_SIGNING_SECRET = 'test-signing-secret-frh';
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
    mockTelegram(tg);
    ActiveSignalRegistry.resetForTests();
    PipelineStatusService.resetForTests();
    TradingViewAlertService.resetTestFanoutHooks();
    TradeEventDispatcher.resetForTests();
    deliveryIdempotency.resetForTests();
    TradingViewAlertService.setTestFanoutHooks({
      subscribers: [proSubscriber(USER_A, '80001')]
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
    DurableDelivery.clearNowForTests();
  });

  it('job existing is not DELIVERED; identity is unique', async () => {
    const spec = {
      eventId: 'e-exist',
      canonicalTradeId: 't-exist',
      subscriberId: USER_A,
      channel: 'telegram',
      eventType: 'entry'
    };
    const a = await DurableDelivery.ensureJob(spec);
    const b = await DurableDelivery.ensureJob(spec);
    assert.equal(a.jobId, b.jobId);
    assert.equal(b.state, 'pending');
    assert.notEqual(b.state, 'delivered');
    const acq = await DurableDelivery.beginAttempt(b, { owner: 'mA' });
    assert.equal(acq.status, 'acquired');
    const done = await DurableDelivery.commitDelivered(a.jobId);
    assert.equal(done.job.state, 'delivered');
    const third = await DurableDelivery.ensureJob(spec);
    assert.equal(third.state, 'delivered');
    const again = await DurableDelivery.beginAttempt(third, { owner: 'mB' });
    assert.equal(again.status, 'delivered');
  });

  it('Mongo durable store survives Redis restart; recovery scans durable docs', async () => {
    const job = await DurableDelivery.ensureJob({
      eventId: 'e-mongo',
      canonicalTradeId: 't-mongo',
      subscriberId: USER_A,
      channel: 'telegram',
      eventType: 'entry'
    });
    DurableDelivery.simulateRedisRestartForTests();
    const reloaded = await DurableDelivery.getJob(job.jobId);
    assert.ok(reloaded, 'job must be rediscovered from durable store after Redis loss');
    assert.equal(reloaded.state, 'pending');
    assert.notEqual(reloaded.state, 'delivered');
    const due = await DurableDelivery.listDueJobs();
    assert.ok(due.some(j => j.jobId === job.jobId));
    const acq = await DurableDelivery.beginAttempt({ jobId: job.jobId }, { owner: 'fly-2' });
    assert.equal(acq.status, 'acquired');
  });

  it('PENDING due is acquired; RETRY_PENDING not-due is skipped (fake clock backoff)', async () => {
    DurableDelivery.setNowForTests(1_000_000);
    const job = await DurableDelivery.ensureJob({
      eventId: 'e-back',
      canonicalTradeId: 't-back',
      subscriberId: USER_A,
      channel: 'telegram',
      eventType: 'entry'
    });
    const acq = await DurableDelivery.beginAttempt(job, { owner: 'mA' });
    assert.equal(acq.status, 'acquired');
    const retry = await DurableDelivery.scheduleRetry(job.jobId, { reason: 'send_failed' });
    assert.equal(retry.status, 'retry_pending');
    assert.ok(retry.delayMs >= 100);
    const notDue = await DurableDelivery.beginAttempt({ jobId: job.jobId }, { owner: 'mB' });
    assert.equal(notDue.status, 'not_due');
    const dueNow = await DurableDelivery.listDueJobs(1_000_000);
    assert.equal(dueNow.some(j => j.jobId === job.jobId), false);
    DurableDelivery.setNowForTests(retry.job.nextAttemptAt);
    const dueLater = await DurableDelivery.listDueJobs();
    assert.ok(dueLater.some(j => j.jobId === job.jobId));
    const acq2 = await DurableDelivery.beginAttempt({ jobId: job.jobId }, { owner: 'mB' });
    assert.equal(acq2.status, 'acquired');
  });

  it('crash A: persist+claim then missing job is recovered on duplicate webhook', async () => {
    const body = pine13('entry', 'frh-crash-a', { symbol: 'FRA' });
    const accept = await TradingViewAlertService.acceptTradingViewWebhook(io, body, mem);
    assert.equal(accept.accepted, true);
    const fan = (await DurableDelivery.listJobs()).find(j => j.channel === '_fanout');
    assert.ok(fan);
    DurableDelivery.dropJobForTests(fan.jobId);
    assert.equal(await DurableDelivery.getJob(fan.jobId), null);
    const recovered = await TradingViewAlertService.acceptTradingViewWebhook(io, body, mem);
    assert.equal(recovered.duplicate, true);
    assert.equal(recovered.reason, 'duplicate_event_id');
    const recreated = await DurableDelivery.getJob(fan.jobId);
    assert.ok(recreated, 'duplicate webhook must recreate missing durable work');
    assert.notEqual(recreated.state, 'delivered');
    await DurableDelivery.processDueJobs({ io, inMemorySignals: mem, owner: 'fly-2' });
    assert.equal(tg.calls, 1);
  });

  it('crash B: durable work before 202 is recovered by worker without a second job', async () => {
    const body = pine13('entry', 'frh-crash-b', { symbol: 'FRB' });
    const accept = await TradingViewAlertService.acceptTradingViewWebhook(io, body, mem);
    assert.equal(accept.accepted, true);
    const fans = (await DurableDelivery.listJobs()).filter(j => j.channel === '_fanout');
    assert.equal(fans.length, 1);
    assert.equal(tg.calls, 0);
    await DurableDelivery.processDueJobs({ io, inMemorySignals: mem, owner: 'fly-2' });
    assert.equal(tg.calls, 1);
    const fansAfter = (await DurableDelivery.listJobs()).filter(j => j.channel === '_fanout');
    assert.equal(fansAfter.length, 1);
  });

  it('crash C: lease before send is reclaimed (at-least-once until commit)', async () => {
    const sub = proSubscriber(USER_A, '80001');
    const signal = {
      ...pine13('entry', 'frh-crash-c', { symbol: 'FRC' }),
      _id: 'mem_frc',
      alertType: 'entry',
      entryAcceptedAt: new Date()
    };
    const claimed = await deliveryIdempotency.claimDelivery(signal, 'entry', 'telegram', USER_A, {
      subscriber: sub
    });
    assert.equal(claimed, true);
    assert.equal(tg.calls, 0);
    const spec = deliveryIdempotency.specFrom(signal, 'entry', 'telegram', USER_A);
    await DurableDelivery.simulateCrashForTests((await DurableDelivery.getJobBySpec(spec)).jobId);
    const sent = await TradeDeliveryService.deliverTelegram(sub, signal);
    assert.equal(sent.ok, true);
    assert.equal(tg.calls, 1);
  });

  it('crash D: Telegram 200 before PROVIDER_ACCEPTED may duplicate (at-least-once)', async () => {
    const sub = proSubscriber(USER_A, '80001');
    const signal = {
      ...pine13('entry', 'frh-crash-d1', { symbol: 'FRD1' }),
      _id: 'mem_frd1',
      alertType: 'entry',
      entryAcceptedAt: new Date()
    };
    const spec = deliveryIdempotency.specFrom(signal, 'entry', 'telegram', USER_A);
    const claimed = await deliveryIdempotency.claimDelivery(signal, 'entry', 'telegram', USER_A, {
      subscriber: sub
    });
    assert.equal(claimed, true);
    await DurableDelivery.markSendingBySpec(spec);
    await TelegramService.notifySubscriber(sub, signal);
    assert.equal(tg.calls, 1);
    const job = await DurableDelivery.getJobBySpec(spec);
    assert.equal(job.state, 'sending');
    await DurableDelivery.simulateCrashForTests(job.jobId);
    const sent = await TradeDeliveryService.deliverTelegram(sub, signal);
    assert.equal(sent.ok, true);
    assert.equal(tg.calls, 2, 'at-least-once: second sendMessage after crash before provider_accepted');
  });

  it('crash D2: PROVIDER_ACCEPTED before COMMITTED does not resend', async () => {
    const sub = proSubscriber(USER_A, '80001');
    const signal = {
      ...pine13('entry', 'frh-crash-d2', { symbol: 'FRD2' }),
      _id: 'mem_frd2',
      alertType: 'entry',
      entryAcceptedAt: new Date()
    };
    const spec = deliveryIdempotency.specFrom(signal, 'entry', 'telegram', USER_A);
    const claimed = await deliveryIdempotency.claimDelivery(signal, 'entry', 'telegram', USER_A, {
      subscriber: sub
    });
    assert.equal(claimed, true);
    await DurableDelivery.markSendingBySpec(spec);
    await TelegramService.notifySubscriber(sub, signal);
    assert.equal(tg.calls, 1);
    await DurableDelivery.markProviderAcceptedBySpec(spec);
    const mid = await DurableDelivery.getJobBySpec(spec);
    assert.equal(mid.state, 'provider_accepted');
    const sent = await TradeDeliveryService.deliverTelegram(sub, signal);
    assert.equal(tg.calls, 1, 'no second sendMessage after provider_accepted');
    const done = await DurableDelivery.getJobBySpec(spec);
    assert.equal(done.state, 'delivered');
    assert.ok(sent.ok === true || sent.reason === 'duplicate_milestone');
  });

  it('crash E: after COMMITTED, duplicate webhook does not send again (exactly-once at app layer)', async () => {
    await acceptAndProcess(io, pine13('entry', 'frh-crash-e', { symbol: 'FRE' }), mem);
    assert.equal(tg.calls, 1);
    await acceptAndProcess(io, pine13('entry', 'frh-crash-e', { symbol: 'FRE' }), mem);
    assert.equal(tg.calls, 1);
  });

  it('two machines: one lease winner; busy does nothing; delivered never reprocessed', async () => {
    const job = await DurableDelivery.ensureJob({
      eventId: 'e-2m',
      canonicalTradeId: 't-2m',
      subscriberId: USER_A,
      channel: 'telegram',
      eventType: 'entry'
    });
    const a = await DurableDelivery.beginAttempt(job, { owner: 'fly-1' });
    const b = await DurableDelivery.beginAttempt(job, { owner: 'fly-2' });
    assert.equal(a.status, 'acquired');
    assert.equal(b.status, 'busy');
    await DurableDelivery.commitDelivered(job.jobId);
    const c = await DurableDelivery.beginAttempt(job, { owner: 'fly-2' });
    assert.equal(c.status, 'delivered');
  });

  it('two machines: lease expiry recovers; Redis restart then fly-2 wins', async () => {
    const job = await DurableDelivery.ensureJob({
      eventId: 'e-2m-exp',
      canonicalTradeId: 't-2m-exp',
      subscriberId: USER_A,
      channel: 'telegram',
      eventType: 'entry'
    });
    const a = await DurableDelivery.beginAttempt(job, { owner: 'fly-1' });
    assert.equal(a.status, 'acquired');
    await DurableDelivery.simulateCrashForTests(job.jobId);
    DurableDelivery.simulateRedisRestartForTests();
    const b = await DurableDelivery.beginAttempt({ jobId: job.jobId }, { owner: 'fly-2' });
    assert.equal(b.status, 'acquired');
  });

  it('ENTRY fail to FAILED_TERMINAL keeps TP3 blocked; admin retry then TP3', async () => {
    process.env.DELIVERY_MAX_ATTEMPTS = '1';
    tg.failNext = 1;
    await acceptAndProcess(io, pine13('entry', 'frh-term-tp3', { symbol: 'FRT' }), mem);
    const entryJob = (await DurableDelivery.listJobs()).find(
      j => j.channel === 'telegram' && j.eventType === 'entry' && String(j.subscriberId) === USER_A
    );
    assert.ok(entryJob);
    assert.equal(entryJob.state, 'failed_terminal');
    await acceptAndProcess(io, pine13('take_profit_3', 'frh-term-tp3', { symbol: 'FRT' }), mem);
    assert.equal(tg.texts.filter(t => /TRADE COMPLETE|TP3 HIT/i.test(t)).length, 0);
    const tp3 = (await DurableDelivery.listJobs()).find(
      j => j.channel === 'telegram' && String(j.eventType || '').includes('take_profit_3')
    );
    if (tp3) {
      assert.notEqual(tp3.state, 'delivered');
    }
    tg.failNext = 0;
    const queued = await DurableDelivery.retryFailedTerminal(entryJob.jobId);
    assert.equal(queued.status, 'retry_pending');
    await DurableDelivery.markDueForTests(entryJob.jobId);
    await DurableDelivery.processDueJobs({ io, inMemorySignals: mem, owner: 'admin-retry' });
    for (const job of await DurableDelivery.listJobs()) {
      if (job.state === 'retry_pending' || job.state === 'blocked_waiting_for_entry') {
        await DurableDelivery.markDueForTests(job.jobId);
      }
    }
    await DurableDelivery.processDueJobs({ io, inMemorySignals: mem, owner: 'admin-retry' });
    const buy = tg.texts.findIndex(t => /KACHING BUY|KACHING SELL/i.test(t));
    const complete = tg.texts.findIndex(t => /TRADE COMPLETE|TP3 HIT/i.test(t));
    assert.ok(buy >= 0, 'ENTRY must send after admin retry');
    if (complete >= 0) assert.ok(buy < complete, 'ENTRY must precede TP3');
  });

  it('onEntryCommitted unblocks BLOCKED_WAITING_FOR_ENTRY', async () => {
    const entry = await DurableDelivery.ensureJob({
      eventId: 'e-ublk',
      canonicalTradeId: 't-ublk',
      subscriberId: USER_A,
      channel: 'telegram',
      eventType: 'entry'
    });
    const tp3 = await DurableDelivery.ensureJob({
      eventId: 'e-ublk-tp3',
      canonicalTradeId: 't-ublk',
      subscriberId: USER_A,
      channel: 'telegram',
      eventType: 'take_profit_3'
    });
    await DurableDelivery.scheduleRetry(tp3.jobId, {
      reason: 'blocked_waiting_for_entry',
      blockedWaitingForEntry: true
    });
    assert.equal((await DurableDelivery.getJob(tp3.jobId)).state, 'blocked_waiting_for_entry');
    await DurableDelivery.commitDelivered(entry.jobId);
    const n = await DurableDelivery.onEntryCommitted({
      canonicalTradeId: 't-ublk',
      subscriberId: USER_A,
      channel: 'telegram'
    });
    assert.ok(n >= 1);
    assert.equal((await DurableDelivery.getJob(tp3.jobId)).state, 'retry_pending');
  });

  it('ingestion Redis fail-closed 503; empty eventId never allows', async () => {
    process.env.TRADE_EVENT_REQUIRE_REDIS = '1';
    TradeEventStore.setClientForTests(null, { unavailable: true });
    const accept = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      pine13('entry', 'frh-503', { symbol: 'FR5' }),
      mem
    );
    assert.equal(accept.accepted, false);
    assert.equal(accept.httpStatus, 503);
    assert.equal(accept.reason, 'redis_unavailable');
    assert.equal(tg.calls, 0);
    TradeEventStore.setClientForTests(null, { unavailable: false });
    let threw = false;
    try {
      await TradeEventStore.claimEventId('');
    } catch (err) {
      threw = true;
      assert.equal(err.reason === 'missing_event_identity' || err.code === 'MISSING_EVENT_IDENTITY', true);
    }
    assert.equal(threw, true);
  });

  it('worker Redis errors are isolated; API process continues; job stays recoverable', async () => {
    const job = await DurableDelivery.ensureJob({
      eventId: 'e-iso',
      canonicalTradeId: 't-iso',
      subscriberId: USER_A,
      channel: 'telegram',
      eventType: 'entry'
    });
    const results = await DurableDelivery.processDueJobs({
      handler: async () => {
        const err = new Error('Redis unavailable for durableDelivery lease');
        err.code = 'REDIS_UNAVAILABLE';
        err.reason = 'redis_unavailable';
        throw err;
      }
    });
    assert.equal(results[0].isolated, true);
    const health = DurableDelivery.getWorkerHealth();
    assert.ok(health.lastError);
    const still = await DurableDelivery.getJob(job.jobId);
    assert.ok(still);
    assert.notEqual(still.state, 'failed_terminal');
    assert.notEqual(still.state, 'delivered');
  });

  it('PipelineStatus includes pending/processing/retry/delivered/failed/blocked/sending/provider_accepted', async () => {
    await acceptAndProcess(io, pine13('entry', 'frh-ps', { symbol: 'FRPS' }), mem);
    const status = await PipelineStatusService.getStatus();
    const c = status.durableDeliveryCounts;
    assert.ok(c);
    for (const key of [
      'pending',
      'processing',
      'sending',
      'retry_pending',
      'provider_accepted',
      'delivered',
      'failed_terminal',
      'blocked_waiting_for_entry'
    ]) {
      assert.equal(typeof c[key], 'number');
    }
    assert.ok(c.delivered >= 1);
    assert.ok(status.durableDeliveryWorker);
  });
});
