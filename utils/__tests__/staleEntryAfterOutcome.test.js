'use strict';

/**
 * Production duplicate/stale ENTRY contracts.
 * In-memory only. Never hits production Telegram / Mongo / Fly.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { generateLicenseToken } = require('../webhookSecurity');
const TradingViewAlertService = require('../../services/TradingViewAlertService');
const TradeDeliveryService = require('../../services/TradeDeliveryService');
const PipelineStatusService = require('../../services/PipelineStatusService');
const ActiveSignalRegistry = require('../activeSignalRegistry');
const TradeEventDispatcher = require('../tradeEventDispatcher');
const TradeEventStore = require('../tradeEventStore');
const deliveryIdempotency = require('../deliveryIdempotency');
const DurableDelivery = require('../durableDelivery');
const SubscriberSignalFormatter = require('../../services/SubscriberSignalFormatter');
const {
  evaluateActionableEntryDelivery,
  mergeLiveLifecycleForEntryDelivery,
  DEFAULT_MAX_TERMINAL_ENTRY_OVERLAP_MS
} = require('../entryDeliveryGuard');

const USER_ID = 'stale-entry-user';
const TV_USER = 'staleentrytrader';

const originalFetch = global.fetch;
const originalNodeEnv = process.env.NODE_ENV;
const originalBot = process.env.TELEGRAM_BOT_TOKEN;
const originalSigning = process.env.WEBHOOK_SIGNING_SECRET;
const originalOrphanWait = process.env.ORPHAN_OUTCOME_WAIT_MS;
const originalOverlap = process.env.MAX_TERMINAL_ENTRY_OVERLAP_MS;

function payload(alertType, uuid, overrides = {}) {
  const eventType = {
    entry: 'ENTRY',
    take_profit_1: 'TP1',
    take_profit_2: 'TP2',
    take_profit_3: 'TP3',
    stop_loss: 'SL'
  }[alertType] || 'ENTRY';
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
    canonicalTradeId: uuid,
    canonicalSignalKey: uuid,
    eventId: `EURUSD|15m|${uuid}|${eventType}`,
    eventType,
    isRealtime: true,
    signalTime: Date.now(),
    message: alertType === 'entry' ? 'KACHING BUY' : `KACHING ${alertType}`,
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
    email: 'stale-entry@example.com',
    role: 'user',
    subscription: { tier: 'professional', status: 'active' },
    telegram: { chatId: '555001', enabled: true, telegramMode: 'alerts_only' },
    mt5: { executionMode: 'manual', enabled: true, devices: [] },
    ...overrides
  };
}

function mockTelegram(order) {
  global.fetch = async (_url, init) => {
    order.calls += 1;
    let text = '';
    try {
      const body = JSON.parse(init.body);
      text = body.text || '';
    } catch {
      /* ignore */
    }
    order.texts.push(text);
    if (order.failNext > 0) {
      order.failNext -= 1;
      return { ok: false, status: 500, async json() { return { ok: false, description: 'temp fail' }; } };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, result: { message_id: order.calls } };
      }
    };
  };
}

function ageAccepted(accept, mem, msAgo) {
  const when = new Date(Date.now() - msAgo);
  for (const obj of [accept.signalData, accept.saved].filter(Boolean)) {
    obj.entryAcceptedAt = when;
  }
  if (Array.isArray(mem) && mem[0]) mem[0].entryAcceptedAt = when;
}

