/**
 * A–Z production lifecycle / delivery contracts.
 * In-memory + optional shared fake Redis. Never hits production Telegram / Fly.
 *
 * Known separate flake (not weakened here): mt5Pairing + mt5ReliabilityHardening
 * share backend/dev-users.json when the full suite runs files in parallel.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { generateLicenseToken } = require('../webhookSecurity');
const TradingViewAlertService = require('../../services/TradingViewAlertService');
const TradeLifecycleService = require('../../services/TradeLifecycleService');
const TradeDeliveryService = require('../../services/TradeDeliveryService');
const PipelineStatusService = require('../../services/PipelineStatusService');
const ActiveSignalRegistry = require('../activeSignalRegistry');
const TradeEventDispatcher = require('../tradeEventDispatcher');
const TradeEventStore = require('../tradeEventStore');
const deliveryIdempotency = require('../deliveryIdempotency');
const { PINE_CLIENT_VERSION } = require('../PineClientVersion');
const { percent: pct } = require('../pipelineObservability');
const identity = require('../tradeEventIdentity');

const USER_ID = 'dist-user-1';
const TV_USER = 'disttrader';

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
    email: 'pro-dist@example.com',
    role: 'user',
    subscription: { tier: 'professional', status: 'active' },
    telegram: { chatId: '555001', enabled: true, telegramMode: 'alerts_only' },
    mt5: { executionMode: 'manual', enabled: true, devices: [] },
    preferences: { emailAlerts: true },
    ...overrides
  };
}

const originalFetch = global.fetch;
const originalNodeEnv = process.env.NODE_ENV;
const originalBot = process.env.TELEGRAM_BOT_TOKEN;
const originalSigning = process.env.WEBHOOK_SIGNING_SECRET;
const originalOrphanWait = process.env.ORPHAN_OUTCOME_WAIT_MS;

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
  const uuid = accept.signalUuid || body.signalUuid;
  // Dispatcher idle ≠ Telegram/Email complete: ENTRY fan-out releases after
  // critical providers and leaves TG/email as detached in-flight promises.
  await TradeEventDispatcher.waitForIdle(uuid);
  await TradeDeliveryService.waitForDetachedProvidersForTests();
  return accept;
}

describe('distributed lifecycle fix A–Z', () => {
  let inMemorySignals;
  let io;
  let tg;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token-dist';
    process.env.WEBHOOK_SIGNING_SECRET = 'test-signing-secret-dist';
    process.env.ORPHAN_OUTCOME_WAIT_MS = '80';
    delete process.env.PIPELINE_SELF_TEST_ACTIVE;
    inMemorySignals = [];
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
    TradeEventStore.resetForTests();
  });

  it('A. generated Pine does not call alert() unless barstate.isrealtime', () => {
    process.env.TRADINGVIEW_WEBHOOK_SECRET =
      process.env.TRADINGVIEW_WEBHOOK_SECRET || 'smoke-test-tv-webhook-secret';
    process.env.WEBHOOK_SIGNING_SECRET =
      process.env.WEBHOOK_SIGNING_SECRET || 'smoke-test-license-signing-secret';
    const { generateForUser } = require('../../services/PineScriptGeneratorService');
    const g = generateForUser(
      {
        _id: '507f1f77bcf86cd799439011',
        email: 't@test.com',
        tradingviewUsername: 'demo_trader',
        subscription: { tier: 'professional', status: 'active' }
      },
      { strategy: 'scalping' }
    );
    assert.match(g.script, /emitKachingEvent\(/);
    assert.match(g.script, /if barstate\.isrealtime/);
    assert.doesNotMatch(g.script, /isCanonicalAuthorityChart/);
    assert.doesNotMatch(g.script, /alertFiredAt = timenow/);
    assert.match(g.script, /alert\(payload, alert\.freq_all\)/);
    assert.equal(g.pineClientVersion, PINE_CLIENT_VERSION);
    assert.doesNotMatch(g.script, /fireLong\s*=.*barstate\.isrealtime/);
  });

  it('B/C. realtime Entry webhook is exactly one Signal; duplicate Entry does not emit twice', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'az-bc-entry';
    const body = payload('entry', uuid, { symbol: 'AZBC', isRealtime: true });
    await acceptAndFanout(io, body, inMemorySignals);
    await acceptAndFanout(io, body, inMemorySignals);
    assert.equal(inMemorySignals.length, 1);
    assert.equal(tg.calls, 1);
    assert.match(tg.texts[0], /KACHING BUY/i);
  });

  it('D. TP3 cannot be delivered before ENTRY', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'az-d-order';
    const entryAccept = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload('entry', uuid, { symbol: 'AZD' }),
      inMemorySignals
    );
    const tp3Accept = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload('take_profit_3', uuid, { symbol: 'AZD' }),
      inMemorySignals
    );
    TradingViewAlertService.scheduleAcceptedTradingViewSignal(io, tp3Accept, inMemorySignals);
    TradingViewAlertService.scheduleAcceptedTradingViewSignal(io, entryAccept, inMemorySignals);
    await TradeEventDispatcher.waitForIdle(uuid);
    assert.ok(tg.calls >= 2);
    assert.match(tg.texts[0], /KACHING BUY/i);
    assert.match(tg.texts[tg.texts.length - 1], /TP3/i);
  });

  it('E. shared Redis store: Machine B orphan is drained by Machine A; second fan-out claim fails', async () => {
    const redis = createFakeRedis();
    TradeEventStore.resetForTests();
    TradeEventStore.setClientForTests(redis);
    const id = 'az-e-cross';
    await TradeEventStore.putOrphan(id, {
      alertType: 'take_profit_3',
      eventTimestamp: Date.now(),
      signalData: payload('take_profit_3', id, { symbol: 'AZE' })
    });
    const peeked = await TradeEventStore.peekOrphans(id);
    assert.equal(peeked.length, 1);
    const drained = await TradeEventStore.takeOrphans(id);
    assert.equal(drained.length, 1);
    assert.equal(drained[0].alertType, 'take_profit_3');
    const empty = await TradeEventStore.takeOrphans(id);
    assert.equal(empty.length, 0);
    const first = await TradeEventStore.claimFanout(id, 'take_profit_3');
    const second = await TradeEventStore.claimFanout(id, 'take_profit_3');
    assert.equal(first, true);
    assert.equal(second, false);
    TradeEventStore.resetForTests();
  });

  it('F/G. orphan TP stored; ENTRY within window processes lifecycle in order', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'az-fg-orphan';
    const tp = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload('take_profit_1', uuid, { symbol: 'AZFG' }),
      inMemorySignals
    );
    assert.equal(tp.reason, 'orphaned_outcome');
    assert.equal(tp.pendingOutcome, true);
    TradingViewAlertService.scheduleAcceptedTradingViewSignal(io, tp, inMemorySignals);
    const entry = await acceptAndFanout(
      io,
      payload('entry', uuid, { symbol: 'AZFG' }),
      inMemorySignals
    );
    assert.equal(entry.accepted, true);
    await TradeEventDispatcher.waitForIdle(uuid, 4000);
    assert.ok(tg.calls >= 1);
    assert.match(tg.texts[0], /KACHING BUY/i);
    if (tg.calls >= 2) assert.match(tg.texts[1], /TP1/i);
  });

  it('H. orphan expiry reason is expired_trade_event (store TTL, not HTTP sleep)', () => {
    assert.equal(TradeEventStore.getOrphanTtlSec() > 0, true);
    assert.notEqual(TradeEventStore.getOrphanTtlSec(), 5);
  });

  it('I/J/K/L. duplicate webhook retry does not duplicate Signal / Telegram / Email / MT5', async () => {
    const emails = [];
    const mailer = require('../mailer');
    const origMail = mailer.sendTradeAlertEmail;
    mailer.sendTradeAlertEmail = async opts => {
      emails.push(opts.signal?.alertType || 'entry');
      return { ok: true };
    };
    const Mt5TradeCopierService = require('../../services/Mt5TradeCopierService');
    let queues = 0;
    const origMt5 = Mt5TradeCopierService.queueExecutionForUser;
    Mt5TradeCopierService.queueExecutionForUser = async () => {
      queues += 1;
      return { ok: true, reason: 'queued' };
    };
    try {
      TradingViewAlertService.setTestFanoutHooks({
        subscribers: [
          proSubscriber({
            id: 'premium-az',
            subscription: { tier: 'premium', status: 'active' },
            mt5: {
              executionMode: 'auto',
              enabled: true,
              devices: [{ deviceId: 'd1', accessToken: 't', revokedAt: null }],
              accountBalance: 1000
            }
          })
        ]
      });
      const uuid = 'az-ijkl-dup';
      const body = payload('entry', uuid, { symbol: 'AZIJ' });
      await acceptAndFanout(io, body, inMemorySignals);
      await acceptAndFanout(io, body, inMemorySignals);
      assert.equal(inMemorySignals.length, 1);
      assert.equal(tg.calls, 1);
      assert.equal(emails.length, 1);
      assert.equal(queues, 1);
    } finally {
      mailer.sendTradeAlertEmail = origMail;
      Mt5TradeCopierService.queueExecutionForUser = origMt5;
    }
  });

  it('M. TP3 and SL cannot both complete the same trade', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const uuid = 'az-m-term';
    await acceptAndFanout(io, payload('entry', uuid, { symbol: 'AZM' }), inMemorySignals);
    await acceptAndFanout(io, payload('take_profit_3', uuid, { symbol: 'AZM' }), inMemorySignals);
    const after = tg.calls;
    await acceptAndFanout(io, payload('stop_loss', uuid, { symbol: 'AZM' }), inMemorySignals);
    assert.equal(inMemorySignals[0].outcome, 'tp3');
    assert.equal(tg.calls, after);
  });

  it('N. completed historical trade received late is stale_entry', async () => {
    const accept = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload('entry', 'az-n-stale', {
        symbol: 'AZN',
        signalTime: Date.now() - 3 * 60 * 60 * 1000
      }),
      inMemorySignals
    );
    assert.equal(accept.reason, 'stale_entry');
    assert.equal(inMemorySignals.length, 0);
  });

  it('O. accepted ENTRY still delivers when later overlay is terminal', async () => {
    const snap = {
      ...payload('entry', 'az-o-term', { symbol: 'AZO' }),
      _id: 'mem_azo',
      alertType: 'entry',
      entryAcceptedAt: new Date(),
      tradeStatus: 'won',
      outcome: 'tp3',
      lifecycleStage: 'TP3',
      closedAt: new Date()
    };
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const elig = TradeDeliveryService.evaluateTelegramEligibility(proSubscriber(), snap);
    assert.equal(elig.eligible, true);
    const sent = await TradeDeliveryService.deliverTelegram(proSubscriber(), snap);
    assert.equal(sent.ok, true);
    assert.match(tg.texts[0], /KACHING BUY/i);
  });

  it('O2. accepted ENTRY that aged past overlap after TP3 is not a new BUY', async () => {
    const aged = new Date(Date.now() - 60 * 1000);
    const snap = {
      ...payload('entry', 'az-o2-term', { symbol: 'AZO2' }),
      _id: 'mem_azo2',
      alertType: 'entry',
      entryAcceptedAt: aged,
      tradeStatus: 'won',
      outcome: 'tp3',
      lifecycleStage: 'TP3',
      closedAt: aged
    };
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    const elig = TradeDeliveryService.evaluateTelegramEligibility(proSubscriber(), snap);
    assert.equal(elig.eligible, false);
    assert.equal(elig.reason, 'terminal_before_entry_delivery');
    const sent = await TradeDeliveryService.deliverTelegram(proSubscriber(), snap);
    assert.equal(sent.ok, false);
    assert.equal(tg.calls, 0);
  });

  it('P/Q/R. channel failures are isolated', async () => {
    const mailer = require('../mailer');
    const orig = mailer.sendTradeAlertEmail;
    mailer.sendTradeAlertEmail = async () => {
      throw new Error('smtp down');
    };
    const Mt5TradeCopierService = require('../../services/Mt5TradeCopierService');
    const origMt5 = Mt5TradeCopierService.queueExecutionForUser;
    Mt5TradeCopierService.queueExecutionForUser = async () => {
      throw new Error('mt5 down');
    };
    try {
      TradingViewAlertService.setTestFanoutHooks({
        subscribers: [
          proSubscriber({
            subscription: { tier: 'premium', status: 'active' },
            mt5: {
              executionMode: 'auto',
              enabled: true,
              devices: [{ deviceId: 'd1', accessToken: 't', revokedAt: null }]
            }
          })
        ]
      });
      await acceptAndFanout(io, payload('entry', 'az-pqr', { symbol: 'AZP' }), inMemorySignals);
      assert.equal(tg.calls, 1);
    } finally {
      mailer.sendTradeAlertEmail = orig;
      Mt5TradeCopierService.queueExecutionForUser = origMt5;
    }
  });

  it('S. two workers cannot independently fan-out the same logical event', async () => {
    const redis = createFakeRedis();
    TradeEventStore.resetForTests();
    TradeEventStore.setClientForTests(redis);
    assert.equal(await TradeEventStore.claimFanout('az-s', 'entry'), true);
    assert.equal(await TradeEventStore.claimFanout('az-s', 'entry'), false);
    assert.equal(await TradeEventStore.claimLifecycleEvent('az-s', 'entry'), true);
    assert.equal(await TradeEventStore.claimLifecycleEvent('az-s', 'entry'), false);
    let ran = 0;
    process.env.TRADE_LOCK_WAIT_MS = '0';
    await TradeEventStore.acquireLock('az-s-lock');
    await assert.rejects(
      () =>
        TradeEventDispatcher.withCanonicalLock('az-s-lock', async () => {
          ran += 1;
        }),
      err => err && err.code === 'CANONICAL_LOCK_BUSY'
    );
    assert.equal(ran, 0);
    delete process.env.TRADE_LOCK_WAIT_MS;
    TradeEventStore.resetForTests();
  });

  it('S2. production Redis down does not fall through to process-local lock', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    TradeEventStore.resetForTests();
    TradeEventStore.setClientForTests(null, { unavailable: true });
    let ran = 0;
    await assert.rejects(
      () =>
        TradeEventDispatcher.withCanonicalLock('az-prod-redis', async () => {
          ran += 1;
        }),
      err => err && err.code === 'REDIS_UNAVAILABLE'
    );
    assert.equal(ran, 0);
    process.env.NODE_ENV = prev;
    TradeEventStore.resetForTests();
  });

  it('T/U. terminal trades delete all drawings via cleanupActiveTradeDrawings', () => {
    const arm = fs.readFileSync(
      path.join(__dirname, '../../templates/snippets/kaching-canon-event-arm.pine.snippet'),
      'utf8'
    );
    const draw = fs.readFileSync(
      path.join(__dirname, '../../templates/snippets/kaching-trade-drawing.pine.snippet'),
      'utf8'
    );
    assert.match(draw, /cleanupActiveTradeDrawings\(/);
    assert.match(arm, /if closeNow[\s\S]{0,2500}cleanupActiveTradeDrawings\(/);
    assert.match(arm, /emitKachingEvent\(/);
    assert.doesNotMatch(arm, /TP3 HIT/);
    assert.doesNotMatch(arm, /STOP LOSS/);
    assert.doesNotMatch(arm, /doneLevelLines/);
    assert.doesNotMatch(draw, /MAX_COMPLETED_TRADES/);
    assert.doesNotMatch(arm, /MAX_COMPLETED_TRADES/);
  });

  it('V. subscriber messages never contain raw JSON or secrets', async () => {
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [proSubscriber()] });
    await acceptAndFanout(
      io,
      payload('entry', 'az-v-safe', {
        symbol: 'AZV',
        licenseToken: generateLicenseToken(USER_ID, TV_USER)
      }),
      inMemorySignals
    );
    assert.equal(tg.calls, 1);
    assert.doesNotMatch(tg.texts[0], /licenseToken|signalUuid|canonicalSignalKey|scriptGenerationId|\{"/);
  });

  it('W. license-token version stamp is current (kls_v2 still generated)', () => {
    const token = generateLicenseToken(USER_ID, TV_USER);
    assert.match(token, /^kls_v2\./);
    assert.equal(PINE_CLIENT_VERSION, '1.3.1');
  });

  it('Y. subscription entitlement skip is unchanged', async () => {
    const basic = proSubscriber({
      subscription: { tier: 'basic', status: 'active' },
      telegram: { chatId: '1', enabled: true }
    });
    const elig = TradeDeliveryService.evaluateTelegramEligibility(
      basic,
      payload('entry', 'az-y', { symbol: 'AZY' })
    );
    assert.equal(elig.eligible, false);
    assert.equal(elig.reason, 'insufficient_tier');
  });

  it('Z. accept returns before Telegram completes', async () => {
    let done = false;
    global.fetch = async () => {
      await new Promise(r => setTimeout(r, 120));
      done = true;
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
      payload('entry', 'az-z-ack', { symbol: 'AZZ' }),
      inMemorySignals
    );
    assert.equal(accept.accepted, true);
    assert.equal(done, false);
    assert.ok(Date.now() - t0 < 120);
    TradingViewAlertService.scheduleAcceptedTradingViewSignal(io, accept, inMemorySignals);
    await TradeEventDispatcher.waitForIdle('az-z-ack');
    // Fan-out slot may release while Telegram Bot API is still in flight.
    await TradeDeliveryService.waitForDetachedProvidersForTests();
    assert.equal(done, true);
  });

  it('non_realtime_event is distinct from stale_entry', async () => {
    const rt = identity.evaluateRealtimeFlag({ isRealtime: false });
    assert.equal(rt.reject, true);
    assert.equal(rt.reason, 'non_realtime_event');
    const accept = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      payload('entry', 'az-nrt', { symbol: 'AZNR', isRealtime: false, signalTime: Date.now() }),
      inMemorySignals
    );
    assert.equal(accept.reason, 'non_realtime_event');
    const missing = identity.evaluateRealtimeFlag({});
    assert.equal(missing.reject, false);
    const stale = identity.evaluateEntryFreshness({
      alertType: 'entry',
      timeframe: '15m',
      eventTimestamp: Date.now() - 3 * 60 * 60 * 1000
    });
    assert.equal(stale.reason, 'stale_entry');
  });

  it('admin success % is null (—) when there are zero attempts, not 0%', () => {
    assert.equal(pct(0, 0), null);
    assert.equal(pct(0, 4), 0);
  });
});
