'use strict';

/**
 * Persist/idempotency + canonical analytics (slice 1 + 2).
 * Never hits production Telegram / Fly / Redis / Mongo.
 */

process.env.REDIS_ENABLED = process.env.REDIS_ENABLED || 'false';
process.env.LEARNING_OUTCOME_DEBOUNCE_MS = process.env.LEARNING_OUTCOME_DEBOUNCE_MS || '1';
process.env.LEARNING_RETRAIN_INTERVAL_MS = process.env.LEARNING_RETRAIN_INTERVAL_MS || '0';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { generateLicenseToken } = require('../../utils/webhookSecurity');
const TradingViewAlertService = require('../TradingViewAlertService');
const PipelineStatusService = require('../PipelineStatusService');
const TradeEventDispatcher = require('../../utils/tradeEventDispatcher');
const TradeEventStore = require('../../utils/tradeEventStore');
const DurableDelivery = require('../../utils/durableDelivery');
const deliveryIdempotency = require('../../utils/deliveryIdempotency');
const { buildAnalytics, openEntryMongoFilter, isOpenTradeStatus } = require('../../utils/signalOutcome');
const { loadCanonicalAnalytics } = require('../../routes/analytics');
const ActiveSignalRegistry = require('../../utils/activeSignalRegistry');

const USER_A = 'persist-user-a';
const TV_USER = 'persisttrader';

function pine13(alertType, uuid, overrides = {}) {
  const eventType = {
    entry: 'ENTRY',
    take_profit_1: 'TP1',
    take_profit_2: 'TP2',
    take_profit_3: 'TP3',
    stop_loss: 'SL'
  }[alertType] || 'ENTRY';
  const seq = { ENTRY: 0, TP1: 1, TP2: 2, TP3: 3, SL: 3 }[eventType];
  return {
    symbol: overrides.symbol || 'XAUUSD',
    strategyName: 'Liquidity Sweep + Fair Value Gap (Scalping)',
    timeframe: '15m',
    pattern: 'liquidity_sweep_fvg_scalp',
    alertType,
    direction: 'long',
    entry: 2400,
    stop_loss: 2390,
    stop_loss_1: 2390,
    take_profit_1: 2410,
    take_profit_2: 2420,
    take_profit_3: 2430,
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
    pineClientVersion: '1.3.0',
    eventId: `XAUUSD|15m|${uuid}|${eventType}`,
    eventType,
    eventSequence: seq,
    barTime: Date.now(),
    ...overrides,
    signalUuid: uuid,
    signalId: uuid
  };
}

const originalNodeEnv = process.env.NODE_ENV;
const originalSigning = process.env.WEBHOOK_SIGNING_SECRET;

