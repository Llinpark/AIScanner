'use strict';

/**
 * Bypass-focused causal sequencing: delayed ENTRY + immediate TP, recovery
 * cannot skip the gate, never-accepted/unflagged stale ENTRY cannot unblock
 * outcomes, identity cannot attach to the wrong trade.
 */

process.env.REDIS_ENABLED = process.env.REDIS_ENABLED || 'false';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const DeliverySequencer = require('../deliverySequencer');
const TradeEventStore = require('../tradeEventStore');
const DurableDelivery = require('../durableDelivery');
const TradeDeliveryService = require('../../services/TradeDeliveryService');
const { logDeliveryTimeline } = require('../deliveryTimeline');

const originalFetch = global.fetch;
const originalNodeEnv = process.env.NODE_ENV;
const originalBot = process.env.TELEGRAM_BOT_TOKEN;

function telegramOrder(state) {
  global.fetch = async (_url, init) => {
    let text = '';
    try {
      text = JSON.parse(init?.body || '{}').text || '';
    } catch {
      text = String(init?.body || '');
    }
    state.started.push(text);
    if (/KACHING BUY|KACHING SELL/i.test(text) && state.holdEntry) {
      await state.entryHold;
    }
    state.texts.push(text);
    state.calls += 1;
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, result: { message_id: state.calls } };
      }
    };
  };
}

