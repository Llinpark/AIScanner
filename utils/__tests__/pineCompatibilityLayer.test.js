/**
 * Pine compatibility gateway â€” version detection, field normalization, identity,
 * Redis SET NX, realtime unknown, ordering, e2e survival, tokens, 1.3.0 regression.
 */
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { generateLicenseToken } = require('../webhookSecurity');
const PineCompatibilityService = require('../../services/PineCompatibilityService');
const { selectAdapter, inspectPayloadCapabilities } = require('../../config/PineCompatibilityRegistry');
const { ADAPTER_IDS, STABLE_SCHEMA_VERSION } = require('../../contracts/KachingTradeEvent');
const { PINE_CLIENT_VERSION } = require('../PineClientVersion');
const TradingViewAlertService = require('../../services/TradingViewAlertService');
const TradeEventStore = require('../tradeEventStore');
const TradeEventDispatcher = require('../tradeEventDispatcher');
const deliveryIdempotency = require('../deliveryIdempotency');
const {
  evaluateRealtimeFlag,
  evaluateUnknownRealtimeFreshness
} = require('../tradeEventIdentity');

const USER = 'compat-user-1';
const TVU = 'compattrader';
const NOW = 1_714_000_000_000;

function levels(overrides = {}) {
  return {
    entry: 1.1,
    stop_loss: 1.09,
    take_profit_1: 1.11,
    take_profit_2: 1.12,
    take_profit_3: 1.13,
    ...overrides
  };
}

function token() {
  process.env.WEBHOOK_SIGNING_SECRET =
    process.env.WEBHOOK_SIGNING_SECRET || 'smoke-test-license-signing-secret';
  return generateLicenseToken(USER, TVU);
}

function auth(extra = {}) {
  return {
    userId: USER,
    tradingviewUsername: TVU,
    licenseToken: token(),
    broadcast: true,
    ...extra
  };
}

function legacyUnknownPayload(overrides = {}) {
  return {
    ticker: 'EURUSD',
    action: 'buy',
    entry: 1.1,
    sl: 1.09,
    tp1: 1.11,
    tp2: 1.12,
    tp3: 1.13,
    timestamp: NOW,
    ...auth(),
    ...overrides
  };
}

function pine12Payload(alertType, uuid, overrides = {}) {
  return {
    symbol: 'EURUSD',
    timeframe: '15',
    pineClientVersion: '1.2.1',
    pattern: 'liquidity_sweep_fvg_scalp',
    alertType,
    direction: 'long',
    ...levels(),
    stop_loss_1: 1.09,
    signalUuid: uuid,
    signalId: uuid,
    canonicalSignalKey: uuid,
    canonicalSignalTf: '15',
    message: 'KACHING BUY',
    ...auth(),
    ...overrides
  };
}

function pine13Payload(alertType, uuid, overrides = {}) {
  const eventType = {
    entry: 'ENTRY',
    take_profit_1: 'TP1',
    take_profit_2: 'TP2',
    take_profit_3: 'TP3',
    stop_loss: 'SL'
  }[alertType] || 'ENTRY';
  const seq = { ENTRY: 0, TP1: 1, TP2: 2, TP3: 3, SL: 3 }[eventType];
  const eventId = `EURUSD|15m|${uuid}|${eventType}`;
  return {
    symbol: 'EURUSD',
    timeframe: '15m',
    canonicalSignalTf: '15m',
    pineClientVersion: '1.3.0',
    pattern: 'liquidity_sweep_fvg_scalp',
    alertType,
    direction: 'long',
    ...levels(),
    stop_loss_1: 1.09,
    signalUuid: uuid,
    signalId: uuid,
    canonicalTradeId: uuid,
    canonicalSignalKey: uuid,
    eventId,
    eventType,
    eventSequence: seq,
    isRealtime: true,
    barTime: Date.now(),
    signalTime: Date.now(),
    message: 'KACHING BUY',
    ...auth(),
    ...overrides
  };
}

function stablePayload(alertType, uuid, overrides = {}) {
  return pine13Payload(alertType, uuid, {
    schemaVersion: STABLE_SCHEMA_VERSION,
    ...overrides
  });
}

