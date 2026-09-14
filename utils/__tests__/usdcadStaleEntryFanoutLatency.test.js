'use strict';

/**
 * USDCAD 2026-09-09 stale ENTRY / fan-out latency regression.
 * In-memory only. Never hits production Telegram / Mongo / Fly.
 *
 * Evidence trade: USDCAD-scalping-c3-1788950520000-short
 * Root cause: fan-out worker awaited email inside TV_FANOUT_CONCURRENCY slots.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.REDIS_ENABLED = process.env.REDIS_ENABLED || 'false';

const TradeDeliveryService = require('../../services/TradeDeliveryService');
const TradingViewAlertService = require('../../services/TradingViewAlertService');
const deliveryIdempotency = require('../deliveryIdempotency');
const DurableDelivery = require('../durableDelivery');
const TradeEventStore = require('../tradeEventStore');
const PipelineStatusService = require('../../services/PipelineStatusService');
const mailer = require('../mailer');
const {
  evaluateActionableEntryDelivery,
  DEFAULT_MAX_ENTRY_DELIVERY_AGE_MS
} = require('../entryDeliveryGuard');

let seq = 0;
const originalFetch = global.fetch;
let originalFanoutConcurrency;
let originalBot;
let originalDeliveryAge;
let originalSendTradeAlertEmail;

function entrySignal(overrides = {}) {
  seq += 1;
  const uuid = overrides.signalUuid || `usd-cad-lat-${seq}`;
  const now = Date.now();
  return {
    _id: overrides._id || `mem_usd_${seq}`,
    signalUuid: uuid,
    signalId: uuid,
    canonicalTradeId: uuid,
    eventId: `USDCAD|3|${uuid}|ENTRY`,
    alertType: 'entry',
    symbol: 'USDCAD',
    direction: 'short',
    timeframe: '3m',
    entry: 1.3782,
    stop_loss: 1.37839,
    take_profit_1: 1.37803,
    take_profit_2: 1.3778,
    take_profit_3: 1.3775,
    confidence: 0.8,
    entryAcceptedAt: new Date(now),
    webhookReceivedAt: new Date(now),
    eventTimestamp: now,
    ...overrides,
    signalUuid: uuid,
    signalId: uuid
  };
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
  return {
    emit() {},
    to() {
      return { emit() {} };
    }
  };
}

function mockTelegramOk(tracker) {
  global.fetch = async (_url, init) => {
    tracker.calls += 1;
    let chatId = '';
    try {
      chatId = JSON.parse(init.body).chat_id;
    } catch {
      /* ignore */
    }
    tracker.starts.push({ at: Date.now(), chatId });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: tracker.calls } }) };
  };
}

