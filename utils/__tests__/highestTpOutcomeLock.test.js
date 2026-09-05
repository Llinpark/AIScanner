/**
 * Highest-TP outcome lock — SL_HIT is only valid when no take-profit was reached.
 * In-memory / test Telegram only. Never hits production Telegram / Mongo / Fly.
 */
'use strict';

process.env.REDIS_ENABLED = process.env.REDIS_ENABLED || 'false';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  applyOutcomeUpdate,
  enrichEntrySignal,
  highestTargetReached,
  SL_AFTER_HIGHEST_TP
} = require('../signalOutcome');
const { generateLicenseToken } = require('../webhookSecurity');
const TradingViewAlertService = require('../../services/TradingViewAlertService');
const TradeLifecycleService = require('../../services/TradeLifecycleService');
const SignalOutcomeService = require('../../services/SignalOutcomeService');
const PipelineStatusService = require('../../services/PipelineStatusService');
const ActiveSignalRegistry = require('../activeSignalRegistry');
const TradeEventDispatcher = require('../tradeEventDispatcher');
const TradeEventStore = require('../tradeEventStore');
const deliveryIdempotency = require('../deliveryIdempotency');
const { resolveCanonicalTradeId } = require('../tradeEventIdentity');

const USER_ID = 'htp-user-1';
const TV_USER = 'htptrader';

const originalFetch = global.fetch;
const originalNodeEnv = process.env.NODE_ENV;
const originalBot = process.env.TELEGRAM_BOT_TOKEN;
const originalSigning = process.env.WEBHOOK_SIGNING_SECRET;

function openEntry(overrides = {}) {
  return enrichEntrySignal({
    symbol: 'EURUSD',
    direction: 'long',
    entry: 1.1,
    stop_loss: 1.09,
    take_profit_1: 1.11,
    take_profit_2: 1.12,
    take_profit_3: 1.13,
    alertType: 'entry',
    timeframe: '15m',
    signalUuid: 'htp-unit',
    ...overrides
  });
}

function levels() {
  return {
    entry: 1.1,
    stop_loss: 1.09,
    stop_loss_1: 1.09,
    take_profit_1: 1.11,
    take_profit_2: 1.12,
    take_profit_3: 1.13,
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

function proSubscriber() {
  return {
    id: USER_ID,
    email: 'htp-pro@example.com',
    role: 'user',
    subscription: { tier: 'professional', status: 'active' },
    telegram: { chatId: 'htp-chat', enabled: true, telegramMode: 'alerts_only' },
    mt5: { executionMode: 'manual', enabled: true, devices: [] }
  };
}

function mockTelegram(order) {
  global.fetch = async (url, init) => {
    order.calls += 1;
    let text = '';
    try {
      text = JSON.parse(init?.body || '{}').text || '';
    } catch {
      text = String(init?.body || '');
    }
    order.texts.push(text);
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, result: { message_id: order.calls } };
      }
    };
  };
}

function slHitCount(texts) {
  return texts.filter(t => /SL HIT/i.test(t)).length;
}

function tpHitCount(texts, n) {
  const re = n === 1 ? /TP1 HIT/i : n === 2 ? /TP2 HIT/i : /TP3 HIT|TRADE COMPLETE/i;
  return texts.filter(t => re.test(t)).length;
}

function findTrade(mem, uuid) {
  return mem.find(
    s =>
      String(s.signalUuid || s.signalId || '') === uuid &&
      (s.alertType === 'entry' || s.alertType === 'signal' || s.outcome)
  );
}

async function acceptAndFanout(io, body, mem) {
  const accept = await TradingViewAlertService.acceptTradingViewWebhook(io, body, mem);
  if (accept.pendingOutcome || (!accept.duplicate && !accept.skippedFanout && accept.accepted)) {
    TradingViewAlertService.scheduleAcceptedTradingViewSignal(io, accept, mem);
  }
  const uuid = accept.signalUuid || resolveCanonicalTradeId(body);
  await TradeEventDispatcher.waitForIdle(uuid);
  return accept;
}

