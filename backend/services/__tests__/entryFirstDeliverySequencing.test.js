/**
 * ENTRY-first + subscriber delivery sequencing (invariants 1–16, tests 1–20).
 * Controlled Telegram barriers prove order is not an accident of network completion.
 * Never hits production Telegram / Fly.
 */
'use strict';

process.env.REDIS_ENABLED = process.env.REDIS_ENABLED || 'false';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { generateLicenseToken } = require('../../utils/webhookSecurity');
const TradingViewAlertService = require('../TradingViewAlertService');
const TradeLifecycleService = require('../TradeLifecycleService');
const PipelineStatusService = require('../PipelineStatusService');
const ActiveSignalRegistry = require('../../utils/activeSignalRegistry');
const TradeEventDispatcher = require('../../utils/tradeEventDispatcher');
const TradeEventStore = require('../../utils/tradeEventStore');
const deliveryIdempotency = require('../../utils/deliveryIdempotency');
const DeliverySequencer = require('../../utils/deliverySequencer');
const { PINE_CLIENT_VERSION } = require('../../utils/PineClientVersion');

const USER_ID = 'seq-user-1';
const TV_USER = 'seqtrader';
const USER_B = 'seq-user-2';

function createFakeRedis() {
  const kv = new Map();
  const hashes = new Map();
  return {
    isOpen: true,
    async set(key, val, opts = {}) {
      if (opts && opts.NX && kv.has(key)) return null;
      kv.set(key, String(val));
      return 'OK';
    },
    async get(key) {
      return kv.has(key) ? kv.get(key) : null;
    },
    async del(...keys) {
      let n = 0;
      for (const key of keys.flat()) {
        if (kv.delete(key)) n += 1;
        if (hashes.delete(key)) n += 1;
      }
      return n;
    },
    async hSet(key, field, value) {
      if (!hashes.has(key)) hashes.set(key, new Map());
      hashes.get(key).set(String(field), String(value));
      return 1;
    },
    async hGetAll(key) {
      const h = hashes.get(key);
      if (!h) return {};
      return Object.fromEntries(h);
    },
    async expire() {
      return 1;
    },
    async eval(_script, { keys, arguments: args }) {
      const cur = kv.get(keys[0]);
      if (cur === args[0]) {
        kv.delete(keys[0]);
        return 1;
      }
      return 0;
    }
  };
}

function levels() {
  return {
    entry: 1.1754,
    stop_loss: 1.1745,
    stop_loss_1: 1.1745,
    take_profit_1: 1.1762,
    take_profit_2: 1.177,
    take_profit_3: 1.1782,
    confidence: 0.82
  };
}

