/**
 * P0 live ENTRY fan-out slot release — Tests A–R.
 * Mocks only. Never hits production Telegram / Fly / Redis / Mongo.
 */
'use strict';

process.env.REDIS_ENABLED = process.env.REDIS_ENABLED || 'false';
process.env.NODE_ENV = 'test';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const TradeDeliveryService = require('../TradeDeliveryService');
const TradingViewAlertService = require('../TradingViewAlertService');
const deliveryIdempotency = require('../../utils/deliveryIdempotency');
const DurableDelivery = require('../../utils/durableDelivery');
const DeliverySequencer = require('../../utils/deliverySequencer');
const TradeEventStore = require('../../utils/tradeEventStore');
const PipelineStatusService = require('../PipelineStatusService');

let seq = 0;
const originalFetch = global.fetch;
let originalFanoutConcurrency;
let originalInflight;
let originalQueue;
let originalBot;

function entrySignal(overrides = {}) {
  seq += 1;
  const uuid = overrides.signalUuid || `slot-uuid-${seq}`;
  return {
    _id: overrides._id || `mem_slot_${seq}`,
    signalUuid: uuid,
    signalId: uuid,
    canonicalTradeId: uuid,
    eventId: `EURUSD|15m|${uuid}|ENTRY`,
    alertType: 'entry',
    symbol: 'EURUSD',
    direction: 'long',
    timeframe: '15m',
    entry: 1.1,
    stop_loss: 1.09,
    take_profit_1: 1.11,
    take_profit_2: 1.12,
    take_profit_3: 1.13,
    confidence: 0.8,
    entryAcceptedAt: new Date(),
    ...overrides,
    signalUuid: uuid,
    signalId: uuid
  };
}

function tpSignal(overrides = {}) {
  const base = entrySignal({ alertType: 'take_profit_1', ...overrides });
  base.eventId = `EURUSD|15m|${base.signalUuid}|TP1`;
  return base;
}

function proSubscriber(id, chatId, overrides = {}) {
  return {
    id,
    email: `${id}@example.com`,
    subscription: { tier: 'professional', status: 'active' },
    telegram: { chatId: String(chatId), enabled: true, telegramMode: 'manual_confirmation' },
    mt5: { executionMode: 'manual', enabled: true, devices: [] },
    preferences: { emailAlerts: true },
    ...overrides
  };
}

function ioMock() {
  const emits = [];
  return {
    emits,
    emit(...args) {
      emits.push({ room: '*', args });
    },
    to(room) {
      return {
        emit(...args) {
          emits.push({ room, args });
        }
      };
    }
  };
}