describe('highest-TP outcome lock (unit)', () => {
  it('TEST 1: ENTRY → SL => finalOutcome SL_HIT', () => {
    const e = openEntry();
    applyOutcomeUpdate(e, 'stop_loss');
    assert.equal(e.outcome, 'sl');
    assert.equal(e.tradeStatus, 'lost');
    assert.equal(highestTargetReached(e), 'none');
    assert.equal(e._suppressDelivery, false);
  });

  it('TEST 2: ENTRY → TP1 → SL => TP1_HIT, suppress SL delivery', () => {
    const e = openEntry();
    applyOutcomeUpdate(e, 'take_profit_1');
    applyOutcomeUpdate(e, 'stop_loss');
    assert.equal(e.outcome, 'tp1');
    assert.equal(e.tradeStatus, 'won');
    assert.equal(highestTargetReached(e), 'tp1');
    assert.equal(e._suppressDelivery, true);
    assert.equal(e._outcomeIgnoreReason, SL_AFTER_HIGHEST_TP);
    assert.ok(e.closedAt);
  });

  it('TEST 3: ENTRY → TP1 → TP2 → SL => TP2_HIT', () => {
    const e = openEntry();
    applyOutcomeUpdate(e, 'take_profit_1');
    applyOutcomeUpdate(e, 'take_profit_2');
    applyOutcomeUpdate(e, 'stop_loss');
    assert.equal(e.outcome, 'tp2');
    assert.equal(e.tradeStatus, 'won');
    assert.equal(highestTargetReached(e), 'tp2');
    assert.equal(e._suppressDelivery, true);
  });

  it('TEST 4: ENTRY → TP1 → TP2 → TP3 => TP3_HIT', () => {
    const e = openEntry();
    applyOutcomeUpdate(e, 'take_profit_1');
    applyOutcomeUpdate(e, 'take_profit_2');
    applyOutcomeUpdate(e, 'take_profit_3');
    assert.equal(e.outcome, 'tp3');
    assert.equal(e.tradeStatus, 'won');
    applyOutcomeUpdate(e, 'stop_loss');
    assert.equal(e.outcome, 'tp3');
    assert.equal(e._outcomeIgnored, true);
  });

  it('never downgrades TP2 → TP1 or TP2 → SL_HIT', () => {
    const e = openEntry();
    applyOutcomeUpdate(e, 'take_profit_2');
    applyOutcomeUpdate(e, 'take_profit_1');
    assert.equal(e.outcome, 'tp2');
    applyOutcomeUpdate(e, 'stop_loss');
    assert.equal(e.outcome, 'tp2');
  });
});