describe('persist accept + canonical analytics', () => {
  let mem;
  let io;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.WEBHOOK_SIGNING_SECRET = process.env.WEBHOOK_SIGNING_SECRET || 'test-signing-secret';
    mem = [];
    io = { emit() {}, to() { return { emit() {} }; } };
    PipelineStatusService.resetForTests();
    TradingViewAlertService.resetTestFanoutHooks();
    TradeEventDispatcher.resetForTests();
    deliveryIdempotency.resetForTests();
    DurableDelivery.resetForTests();
    TradeEventStore.resetForTests();
    ActiveSignalRegistry.resetForTests();
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [] });
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalSigning == null) delete process.env.WEBHOOK_SIGNING_SECRET;
    else process.env.WEBHOOK_SIGNING_SECRET = originalSigning;
    TradingViewAlertService.resetTestFanoutHooks();
    TradeEventStore.resetForTests();
    DurableDelivery.resetForTests();
  });

  it('1. ENTRY persists a Signal document', async () => {
    const uuid = 'persist-entry-1';
    const accept = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      pine13('entry', uuid),
      mem
    );
    assert.equal(accept.accepted, true);
    assert.equal(accept.persisted, true);
    assert.equal(accept.pendingOutcome, false);
    assert.equal(mem.length, 1);
    assert.equal(mem[0].signalUuid, uuid);
    assert.equal(mem[0].alertType, 'entry');
    assert.ok(mem[0]._id);
    const jobs = await DurableDelivery.listJobs();
    assert.ok(jobs.some(j => j.channel === '_fanout' && j.signalUuid === uuid));
  });

  it('2. ENTRY persist fail does not permanently poison claim; retry persists', async () => {
    const uuid = 'persist-fail-retry';
    const eventId = `XAUUSD|15m|${uuid}|ENTRY`;
    TradingViewAlertService.setTestFanoutHooks({
      persistError: new Error('mongo persist failed'),
      subscribers: []
    });
    await assert.rejects(
      () => TradingViewAlertService.acceptTradingViewWebhook(io, pine13('entry', uuid), mem),
      /mongo persist failed/
    );
    assert.equal(mem.length, 0);
    assert.equal(await TradeEventStore.hasEventId(eventId), false);

    TradingViewAlertService.resetTestFanoutHooks();
    TradingViewAlertService.setTestFanoutHooks({ subscribers: [] });
    const retry = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      pine13('entry', uuid),
      mem
    );
    assert.equal(retry.accepted, true);
    assert.equal(retry.persisted, true);
    assert.equal(retry.duplicate, false);
    assert.equal(mem.length, 1);
    assert.equal(mem[0].signalUuid, uuid);
  });

  it('3. TP3 with ENTRY updates the same Signal uuid', async () => {
    const uuid = 'persist-same-doc';
    await TradingViewAlertService.acceptTradingViewWebhook(io, pine13('entry', uuid), mem);
    const tp3 = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      pine13('take_profit_3', uuid),
      mem
    );
    assert.equal(tp3.accepted, true);
    assert.equal(tp3.persisted, true);
    assert.equal(tp3.pendingOutcome, false);
    const entries = mem.filter(s => String(s.signalUuid) === uuid);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].outcome, 'tp3');
    assert.equal(entries[0].tradeStatus, 'won');
  });

  it('4. TP3 without ENTRY cannot masquerade as persisted', async () => {
    const uuid = 'persist-orphan-tp3';
    const accept = await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      pine13('take_profit_3', uuid),
      mem
    );
    assert.equal(accept.accepted, true);
    assert.equal(accept.pendingOutcome, true);
    assert.equal(accept.persisted, false);
    assert.equal(accept.reason, 'orphaned_outcome');
    assert.equal(mem.length, 0);
    const orphans = await TradeEventStore.peekOrphans(uuid);
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].alertType, 'take_profit_3');
  });

  it('5. TP3 without ENTRY cannot create synthetic subscriber fanout', async () => {
    const uuid = 'persist-no-synth-fanout';
    await TradingViewAlertService.acceptTradingViewWebhook(
      io,
      pine13('take_profit_3', uuid),
      mem
    );
    const jobs = await DurableDelivery.listJobs();
    assert.equal(
      jobs.filter(j => String(j.signalUuid) === uuid || String(j.canonicalTradeId) === uuid).length,
      0
    );
    const synthetic = await DurableDelivery.ensureFanoutWork({
      accepted: true,
      signalUuid: uuid,
      saved: { signalUuid: uuid, alertType: 'take_profit_3' },
      signalData: pine13('take_profit_3', uuid)
    });
    assert.equal(synthetic, null);
  });

  it('6. persisted ENTRY appears in canonical analytics', async () => {
    const uuid = 'persist-analytics-6';
    await TradingViewAlertService.acceptTradingViewWebhook(io, pine13('entry', uuid), mem);
    const analytics = buildAnalytics(mem);
    assert.equal(analytics.totalEntries, 1);
    assert.equal(analytics.openTrades, 1);
    assert.equal(analytics.closedTrades, 0);
  });

  it('7/8. loadCanonicalAnalytics is the single summary builder (performance alias uses it)', () => {
    assert.equal(typeof loadCanonicalAnalytics, 'function');
    const src = require('fs').readFileSync(require.resolve('../../server.js'), 'utf8');
    assert.match(src, /loadCanonicalAnalytics/);
    assert.doesNotMatch(src, /app\.get\('\/api\/performance\/summary'[\s\S]*buildAnalytics\(filtered\)/);
  });

  it('9. Admin Overview open-trade filter keeps TP1/TP2 partials open', () => {
    const filter = openEntryMongoFilter();
    assert.deepEqual(filter.alertType, { $in: ['entry', 'signal'] });
    const outcomeOr = filter.$and.find(c => c.$or && c.$or.some(o => o.outcome && o.outcome.$in));
    assert.ok(outcomeOr.$or.some(o => Array.isArray(o.outcome?.$in) && o.outcome.$in.includes('tp1')));
    assert.ok(outcomeOr.$or.some(o => Array.isArray(o.outcome?.$in) && o.outcome.$in.includes('tp2')));
    assert.equal(isOpenTradeStatus('partial'), true);
    assert.equal(isOpenTradeStatus('won'), false);
  });

  it('10. Partial TP1/TP2 is not classified as closed by buildAnalytics', async () => {
    const uuid = 'persist-partial-10';
    await TradingViewAlertService.acceptTradingViewWebhook(io, pine13('entry', uuid), mem);
    await TradingViewAlertService.acceptTradingViewWebhook(io, pine13('take_profit_1', uuid), mem);
    const analytics = buildAnalytics(mem);
    assert.equal(analytics.openTrades, 1);
    assert.equal(analytics.closedTrades, 0);
    assert.equal(mem[0].tradeStatus, 'partial');
    assert.equal(mem[0].outcome, 'tp1');
  });

  it('11. Insights summary payload already includes timeseries (no second fetch needed)', async () => {
    const uuid = 'persist-ts-11';
    await TradingViewAlertService.acceptTradingViewWebhook(io, pine13('entry', uuid), mem);
    const analytics = await loadCanonicalAnalytics({
      user: { subscription: { tier: 'premium', status: 'active' } },
      inMemorySignals: mem,
      isDbReady: () => false
    });
    assert.ok(Array.isArray(analytics.timeseries));
    assert.ok(Array.isArray(analytics.equityCurve));
    assert.ok(Array.isArray(analytics.byStrategy));
    assert.equal(analytics.totalEntries, 1);
  });
});
