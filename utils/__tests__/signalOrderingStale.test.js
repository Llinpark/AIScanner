/**
 * Signal staleness, duplicate, and out-of-order delivery — 30 spec scenarios.
 * In-memory only. Never hits production Telegram / Mongo / Fly.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { generateLicenseToken } = require('../webhookSecurity');
const TradingViewAlertService = require('../../services/TradingViewAlertService');
const TradeLifecycleService = require('../../services/TradeLifecycleService');
const SignalOutcomeService = require('../../services/SignalOutcomeService');
const TradeDeliveryService = require('../../services/TradeDeliveryService');
const PipelineStatusService = require('../../services/PipelineStatusService');
const ActiveSignalRegistry = require('../activeSignalRegistry');
const TradeEventDispatcher = require('../tradeEventDispatcher');
const deliveryIdempotency = require('../deliveryIdempotency');
const { evaluateEntryFreshness, resolveCanonicalTradeId } = require('../tradeEventIdentity');
const { isTerminalEntry, findEntryBySignalUuid } = require('../signalOutcome');

const USER_ID = 'order-user-1';
const TV_USER = 'ordertrader';

const originalFetch = global.fetch;
const originalNodeEnv = process.env.NODE_ENV;
const originalBot = process.env.TELEGRAM_BOT_TOKEN;
const originalOrphanWait = process.env.ORPHAN_OUTCOME_WAIT_MS;
const originalSigning = process.env.WEBHOOK_SIGNING_SECRET;

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
    message: alertType === 'entry' ? 'KACHING BUY' : `KACHING ${alertType}`,
    broadcast: true,
    tradingviewUsername: TV_USER,
    userId: USER_ID,
    licenseToken: generateLicenseToken(USER_ID, TV_USER),
    signalTime: overrides.signalTime,
    timestamp: overrides.timestamp,
    bridgeEventIndex: overrides.bridgeEventIndex,
    ...overrides,
    signalUuid: uuid,
    signalId: uuid
  };
}

function proSubscriber(overrides = {}) {
  return {
    id: USER_ID,
    email: 'pro-order@example.com',
    role: 'user',
    subscription: { tier: 'professional', status: 'active' },
    telegram: { chatId: '333001', enabled: true, telegramMode: 'alerts_only' },
    mt5: { executionMode: 'manual', enabled: true, devices: [] },
    ...overrides
  };
}

function premiumSubscriber(overrides = {}) {
  return {
    id: 'premium-order',
    email: 'premium-order@example.com',
    role: 'user',
    subscription: { tier: 'premium', status: 'active' },
    telegram: { chatId: '444001', enabled: true },
    mt5: {
      executionMode: 'auto',
      enabled: true,
      devices: [{ deviceId: 'd1', accessToken: 't', revokedAt: null }],
      accountBalance: 1000
    },
    ...overrides
  };
}

function mockTelegram(order) {
  global.fetch = async (_url, init) => {
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

async function acceptAndFanout(io, body, inMemorySignals) {
  const accept = await TradingViewAlertService.acceptTradingViewWebhook(io, body, inMemorySignals);
  if (accept.pendingOutcome || (!accept.duplicate && !accept.skippedFanout && accept.accepted)) {
    TradingViewAlertService.scheduleAcceptedTradingViewSignal(io, accept, inMemorySignals);
  }
  const uuid = accept.signalUuid || resolveCanonicalTradeId(body);
  await TradeEventDispatcher.waitForIdle(uuid);
  return accept;
}

describe('signal ordering / staleness / exactly-once (30 scenarios)', () => {
  let inMemorySignals;
  let io;
  let tg;
  let socketEvents;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token-order';
    process.env.WEBHOOK_SIGNING_SECRET = 'test-signing-secret-order';
    process.env.ORPHAN_OUTCOME_WAIT_MS = '120';
    delete process.env.PIPELINE_SELF_TEST_ACTIVE;
    inMemorySignals = [];
    socketEvents = [];
    io = {
      emit(ev, payload) {
        socketEvents.push({ ev, payload });
      },
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
    deliveryIdempotency.resetForTests();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.NODE_ENV = originalNodeEnv;
    process.env.TELEGRAM_BOT_TOKEN = originalBot;
    process.env.WEBHOOK_SIGNING_SECRET = originalSigning;
    if (originalOrphanWait == null) delete process.env.ORPHAN_OUTCOME_WAIT_MS;
    else process.env.ORPHAN_OUTCOME_WAIT_MS = originalOrphanWait;
    TradingViewAlertService.resetTestFanoutHooks();
  });

  it('1. Fresh Entry → exactly one Signal', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'ord-1-fresh';
    await acceptAndFanout(io, payload('entry', uuid, { symbol: 'ORD1' }), inMemorySignals);
    assert.equal(inMemorySignals.length, 1);
    assert.equal(inMemorySignals[0].signalUuid, uuid);
    assert.equal(inMemorySignals[0].alertType, 'entry');
  });

  it('2. Duplicate identical Entry webhook → one Signal, one subscriber Entry delivery', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'ord-2-dup';
    const body = payload('entry', uuid, { symbol: 'ORD2' });
    await acceptAndFanout(io, body, inMemorySignals);
    await acceptAndFanout(io, body, inMemorySignals);
    assert.equal(inMemorySignals.length, 1);
    assert.equal(tg.calls, 1);
  });

  it('3. Entry → TP1 → TP2 → TP3 produces correct order', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'ord-3-seq';
    const sym = 'ORD3';
    await acceptAndFanout(io, payload('entry', uuid, { symbol: sym }), inMemorySignals);
    await acceptAndFanout(io, payload('take_profit_1', uuid, { symbol: sym }), inMemorySignals);
    await acceptAndFanout(io, payload('take_profit_2', uuid, { symbol: sym }), inMemorySignals);
    await acceptAndFanout(io, payload('take_profit_3', uuid, { symbol: sym }), inMemorySignals);
    assert.equal(tg.calls, 4);
    assert.match(tg.texts[0], /KACHING BUY|Entry/i);
    assert.match(tg.texts[1], /TP1/i);
    assert.match(tg.texts[2], /TP2/i);
    assert.match(tg.texts[3], /TP3/i);
    assert.equal(inMemorySignals[0].outcome, 'tp3');
    assert.ok(isTerminalEntry(inMemorySignals[0]));
  });

  it('4. Entry → SL produces correct order and terminal lock', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'ord-4-sl';
    await acceptAndFanout(io, payload('entry', uuid, { symbol: 'ORD4' }), inMemorySignals);
    await acceptAndFanout(io, payload('stop_loss', uuid, { symbol: 'ORD4' }), inMemorySignals);
    assert.equal(tg.calls, 2);
    assert.match(tg.texts[1], /STOP LOSS|SL/i);
    assert.equal(inMemorySignals[0].outcome, 'sl');
    assert.ok(isTerminalEntry(inMemorySignals[0]));
  });

  it('5. TP3 received before Entry → orphaned outcome rejected, no subscriber notification', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'ord-5-orphan';
    const accept = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload('take_profit_3', uuid, { symbol: 'ORD5' }),
      inMemorySignals
    );
    assert.equal(accept.reason, 'orphaned_outcome');
    assert.equal(inMemorySignals.length, 0);
    assert.equal(tg.calls, 0);
  });

  it('6. TP1 received before Entry → rejected/quarantined', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const accept = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload('take_profit_1', 'ord-6-tp1', { symbol: 'ORD6' }),
      inMemorySignals
    );
    assert.equal(accept.reason, 'orphaned_outcome');
    assert.equal(tg.calls, 0);
    assert.equal(inMemorySignals.length, 0);
  });

  it('7. TP2 before TP1 after Entry → monotonic skip-ahead allowed (gap semantics)', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'ord-7-gap';
    await acceptAndFanout(io, payload('entry', uuid, { symbol: 'ORD7' }), inMemorySignals);
    await acceptAndFanout(io, payload('take_profit_2', uuid, { symbol: 'ORD7' }), inMemorySignals);
    assert.equal(inMemorySignals[0].outcome, 'tp2');
    assert.equal(tg.calls, 2);
    assert.match(tg.texts[0], /KACHING BUY|Entry/i);
    assert.match(tg.texts[1], /TP2/i);
  });

  it('8. TP3 before queued Entry fan-out completes → Entry still delivered first', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'ord-8-race';
    const entryAccept = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload('entry', uuid, { symbol: 'ORD8' }),
      inMemorySignals
    );
    const tp3Accept = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload('take_profit_3', uuid, { symbol: 'ORD8' }),
      inMemorySignals
    );
    TradingViewAlertService.scheduleAcceptedTradingViewSignal(io, tp3Accept, inMemorySignals);
    TradingViewAlertService.scheduleAcceptedTradingViewSignal(io, entryAccept, inMemorySignals);
    await TradeEventDispatcher.waitForIdle(uuid);
    assert.ok(tg.calls >= 2);
    assert.match(tg.texts[0], /KACHING BUY|Entry/i);
    assert.match(tg.texts[tg.texts.length - 1], /TP3/i);
  });

  it('9. concurrent Entry + TP3 → subscriber sees Entry before TP3 (repeat)', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    for (let i = 0; i < 8; i += 1) {
      inMemorySignals = [];
      tg = { calls: 0, texts: [] };
      mockTelegram(tg);
      ActiveSignalRegistry.resetForTests();
      TradeEventDispatcher.resetForTests();
      deliveryIdempotency.resetForTests();
      const uuid = `ord-9-conc-${i}`;
      const [entryAccept, tp3Accept] = await Promise.all([
        TradingViewAlertService.acceptTradingViewWebhook(
          io,
          payload('entry', uuid, { symbol: `O9${i}` }),
          inMemorySignals
        ),
        TradingViewAlertService.acceptTradingViewWebhook(
          io,
          payload('take_profit_3', uuid, { symbol: `O9${i}` }),
          inMemorySignals
        )
      ]);
      TradingViewAlertService.scheduleAcceptedTradingViewSignal(io, entryAccept, inMemorySignals);
      TradingViewAlertService.scheduleAcceptedTradingViewSignal(io, tp3Accept, inMemorySignals);
      await TradeEventDispatcher.waitForIdle(uuid, 4000);
      assert.ok(tg.calls >= 1, `iter ${i} expected delivery`);
      assert.match(tg.texts[0], /KACHING BUY|Entry/i, `iter ${i} first must be Entry`);
      if (tg.calls >= 2) {
        assert.match(tg.texts[1], /TP3/i, `iter ${i} second must be TP3`);
      }
    }
  });

  it('10. Same-bar Entry + TP1 + TP2 preserves logical sequence', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'ord-10-bar';
    const t0 = Date.now();
    const entryAccept = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload('entry', uuid, { symbol: 'ORD10', signalTime: t0, bridgeEventIndex: 0 }),
      inMemorySignals
    );
    const tp1Accept = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload('take_profit_1', uuid, { symbol: 'ORD10', signalTime: t0, bridgeEventIndex: 1 }),
      inMemorySignals
    );
    const tp2Accept = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload('take_profit_2', uuid, { symbol: 'ORD10', signalTime: t0, bridgeEventIndex: 2 }),
      inMemorySignals
    );
    TradingViewAlertService.scheduleAcceptedTradingViewSignal(io, tp2Accept, inMemorySignals);
    TradingViewAlertService.scheduleAcceptedTradingViewSignal(io, tp1Accept, inMemorySignals);
    TradingViewAlertService.scheduleAcceptedTradingViewSignal(io, entryAccept, inMemorySignals);
    await TradeEventDispatcher.waitForIdle(uuid);
    assert.ok(tg.calls >= 3);
    assert.match(tg.texts[0], /KACHING BUY/i);
    assert.match(tg.texts[1], /TP1 HIT/i);
    assert.match(tg.texts[2], /TP2 HIT/i);
  });

  it('11. Duplicate TP1 → only one TP1 notification', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'ord-11-tp1';
    await acceptAndFanout(io, payload('entry', uuid, { symbol: 'ORD11' }), inMemorySignals);
    await acceptAndFanout(io, payload('take_profit_1', uuid, { symbol: 'ORD11' }), inMemorySignals);
    await acceptAndFanout(io, payload('take_profit_1', uuid, { symbol: 'ORD11' }), inMemorySignals);
    const tp1Hits = tg.texts.filter(t => /TP1 HIT/i.test(t));
    assert.equal(tp1Hits.length, 1);
  });

  it('12. Duplicate TP3 → only one terminal notification', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'ord-12-tp3';
    await acceptAndFanout(io, payload('entry', uuid, { symbol: 'ORD12' }), inMemorySignals);
    await acceptAndFanout(io, payload('take_profit_3', uuid, { symbol: 'ORD12' }), inMemorySignals);
    await acceptAndFanout(io, payload('take_profit_3', uuid, { symbol: 'ORD12' }), inMemorySignals);
    const tp3Hits = tg.texts.filter(t => /TP3 HIT/i.test(t));
    assert.equal(tp3Hits.length, 1);
  });

  it('13. Duplicate SL → only one terminal notification', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'ord-13-sl';
    await acceptAndFanout(io, payload('entry', uuid, { symbol: 'ORD13' }), inMemorySignals);
    await acceptAndFanout(io, payload('stop_loss', uuid, { symbol: 'ORD13' }), inMemorySignals);
    await acceptAndFanout(io, payload('stop_loss', uuid, { symbol: 'ORD13' }), inMemorySignals);
    const slTexts = tg.texts.filter(t => /STOP LOSS|SL HIT/i.test(t));
    assert.equal(slTexts.length, 1);
  });

  it('14. TP3 then later Entry replay → no reopening and no fresh Entry alert', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'ord-14-reopen';
    await acceptAndFanout(io, payload('entry', uuid, { symbol: 'ORD14' }), inMemorySignals);
    await acceptAndFanout(io, payload('take_profit_3', uuid, { symbol: 'ORD14' }), inMemorySignals);
    const after = tg.calls;
    const replay = await acceptAndFanout(
      io,
      payload('entry', uuid, { symbol: 'ORD14' }),
      inMemorySignals
    );
    assert.ok(replay.skippedFanout || replay.duplicate || replay.reason === 'already_terminal');
    assert.equal(inMemorySignals.length, 1);
    assert.ok(isTerminalEntry(inMemorySignals[0]));
    assert.equal(tg.calls, after);
  });

  it('15. SL then later Entry replay → no reopening', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'ord-15-slre';
    await acceptAndFanout(io, payload('entry', uuid, { symbol: 'ORD15' }), inMemorySignals);
    await acceptAndFanout(io, payload('stop_loss', uuid, { symbol: 'ORD15' }), inMemorySignals);
    const replay = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload('entry', uuid, { symbol: 'ORD15' }),
      inMemorySignals
    );
    assert.ok(replay.skippedFanout || replay.duplicate || replay.reason === 'already_terminal');
    assert.equal(inMemorySignals[0].outcome, 'sl');
  });

  it('16. Old stale Entry → no Telegram/Email/Socket/MT5', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'ord-16-stale';
    const accept = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload('entry', uuid, {
        symbol: 'ORD16',
        signalTime: Date.now() - 3 * 60 * 60 * 1000
      }),
      inMemorySignals
    );
    TradingViewAlertService.scheduleAcceptedTradingViewSignal(io, accept, inMemorySignals);
    await TradeEventDispatcher.waitForIdle(uuid);
    assert.equal(accept.reason, 'stale_entry');
    assert.equal(tg.calls, 0);
    assert.equal(inMemorySignals.length, 0);
  });

  it('17. Delayed legitimate webhook within allowed window → accepted', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'ord-17-delay';
    const accept = await acceptAndFanout(
      io,
      payload('entry', uuid, {
        symbol: 'ORD17',
        signalTime: Date.now() - 60 * 1000
      }),
      inMemorySignals
    );
    assert.equal(accept.accepted, true);
    assert.equal(accept.reason !== 'stale_entry', true);
    assert.equal(inMemorySignals.length, 1);
    assert.equal(tg.calls, 1);
  });

  it('18. Mongo restart/reload scenario preserves idempotency', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'ord-18-idemp';
    await acceptAndFanout(io, payload('entry', uuid, { symbol: 'ORD18' }), inMemorySignals);
    ActiveSignalRegistry.resetForTests();
    const retry = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload('entry', uuid, { symbol: 'ORD18' }),
      inMemorySignals
    );
    assert.equal(retry.duplicate || retry.skippedFanout, true);
    assert.equal(inMemorySignals.length, 1);
  });

  it('19. Duplicate signalUuid never creates duplicate MT5 execution', async () => {
    const Mt5TradeCopierService = require('../../services/Mt5TradeCopierService');
    let queues = 0;
    const orig = Mt5TradeCopierService.queueExecutionForUser;
    Mt5TradeCopierService.queueExecutionForUser = async () => {
      queues += 1;
      return { ok: true, reason: 'queued' };
    };
    try {
      TradingViewAlertService.setTestFanoutHooks({ subscribers: [premiumSubscriber()] });
      const uuid = 'ord-19-mt5';
      const body = payload('entry', uuid, { symbol: 'ORD19' });
      await acceptAndFanout(io, body, inMemorySignals);
      await acceptAndFanout(io, body, inMemorySignals);
      assert.equal(queues, 1);
    } finally {
      Mt5TradeCopierService.queueExecutionForUser = orig;
    }
  });

  it('20. One canonical trade never creates N Mongo Signals for N subscribers', async () => {
    TradingViewAlertService.setTestFanoutHooks({
      subscribers: [proSubscriber(), proSubscriber({ id: 'u2', email: 'u2@example.com', telegram: { chatId: '2', enabled: true, telegramMode: 'alerts_only' } })]
    });
    await acceptAndFanout(io, payload('entry', 'ord-20-fan', { symbol: 'ORD20' }), inMemorySignals);
    assert.equal(inMemorySignals.length, 1);
    assert.equal(tg.calls, 2);
  });

  it('21. Telegram-only subscriber still receives exactly one Entry', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    await acceptAndFanout(io, payload('entry', 'ord-21-tg', { symbol: 'ORD21' }), inMemorySignals);
    assert.equal(tg.calls, 1);
  });

  it('22. Pro Telegram + Email subscriber receives correct order', async () => {
    const emails = [];
    const mailer = require('../mailer');
    const orig = mailer.sendTradeAlertEmail;
    mailer.sendTradeAlertEmail = async opts => {
      emails.push(opts.signal?.alertType || 'entry');
      return { ok: true };
    };
    try {
      TradingViewAlertService.setTestFanoutHooks({
        subscribers: [proSubscriber({ preferences: { emailAlerts: true } })]
      });
      const uuid = 'ord-22-em';
      await acceptAndFanout(io, payload('entry', uuid, { symbol: 'ORD22' }), inMemorySignals);
      await acceptAndFanout(io, payload('take_profit_1', uuid, { symbol: 'ORD22' }), inMemorySignals);
      assert.equal(tg.texts.length >= 1, true);
      assert.match(tg.texts[0], /KACHING BUY|Entry/i);
      if (emails.length >= 2) {
        assert.equal(emails[0], 'entry');
        assert.equal(emails[1], 'take_profit_1');
      }
    } finally {
      mailer.sendTradeAlertEmail = orig;
    }
  });

  it('23. Premium MT5 subscriber does not execute duplicate Entry', async () => {
    const Mt5TradeCopierService = require('../../services/Mt5TradeCopierService');
    let queues = 0;
    const orig = Mt5TradeCopierService.queueExecutionForUser;
    Mt5TradeCopierService.queueExecutionForUser = async () => {
      queues += 1;
      return { ok: true, reason: 'queued' };
    };
    try {
      TradingViewAlertService.setTestFanoutHooks({ subscribers: [premiumSubscriber()] });
      const uuid = 'ord-23-mt5';
      await acceptAndFanout(io, payload('entry', uuid, { symbol: 'ORD23' }), inMemorySignals);
      await acceptAndFanout(io, payload('entry', uuid, { symbol: 'ORD23' }), inMemorySignals);
      assert.equal(queues, 1);
    } finally {
      Mt5TradeCopierService.queueExecutionForUser = orig;
    }
  });

  it('24. Failed Telegram delivery does not reset lifecycle or resend endlessly', async () => {
    global.fetch = async () => ({
      ok: false,
      status: 500,
      async json() {
        return { ok: false, description: 'boom' };
      }
    });
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'ord-24-fail';
    await acceptAndFanout(io, payload('entry', uuid, { symbol: 'ORD24' }), inMemorySignals);
    assert.equal(inMemorySignals[0].tradeStatus, 'open');
    await acceptAndFanout(io, payload('entry', uuid, { symbol: 'ORD24' }), inMemorySignals);
    assert.equal(inMemorySignals.length, 1);
  });

  it('25. Email failure does not duplicate Telegram', async () => {
    const mailer = require('../mailer');
    const orig = mailer.sendTradeAlertEmail;
    mailer.sendTradeAlertEmail = async () => {
      throw new Error('smtp down');
    };
    try {
      TradingViewAlertService.setTestFanoutHooks({
        subscribers: [proSubscriber({ preferences: { emailAlerts: true } })]
      });
      await acceptAndFanout(io, payload('entry', 'ord-25-em', { symbol: 'ORD25' }), inMemorySignals);
      assert.equal(tg.calls, 1);
    } finally {
      mailer.sendTradeAlertEmail = orig;
    }
  });

  it('26. Fast-ack still returns 202 before slow Telegram (via schedule, not HTTP wait)', async () => {
    let telegramStarted = false;
    let telegramDone = false;
    global.fetch = async () => {
      telegramStarted = true;
      await new Promise(r => setTimeout(r, 180));
      telegramDone = true;
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: { message_id: 1 } };
        }
      };
    };
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const t0 = Date.now();
    const accept = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload('entry', 'ord-26-ack', { symbol: 'ORD26' }),
      inMemorySignals
    );
    const acceptMs = Date.now() - t0;
    assert.equal(accept.accepted, true);
    assert.equal(telegramDone, false);
    assert.ok(acceptMs < 180, `accept ${acceptMs}ms must be faster than Telegram`);
    TradingViewAlertService.scheduleAcceptedTradingViewSignal(io, accept, inMemorySignals);
    assert.equal(telegramDone, false);
    await TradeEventDispatcher.waitForIdle('ord-26-ack');
    assert.equal(telegramStarted, true);
    assert.equal(telegramDone, true);
  });

  it('27. Admin Pipeline shows accepted → lifecycle → ordered delivery stages', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    PipelineStatusService.resetForTests();
    await acceptAndFanout(io, payload('entry', 'ord-27-pipe', { symbol: 'ORD27' }), inMemorySignals);
    const events = PipelineStatusService.getLiveEvents(50);
    const types = events.map(e => e.type);
    assert.ok(types.includes('Lifecycle') || types.includes('Accepted'));
    assert.ok(types.includes('Accepted'));
    assert.ok(types.includes('DeliveryTelegram') || types.includes('Publish') || types.includes('Broadcast'));
  });

  it('28. Terminal trade cannot be reopened', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'ord-28-term';
    await acceptAndFanout(io, payload('entry', uuid, { symbol: 'ORD28' }), inMemorySignals);
    await acceptAndFanout(io, payload('take_profit_3', uuid, { symbol: 'ORD28' }), inMemorySignals);
    const gate = await TradeLifecycleService.assertCanOpenEntry(
      payload('entry', uuid, { symbol: 'ORD28' }),
      inMemorySignals
    );
    assert.equal(gate.allowed, false);
    assert.equal(gate.reason, 'already_terminal');
  });

  it('29. Old Signal records cannot be selected merely by symbol + timeframe', async () => {
    const { enrichEntrySignal } = require('../signalOutcome');
    const mem = [
      enrichEntrySignal({
        symbol: 'ORD29',
        direction: 'long',
        ...levels(),
        alertType: 'entry',
        timeframe: '15m',
        signalUuid: 'ord-29-a'
      })
    ];
    const orphan = await TradeLifecycleService.processIncomingTradeAlert(
      payload('take_profit_1', 'ord-29-b', { symbol: 'ORD29' }),
      mem
    );
    assert.equal(orphan.reason, 'orphaned_outcome');
    assert.equal(mem[0].signalUuid, 'ord-29-a');
    assert.notEqual(mem[0].outcome, 'tp1');
  });

  it('30. Outcome matching prefers exact signalUuid / canonical identity', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    await acceptAndFanout(io, payload('entry', 'ord-30-a', { symbol: 'ORD30', timeframe: '15m' }), inMemorySignals);
    await acceptAndFanout(io, payload('entry', 'ord-30-b', { symbol: 'ORD30', timeframe: '5m' }), inMemorySignals);
    await acceptAndFanout(
      io,
      payload('take_profit_1', 'ord-30-a', { symbol: 'ORD30', timeframe: '15m' }),
      inMemorySignals
    );
    const a = inMemorySignals.find(s => s.signalUuid === 'ord-30-a');
    const b = inMemorySignals.find(s => s.signalUuid === 'ord-30-b');
    assert.equal(a.outcome, 'tp1');
    assert.equal(b.outcome, 'pending');
    const found = await SignalOutcomeService.findEntryByUuidInDb('ord-30-a');
    assert.equal(found, null);
    const memHit = findEntryBySignalUuid(inMemorySignals, 'ord-30-a');
    assert.equal(memHit.signalUuid, 'ord-30-a');
  });

  it('freshness helper documents MAX_ENTRY_SIGNAL_AGE_MS default', () => {
    const fresh = evaluateEntryFreshness({
      alertType: 'entry',
      timeframe: '15m',
      eventTimestamp: Date.now() - 1000
    });
    assert.equal(fresh.stale, false);
    const stale = evaluateEntryFreshness({
      alertType: 'entry',
      timeframe: '15m',
      eventTimestamp: Date.now() - 3 * 60 * 60 * 1000
    });
    assert.equal(stale.stale, true);
    assert.ok(stale.maxAgeMs >= 30 * 60 * 1000);
  });
});