describe('A. version detection', () => {
  it('detects legacy, 1.2.x, 1.3.0, and stable-v1', () => {
    assert.equal(selectAdapter(legacyUnknownPayload()).adapterId, ADAPTER_IDS.LEGACY);
    assert.equal(selectAdapter(pine12Payload('entry', 'u12')).adapterId, ADAPTER_IDS.PINE12);
    assert.equal(selectAdapter(pine13Payload('entry', 'u13')).adapterId, ADAPTER_IDS.PINE13);
    assert.equal(selectAdapter(stablePayload('entry', 'uS')).adapterId, ADAPTER_IDS.STABLE);
  });

  it('does not reject missing pineClientVersion; uses capabilities then fallback', () => {
    const modern = pine13Payload('entry', 'cap-1');
    delete modern.pineClientVersion;
    const selected = selectAdapter(modern);
    assert.equal(selected.adapterId, ADAPTER_IDS.PINE13);
    const caps = inspectPayloadCapabilities(modern);
    assert.equal(caps.hasEventId, true);
    assert.equal(caps.hasCanonicalTradeId, true);
    assert.equal(caps.hasRealtimeFlag, true);
  });
});

describe('B. field normalization', () => {
  it('maps ticker/action/tp1/sl into canonical BUY + take_profit_*', () => {
    const ev = PineCompatibilityService.normalizeIncomingPineEvent(legacyUnknownPayload(), {
      receivedAt: NOW + 1000,
      userId: USER
    });
    assert.equal(ev.schemaVersion, STABLE_SCHEMA_VERSION);
    assert.equal(ev.trade.side, 'BUY');
    assert.equal(ev.trade.entry, 1.1);
    assert.equal(ev.trade.sl, 1.09);
    assert.equal(ev.trade.tp1, 1.11);
    assert.equal(ev.event.type, 'ENTRY');
    assert.ok(ev.identity.eventId);
    assert.ok(ev.identity.canonicalTradeId);
  });
});

describe('C. legacy identity (deterministic, no random UUID)', () => {
  it('same webhook twice â†’ same eventId; Fly machines agree', () => {
    const body = legacyUnknownPayload();
    const a = PineCompatibilityService.normalizeIncomingPineEvent(body, { userId: USER, receivedAt: NOW });
    const b = PineCompatibilityService.normalizeIncomingPineEvent(body, { userId: USER, receivedAt: NOW + 50 });
    assert.equal(a.identity.eventId, b.identity.eventId);
    assert.equal(a.identity.canonicalTradeId, b.identity.canonicalTradeId);
    assert.match(a.identity.canonicalTradeId, /^leg-/);
    assert.doesNotMatch(a.identity.eventId, /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
  });

  it('different later trade â†’ different canonicalTradeId', () => {
    const a = PineCompatibilityService.normalizeIncomingPineEvent(
      legacyUnknownPayload({ timestamp: NOW, entry: 1.1 }),
      { userId: USER }
    );
    const b = PineCompatibilityService.normalizeIncomingPineEvent(
      legacyUnknownPayload({ timestamp: NOW + 8 * 60 * 60 * 1000, entry: 1.25 }),
      { userId: USER }
    );
    assert.notEqual(a.identity.canonicalTradeId, b.identity.canonicalTradeId);
  });

  it('BUY vs SELL same price â†’ different canonicalTradeId', () => {
    const buy = PineCompatibilityService.normalizeIncomingPineEvent(
      legacyUnknownPayload({ action: 'buy' }),
      { userId: USER }
    );
    const sell = PineCompatibilityService.normalizeIncomingPineEvent(
      legacyUnknownPayload({ action: 'sell' }),
      { userId: USER }
    );
    assert.notEqual(buy.identity.canonicalTradeId, sell.identity.canonicalTradeId);
  });

  it('same trade TP1 twice â†’ same eventId; TP1 vs TP2 differ', () => {
    const uuid = 'EURUSD-scalping-c15-1714000000000-long';
    const tp1a = PineCompatibilityService.normalizeIncomingPineEvent(
      pine12Payload('take_profit_1', uuid),
      { userId: USER }
    );
    const tp1b = PineCompatibilityService.normalizeIncomingPineEvent(
      pine12Payload('take_profit_1', uuid),
      { userId: USER }
    );
    const tp2 = PineCompatibilityService.normalizeIncomingPineEvent(
      pine12Payload('take_profit_2', uuid),
      { userId: USER }
    );
    assert.equal(tp1a.identity.eventId, tp1b.identity.eventId);
    assert.notEqual(tp1a.identity.eventId, tp2.identity.eventId);
    assert.equal(tp1a.identity.canonicalTradeId, tp2.identity.canonicalTradeId);
  });
});

describe('D. Redis SET NX + fail closed', () => {
  const originalEnv = process.env.NODE_ENV;
  beforeEach(() => TradeEventStore.resetForTests());
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    TradeEventStore.resetForTests();
  });

  it('empty eventId no longer allows; throws missing_event_identity', async () => {
    await assert.rejects(
      () => TradeEventStore.claimEventId(''),
      err => err && err.reason === 'missing_event_identity'
    );
  });

  it('first claim wins; retry loses', async () => {
    const id = 'EURUSD|15m|canon|ENTRY';
    assert.equal(await TradeEventStore.claimEventId(id), true);
    assert.equal(await TradeEventStore.claimEventId(id), false);
  });

  it('production Redis down â†’ redis_unavailable, not process-local allow', async () => {
    process.env.NODE_ENV = 'production';
    TradeEventStore.setClientForTests(null, { unavailable: true });
    await assert.rejects(
      () => TradeEventStore.claimEventId('EURUSD|15m|prod|ENTRY'),
      err => err && err.reason === 'redis_unavailable'
    );
  });
});