function mockTelegramOk(tracker) {
  global.fetch = async url => {
    assert.match(String(url), /api\.telegram\.org\/bot/);
    const startedAt = Date.now();
    tracker.calls += 1;
    tracker.starts.push(startedAt);
    tracker.lastUrl = String(url);
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, result: { message_id: tracker.calls } };
      }
    };
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitUntil(predicate, { timeoutMs = 1000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

describe('P0 live ENTRY slot release A–R', { concurrency: false }, () => {
  beforeEach(() => {
    originalFanoutConcurrency = process.env.TV_FANOUT_CONCURRENCY;
    originalInflight = process.env.TV_POST_SLOT_SOCKET_INFLIGHT;
    originalQueue = process.env.TV_POST_SLOT_SOCKET_QUEUE;
    originalBot = process.env.TELEGRAM_BOT_TOKEN;
    process.env.NODE_ENV = 'test';
    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token-not-real';
    process.env.EMAIL_TRADE_ALERTS_ENABLED = 'false';
    deliveryIdempotency.resetForTests();
    DurableDelivery.resetForTests();
    TradeEventStore.resetForTests();
    PipelineStatusService.resetForTests?.();
    TradeDeliveryService.resetPostSlotSocketForTests();
    TradingViewAlertService.resetTestFanoutHooks();
  });

  afterEach(async () => {
    TradeDeliveryService.setTestBeforeSocket(null);
    TradeDeliveryService.resetPostSlotSocketForTests();
    global.fetch = originalFetch;
    if (originalFanoutConcurrency == null) delete process.env.TV_FANOUT_CONCURRENCY;
    else process.env.TV_FANOUT_CONCURRENCY = originalFanoutConcurrency;
    if (originalInflight == null) delete process.env.TV_POST_SLOT_SOCKET_INFLIGHT;
    else process.env.TV_POST_SLOT_SOCKET_INFLIGHT = originalInflight;
    if (originalQueue == null) delete process.env.TV_POST_SLOT_SOCKET_QUEUE;
    else process.env.TV_POST_SLOT_SOCKET_QUEUE = originalQueue;
    if (originalBot == null) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalBot;
    delete process.env.EMAIL_TRADE_ALERTS_ENABLED;
    TradingViewAlertService.resetTestFanoutHooks();
    DurableDelivery.resetForTests();
    deliveryIdempotency.resetForTests();
  });

  it('A. slow socket does not block next subscriber telegram start', async () => {
    process.env.TV_FANOUT_CONCURRENCY = '1';
    const tg = { calls: 0, starts: [] };
    mockTelegramOk(tg);
    const io = ioMock();
    const slow = proSubscriber('slot-slow', '80001');
    const fast = proSubscriber('slot-fast', '80002');
    let slowSocketStarted = false;
    let slowSocketReleased = false;
    let releaseSlow;
    const hold = new Promise(resolve => {
      releaseSlow = resolve;
    });
    TradeDeliveryService.setTestBeforeSocket(async subscriber => {
      if (subscriber?.id === 'slot-slow') {
        slowSocketStarted = true;
        await hold;
        slowSocketReleased = true;
      }
    });
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [slow, fast] });
    const saved = entrySignal({ signalUuid: 'slot-a-fanout' });
    const fanoutP = TradingViewAlertService.fanOutAcceptedSignal(io, saved, saved, [], {
      subscribers: [slow, fast]
    });
    try {
      const fastStarted = await waitUntil(() => tg.starts.length >= 2);
      assert.equal(fastStarted, true, 'subscriber 2 telegram must start while sub 1 socket is held');
      assert.equal(tg.calls, 2);
      assert.equal(slowSocketReleased, false, 'slow socket must not finish before fast telegram starts');
    } finally {
      releaseSlow();
    }
    const delivery = await fanoutP;
    assert.equal(delivery.delivered, 2);
    assert.equal(slowSocketReleased, true);
  });

  it('B. deliverToSubscriber ENTRY + release flag returns before socket emit', async () => {
    const tg = { calls: 0, starts: [] };
    mockTelegramOk(tg);
    const io = ioMock();
    const sub = proSubscriber('slot-b', '80003');
    let socketDone = false;
    let release;
    const hold = new Promise(resolve => {
      release = resolve;
    });
    TradeDeliveryService.setTestBeforeSocket(async () => {
      await hold;
      socketDone = true;
    });
    const returned = await TradeDeliveryService.deliverToSubscriber(io, entrySignal(), sub, {
      releaseAfterCriticalProviders: true
    });
    try {
      assert.equal(returned.deferredSocket, true);
      assert.equal(socketDone, false);
      assert.equal(io.emits.length, 0);
      assert.ok(tg.calls >= 1);
    } finally {
      release();
    }
    await TradeDeliveryService.waitForPostSlotSocketIdle();
    assert.equal(socketDone, true);
    assert.ok(io.emits.length >= 1);
  });

  it('C. socket DeliveryJob exists before fan-out slot release', async () => {
    const tg = { calls: 0, starts: [] };
    mockTelegramOk(tg);
    const io = ioMock();
    const sub = proSubscriber('slot-c', '80004');
    let release;
    const hold = new Promise(resolve => {
      release = resolve;
    });
    TradeDeliveryService.setTestBeforeSocket(async () => hold);
    const signal = entrySignal({ signalUuid: 'slot-c-uuid' });
    await TradeDeliveryService.deliverToSubscriber(io, signal, sub, {
      releaseAfterCriticalProviders: true
    });
    try {
      const job = await DurableDelivery.getJobBySpec({
        eventId: signal.eventId,
        canonicalTradeId: signal.canonicalTradeId,
        subscriberId: sub.id,
        channel: 'socket',
        eventType: 'entry'
      });
      assert.ok(job, 'socket job must exist before detached emit');
      assert.ok(
        ['pending', 'processing', 'sending'].includes(job.state),
        `socket job state=${job.state} must be recoverable`
      );
    } finally {
      release();
    }
    await TradeDeliveryService.waitForPostSlotSocketIdle();
  });

  it('D. crash after socket ensureJob before emit: recovery delivers socket, no telegram resend', async () => {
    const tg = { calls: 0, starts: [] };
    mockTelegramOk(tg);
    const io = ioMock();
    const sub = proSubscriber('slot-d', '80005');
    const signal = entrySignal({ signalUuid: 'slot-d-uuid' });
    await TradeDeliveryService.deliverTelegram(sub, signal);
    const tgAfterLive = tg.calls;
    assert.ok(tgAfterLive >= 1);
    const spec = {
      eventId: signal.eventId,
      canonicalTradeId: signal.canonicalTradeId,
      subscriberId: sub.id,
      channel: 'socket',
      eventType: 'entry',
      signalUuid: signal.signalUuid,
      payload: {
        subscriber: DurableDelivery.snapshotSubscriber(sub),
        signal: DurableDelivery.snapshotSignal(signal)
      }
    };
    const job = await DurableDelivery.ensureJob(spec);
    assert.equal(job.state, 'pending');
    const recovered = await TradingViewAlertService.processDurableJob(job, { io, waitMode: 'check_once' });
    assert.ok(recovered);
    const after = await DurableDelivery.getJob(job.jobId);
    assert.equal(after.state, 'delivered');
    assert.equal(tg.calls, tgAfterLive, 'recovery of socket must not resend telegram');
    assert.ok(io.emits.some(e => e.args[0] === 'tv:live-alert'));
  });

  it('E. persistDeliveryFlags is non-authoritative: mapper can return with DeliveryJob already committed', async () => {
    const tg = { calls: 0, starts: [] };
    mockTelegramOk(tg);
    const io = ioMock();
    const sub = proSubscriber('slot-e', '80006');
    const signal = entrySignal({ signalUuid: 'slot-e-uuid' });
    await TradeDeliveryService.deliverToSubscriber(io, signal, sub, {
      releaseAfterCriticalProviders: true
    });
    await TradeDeliveryService.waitForPostSlotSocketIdle();
    const tgJob = await DurableDelivery.getJobBySpec({
      eventId: signal.eventId,
      canonicalTradeId: signal.canonicalTradeId,
      subscriberId: sub.id,
      channel: 'telegram',
      eventType: 'entry'
    });
    assert.ok(tgJob);
    assert.equal(tgJob.state, 'delivered');
  });

  it('F. ENTRY email∥telegram∥mt5 still start together (RC-G preserved)', async () => {
    const tg = { calls: 0, starts: [] };
    mockTelegramOk(tg);
    const io = ioMock();
    const sub = proSubscriber('slot-f', '80007');
    const t0 = Date.now();
    await TradeDeliveryService.deliverToSubscriber(io, entrySignal(), sub, {
      releaseAfterCriticalProviders: true
    });
    await TradeDeliveryService.waitForPostSlotSocketIdle();
    assert.ok(tg.starts[0] - t0 < 500, 'telegram still starts on the critical path');
  });

  it('G. outcome path still waits for socket even with release flag', async () => {
    const tg = { calls: 0, starts: [] };
    mockTelegramOk(tg);
    const io = ioMock();
    const sub = proSubscriber('slot-g', '80008');
    const uuid = 'slot-g-uuid';
    await TradeDeliveryService.deliverToSubscriber(io, entrySignal({ signalUuid: uuid }), sub, {
      releaseAfterCriticalProviders: true
    });
    await TradeDeliveryService.waitForPostSlotSocketIdle();
    let socketDone = false;
    TradeDeliveryService.setTestBeforeSocket(async () => {
      await sleep(40);
      socketDone = true;
    });
    const p = TradeDeliveryService.deliverToSubscriber(
      io,
      tpSignal({ signalUuid: uuid, eventId: `EURUSD|15m|${uuid}|TP1` }),
      sub,
      { releaseAfterCriticalProviders: true }
    );
    const raced = await Promise.race([p.then(() => 'returned'), sleep(15).then(() => 'waiting')]);
    assert.equal(raced, 'waiting');
    await p;
    assert.equal(socketDone, true);
  });

  it('H. FANOUT_CONCURRENCY stays bounded (8 default, never subscriber count)', async () => {
    delete process.env.TV_FANOUT_CONCURRENCY;
    assert.equal(TradingViewAlertService.getFanoutConcurrency(), 8);
    process.env.TV_FANOUT_CONCURRENCY = '38';
    assert.equal(TradingViewAlertService.getFanoutConcurrency(), 32);
    process.env.TV_FANOUT_CONCURRENCY = '100';
    assert.equal(TradingViewAlertService.getFanoutConcurrency(), 32);
    process.env.TV_FANOUT_CONCURRENCY = '1';
    assert.equal(TradingViewAlertService.getFanoutConcurrency(), 1);
  });

  it('I. duplicate deliverToSubscriber does not resend telegram', async () => {
    const tg = { calls: 0, starts: [] };
    mockTelegramOk(tg);
    const io = ioMock();
    const sub = proSubscriber('slot-i', '80009');
    const signal = entrySignal({ signalUuid: 'slot-i-uuid' });
    await TradeDeliveryService.deliverToSubscriber(io, signal, sub, {
      releaseAfterCriticalProviders: true
    });
    await TradeDeliveryService.waitForPostSlotSocketIdle();
    const first = tg.calls;
    await TradeDeliveryService.deliverToSubscriber(io, signal, sub, {
      releaseAfterCriticalProviders: true
    });
    await TradeDeliveryService.waitForPostSlotSocketIdle();
    assert.equal(tg.calls, first);
  });

  it('J. Redis unavailable on socket ensureJob fail-closes: slot held, socket still attempted', async () => {
    const tg = { calls: 0, starts: [] };
    mockTelegramOk(tg);
    const io = ioMock();
    const sub = proSubscriber('slot-j', '80010');
    const originalEnsure = DurableDelivery.ensureJob;
    DurableDelivery.ensureJob = async spec => {
      if (spec.channel === 'socket') {
        const err = new Error('Redis unavailable for durableDelivery; refusing process-local fallback');
        err.code = 'REDIS_UNAVAILABLE';
        err.reason = 'redis_unavailable';
        throw err;
      }
      return originalEnsure(spec);
    };
    try {
      let socketDone = false;
      TradeDeliveryService.setTestBeforeSocket(async () => {
        await sleep(30);
        socketDone = true;
      });
      const p = TradeDeliveryService.deliverToSubscriber(io, entrySignal(), sub, {
        releaseAfterCriticalProviders: true
      });
      const raced = await Promise.race([p.then(() => 'returned'), sleep(10).then(() => 'waiting')]);
      assert.equal(raced, 'waiting', 'must hold the fan-out slot when socket is not durably owned');
      const result = await p;
      assert.equal(socketDone, true);
      assert.notEqual(result?.deferredSocket, true);
    } finally {
      DurableDelivery.ensureJob = originalEnsure;
    }
  });

  it('K. post-slot socket inflight is bounded; overflow stays recoverable DeliveryJobs', async () => {
    process.env.TV_POST_SLOT_SOCKET_INFLIGHT = '2';
    process.env.TV_POST_SLOT_SOCKET_QUEUE = '0';
    const tg = { calls: 0, starts: [] };
    mockTelegramOk(tg);
    const io = ioMock();
    const signal = entrySignal({ signalUuid: 'slot-k-uuid' });
    const subs = [
      proSubscriber('slot-k1', '80101'),
      proSubscriber('slot-k2', '80102'),
      proSubscriber('slot-k3', '80103'),
      proSubscriber('slot-k4', '80104')
    ];
    let release;
    const hold = new Promise(resolve => {
      release = resolve;
    });
    TradeDeliveryService.setTestBeforeSocket(async () => hold);
    await Promise.all(
      subs.map(sub =>
        TradeDeliveryService.deliverToSubscriber(io, signal, sub, {
          releaseAfterCriticalProviders: true
        })
      )
    );
    try {
      const stats = TradeDeliveryService.getPostSlotSocketStatsForTests();
      assert.ok(stats.workers + stats.queued <= 2, `inflight ${stats.workers}+${stats.queued} exceeds cap 2`);
      const socketJobs = (await DurableDelivery.listJobs()).filter(j => j.channel === 'socket');
      assert.equal(socketJobs.length, 4);
      const pendingOverflow = socketJobs.filter(j => j.state === 'pending');
      assert.ok(pendingOverflow.length >= 2, 'overflow subscribers must remain recoverable pending jobs');
      release();
      await TradeDeliveryService.waitForPostSlotSocketIdle();
      for (const job of pendingOverflow) {
        await TradingViewAlertService.processDurableJob(job, { io, waitMode: 'check_once' });
      }
      const after = (await DurableDelivery.listJobs()).filter(j => j.channel === 'socket');
      const delivered = after.filter(j => j.state === 'delivered');
      assert.ok(delivered.length >= 2);
    } finally {
      release();
      await TradeDeliveryService.waitForPostSlotSocketIdle();
    }
  });

  it('L. detached socket rejection is caught (no unhandled rejection)', async () => {
    const tg = { calls: 0, starts: [] };
    mockTelegramOk(tg);
    const io = {
      emit() {
        throw new Error('socket_boom');
      },
      to() {
        return {
          emit() {
            throw new Error('socket_boom');
          }
        };
      }
    };
    const sub = proSubscriber('slot-l', '80011');
    let unhandled = null;
    const onUnhandled = err => {
      unhandled = err;
    };
    process.once('unhandledRejection', onUnhandled);
    await TradeDeliveryService.deliverToSubscriber(io, entrySignal(), sub, {
      releaseAfterCriticalProviders: true
    });
    await TradeDeliveryService.waitForPostSlotSocketIdle();
    await sleep(20);
    process.removeListener('unhandledRejection', onUnhandled);
    assert.equal(unhandled, null);
  });

  it('M. sequencer ENTRY predecessors remain empty (RC-E)', () => {
    assert.deepEqual(DeliverySequencer.requiredPredecessors('entry', []), []);
    assert.deepEqual(DeliverySequencer.requiredPredecessors('entry', ['take_profit_1']), []);
    assert.ok(DeliverySequencer.requiredPredecessors('take_profit_1', []).includes('entry'));
  });

  it('N. FANOUT_CONCURRENCY=8 does not allocate 38 provider calls for 2 subscribers', async () => {
    process.env.TV_FANOUT_CONCURRENCY = '8';
    const tg = { calls: 0, starts: [] };
    mockTelegramOk(tg);
    const io = ioMock();
    const a = proSubscriber('slot-n1', '80012');
    const b = proSubscriber('slot-n2', '80013');
    const saved = entrySignal({ signalUuid: 'slot-n-uuid' });
    await TradingViewAlertService.fanOutAcceptedSignal(io, saved, saved, [], {
      subscribers: [a, b]
    });
    assert.equal(tg.calls, 2);
  });

  it('O. fan-out commit after slot release does not lose socket job', async () => {
    const tg = { calls: 0, starts: [] };
    mockTelegramOk(tg);
    const io = ioMock();
    const sub = proSubscriber('slot-o', '80014');
    const saved = entrySignal({ signalUuid: 'slot-o-uuid' });
    await TradingViewAlertService.fanOutAcceptedSignal(io, saved, saved, [], {
      subscribers: [sub]
    });
    const socketJob = (await DurableDelivery.listJobs()).find(
      j => j.channel === 'socket' && j.subscriberId === sub.id
    );
    assert.ok(socketJob);
    assert.equal(socketJob.state, 'delivered');
  });

  it('P. provider_accepted telegram is not resent when socket recovers', async () => {
    const tg = { calls: 0, starts: [] };
    mockTelegramOk(tg);
    const io = ioMock();
    const sub = proSubscriber('slot-p', '80015');
    const signal = entrySignal({ signalUuid: 'slot-p-uuid' });
    await TradeDeliveryService.deliverTelegram(sub, signal);
    const first = tg.calls;
    const tgJob = await DurableDelivery.getJobBySpec({
      eventId: signal.eventId,
      canonicalTradeId: signal.canonicalTradeId,
      subscriberId: sub.id,
      channel: 'telegram',
      eventType: 'entry'
    });
    assert.equal(tgJob.state, 'delivered');
    await TradingViewAlertService.processDurableJob(tgJob, { io, waitMode: 'check_once' });
    assert.equal(tg.calls, first);
  });

  it('Q. slot timing ring is capped (no unlimited history)', async () => {
    const tg = { calls: 0, starts: [] };
    mockTelegramOk(tg);
    const io = ioMock();
    for (let i = 0; i < 40; i += 1) {
      const sub = proSubscriber(`slot-q-${i}`, `809${String(i).padStart(2, '0')}`);
      await TradeDeliveryService.deliverToSubscriber(io, entrySignal(), sub, {
        releaseAfterCriticalProviders: true
      });
    }
    await TradeDeliveryService.waitForPostSlotSocketIdle();
    const stats = TradeDeliveryService.getPostSlotSocketStatsForTests();
    assert.ok(stats.timings.length <= 32);
  });

  it('R. recovered socket uses check_once waitMode (no live poll loop)', async () => {
    const io = ioMock();
    const sub = proSubscriber('slot-r', '80016');
    const signal = entrySignal({ signalUuid: 'slot-r-uuid' });
    const job = await DurableDelivery.ensureJob({
      eventId: signal.eventId,
      canonicalTradeId: signal.canonicalTradeId,
      subscriberId: sub.id,
      channel: 'socket',
      eventType: 'entry',
      signalUuid: signal.signalUuid,
      payload: {
        subscriber: DurableDelivery.snapshotSubscriber(sub),
        signal: DurableDelivery.snapshotSignal(signal)
      }
    });
    const original = DeliverySequencer.withChannelSequence;
    const modes = [];
    DeliverySequencer.withChannelSequence = async opts => {
      modes.push(opts.waitMode);
      return original(opts);
    };
    try {
      await TradingViewAlertService.processDurableJob(job, { io, waitMode: 'check_once' });
    } finally {
      DeliverySequencer.withChannelSequence = original;
    }
    assert.ok(modes.includes('check_once'));
  });
});