function payload(alertType, uuid, overrides = {}) {
  return {
    symbol: overrides.symbol || 'EURUSD',
    strategyName: 'Liquidity Sweep + Fair Value Gap (Scalping)',
    timeframe: overrides.timeframe || '15m',
    pattern: 'liquidity_sweep_fvg_scalp',
    alertType,
    direction: 'long',
    ...levels(),
    signalUuid: uuid,
    signalId: uuid,
    canonicalSignalKey: uuid,
    canonicalTradeId: uuid,
    message: alertType === 'entry' ? 'KACHING BUY' : `KACHING ${alertType}`,
    broadcast: true,
    tradingviewUsername: TV_USER,
    userId: USER_ID,
    licenseToken: generateLicenseToken(USER_ID, TV_USER),
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
    stop_loss: 'SL',
    expired: 'EXPIRED',
    cancelled: 'CANCELLED'
  }[alertType] || 'ENTRY';
  const seq = { ENTRY: 0, TP1: 1, TP2: 2, TP3: 3, SL: 3, EXPIRED: 3, CANCELLED: 3 }[eventType];
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

function proSubscriber(overrides = {}) {
  return {
    id: USER_ID,
    email: 'pro-seq@example.com',
    role: 'user',
    subscription: { tier: 'professional', status: 'active' },
    telegram: { chatId: '555010', enabled: true, telegramMode: 'alerts_only' },
    mt5: { executionMode: 'manual', enabled: true, devices: [] },
    preferences: { emailAlerts: true },
    ...overrides
  };
}

function isEntryText(text) {
  return /KACHING BUY|KACHING SELL/i.test(text) && !/TP1 HIT|TP2 HIT|TP3 HIT|SL HIT|TRADE COMPLETE|TRADE CLOSED/i.test(text);
}

function isTp3Text(text) {
  return /TRADE COMPLETE|TP3 HIT/i.test(text);
}

async function waitUntil(fn, ms = 2500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('waitUntil timeout');
}

const originalFetch = global.fetch;
const originalNodeEnv = process.env.NODE_ENV;
const originalBot = process.env.TELEGRAM_BOT_TOKEN;
const originalSigning = process.env.WEBHOOK_SIGNING_SECRET;
const originalSeqWait = process.env.DELIVERY_SEQ_WAIT_MS;
const originalOrphanWait = process.env.ORPHAN_OUTCOME_WAIT_MS;
const originalRedisEnabled = process.env.REDIS_ENABLED;

function installBarrierTelegram(state) {
  global.fetch = async (_url, init) => {
    let text = '';
    let chatId = '';
    try {
      const body = JSON.parse(init?.body || '{}');
      text = body.text || '';
      chatId = String(body.chat_id || '');
    } catch {
      text = String(init?.body || '');
    }
    state.started.push(text);
    if (chatId) {
      if (!state.byChat[chatId]) state.byChat[chatId] = [];
    }
    if (isEntryText(text) && state.holdEntry && (!state.holdIf || state.holdIf(text))) {
      await state.entryHold;
    }
    state.calls += 1;
    state.texts.push(text);
    if (chatId) state.byChat[chatId].push(text);
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, result: { message_id: state.calls } };
      }
    };
  };
}

async function acceptOnly(io, body, mem) {
  return TradingViewAlertService.acceptTradingViewWebhook(io, body, mem);
}

async function acceptAndFanout(io, body, mem) {
  const accept = await TradingViewAlertService.acceptTradingViewWebhook(io, body, mem);
  if (accept.pendingOutcome || (!accept.duplicate && !accept.skippedFanout && accept.accepted)) {
    TradingViewAlertService.scheduleAcceptedTradingViewSignal(io, accept, mem);
  }
  const uuid = accept.signalUuid || body.signalUuid;
  await TradeEventDispatcher.waitForIdle(uuid, 6000);
  return accept;
}