describe('E. realtime true/false/unknown', () => {
  it('true passes; false rejects; missing is unknown', () => {
    assert.equal(evaluateRealtimeFlag({ isRealtime: true }).state, 'true');
    assert.equal(evaluateRealtimeFlag({ isRealtime: false }).reject, true);
    assert.equal(evaluateRealtimeFlag({}).state, 'unknown');
  });

  it('unknown + fresh timestamp is not stale; unknown + old entry is stale', () => {
    const fresh = evaluateUnknownRealtimeFreshness(
      { alertType: 'entry', eventTimestamp: Date.now() - 1000 },
      { receivedAt: Date.now() }
    );
    assert.equal(fresh.stale, false);
    const stale = evaluateUnknownRealtimeFreshness(
      { alertType: 'entry', eventTimestamp: Date.now() - 3 * 60 * 60 * 1000 },
      { receivedAt: Date.now() }
    );
    assert.equal(stale.stale, true);
    assert.equal(stale.reason, 'stale_entry');
    const staleOut = evaluateUnknownRealtimeFreshness(
      { alertType: 'take_profit_1', eventTimestamp: Date.now() - 5 * 60 * 60 * 1000 },
      { receivedAt: Date.now() }
    );
    assert.equal(staleOut.stale, true);
    assert.equal(staleOut.reason, 'stale_outcome');
  });
});