describe('entryDeliveryGuard unit', () => {
  it('documents default overlap 15s', () => {
    assert.equal(DEFAULT_MAX_TERMINAL_ENTRY_OVERLAP_MS, 15 * 1000);
  });

  it('open ENTRY is still actionable', () => {
    const g = evaluateActionableEntryDelivery({
      alertType: 'entry',
      signalTime: Date.now(),
      entryAcceptedAt: new Date()
    });
    assert.equal(g.skip, false);
  });

  it('same-bar terminal overlay still owes BUY within overlap', () => {
    const g = evaluateActionableEntryDelivery({
      alertType: 'entry',
      signalTime: Date.now(),
      entryAcceptedAt: new Date(),
      tradeStatus: 'won',
      outcome: 'tp3',
      lifecycleStage: 'TP3',
      closedAt: new Date()
    });
    assert.equal(g.skip, false);
    assert.equal(g.reason, 'live_overlap_entry_owed');
  });

  it('delayed ENTRY after TP3 is not a new actionable trade', () => {
    const g = evaluateActionableEntryDelivery({
      alertType: 'entry',
      signalTime: Date.now() - 60 * 1000,
      entryAcceptedAt: new Date(Date.now() - 60 * 1000),
      tradeStatus: 'won',
      outcome: 'tp3',
      lifecycleStage: 'TP3',
      closedAt: new Date(Date.now() - 50 * 1000)
    });
    assert.equal(g.skip, true);
    assert.equal(g.reason, 'terminal_before_entry_delivery');
  });

  it('delayed ENTRY after TP1 is not a new actionable trade', () => {
    const g = evaluateActionableEntryDelivery({
      alertType: 'entry',
      signalTime: Date.now() - 60 * 1000,
      entryAcceptedAt: new Date(Date.now() - 60 * 1000),
      lifecycleStage: 'TP1',
      outcome: 'tp1',
      tradeStatus: 'partial'
    });
    assert.equal(g.skip, true);
    assert.equal(g.reason, 'stale_trade_before_delivery');
  });

  it('merge copies live TP3 onto an OPEN accept snapshot', () => {
    const merged = mergeLiveLifecycleForEntryDelivery(
      { alertType: 'entry', tradeStatus: 'open', entryAcceptedAt: new Date() },
      { tradeStatus: 'lost', outcome: 'sl', lifecycleStage: 'SL', closedAt: new Date() }
    );
    assert.equal(merged.alertType, 'entry');
    assert.equal(merged.outcome, 'sl');
    assert.equal(merged.tradeStatus, 'lost');
  });
});