describe('USDCAD stale ENTRY fan-out latency', () => {
  beforeEach(() => {
    seq = 0;
    originalFanoutConcurrency = process.env.TV_FANOUT_CONCURRENCY;
    originalBot = process.env.TELEGRAM_BOT_TOKEN;
    originalDeliveryAge = process.env.MAX_ENTRY_DELIVERY_AGE_MS;
    originalSendTradeAlertEmail = mailer.sendTradeAlertEmail;
    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';
    process.env.TV_FANOUT_CONCURRENCY = '1';
    delete process.env.MAX_ENTRY_DELIVERY_AGE_MS;
    deliveryIdempotency.resetForTests();
    DurableDelivery.resetForTests();
    TradeEventStore.resetForTests();
    PipelineStatusService.resetForTests?.();
    TradeDeliveryService.resetPostSlotSocketQueueForTests?.();
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 1 } })
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    mailer.sendTradeAlertEmail = originalSendTradeAlertEmail;
    if (originalFanoutConcurrency == null) delete process.env.TV_FANOUT_CONCURRENCY;
    else process.env.TV_FANOUT_CONCURRENCY = originalFanoutConcurrency;
    if (originalBot == null) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalBot;
    if (originalDeliveryAge == null) delete process.env.MAX_ENTRY_DELIVERY_AGE_MS;
    else process.env.MAX_ENTRY_DELIVERY_AGE_MS = originalDeliveryAge;
    deliveryIdempotency.resetForTests();
    DurableDelivery.resetForTests();
    TradeEventStore.resetForTests();
    TradeDeliveryService.resetPostSlotSocketQueueForTests?.();
    TradeDeliveryService.resetPostSlotSocketForTests?.();
    TradeDeliveryService.setTestBeforeSocket?.(null);
  });

  it('J/K. delivery-age guard skips actionable ENTRY after MAX_ENTRY_DELIVERY_AGE_MS', () => {
    assert.equal(DEFAULT_MAX_ENTRY_DELIVERY_AGE_MS, 60_000);
    const receivedAt = Date.now() - 61_000;
    const signal = entrySignal({
      webhookReceivedAt: new Date(receivedAt),
      entryAcceptedAt: new Date(receivedAt + 10_000)
    });
    const decision = evaluateActionableEntryDelivery(signal, { now: Date.now() });
    assert.equal(decision.skip, true);
    assert.equal(decision.reason, 'stale_entry_delivery_age');
    assert.ok(decision.deliveryAgeMs > 60_000);
  });

  it('does not skip fresh ENTRY within delivery-age window', () => {
    const signal = entrySignal({
      webhookReceivedAt: new Date(Date.now() - 5_000),
      entryAcceptedAt: new Date(Date.now() - 4_000)
    });
    const decision = evaluateActionableEntryDelivery(signal, { now: Date.now() });
    assert.equal(decision.skip, false);
  });

  it('stale_entry_delivery_age skip commits accepted ENTRY so TP1 can deliver', async () => {
    const DeliverySequencer = require('../deliverySequencer');
    const tg = { calls: 0, texts: [] };
    global.fetch = async (_url, init) => {
      tg.calls += 1;
      let text = '';
      try {
        text = JSON.parse(init?.body || '{}').text || '';
      } catch {
        text = String(init?.body || '');
      }
      tg.texts.push(text);
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: { message_id: tg.calls } };
        }
      };
    };

    const signal = entrySignal({
      signalUuid: 'usd-cad-stale-age-tp1',
      webhookReceivedAt: new Date(Date.now() - 90_000),
      entryAcceptedAt: new Date(Date.now() - 80_000)
    });
    const guard = evaluateActionableEntryDelivery(signal);
    assert.equal(guard.reason, 'stale_entry_delivery_age');
    // Bare skip (no accepted-skip flag) still must not commit.
    assert.equal(
      DeliverySequencer.shouldCommitResult({ ok: false, reason: 'stale_entry_delivery_age' }),
      false
    );
    assert.equal(
      DeliverySequencer.shouldCommitResult({
        ok: false,
        skipped: true,
        reason: 'stale_entry_delivery_age',
        commitAcceptedEntrySkip: true
      }),
      true
    );

    const sub = proSubscriber('stale-age-sub', 7777);
    const entryResult = await TradeDeliveryService.deliverTelegram(sub, signal);
    assert.equal(entryResult.ok, false);
    assert.equal(entryResult.reason, 'stale_entry_delivery_age');
    assert.equal(entryResult.skipped, true);
    assert.equal(tg.calls, 0);

    const committed = await TradeEventStore.getCommittedDeliveries(
      signal.canonicalTradeId,
      sub.id,
      'telegram'
    );
    assert.equal(committed.has('entry'), true);

    const tp = {
      ...signal,
      alertType: 'take_profit_1',
      eventId: `USDCAD|3|${signal.signalUuid}|TP1`
    };
    const tpResult = await TradeDeliveryService.deliverTelegram(sub, tp, {
      waitMode: 'check_once'
    });
    assert.equal(tpResult.ok, true);
    assert.ok(tg.texts.some(t => /TP1/i.test(t)));
    assert.equal(tg.texts.filter(t => /KACHING BUY/i.test(t)).length, 0);
  });

  it('A/C. slow email must not delay telegram for next fan-out subscriber (concurrency=1)', async () => {
    const tg = { calls: 0, starts: [] };
    mockTelegramOk(tg);
    const slowEmailMs = 400;
    const emailEvents = [];
    mailer.sendTradeAlertEmail = async ({ to }) => {
      emailEvents.push({ phase: 'start', to, at: Date.now() });
      await new Promise((r) => setTimeout(r, slowEmailMs));
      emailEvents.push({ phase: 'done', to, at: Date.now() });
      return { ok: true };
    };

    const signal = entrySignal({ signalUuid: 'usd-cad-fanout-latency' });
    const subA = proSubscriber('sub-a', 1001);
    const subB = proSubscriber('sub-b', 1002);
    const t0 = Date.now();
    await TradingViewAlertService.fanOutAcceptedSignal(ioMock(), signal, signal, [], {
      subscribers: [subA, subB]
    });
    const elapsed = Date.now() - t0;
    await TradeDeliveryService.waitForPostSlotSocketIdle();
    const emailDeadline = Date.now() + 3000;
    while (
      Date.now() < emailDeadline &&
      !emailEvents.some((e) => e.phase === 'done' && String(e.to).includes('sub-a'))
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }

    assert.ok(tg.starts.length >= 2, `expected 2 telegram starts, got ${tg.starts.length}`);
    const tgB = tg.starts[1].at;
    const emailDoneA = emailEvents.find((e) => e.phase === 'done' && String(e.to).includes('sub-a'));
    assert.ok(emailDoneA, 'sub-a email must eventually complete');
    assert.ok(
      tgB < emailDoneA.at,
      `telegram for sub-b (${tgB}) must start before email_done sub-a (${emailDoneA.at})`
    );
    assert.ok(
      elapsed < slowEmailMs * 2,
      `fan-out elapsed ${elapsed}ms should be < ${slowEmailMs * 2}ms when email is non-blocking`
    );
  });

  it('prioritizes telegram-ready subscribers ahead of email-only rows', async () => {
    const seen = [];
    const original = TradeDeliveryService.deliverToSubscriber;
    TradeDeliveryService.deliverToSubscriber = async (_io, _signal, subscriber) => {
      seen.push(subscriber.id);
      return { ok: true };
    };
    try {
      const signal = entrySignal();
      const emailOnly = proSubscriber('email-only', '', {
        telegram: { chatId: '', enabled: false }
      });
      const tgReady = proSubscriber('tg-ready', 4242);
      await TradingViewAlertService.fanOutAcceptedSignal(ioMock(), signal, signal, [], {
        subscribers: [emailOnly, tgReady]
      });
      assert.deepEqual(seen.slice(0, 2), ['tg-ready', 'email-only']);
    } finally {
      TradeDeliveryService.deliverToSubscriber = original;
    }
  });

  it('email DeliveryJob is durable before provider completion (release path)', async () => {
    const tg = { calls: 0, starts: [] };
    mockTelegramOk(tg);
    let providerStarted = false;
    let providerReleased;
    const hold = new Promise((resolve) => {
      providerReleased = resolve;
    });
    mailer.sendTradeAlertEmail = async () => {
      providerStarted = true;
      await hold;
      return { ok: true };
    };
    const signal = entrySignal({ signalUuid: 'usd-cad-email-durable' });
    const sub = proSubscriber('durable-email-sub', 5555);
    const deliverP = TradeDeliveryService.deliverToSubscriber(ioMock(), signal, sub, {
      releaseAfterCriticalProviders: true
    });
    const deadline = Date.now() + 2000;
    let job = null;
    while (Date.now() < deadline) {
      job = await DurableDelivery.getJobBySpec({
        eventId: signal.eventId,
        canonicalTradeId: signal.canonicalTradeId,
        subscriberId: sub.id,
        channel: 'email',
        eventType: 'entry'
      });
      if (job) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(job, 'email DeliveryJob must exist before/while provider runs');
    assert.ok(
      ['pending', 'processing', 'sending', 'provider_accepted', 'delivered'].includes(job.state),
      `unexpected email job state=${job.state}`
    );
    const returned = await deliverP;
    assert.equal(returned.deferredSocket, true);
    // Provider may or may not have started; job must already be durable either way.
    assert.equal(providerStarted || Boolean(job), true);
    providerReleased();
    await TradeDeliveryService.waitForDetachedProvidersForTests();
    await TradeDeliveryService.waitForPostSlotSocketIdle();
  });

  it('slow Telegram must not delay next subscriber MT5 attempt (concurrency=1)', async () => {
    process.env.TV_FANOUT_CONCURRENCY = '1';
    const Mt5TradeCopierService = require('../../services/Mt5TradeCopierService');
    const originalQueue = Mt5TradeCopierService.queueExecutionForUser;
    const mt5Starts = [];
    Mt5TradeCopierService.queueExecutionForUser = async (userId) => {
      mt5Starts.push({ userId: String(userId), at: Date.now() });
      return { ok: true };
    };
    mailer.sendTradeAlertEmail = async () => ({ ok: true });
    let releaseSlowTg;
    const holdTg = new Promise((resolve) => {
      releaseSlowTg = resolve;
    });
    global.fetch = async (_url, init) => {
      let chatId = '';
      try {
        chatId = JSON.parse(init.body).chat_id;
      } catch {
        /* ignore */
      }
      if (String(chatId) === '7001') {
        await holdTg;
      }
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    };

    const signal = entrySignal({ signalUuid: 'usd-cad-tg-mt5-decouple' });
    const slowTg = {
      id: 'sub-slow-tg',
      email: 'slow-tg@example.com',
      subscription: { tier: 'premium', status: 'active' },
      telegram: { chatId: '7001', enabled: true, telegramMode: 'alerts_only' },
      mt5: { executionMode: 'auto', enabled: true, devices: [{ deviceId: 'd1' }] },
      preferences: { emailAlerts: true }
    };
    const fastMt5 = {
      id: 'sub-fast-mt5',
      email: 'fast-mt5@example.com',
      subscription: { tier: 'premium', status: 'active' },
      telegram: { chatId: '7002', enabled: true, telegramMode: 'alerts_only' },
      mt5: { executionMode: 'auto', enabled: true, devices: [{ deviceId: 'd2' }] },
      preferences: { emailAlerts: true }
    };

    // Avoid real linked-device checks by stubbing isMt5Linked if needed.
    const originalLinked = Mt5TradeCopierService.isMt5Linked;
    Mt5TradeCopierService.isMt5Linked = () => true;
    const originalResolve = Mt5TradeCopierService.resolveExecutionMode;
    Mt5TradeCopierService.resolveExecutionMode = () => 'auto';

    try {
      const fanoutP = TradingViewAlertService.fanOutAcceptedSignal(ioMock(), signal, signal, [], {
        subscribers: [slowTg, fastMt5]
      });
      const mt5B = await (async () => {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          if (mt5Starts.some((s) => s.userId === 'sub-fast-mt5')) return true;
          await new Promise((r) => setTimeout(r, 15));
        }
        return false;
      })();
      assert.equal(
        mt5B,
        true,
        'subscriber B MT5 must start while subscriber A Telegram is still held'
      );
      releaseSlowTg();
      await fanoutP;
      await TradeDeliveryService.waitForDetachedProvidersForTests();
      await TradeDeliveryService.waitForPostSlotSocketIdle();
    } finally {
      Mt5TradeCopierService.queueExecutionForUser = originalQueue;
      Mt5TradeCopierService.isMt5Linked = originalLinked;
      Mt5TradeCopierService.resolveExecutionMode = originalResolve;
    }
  });

  it('concurrency=8 with 36 subscribers: slow email must not serialize telegram starts', async () => {
    process.env.TV_FANOUT_CONCURRENCY = '8';
    const tg = { calls: 0, starts: [] };
    mockTelegramOk(tg);
    const slowEmailMs = 250;
    mailer.sendTradeAlertEmail = async () => {
      await new Promise((r) => setTimeout(r, slowEmailMs));
      return { ok: true };
    };
    const signal = entrySignal({ signalUuid: 'usd-cad-36-fanout' });
    const subscribers = Array.from({ length: 36 }, (_, i) =>
      proSubscriber(`sub-${i}`, 9000 + i)
    );
    const t0 = Date.now();
    await TradingViewAlertService.fanOutAcceptedSignal(ioMock(), signal, signal, [], {
      subscribers
    });
    const elapsed = Date.now() - t0;
    await TradeDeliveryService.waitForDetachedProvidersForTests();
    await TradeDeliveryService.waitForPostSlotSocketIdle();
    assert.ok(tg.starts.length >= 36, `expected 36 telegram starts, got ${tg.starts.length}`);
    const firstWave = tg.starts.filter((s) => s.at - t0 < 150).length;
    assert.ok(
      firstWave >= 8,
      `expected >=8 telegram starts in first 150ms under concurrency 8, got ${firstWave}`
    );
    // If email still held slots: 36 * ~250ms / 8 ≈ 1125ms minimum of pure email wait.
    assert.ok(
      elapsed < slowEmailMs * 36 / 8,
      `fan-out elapsed ${elapsed}ms must beat serial-email bound ${slowEmailMs * 36 / 8}ms`
    );
  });
});