describe('causal sequencing bypasses', () => {
  let tg;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token-bypass';
    process.env.DELIVERY_SEQ_WAIT_MS = '120';
    tg = { calls: 0, texts: [], started: [], holdEntry: false, entryHold: Promise.resolve() };
    telegramOrder(tg);
    TradeEventStore.resetForTests();
    DurableDelivery.resetForTests();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.NODE_ENV = originalNodeEnv;
    process.env.TELEGRAM_BOT_TOKEN = originalBot;
    delete process.env.DELIVERY_SEQ_WAIT_MS;
    TradeEventStore.resetForTests();
  });

  it('timeline log is JSON and does not throw', () => {
    const lines = [];
    const orig = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      const row = logDeliveryTimeline('webhook_received', {
        canonicalTradeId: 'tl-1',
        signalUuid: 'tl-1',
        symbol: 'JUMP_10_INDEX',
        direction: 'sell',
        alertType: 'entry',
        eventTimestamp: Date.now(),
        webhookReceivedAt: Date.now(),
        channel: 'telegram',
        subscriberId: 'sub-1'
      });
      assert.equal(row.tradeId, 'tl-1');
      assert.equal(row.symbol, 'JUMP_10_INDEX');
      assert.ok(row.machineId);
      assert.equal(typeof row.processId, 'number');
      assert.ok(lines.some(l => l.startsWith('[DELIVERY_TIMELINE] {')));
      const parsed = JSON.parse(lines.find(l => l.startsWith('[DELIVERY_TIMELINE] {')).slice('[DELIVERY_TIMELINE] '.length));
      assert.equal(parsed.eventType, 'entry');
    } finally {
      console.log = orig;
    }
  });

  it('6. TP before ENTRY internally is blocked', async () => {
    const result = await DeliverySequencer.withChannelSequence({
      signalDoc: { canonicalTradeId: 'bp-6', signalUuid: 'bp-6', alertType: 'take_profit_1' },
      subscriberId: 'sub-6',
      channel: 'telegram',
      alertType: 'take_profit_1',
      waitMode: 'check_once',
      send: async () => ({ ok: true })
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'delivery_sequence_wait');
    assert.equal(result.blocked, true);
  });

  it('7+8. ENTRY temporary fail keeps outcome blocked; retry then releases', async () => {
    const cid = 'bp-78';
    const sub = 'sub-78';
    const ch = 'telegram';
    let entryOk = false;
    const entryFail = await DeliverySequencer.withChannelSequence({
      signalDoc: { canonicalTradeId: cid, signalUuid: cid, alertType: 'entry' },
      subscriberId: sub,
      channel: ch,
      alertType: 'entry',
      send: async () => ({ ok: false, reason: 'telegram_timeout' })
    });
    assert.equal(entryFail.ok, false);
    const blocked = await DeliverySequencer.withChannelSequence({
      signalDoc: { canonicalTradeId: cid, signalUuid: cid, alertType: 'take_profit_3' },
      subscriberId: sub,
      channel: ch,
      alertType: 'take_profit_3',
      waitMode: 'check_once',
      send: async () => ({ ok: true, kind: 'tp3' })
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'delivery_sequence_wait');

    entryOk = true;
    const entryRetry = await DeliverySequencer.withChannelSequence({
      signalDoc: { canonicalTradeId: cid, signalUuid: cid, alertType: 'entry' },
      subscriberId: sub,
      channel: ch,
      alertType: 'entry',
      send: async () => ({ ok: entryOk })
    });
    assert.equal(entryRetry.ok, true);
    const released = await DeliverySequencer.withChannelSequence({
      signalDoc: { canonicalTradeId: cid, signalUuid: cid, alertType: 'take_profit_3' },
      subscriberId: sub,
      channel: ch,
      alertType: 'take_profit_3',
      waitMode: 'check_once',
      send: async () => ({ ok: true, kind: 'tp3' })
    });
    assert.equal(released.ok, true);
    assert.equal(released.kind, 'tp3');
  });

  it('9. process restart while outcome blocked still requires ENTRY commit', async () => {
    const cid = 'bp-9';
    await DeliverySequencer.withChannelSequence({
      signalDoc: { canonicalTradeId: cid, signalUuid: cid, alertType: 'take_profit_2' },
      subscriberId: 'sub-9',
      channel: 'email',
      alertType: 'take_profit_2',
      waitMode: 'check_once',
      send: async () => ({ ok: true })
    });
    TradeEventStore.resetLocalQueuesForTests?.();
    const afterRestart = await DeliverySequencer.withChannelSequence({
      signalDoc: { canonicalTradeId: cid, signalUuid: cid, alertType: 'take_profit_2' },
      subscriberId: 'sub-9',
      channel: 'email',
      alertType: 'take_profit_2',
      waitMode: 'check_once',
      send: async () => ({ ok: true })
    });
    assert.equal(afterRestart.ok, false);
    assert.equal(afterRestart.reason, 'delivery_sequence_wait');
  });

  it('10. two machines: outcome send is serialized behind ENTRY HASH', async () => {
    const redis = {
      isOpen: true,
      kv: new Map(),
      hashes: new Map(),
      async set(key, val, opts = {}) {
        if (opts && opts.NX && this.kv.has(key)) return null;
        this.kv.set(key, String(val));
        return 'OK';
      },
      async get(key) {
        return this.kv.has(key) ? this.kv.get(key) : null;
      },
      async del(...keys) {
        let n = 0;
        for (const key of keys.flat()) {
          if (this.kv.delete(key)) n += 1;
          if (this.hashes.delete(key)) n += 1;
        }
        return n;
      },
      async hSet(key, field, value) {
        if (!this.hashes.has(key)) this.hashes.set(key, new Map());
        this.hashes.get(key).set(String(field), String(value));
        return 1;
      },
      async hGetAll(key) {
        const h = this.hashes.get(key);
        return h ? Object.fromEntries(h) : {};
      },
      async expire() {
        return 1;
      },
      async eval(_script, { keys, arguments: args }) {
        const cur = this.kv.get(keys[0]);
        if (cur === args[0]) {
          this.kv.delete(keys[0]);
          return 1;
        }
        return 0;
      }
    };
    TradeEventStore.setClientForTests(redis);
    const cid = 'bp-10';
    let order = [];
    const tp = DeliverySequencer.withChannelSequence({
      signalDoc: { canonicalTradeId: cid, signalUuid: cid, alertType: 'stop_loss' },
      subscriberId: 'sub-10',
      channel: 'telegram',
      alertType: 'stop_loss',
      waitMode: 'live',
      send: async () => {
        order.push('sl');
        return { ok: true };
      }
    });
    await new Promise(r => setTimeout(r, 20));
    const entry = await DeliverySequencer.withChannelSequence({
      signalDoc: { canonicalTradeId: cid, signalUuid: cid, alertType: 'entry' },
      subscriberId: 'sub-10',
      channel: 'telegram',
      alertType: 'entry',
      send: async () => {
        order.push('entry');
        return { ok: true };
      }
    });
    const tpResult = await tp;
    assert.equal(entry.ok, true);
    assert.equal(tpResult.ok, true);
    assert.deepEqual(order, ['entry', 'sl']);
    TradeEventStore.resetForTests();
  });

  it('15. recovery check_once cannot send TP before ENTRY', async () => {
    const cid = 'bp-15';
    const job = await DurableDelivery.ensureJob({
      eventId: `EURUSD|3|${cid}|TP3`,
      canonicalTradeId: cid,
      subscriberId: 'sub-15',
      channel: 'telegram',
      eventType: 'take_profit_3',
      signalUuid: cid
    });
    assert.ok(job);
    const recovered = await TradeDeliveryService.deliverDurableJob(
      { emit() {}, to() { return { emit() {} }; } },
      {
        ...job,
        payload: {
          signal: {
            canonicalTradeId: cid,
            signalUuid: cid,
            alertType: 'take_profit_3',
            symbol: 'EURUSD',
            direction: 'long',
            entry: 1,
            take_profit_3: 2,
            stop_loss: 0.5
          },
          subscriber: {
            id: 'sub-15',
            email: 'a@b.c',
            subscription: { tier: 'professional', status: 'active' },
            telegram: { chatId: '1', enabled: true }
          }
        }
      },
      { waitMode: 'check_once' }
    );
    assert.equal(recovered.ok, false);
    assert.equal(recovered.reason, 'delivery_sequence_wait');
    assert.equal(tg.calls, 0);
  });

  it('20. outcomes cannot attach to the wrong trade HASH', async () => {
    await DeliverySequencer.withChannelSequence({
      signalDoc: { canonicalTradeId: 'trade-a', signalUuid: 'trade-a', alertType: 'entry' },
      subscriberId: 'sub-20',
      channel: 'telegram',
      alertType: 'entry',
      send: async () => ({ ok: true })
    });
    const wrong = await DeliverySequencer.withChannelSequence({
      signalDoc: { canonicalTradeId: 'trade-b', signalUuid: 'trade-b', alertType: 'take_profit_3' },
      subscriberId: 'sub-20',
      channel: 'telegram',
      alertType: 'take_profit_3',
      waitMode: 'check_once',
      send: async () => ({ ok: true })
    });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.reason, 'delivery_sequence_wait');
    const committedA = await TradeEventStore.getCommittedDeliveries('trade-a', 'sub-20', 'telegram');
    const committedB = await TradeEventStore.getCommittedDeliveries('trade-b', 'sub-20', 'telegram');
    assert.equal(committedA.has('entry'), true);
    assert.equal(committedB.has('entry'), false);
  });
});