describe('delayed ENTRY after outcome must not look like a new trade', () => {
  let inMemorySignals;
  let io;
  let tg;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token-stale-entry';
    process.env.WEBHOOK_SIGNING_SECRET = 'test-signing-secret-stale-entry';
    process.env.ORPHAN_OUTCOME_WAIT_MS = '80';
    process.env.MAX_TERMINAL_ENTRY_OVERLAP_MS = '15000';
    delete process.env.PIPELINE_SELF_TEST_ACTIVE;
    inMemorySignals = [];
    io = {
      emit() {},
      to() {
        return { emit() {} };
      }
    };
    tg = { calls: 0, texts: [], failNext: 0 };
    mockTelegram(tg);
    ActiveSignalRegistry.resetForTests();
    PipelineStatusService.resetForTests();
    TradingViewAlertService.resetTestFanoutHooks();
    TradeEventDispatcher.resetForTests();
    deliveryIdempotency.resetForTests();
    TradeEventStore.resetForTests();
    DurableDelivery.resetForTests();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.NODE_ENV = originalNodeEnv;
    process.env.TELEGRAM_BOT_TOKEN = originalBot;
    process.env.WEBHOOK_SIGNING_SECRET = originalSigning;
    if (originalOrphanWait == null) delete process.env.ORPHAN_OUTCOME_WAIT_MS;
    else process.env.ORPHAN_OUTCOME_WAIT_MS = originalOrphanWait;
    if (originalOverlap == null) delete process.env.MAX_TERMINAL_ENTRY_OVERLAP_MS;
    else process.env.MAX_TERMINAL_ENTRY_OVERLAP_MS = originalOverlap;
    TradingViewAlertService.resetTestFanoutHooks();
  });

  it('1. same ENTRY webhook multiple times → one Signal, one ENTRY send', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'se-1-dup-hook';
    const body = payload('entry', uuid, { symbol: 'SE1' });
    const first = await TradingViewAlertService.acceptTradingViewWebhook(io, body, inMemorySignals);
    TradingViewAlertService.scheduleAcceptedTradingViewSignal(io, first, inMemorySignals);
    await TradeEventDispatcher.waitForIdle(uuid);
    const second = await TradingViewAlertService.acceptTradingViewWebhook(io, body, inMemorySignals);
    if (!second.skippedFanout && second.accepted && !second.duplicate) {
      TradingViewAlertService.scheduleAcceptedTradingViewSignal(io, second, inMemorySignals);
      await TradeEventDispatcher.waitForIdle(uuid);
    }
    assert.equal(inMemorySignals.length, 1);
    assert.equal(tg.calls, 1);
    assert.equal(Boolean(second.duplicate || second.skippedFanout), true);
  });

  it('2. same canonicalTradeId duplicate ENTRY → one ENTRY', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'se-2-canon';
    await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload('entry', uuid, { symbol: 'SE2' }),
      inMemorySignals
    );
    const replay = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload('entry', uuid, { symbol: 'SE2', eventId: `EURUSD|15m|${uuid}|ENTRY` }),
      inMemorySignals
    );
    assert.equal(inMemorySignals.length, 1);
    assert.ok(replay.duplicate || replay.skippedFanout || replay.reason === 'duplicate_event_id');
  });

  it('3. ENTRY delayed while TP occurs → stale ENTRY is not a new BUY', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'se-3-tp-delay';
    const entryAccept = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload('entry', uuid, { symbol: 'SE3' }),
      inMemorySignals
    );
    assert.equal(entryAccept.accepted, true);
    ageAccepted(entryAccept, inMemorySignals, 60 * 1000);

    const tpAccept = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload('take_profit_1', uuid, { symbol: 'SE3' }),
      inMemorySignals
    );
    assert.ok(tpAccept.accepted || tpAccept.outcomeLinked || tpAccept.pendingOutcome);

    await TradingViewAlertService.processAcceptedTradingViewSignal(io, entryAccept, inMemorySignals);
    const buyTexts = tg.texts.filter(t => /KACHING BUY/i.test(t));
    assert.equal(buyTexts.length, 0);

    if (tpAccept.accepted && !tpAccept.skippedFanout) {
      await TradingViewAlertService.processAcceptedTradingViewSignal(io, tpAccept, inMemorySignals);
    }
    assert.equal(buyTexts.length, 0);
    assert.equal(SubscriberSignalFormatter.isStaleFreshEntry(inMemorySignals[0] && {
      ...inMemorySignals[0],
      alertType: 'entry',
      entryAcceptedAt: entryAccept.saved?.entryAcceptedAt
    }), true);
  });

  it('4. ENTRY delayed until SL → not delivered as actionable entry; SL may still send', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'se-4-sl-delay';
    const entryAccept = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload('entry', uuid, { symbol: 'SE4' }),
      inMemorySignals
    );
    ageAccepted(entryAccept, inMemorySignals, 60 * 1000);
    const slAccept = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload('stop_loss', uuid, { symbol: 'SE4' }),
      inMemorySignals
    );
    const entryResult = await TradingViewAlertService.processAcceptedTradingViewSignal(
      io,
      entryAccept,
      inMemorySignals
    );
    const buys = tg.texts.filter(t => /KACHING BUY/i.test(t));
    assert.equal(buys.length, 0);
    assert.ok(
      entryResult.skippedFanout ||
        tg.texts.length === 0 ||
        !/KACHING BUY/i.test(tg.texts.join('\n'))
    );

    if (slAccept.accepted && !slAccept.skippedFanout) {
      await TradingViewAlertService.processAcceptedTradingViewSignal(io, slAccept, inMemorySignals);
    }
    assert.equal(tg.texts.filter(t => /KACHING BUY/i.test(t)).length, 0);
    const slTexts = tg.texts.filter(t => /STOP LOSS|SL HIT/i.test(t));
    assert.ok(slTexts.length <= 1);
  });

  it('5. Telegram temp fail retries without a new ENTRY Signal', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'se-5-retry';
    const signal = {
      ...payload('entry', uuid, { symbol: 'SE5' }),
      _id: 'mem_se5',
      alertType: 'entry',
      entryAcceptedAt: new Date()
    };
    tg.failNext = 1;
    const fail = await TradeDeliveryService.deliverTelegram(proSubscriber(), signal);
    assert.equal(fail.ok, false);
    assert.equal(inMemorySignals.length, 0);
    const spec = deliveryIdempotency.specFrom(signal, 'entry', 'telegram', USER_ID);
    const afterFail = await DurableDelivery.getJobBySpec(spec);
    assert.notEqual(afterFail.state, 'delivered');
    await DurableDelivery.markDueForTests(afterFail.jobId);
    const ok = await TradeDeliveryService.deliverTelegram(proSubscriber(), signal);
    assert.equal(ok.ok, true);
    assert.equal(tg.calls, 2);
    const afterOk = await DurableDelivery.getJobBySpec(spec);
    assert.equal(afterOk.state, 'delivered');
  });

  it('6. restart after provider success: PROVIDER_ACCEPTED does not resend; pre-accept crash can', async () => {
    const uuid = 'se-6-restart';
    const signal = {
      ...payload('entry', uuid, { symbol: 'SE6' }),
      _id: 'mem_se6',
      alertType: 'entry',
      entryAcceptedAt: new Date()
    };
    const spec = deliveryIdempotency.specFrom(signal, 'entry', 'telegram', USER_ID);
    const claimed = await deliveryIdempotency.claimDelivery(signal, 'entry', 'telegram', USER_ID, {
      subscriber: proSubscriber()
    });
    assert.equal(claimed, true);
    await DurableDelivery.markProviderAcceptedBySpec(spec, { reason: 'telegram_http_200' });
    const before = tg.calls;
    const again = await DurableDelivery.beginAttempt(spec, { owner: 'restart-machine' });
    assert.equal(again.status, 'provider_accepted');
    assert.equal(tg.calls, before, 'PROVIDER_ACCEPTED must not send again');
    // Crash after Bot API 200 and BEFORE markProviderAccepted remains at-least-once
    // (documented in utils/deliveryIdempotency.js). That window is not closed here.
  });

  it('7. multi-instance claim of the same job → one acquired owner', async () => {
    const uuid = 'se-7-claim';
    const signal = {
      ...payload('entry', uuid, { symbol: 'SE7' }),
      _id: 'mem_se7',
      alertType: 'entry',
      entryAcceptedAt: new Date()
    };
    const spec = deliveryIdempotency.specFrom(signal, 'entry', 'telegram', USER_ID);
    const a = await DurableDelivery.beginAttempt(spec, { owner: 'machine-A' });
    assert.equal(a.status, 'acquired');
    const b = await DurableDelivery.beginAttempt(spec, { owner: 'machine-B' });
    assert.ok(b.status === 'busy' || b.status === 'acquired' && b.job.owner === 'machine-A');
    if (b.status === 'busy') {
      assert.notEqual(b.status, 'acquired');
    } else {
      assert.equal(a.job.owner === 'machine-A' || b.job.owner === 'machine-A', true);
    }
    const owners = new Set([a.job?.owner, b.job?.owner].filter(Boolean));
    assert.ok(owners.size <= 2);
    const liveOwners = [a, b].filter(x => x.status === 'acquired');
    assert.equal(liveOwners.length, 1);
  });

  it('channel delivery of delayed terminal ENTRY is skipped even with entryAcceptedAt', async () => {
    const snap = {
      ...payload('entry', 'se-ch-term', { symbol: 'SECH' }),
      _id: 'mem_sech',
      alertType: 'entry',
      entryAcceptedAt: new Date(Date.now() - 60 * 1000),
      tradeStatus: 'won',
      outcome: 'tp3',
      lifecycleStage: 'TP3',
      closedAt: new Date(Date.now() - 50 * 1000)
    };
    const elig = TradeDeliveryService.evaluateTelegramEligibility(proSubscriber(), snap);
    assert.equal(elig.eligible, false);
    assert.equal(elig.reason, 'terminal_before_entry_delivery');
    const sent = await TradeDeliveryService.deliverTelegram(proSubscriber(), snap);
    assert.equal(sent.ok, false);
    assert.equal(sent.reason, 'terminal_before_entry_delivery');
    assert.equal(tg.calls, 0);
    const email = await TradeDeliveryService.deliverEmail(proSubscriber(), snap);
    assert.equal(email.ok, false);
    assert.equal(email.reason, 'terminal_before_entry_delivery');
  });

  it('delayed ENTRY after TP2 is not a new BUY', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'se-tp2-delay';
    const entryAccept = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload('entry', uuid, { symbol: 'SETP2' }),
      inMemorySignals
    );
    ageAccepted(entryAccept, inMemorySignals, 60 * 1000);
    await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload('take_profit_2', uuid, { symbol: 'SETP2' }),
      inMemorySignals
    );
    await TradingViewAlertService.processAcceptedTradingViewSignal(io, entryAccept, inMemorySignals);
    assert.equal(tg.texts.filter(t => /KACHING BUY/i.test(t)).length, 0);
  });

  it('delayed ENTRY after TP3 is not a new BUY', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'se-tp3-delay';
    const entryAccept = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload('entry', uuid, { symbol: 'SETP3' }),
      inMemorySignals
    );
    ageAccepted(entryAccept, inMemorySignals, 60 * 1000);
    await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload('take_profit_3', uuid, { symbol: 'SETP3' }),
      inMemorySignals
    );
    await TradingViewAlertService.processAcceptedTradingViewSignal(io, entryAccept, inMemorySignals);
    assert.equal(tg.texts.filter(t => /KACHING BUY/i.test(t)).length, 0);
  });

  it('skipped already-accepted ENTRY commits sequence so TP/SL can deliver', async () => {
    const prevWait = process.env.DELIVERY_SEQ_WAIT_MS;
    process.env.DELIVERY_SEQ_WAIT_MS = '80';
    try {
      const sub = proSubscriber();
      const uuid = 'se-seq-unblock';
      const aged = new Date(Date.now() - 60 * 1000);
      const entrySnap = {
        ...payload('entry', uuid, { symbol: 'SESEQ' }),
        _id: 'mem_seseq',
        alertType: 'entry',
        entryAcceptedAt: aged,
        tradeStatus: 'partial',
        outcome: 'tp1',
        lifecycleStage: 'TP1'
      };
      // 1–3. Accepted ENTRY, lifecycle already at TP1, delivery suppresses BUY/SELL.
      assert.ok(entrySnap.entryAcceptedAt);
      const skipped = await TradeDeliveryService.deliverTelegram(sub, entrySnap);
      assert.equal(skipped.ok, false);
      assert.equal(skipped.reason, 'stale_trade_before_delivery');
      assert.equal(skipped.skipped, true);
      assert.equal(tg.calls, 0);
      assert.equal(tg.texts.filter(t => /KACHING BUY/i.test(t)).length, 0);

      // 5. Accepted-skip still commits ENTRY into the channel sequence.
      const committed = await TradeEventStore.getCommittedDeliveries(uuid, sub.id, 'telegram');
      assert.equal(committed.has('entry'), true);

      // 6–7. Successor TP1 is not permanently blocked and can deliver.
      const tp1 = await TradeDeliveryService.deliverTelegram(sub, {
        ...entrySnap,
        alertType: 'take_profit_1',
        eventType: 'TP1',
        eventId: `EURUSD|15m|${uuid}|TP1`,
        message: 'KACHING take_profit_1'
      });
      assert.equal(tp1.ok, true);
      assert.equal(tg.texts.filter(t => /KACHING BUY/i.test(t)).length, 0);
      assert.ok(tg.texts.some(t => /TP1/i.test(t)), 'TP1 alert must be sent after accepted ENTRY skip-commit');
    } finally {
      if (prevWait == null) delete process.env.DELIVERY_SEQ_WAIT_MS;
      else process.env.DELIVERY_SEQ_WAIT_MS = prevWait;
    }
  });

  it('never-accepted closed ENTRY does not unblock outcome sequencing', async () => {
    const prevWait = process.env.DELIVERY_SEQ_WAIT_MS;
    process.env.DELIVERY_SEQ_WAIT_MS = '80';
    try {
      const sub = proSubscriber();
      const uuid = 'se-seq-never';
      const closed = {
        ...payload('entry', uuid, { symbol: 'SENEV' }),
        _id: 'mem_senev',
        alertType: 'entry',
        tradeStatus: 'won',
        outcome: 'tp3',
        lifecycleStage: 'TP3',
        closedAt: new Date(Date.now() - 50 * 1000)
      };
      const skipped = await TradeDeliveryService.deliverTelegram(sub, closed);
      assert.equal(skipped.ok, false);
      assert.equal(skipped.reason, 'terminal_before_entry_delivery');
      const tp3 = await TradeDeliveryService.deliverTelegram(sub, {
        ...closed,
        alertType: 'take_profit_3',
        eventType: 'TP3',
        eventId: `EURUSD|15m|${uuid}|TP3`
      });
      assert.equal(tp3.ok, false);
      assert.equal(tp3.reason, 'delivery_sequence_wait');
      assert.equal(tg.calls, 0);
    } finally {
      if (prevWait == null) delete process.env.DELIVERY_SEQ_WAIT_MS;
      else process.env.DELIVERY_SEQ_WAIT_MS = prevWait;
    }
  });

  it('in-app socket does not emit a stale BUY after terminal overlay', async () => {
    const emits = [];
    const socketIo = {
      emit(ev, p) {
        emits.push({ ev, p });
      },
      to() {
        return {
          emit(ev, p) {
            emits.push({ ev, p });
          }
        };
      }
    };
    const snap = {
      ...payload('entry', 'se-sock', { symbol: 'SESK' }),
      _id: 'mem_sesk',
      alertType: 'entry',
      userId: USER_ID,
      entryAcceptedAt: new Date(Date.now() - 60 * 1000),
      tradeStatus: 'won',
      outcome: 'tp3',
      lifecycleStage: 'TP3',
      closedAt: new Date(Date.now() - 50 * 1000)
    };
    const sent = await TradeDeliveryService.deliverInApp(socketIo, snap, proSubscriber());
    assert.equal(sent.ok, false);
    assert.equal(sent.skipped, true);
    assert.equal(sent.reason, 'terminal_before_entry_delivery');
    assert.equal(emits.length, 0);
  });

  it('recovered pending ENTRY job with terminal snapshot does not send BUY', async () => {
    const uuid = 'se-recover';
    const snap = {
      ...payload('entry', uuid, { symbol: 'SERC' }),
      _id: 'mem_serc',
      alertType: 'entry',
      entryAcceptedAt: new Date(Date.now() - 60 * 1000),
      tradeStatus: 'lost',
      outcome: 'sl',
      lifecycleStage: 'SL',
      closedAt: new Date(Date.now() - 50 * 1000)
    };
    const spec = deliveryIdempotency.specFrom(snap, 'entry', 'telegram', USER_ID);
    await DurableDelivery.ensureJob({
      ...spec,
      signalUuid: uuid,
      payload: {
        subscriber: DurableDelivery.snapshotSubscriber(proSubscriber()),
        signal: DurableDelivery.snapshotSignal(snap)
      }
    });
    const job = await DurableDelivery.getJobBySpec(spec);
    assert.ok(job);
    const recovered = await TradingViewAlertService.processDurableJob(job, { io, waitMode: 'check_once' });
    assert.equal(recovered.ok, false);
    assert.equal(recovered.reason, 'terminal_before_entry_delivery');
    assert.equal(tg.calls, 0);
  });

  it('open ENTRY still delivers as BUY', async () => {
    const snap = {
      ...payload('entry', 'se-open', { symbol: 'SEOP' }),
      _id: 'mem_seop',
      alertType: 'entry',
      entryAcceptedAt: new Date()
    };
    const sent = await TradeDeliveryService.deliverTelegram(proSubscriber(), snap);
    assert.equal(sent.ok, true);
    assert.equal(tg.texts.filter(t => /KACHING BUY/i.test(t)).length, 1);
  });
});