describe('highest-TP outcome lock (webhook + recovery)', () => {
  let mem;
  let io;
  let tg;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token-htp';
    process.env.WEBHOOK_SIGNING_SECRET = 'test-signing-secret-htp';
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
    tg = { calls: 0, texts: [] };
    mockTelegram(tg);
    ActiveSignalRegistry.resetForTests();
    PipelineStatusService.resetForTests();
    TradingViewAlertService.resetTestFanoutHooks();
    TradeEventDispatcher.resetForTests();
    TradeEventStore.resetForTests();
    deliveryIdempotency.resetForTests();
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.NODE_ENV = originalNodeEnv;
    process.env.TELEGRAM_BOT_TOKEN = originalBot;
    process.env.WEBHOOK_SIGNING_SECRET = originalSigning;
    TradingViewAlertService.resetTestFanoutHooks();
    TradeEventStore.resetForTests();
  });

  it('TEST 1 webhook: ENTRY → SL sends SL HIT once, finalOutcome sl', async () => {
    const uuid = 'htp-w1';
    await acceptAndFanout(io, payload('entry', uuid, { symbol: 'HTP1' }), mem);
    await acceptAndFanout(io, payload('stop_loss', uuid, { symbol: 'HTP1' }), mem);
    const trade = findTrade(mem, uuid);
    assert.equal(trade.outcome, 'sl');
    assert.equal(trade.tradeStatus, 'lost');
    assert.equal(slHitCount(tg.texts), 1);
  });

  it('TEST 2 webhook: ENTRY → TP1 → SL keeps TP1, no SL HIT', async () => {
    const uuid = 'htp-w2';
    await acceptAndFanout(io, payload('entry', uuid, { symbol: 'HTP2' }), mem);
    await acceptAndFanout(io, payload('take_profit_1', uuid, { symbol: 'HTP2' }), mem);
    const afterTp = tg.calls;
    await acceptAndFanout(io, payload('stop_loss', uuid, { symbol: 'HTP2' }), mem);
    const trade = findTrade(mem, uuid);
    assert.equal(trade.outcome, 'tp1');
    assert.equal(trade.tradeStatus, 'won');
    assert.equal(slHitCount(tg.texts), 0);
    assert.equal(tpHitCount(tg.texts, 1), 1);
    assert.equal(tg.calls, afterTp);
    const active = await ActiveSignalRegistry.getActive('HTP2', '15m');
    assert.ok(!active);
  });

  it('TEST 3 webhook: ENTRY → TP1 → TP2 → SL keeps TP2, no SL HIT', async () => {
    const uuid = 'htp-w3';
    await acceptAndFanout(io, payload('entry', uuid, { symbol: 'HTP3' }), mem);
    await acceptAndFanout(io, payload('take_profit_1', uuid, { symbol: 'HTP3' }), mem);
    await acceptAndFanout(io, payload('take_profit_2', uuid, { symbol: 'HTP3' }), mem);
    const afterTp = tg.calls;
    await acceptAndFanout(io, payload('stop_loss', uuid, { symbol: 'HTP3' }), mem);
    const trade = findTrade(mem, uuid);
    assert.equal(trade.outcome, 'tp2');
    assert.equal(highestTargetReached(trade), 'tp2');
    assert.equal(slHitCount(tg.texts), 0);
    assert.equal(tg.calls, afterTp);
  });

  it('TEST 4 webhook: full TP path ends TP3_HIT', async () => {
    const uuid = 'htp-w4';
    await acceptAndFanout(io, payload('entry', uuid, { symbol: 'HTP4' }), mem);
    await acceptAndFanout(io, payload('take_profit_1', uuid, { symbol: 'HTP4' }), mem);
    await acceptAndFanout(io, payload('take_profit_2', uuid, { symbol: 'HTP4' }), mem);
    await acceptAndFanout(io, payload('take_profit_3', uuid, { symbol: 'HTP4' }), mem);
    assert.equal(findTrade(mem, uuid).outcome, 'tp3');
    assert.equal(findTrade(mem, uuid).tradeStatus, 'won');
  });

  it('TEST 5: duplicate TP1 webhook notifies once', async () => {
    const uuid = 'htp-w5';
    await acceptAndFanout(io, payload('entry', uuid, { symbol: 'HTP5' }), mem);
    await acceptAndFanout(io, payload('take_profit_1', uuid, { symbol: 'HTP5' }), mem);
    await acceptAndFanout(io, payload('take_profit_1', uuid, { symbol: 'HTP5' }), mem);
    assert.equal(tpHitCount(tg.texts, 1), 1);
    assert.equal(findTrade(mem, uuid).outcome, 'tp1');
  });

  it('TEST 6: duplicate SL after TP1 never sends SL HIT', async () => {
    const uuid = 'htp-w6';
    await acceptAndFanout(io, payload('entry', uuid, { symbol: 'HTP6' }), mem);
    await acceptAndFanout(io, payload('take_profit_1', uuid, { symbol: 'HTP6' }), mem);
    await acceptAndFanout(io, payload('stop_loss', uuid, { symbol: 'HTP6' }), mem);
    await acceptAndFanout(io, payload('stop_loss', uuid, { symbol: 'HTP6' }), mem);
    assert.equal(slHitCount(tg.texts), 0);
    assert.equal(findTrade(mem, uuid).outcome, 'tp1');
  });

  it('TEST 7: duplicate SL after TP2 never sends SL HIT', async () => {
    const uuid = 'htp-w7';
    await acceptAndFanout(io, payload('entry', uuid, { symbol: 'HTP7' }), mem);
    await acceptAndFanout(io, payload('take_profit_1', uuid, { symbol: 'HTP7' }), mem);
    await acceptAndFanout(io, payload('take_profit_2', uuid, { symbol: 'HTP7' }), mem);
    await acceptAndFanout(io, payload('stop_loss', uuid, { symbol: 'HTP7' }), mem);
    await acceptAndFanout(io, payload('stop_loss', uuid, { symbol: 'HTP7' }), mem);
    assert.equal(slHitCount(tg.texts), 0);
    assert.equal(findTrade(mem, uuid).outcome, 'tp2');
  });

  it('TEST 8: recovery SL after TP2 already persisted keeps TP2_HIT', async () => {
    const uuid = 'htp-w8';
    const entry = {
      _id: 'mem_htp8',
      ...openEntry({ signalUuid: uuid, symbol: 'HTP8' }),
      tradeStatus: 'open',
      outcome: 'pending'
    };
    mem.push(entry);
    await SignalOutcomeService.updateEntryOutcome(entry, 'take_profit_1', mem, 'tp1');
    await SignalOutcomeService.updateEntryOutcome(mem[0], 'take_profit_2', mem, 'tp2');
    assert.equal(mem[0].outcome, 'tp2');

    const recovered = await TradeLifecycleService.processIncomingTradeAlert(
      payload('stop_loss', uuid, { symbol: 'HTP8' }),
      mem,
      { fromTradingViewWebhook: true, skipMarketData: true }
    );
    assert.equal(recovered.skipped, true);
    assert.equal(recovered.reason, SL_AFTER_HIGHEST_TP);
    assert.equal(mem[0].outcome, 'tp2');
    assert.equal(mem[0].tradeStatus, 'won');
    assert.equal(highestTargetReached(mem[0]), 'tp2');
  });

  it('TEST 9: recovery SL after no TP persisted is SL_HIT', async () => {
    const uuid = 'htp-w9';
    const entry = {
      _id: 'mem_htp9',
      ...openEntry({ signalUuid: uuid, symbol: 'HTP9' }),
      tradeStatus: 'open',
      outcome: 'pending'
    };
    mem.push(entry);
    const recovered = await TradeLifecycleService.processIncomingTradeAlert(
      payload('stop_loss', uuid, { symbol: 'HTP9' }),
      mem,
      { fromTradingViewWebhook: true, skipMarketData: true }
    );
    assert.equal(recovered.skipped, undefined);
    assert.equal(mem[0].outcome, 'sl');
    assert.equal(mem[0].tradeStatus, 'lost');
  });

  it('TEST 10: concurrent TP2 and SL — highest TP wins', async () => {
    const uuid = 'htp-w10';
    const entry = {
      _id: 'mem_htp10',
      ...openEntry({ signalUuid: uuid, symbol: 'HTP10' }),
      tradeStatus: 'open',
      outcome: 'pending',
      highestMilestone: 'pending'
    };
    mem.push(entry);
    await Promise.all([
      SignalOutcomeService.updateEntryOutcome(mem[0], 'take_profit_2', mem, 'tp2'),
      SignalOutcomeService.updateEntryOutcome(mem[0], 'stop_loss', mem, 'sl')
    ]);
    assert.equal(highestTargetReached(mem[0]), 'tp2');
    assert.equal(mem[0].outcome, 'tp2');
    assert.notEqual(mem[0].outcome, 'sl');
  });

  it('TEST 11: TP3 then delayed SL keeps TP3, no SL HIT', async () => {
    const uuid = 'htp-w11';
    await acceptAndFanout(io, payload('entry', uuid, { symbol: 'HTPA' }), mem);
    await acceptAndFanout(io, payload('take_profit_1', uuid, { symbol: 'HTPA' }), mem);
    await acceptAndFanout(io, payload('take_profit_2', uuid, { symbol: 'HTPA' }), mem);
    await acceptAndFanout(io, payload('take_profit_3', uuid, { symbol: 'HTPA' }), mem);
    const afterTp3 = tg.calls;
    await acceptAndFanout(io, payload('stop_loss', uuid, { symbol: 'HTPA' }), mem);
    assert.equal(findTrade(mem, uuid).outcome, 'tp3');
    assert.equal(slHitCount(tg.texts), 0);
    assert.equal(tg.calls, afterTp3);
  });

  it('TEST 12: ENTRY → TP1 → dup TP1 → TP2 → SL', async () => {
    const uuid = 'htp-w12';
    await acceptAndFanout(io, payload('entry', uuid, { symbol: 'HTPB' }), mem);
    await acceptAndFanout(io, payload('take_profit_1', uuid, { symbol: 'HTPB' }), mem);
    await acceptAndFanout(io, payload('take_profit_1', uuid, { symbol: 'HTPB' }), mem);
    await acceptAndFanout(io, payload('take_profit_2', uuid, { symbol: 'HTPB' }), mem);
    await acceptAndFanout(io, payload('stop_loss', uuid, { symbol: 'HTPB' }), mem);
    assert.equal(tpHitCount(tg.texts, 1), 1);
    assert.equal(tpHitCount(tg.texts, 2), 1);
    assert.equal(slHitCount(tg.texts), 0);
    assert.equal(findTrade(mem, uuid).outcome, 'tp2');
  });
});