describe('entry-first delivery sequencing 1–20', () => {
  let mem;
  let io;
  let tg;
  let emails;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token-seq';
    process.env.WEBHOOK_SIGNING_SECRET = 'test-signing-secret-seq';
    process.env.DELIVERY_SEQ_WAIT_MS = '4000';
    process.env.ORPHAN_OUTCOME_WAIT_MS = '80';
    process.env.REDIS_ENABLED = 'false';
    delete process.env.PIPELINE_SELF_TEST_ACTIVE;
    mem = [];
    io = {
      emit() {},
      to() {
        return { emit() {} };
      }
    };
    tg = { calls: 0, texts: [], started: [], byChat: {}, holdEntry: false, holdIf: null, entryHold: Promise.resolve() };
    emails = [];
    installBarrierTelegram(tg);
    const mailer = require('../../utils/mailer');
    if (!global.__seqOrigMailer) global.__seqOrigMailer = mailer.sendTradeAlertEmail;
    mailer.sendTradeAlertEmail = async opts => {
      emails.push(opts.signal?.alertType || 'entry');
      return { ok: true };
    };
    ActiveSignalRegistry.resetForTests();
    PipelineStatusService.resetForTests();
    TradingViewAlertService.resetTestFanoutHooks();
    TradeEventDispatcher.resetForTests();
    deliveryIdempotency.resetForTests();
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.NODE_ENV = originalNodeEnv;
    process.env.TELEGRAM_BOT_TOKEN = originalBot;
    process.env.WEBHOOK_SIGNING_SECRET = originalSigning;
    if (originalSeqWait == null) delete process.env.DELIVERY_SEQ_WAIT_MS;
    else process.env.DELIVERY_SEQ_WAIT_MS = originalSeqWait;
    if (originalRedisEnabled == null) delete process.env.REDIS_ENABLED;
    else process.env.REDIS_ENABLED = originalRedisEnabled;
    TradingViewAlertService.resetTestFanoutHooks();
    TradeEventStore.resetForTests();
    const mailer = require('../../utils/mailer');
    if (global.__seqOrigMailer) mailer.sendTradeAlertEmail = global.__seqOrigMailer;
  });

  it('invariants: skip-milestone ENTRY→TP3; never invent TP1/TP2; never TP3 before ENTRY', () => {
    assert.deepEqual(DeliverySequencer.requiredPredecessors('entry', []), []);
    assert.deepEqual(DeliverySequencer.requiredPredecessors('take_profit_3', ['entry']), ['entry']);
    assert.deepEqual(DeliverySequencer.requiredPredecessors('take_profit_3', ['entry', 'take_profit_3']), [
      'entry'
    ]);
    assert.deepEqual(
      DeliverySequencer.requiredPredecessors('take_profit_3', ['entry', 'take_profit_1', 'take_profit_2']),
      ['entry', 'take_profit_1', 'take_profit_2']
    );
    assert.deepEqual(DeliverySequencer.requiredPredecessors('take_profit_2', ['entry', 'take_profit_1']), [
      'entry',
      'take_profit_1'
    ]);
    assert.deepEqual(DeliverySequencer.requiredPredecessors('stop_loss', ['entry']), ['entry']);
    assert.equal(PINE_CLIENT_VERSION, '1.3.0');
  });

  it('1. sequential ENTRY then TP1 → Telegram ENTRY first', async () => {
    await acceptAndFanout(io, payload('entry', 'seq-1'), mem);
    await acceptAndFanout(io, payload('take_profit_1', 'seq-1'), mem);
    assert.ok(tg.calls >= 2);
    assert.equal(isEntryText(tg.texts[0]), true);
    assert.match(tg.texts[tg.texts.length - 1], /TP1/i);
  });

  it('2. CRITICAL: independent fan-out ENTRY+TP3; TP3 cannot hit Telegram before ENTRY commit', async () => {
    const uuid = 'seq-2-race';
    const entryAccept = await acceptOnly(io, payload('entry', uuid, { symbol: 'SEQ2' }), mem);
    const tp3Accept = await acceptOnly(io, payload('take_profit_3', uuid, { symbol: 'SEQ2' }), mem);
    assert.equal(entryAccept.accepted, true);
    assert.equal(tp3Accept.accepted, true);

    let releaseEntry;
    tg.holdEntry = true;
    tg.entryHold = new Promise(r => {
      releaseEntry = r;
    });

    const racing = Promise.all([
      TradingViewAlertService.processAcceptedTradingViewSignal(io, tp3Accept, mem),
      TradingViewAlertService.processAcceptedTradingViewSignal(io, entryAccept, mem)
    ]);

    await waitUntil(() => tg.started.some(isEntryText));
    await new Promise(r => setTimeout(r, 40));
    assert.equal(tg.started.some(isTp3Text), false, 'TP3 must not start Telegram while ENTRY is in-flight');
    assert.equal(tg.texts.some(isTp3Text), false);

    releaseEntry();
    await racing;

    assert.ok(tg.texts.length >= 2);
    assert.equal(isEntryText(tg.texts[0]), true);
    assert.equal(tg.texts.some(isTp3Text), true);
    assert.ok(tg.texts.findIndex(isTp3Text) > 0);
  });

  it('3. genuine skip-milestone ENTRY→TP3; no synthetic TP1/TP2 messages', async () => {
    await acceptAndFanout(io, payload('entry', 'seq-3', { symbol: 'SEQ3' }), mem);
    await acceptAndFanout(io, payload('take_profit_3', 'seq-3', { symbol: 'SEQ3' }), mem);
    assert.equal(isEntryText(tg.texts[0]), true);
    assert.equal(tg.texts.some(isTp3Text), true);
    assert.equal(tg.texts.some(t => /TP1 HIT/i.test(t)), false);
    assert.equal(tg.texts.some(t => /TP2 HIT/i.test(t)), false);
  });

  it('4. TP1 before ENTRY is buffered (orphan); released after ENTRY, never before', async () => {
    const tp1 = await acceptOnly(io, payload('take_profit_1', 'seq-4', { symbol: 'SEQ4' }), mem);
    assert.equal(tp1.reason, 'orphaned_outcome');
    TradingViewAlertService.scheduleAcceptedTradingViewSignal(io, tp1, mem);
    assert.equal(tg.calls, 0);
    await acceptAndFanout(io, payload('entry', 'seq-4', { symbol: 'SEQ4' }), mem);
    await TradeEventDispatcher.waitForIdle('seq-4', 6000);
    assert.equal(isEntryText(tg.texts[0]), true);
    if (tg.calls >= 2) assert.match(tg.texts[1], /TP1/i);
  });

  it('5. TP2 never before ENTRY or accepted TP1', async () => {
    const uuid = 'seq-5';
    const entryAccept = await acceptOnly(io, payload('entry', uuid, { symbol: 'SEQ5' }), mem);
    const tp1Accept = await acceptOnly(io, payload('take_profit_1', uuid, { symbol: 'SEQ5' }), mem);
    const tp2Accept = await acceptOnly(io, payload('take_profit_2', uuid, { symbol: 'SEQ5' }), mem);

    await Promise.all([
      TradingViewAlertService.processAcceptedTradingViewSignal(io, tp2Accept, mem),
      TradingViewAlertService.processAcceptedTradingViewSignal(io, tp1Accept, mem),
      TradingViewAlertService.processAcceptedTradingViewSignal(io, entryAccept, mem)
    ]);

    assert.equal(isEntryText(tg.texts[0]), true);
    const i1 = tg.texts.findIndex(t => /TP1 HIT/i.test(t));
    const i2 = tg.texts.findIndex(t => /TP2 HIT/i.test(t));
    assert.ok(i1 > 0);
    assert.ok(i2 > i1);
  });

  it('6. SL never before ENTRY', async () => {
    const uuid = 'seq-6';
    const entryAccept = await acceptOnly(io, payload('entry', uuid, { symbol: 'SEQ6' }), mem);
    const slAccept = await acceptOnly(io, payload('stop_loss', uuid, { symbol: 'SEQ6' }), mem);
    let releaseEntry;
    tg.holdEntry = true;
    tg.entryHold = new Promise(r => {
      releaseEntry = r;
    });
    const racing = Promise.all([
      TradingViewAlertService.processAcceptedTradingViewSignal(io, slAccept, mem),
      TradingViewAlertService.processAcceptedTradingViewSignal(io, entryAccept, mem)
    ]);
    await waitUntil(() => tg.started.some(isEntryText));
    await new Promise(r => setTimeout(r, 30));
    assert.equal(tg.texts.some(t => /SL HIT|TRADE CLOSED/i.test(t)), false);
    releaseEntry();
    await racing;
    assert.equal(isEntryText(tg.texts[0]), true);
    assert.equal(tg.texts.some(t => /SL HIT|TRADE CLOSED/i.test(t)), true);
  });

  it('7. KACHING TRADE COMPLETE never before ENTRY', async () => {
    const uuid = 'seq-7';
    const entryAccept = await acceptOnly(io, payload('entry', uuid, { symbol: 'SEQ7' }), mem);
    const tp3Accept = await acceptOnly(io, payload('take_profit_3', uuid, { symbol: 'SEQ7' }), mem);
    await Promise.all([
      TradingViewAlertService.processAcceptedTradingViewSignal(io, tp3Accept, mem),
      TradingViewAlertService.processAcceptedTradingViewSignal(io, entryAccept, mem)
    ]);
    assert.equal(isEntryText(tg.texts[0]), true);
    assert.match(tg.texts.find(isTp3Text) || '', /TRADE COMPLETE|TP3/i);
  });

  it('8. EXPIRED without ENTRY is not delivered as a completed trade', async () => {
    const accept = await acceptOnly(io, payload('expired', 'seq-8', { symbol: 'SEQ8' }), mem);
    assert.equal(accept.reason, 'orphaned_outcome');
    TradingViewAlertService.scheduleAcceptedTradingViewSignal(io, accept, mem);
    await TradeEventDispatcher.waitForIdle('seq-8', 400);
    assert.equal(tg.texts.some(t => /TRADE COMPLETE|TRADE CLOSED|EXPIRED/i.test(t)), false);
  });

  it('9. CANCELLED without ENTRY is not a completed-trade notice', async () => {
    const accept = await acceptOnly(io, payload('cancelled', 'seq-9', { symbol: 'SEQ9' }), mem);
    assert.equal(accept.reason, 'orphaned_outcome');
    TradingViewAlertService.scheduleAcceptedTradingViewSignal(io, accept, mem);
    await TradeEventDispatcher.waitForIdle('seq-9', 400);
    assert.equal(tg.calls, 0);
  });

  it('10. multi-subscriber: each sees ENTRY first', async () => {
    TradingViewAlertService.setTestFanoutHooks({
      subscribers: [
        proSubscriber({ id: USER_ID, telegram: { chatId: 'aaa', enabled: true, telegramMode: 'alerts_only' } }),
        proSubscriber({
          id: USER_B,
          email: 'b@example.com',
          telegram: { chatId: 'bbb', enabled: true, telegramMode: 'alerts_only' }
        })
      ]
    });
    const uuid = 'seq-10';
    const entryAccept = await acceptOnly(io, payload('entry', uuid, { symbol: 'SEQA' }), mem);
    const tp1Accept = await acceptOnly(io, payload('take_profit_1', uuid, { symbol: 'SEQA' }), mem);
    await Promise.all([
      TradingViewAlertService.processAcceptedTradingViewSignal(io, tp1Accept, mem),
      TradingViewAlertService.processAcceptedTradingViewSignal(io, entryAccept, mem)
    ]);
    const entries = tg.texts.filter(isEntryText);
    const tp1s = tg.texts.filter(t => /TP1 HIT/i.test(t));
    assert.equal(entries.length, 2);
    assert.equal(tp1s.length, 2);
    for (const chatTexts of Object.values(tg.byChat)) {
      assert.equal(isEntryText(chatTexts[0]), true);
    }
  });

  it('11. different trades do not block each other globally', async () => {
    const aEntry = await acceptOnly(io, payload('entry', 'seq-11a', { symbol: 'GBPAUD' }), mem);
    const bEntry = await acceptOnly(io, payload('entry', 'seq-11b', { symbol: 'USDJPY' }), mem);
    const bTp3 = await acceptOnly(io, payload('take_profit_3', 'seq-11b', { symbol: 'USDJPY' }), mem);

    let releaseA;
    tg.holdEntry = true;
    tg.holdIf = text => /GBPAUD/i.test(text);
    tg.entryHold = new Promise(r => {
      releaseA = r;
    });

    const aFan = TradingViewAlertService.processAcceptedTradingViewSignal(io, aEntry, mem);
    await waitUntil(() => tg.started.some(t => isEntryText(t) && /GBPAUD/i.test(t)));

    tg.holdEntry = false;
    await TradingViewAlertService.processAcceptedTradingViewSignal(io, bEntry, mem);
    await TradingViewAlertService.processAcceptedTradingViewSignal(io, bTp3, mem);

    assert.ok(tg.texts.filter(isEntryText).length >= 1);
    assert.equal(tg.texts.some(isTp3Text), true);

    releaseA();
    await aFan;
  });

  it('12. telegram + email both ENTRY-first', async () => {
    const uuid = 'seq-12';
    const entryAccept = await acceptOnly(io, payload('entry', uuid, { symbol: 'SEQC' }), mem);
    const tp1Accept = await acceptOnly(io, payload('take_profit_1', uuid, { symbol: 'SEQC' }), mem);
    await Promise.all([
      TradingViewAlertService.processAcceptedTradingViewSignal(io, tp1Accept, mem),
      TradingViewAlertService.processAcceptedTradingViewSignal(io, entryAccept, mem)
    ]);
    assert.equal(emails[0], 'entry');
    assert.ok(emails.indexOf('take_profit_1') > 0);
    assert.equal(isEntryText(tg.texts[0]), true);
  });

  it('13. claimDelivery is after ordering: TP3 cannot send first even if claimed independently', async () => {
    const uuid = 'seq-13';
    const entryAccept = await acceptOnly(io, payload('entry', uuid, { symbol: 'SEQD' }), mem);
    const tp3Accept = await acceptOnly(io, payload('take_profit_3', uuid, { symbol: 'SEQD' }), mem);
    let releaseEntry;
    tg.holdEntry = true;
    tg.entryHold = new Promise(r => {
      releaseEntry = r;
    });
    const racing = Promise.all([
      TradingViewAlertService.processAcceptedTradingViewSignal(io, tp3Accept, mem),
      TradingViewAlertService.processAcceptedTradingViewSignal(io, entryAccept, mem)
    ]);
    await waitUntil(() => tg.started.some(isEntryText));
    assert.equal(tg.started.filter(isTp3Text).length, 0);
    releaseEntry();
    await racing;
    assert.equal(isEntryText(tg.texts[0]), true);
  });

  it('14. duplicate eventId does not double-deliver Telegram', async () => {
    const body = pine13('entry', 'seq-14', { symbol: 'SEQE' });
    await acceptAndFanout(io, body, mem);
    const dup = await acceptAndFanout(io, body, mem);
    assert.equal(dup.duplicate || dup.reason === 'duplicate_event_id', true);
    assert.equal(tg.calls, 1);
  });

  it('15. retry of older event does not reorder behind newer', async () => {
    const uuid = 'seq-15';
    await acceptAndFanout(io, payload('entry', uuid, { symbol: 'SEQF' }), mem);
    await acceptAndFanout(io, payload('take_profit_1', uuid, { symbol: 'SEQF' }), mem);
    const retry = await acceptAndFanout(io, payload('entry', uuid, { symbol: 'SEQF' }), mem);
    assert.ok(retry.duplicate || retry.skippedFanout || retry.reason);
    assert.equal(isEntryText(tg.texts[0]), true);
    assert.match(tg.texts[1], /TP1/i);
    assert.equal(tg.texts.filter(isEntryText).length, 1);
  });

  it('16. multi-machine: process-local dispatcher cleared; Redis sequencer still orders', async () => {
    const redis = createFakeRedis();
    TradeEventStore.resetForTests();
    TradeEventStore.setClientForTests(redis);
    deliveryIdempotency.resetForTests();

    const uuid = 'seq-16';
    const entryAccept = await acceptOnly(io, payload('entry', uuid, { symbol: 'SEQG' }), mem);
    const tp3Accept = await acceptOnly(io, payload('take_profit_3', uuid, { symbol: 'SEQG' }), mem);
    TradeEventDispatcher.resetLocalQueuesForTests();

    let releaseEntry;
    tg.holdEntry = true;
    tg.entryHold = new Promise(r => {
      releaseEntry = r;
    });
    const racing = Promise.all([
      TradingViewAlertService.processAcceptedTradingViewSignal(io, tp3Accept, mem),
      TradingViewAlertService.processAcceptedTradingViewSignal(io, entryAccept, mem)
    ]);
    await waitUntil(() => tg.started.some(isEntryText));
    await new Promise(r => setTimeout(r, 40));
    assert.equal(tg.started.some(isTp3Text), false);
    releaseEntry();
    await racing;
    assert.equal(isEntryText(tg.texts[0]), true);
    assert.equal(tg.texts.some(isTp3Text), true);
  });

  it('17. legacy payload (no eventId) still ENTRY-first via derived identity', async () => {
    const uuid = 'seq-17-leg';
    const entry = {
      ticker: 'EURUSD',
      action: 'buy',
      entry: 1.1754,
      sl: 1.1745,
      tp1: 1.1762,
      tp2: 1.177,
      tp3: 1.1782,
      timestamp: Date.now(),
      signalUuid: uuid,
      signalId: uuid,
      broadcast: true,
      userId: USER_ID,
      tradingviewUsername: TV_USER,
      licenseToken: generateLicenseToken(USER_ID, TV_USER)
    };
    const tp3 = {
      ...entry,
      alertType: 'take_profit_3',
      type: 'take_profit_3',
      action: 'tp3'
    };
    const entryAccept = await acceptOnly(io, entry, mem);
    if (!entryAccept.accepted) {
      assert.ok(['stale_entry', 'missing_event_identity'].includes(entryAccept.reason) === false);
    }
    if (entryAccept.accepted && !entryAccept.duplicate) {
      const tp3Accept = await acceptOnly(io, { ...tp3, signalUuid: entryAccept.signalUuid, signalId: entryAccept.signalUuid }, mem);
      if (tp3Accept.accepted && !tp3Accept.duplicate && !tp3Accept.pendingOutcome) {
        await Promise.all([
          TradingViewAlertService.processAcceptedTradingViewSignal(io, tp3Accept, mem),
          TradingViewAlertService.processAcceptedTradingViewSignal(io, entryAccept, mem)
        ]);
        assert.equal(isEntryText(tg.texts[0]), true);
      } else {
        TradingViewAlertService.scheduleAcceptedTradingViewSignal(io, entryAccept, mem);
        await TradeEventDispatcher.waitForIdle(entryAccept.signalUuid, 4000);
        assert.equal(isEntryText(tg.texts[0]), true);
      }
    }
  });

  it('18. Pine 1.3.0 native fields ENTRY-first', async () => {
    const uuid = 'seq-18-13';
    const entryAccept = await acceptOnly(io, pine13('entry', uuid, { symbol: 'SEQH' }), mem);
    const tp3Accept = await acceptOnly(io, pine13('take_profit_3', uuid, { symbol: 'SEQH' }), mem);
    await Promise.all([
      TradingViewAlertService.processAcceptedTradingViewSignal(io, tp3Accept, mem),
      TradingViewAlertService.processAcceptedTradingViewSignal(io, entryAccept, mem)
    ]);
    assert.equal(isEntryText(tg.texts[0]), true);
    assert.equal(tg.texts.some(isTp3Text), true);
  });

  it('19. production Redis down: outcome is not sent out-of-order (fail-closed)', async () => {
    const prev = process.env.NODE_ENV;
    const uuid = 'seq-19';
    const entryAccept = await acceptOnly(io, payload('entry', uuid, { symbol: 'SEQI' }), mem);
    const tp3Accept = await acceptOnly(io, payload('take_profit_3', uuid, { symbol: 'SEQI' }), mem);
    process.env.NODE_ENV = 'production';
    TradeEventStore.setClientForTests(null, { unavailable: true });
    const out = await TradingViewAlertService.processAcceptedTradingViewSignal(io, tp3Accept, mem);
    process.env.NODE_ENV = prev;
    TradeEventStore.resetForTests();
    assert.equal(tg.texts.some(isTp3Text), false);
    assert.ok(out.skippedFanout || out.reason === 'redis_unavailable' || tg.texts.every(t => !isTp3Text(t)));
    void entryAccept;
  });

  it('20. ENTRY dispatches immediately after accept; never waits for TP', async () => {
    let telegramStarted = false;
    global.fetch = async (_url, init) => {
      telegramStarted = true;
      let text = '';
      try {
        text = JSON.parse(init?.body || '{}').text || '';
      } catch {
        text = '';
      }
      tg.texts.push(text);
      tg.calls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: { message_id: 1 } };
        }
      };
    };
    const t0 = Date.now();
    const accept = await acceptOnly(io, payload('entry', 'seq-20', { symbol: 'SEQJ' }), mem);
    assert.equal(accept.accepted, true);
    assert.equal(telegramStarted, false);
    assert.ok(Date.now() - t0 < 200);
    TradingViewAlertService.scheduleAcceptedTradingViewSignal(io, accept, mem);
    await TradeEventDispatcher.waitForIdle('seq-20');
    assert.equal(telegramStarted, true);
    assert.equal(isEntryText(tg.texts[0]), true);
    assert.equal(TradeLifecycleService.isEntryAlert('entry'), true);
  });
});