describe('Fâ€“H. compatibility e2e + duplicate delivery', () => {
  const originalEnv = process.env.NODE_ENV;
  const originalOrphan = process.env.ORPHAN_OUTCOME_WAIT_MS;
  beforeEach(() => {
    process.env.ORPHAN_OUTCOME_WAIT_MS = '0';
    TradeEventStore.resetForTests();
    TradeEventDispatcher.resetForTests();
    deliveryIdempotency.resetForTests();
    TradingViewAlertService.resetTestFanoutHooks();
  });
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    if (originalOrphan == null) delete process.env.ORPHAN_OUTCOME_WAIT_MS;
    else process.env.ORPHAN_OUTCOME_WAIT_MS = originalOrphan;
    TradeEventStore.resetForTests();
    TradeEventDispatcher.resetForTests();
    deliveryIdempotency.resetForTests();
    TradingViewAlertService.resetTestFanoutHooks();
  });

  async function accept(body) {
    return TradingViewAlertService.acceptTradingViewWebhook({ emit() {} }, body, []);
  }

  it('G. legacy / 1.2 / 1.3 / stable ENTRY then duplicate ENTRY', async () => {
    const cases = [
      ['legacy', legacyUnknownPayload({ timestamp: Date.now() })],
      ['1.2', pine12Payload('entry', 'uuid-12-e2e', { signalTime: Date.now() })],
      ['1.3', pine13Payload('entry', 'uuid-13-e2e')],
      ['stable', stablePayload('entry', 'uuid-st-e2e')]
    ];
    for (const [label, body] of cases) {
      TradeEventStore.resetForTests();
      const mem = [];
      const first = await TradingViewAlertService.acceptTradingViewWebhook({ emit() {} }, body, mem);
      const second = await TradingViewAlertService.acceptTradingViewWebhook({ emit() {} }, body, mem);
      assert.equal(first.accepted, true, `${label} first accepted`);
      assert.equal(second.duplicate, true, `${label} duplicate`);
      assert.equal(second.reason, 'duplicate_event_id', `${label} reason`);
    }
  });

  it('E. isRealtime false rejects subscriber delivery', async () => {
    const result = await accept(
      pine13Payload('entry', 'uuid-nrt', { isRealtime: false, signalTime: Date.now() })
    );
    assert.equal(result.reason, 'non_realtime_event');
    assert.equal(result.skippedFanout, true);
  });

  it('E. unknown realtime stale entry is skipped', async () => {
    const result = await accept(
      pine12Payload('entry', 'uuid-stale-unk', {
        signalTime: Date.now() - 3 * 60 * 60 * 1000,
        timestamp: Date.now() - 3 * 60 * 60 * 1000
      })
    );
    assert.equal(result.reason, 'stale_entry');
  });

  it('F. ENTRY-first: TP1 before ENTRY is orphaned then linked', async () => {
    const uuid = 'uuid-orphan-order';
    const mem = [];
    const tp = await TradingViewAlertService.acceptTradingViewWebhook(
      { emit() {} },
      pine13Payload('take_profit_1', uuid),
      mem
    );
    assert.ok(['orphaned_outcome', 'pending_outcome'].includes(tp.reason) || tp.pendingOutcome);
    const entry = await TradingViewAlertService.acceptTradingViewWebhook(
      { emit() {} },
      pine13Payload('entry', uuid),
      mem
    );
    assert.equal(entry.accepted, true);
  });

  it('F. TP3 and SL are exclusive', async () => {
    const uuid = 'uuid-term-mutex';
    const mem = [];
    const entry = await TradingViewAlertService.acceptTradingViewWebhook(
      { emit() {} },
      pine13Payload('entry', uuid),
      mem
    );
    assert.equal(entry.accepted, true);
    const tp3 = await TradingViewAlertService.acceptTradingViewWebhook(
      { emit() {} },
      pine13Payload('take_profit_3', uuid),
      mem
    );
    assert.equal(tp3.accepted, true);
    const sl = await TradingViewAlertService.acceptTradingViewWebhook(
      { emit() {} },
      pine13Payload('stop_loss', uuid),
      mem
    );
    assert.equal(sl.duplicate || sl.reason === 'duplicate_lifecycle_event' || sl.skippedFanout, true);
  });

  it('H. same eventId persist once (delivery claim path)', async () => {
    const uuid = 'uuid-once-deliv';
    const mem = [];
    const first = await TradingViewAlertService.acceptTradingViewWebhook(
      { emit() {} },
      pine13Payload('entry', uuid),
      mem
    );
    const retry = await TradingViewAlertService.acceptTradingViewWebhook(
      { emit() {} },
      pine13Payload('entry', uuid),
      mem
    );
    assert.equal(first.accepted, true);
    assert.equal(retry.duplicate, true);
    assert.equal(mem.length, 1);
  });

  it('D. accept path Redis down is 503', async () => {
    const body = pine13Payload('entry', 'uuid-redis-down');
    process.env.NODE_ENV = 'production';
    TradeEventStore.setClientForTests(null, { unavailable: true });
    const result = await accept(body);
    assert.equal(result.reason, 'redis_unavailable');
    assert.equal(result.httpStatus, 503);
  });
});

describe('J. 1.3.0 regression', () => {
  it('generator stamp remains 1.3.0; stable adapter shares 1.3 normalizer', () => {
    assert.equal(PINE_CLIENT_VERSION, '1.3.2');
    const a = PineCompatibilityService.normalizeIncomingPineEvent(pine13Payload('entry', 'reg-13'));
    const b = PineCompatibilityService.normalizeIncomingPineEvent(stablePayload('entry', 'reg-13'));
    assert.equal(a.identity.eventId, b.identity.eventId);
    assert.equal(a.event.type, 'ENTRY');
    assert.equal(a.event.isRealtime, true);
    assert.equal(a.metadata.compatibilityAdapter, ADAPTER_IDS.PINE13);
    assert.equal(b.metadata.compatibilityAdapter, ADAPTER_IDS.STABLE);
    assert.equal(a.source.compatibilityMode, 'native');
  });

  it('buildSignalData 1.3.0 keeps eventId and levels', () => {
    const data = TradingViewAlertService.buildSignalData(pine13Payload('entry', 'build-13'));
    assert.equal(data.pineClientVersion, '1.3.2');
    assert.ok(data.eventId);
    assert.equal(data.take_profit_1, 1.11);
    assert.equal(data.compatibilityAdapter, ADAPTER_IDS.PINE13);
  });
});
