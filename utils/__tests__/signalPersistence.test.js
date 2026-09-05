const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  applyOutcomeUpdate,
  enrichEntrySignal,
  findOpenEntry,
  isTerminalAlert,
  isPartialAlert,
  buildAnalytics
} = require('../signalOutcome');
const ActiveSignalRegistry = require('../activeSignalRegistry');
const TradeLifecycleService = require('../../services/TradeLifecycleService');

describe('signal persistence lifecycle', () => {
  beforeEach(() => {
    ActiveSignalRegistry.resetForTests();
  });

  it('keeps trade open after TP1/TP2 (partial), closes only on TP3/SL/expiry', () => {
    const entry = enrichEntrySignal({
      symbol: 'XAUUSD',
      direction: 'long',
      entry: 100,
      stop_loss: 99,
      take_profit_1: 101,
      take_profit_2: 102,
      take_profit_3: 103,
      alertType: 'entry',
      timeframe: '15m'
    });

    applyOutcomeUpdate(entry, 'take_profit_1');
    assert.equal(entry.outcome, 'tp1');
    assert.equal(entry.tradeStatus, 'partial');
    assert.equal(entry.lifecycleStage, 'TP1');
    assert.equal(entry.highestMilestone, 'tp1');
    assert.equal(entry.closedAt, null);

    applyOutcomeUpdate(entry, 'take_profit_2');
    assert.equal(entry.outcome, 'tp2');
    assert.equal(entry.tradeStatus, 'partial');
    assert.equal(entry.highestMilestone, 'tp2');
    assert.equal(entry.closedAt, null);

    applyOutcomeUpdate(entry, 'take_profit_3');
    assert.equal(entry.outcome, 'tp3');
    assert.equal(entry.tradeStatus, 'won');
    assert.ok(entry.closedAt);
  });

  it('treats expiry after TP1 as distinct TP1 win (not TP3-only)', () => {
    const entry = enrichEntrySignal({
      symbol: 'EURUSD',
      direction: 'long',
      entry: 1.1,
      stop_loss: 1.09,
      take_profit_1: 1.11,
      take_profit_2: 1.12,
      take_profit_3: 1.13,
      alertType: 'entry',
      timeframe: '5'
    });
    applyOutcomeUpdate(entry, 'take_profit_1');
    applyOutcomeUpdate(entry, 'expired', 'candle_expiry');
    assert.equal(entry.outcome, 'tp1');
    assert.equal(entry.tradeStatus, 'won');
    assert.match(String(entry.closedReason), /expired_after_tp1/);
  });

  it('findOpenEntry scopes by timeframe and still matches partial TP1/TP2', () => {
    const open15 = enrichEntrySignal({
      symbol: 'EURUSD',
      direction: 'long',
      entry: 1.1,
      stop_loss: 1.09,
      take_profit_1: 1.11,
      take_profit_2: 1.12,
      take_profit_3: 1.13,
      alertType: 'entry',
      timeframe: '15m',
      createdAt: new Date()
    });
    applyOutcomeUpdate(open15, 'take_profit_1');

    const open5 = enrichEntrySignal({
      symbol: 'EURUSD',
      direction: 'short',
      entry: 1.2,
      stop_loss: 1.21,
      take_profit_1: 1.19,
      take_profit_2: 1.18,
      take_profit_3: 1.17,
      alertType: 'entry',
      timeframe: '5m',
      createdAt: new Date()
    });

    const found15 = findOpenEntry([open15, open5], 'EURUSD', '15');
    assert.ok(found15);
    assert.equal(found15.timeframe, '15m');
    assert.equal(found15.outcome, 'tp1');

    const found5 = findOpenEntry([open15, open5], 'EURUSD', '5m');
    assert.ok(found5);
    assert.equal(found5.direction, 'short');
  });

  it('ActiveSignalRegistry is keyed per symbol+timeframe (never global)', async () => {
    await ActiveSignalRegistry.registerActive({
      symbol: 'XAUUSD',
      timeframe: '15m',
      signalUuid: 'abc-15',
      direction: 'long',
      entry: 1,
      stop_loss: 0.9,
      take_profit_1: 1.1,
      take_profit_2: 1.2,
      take_profit_3: 1.3
    });
    await ActiveSignalRegistry.registerActive({
      symbol: 'XAUUSD',
      timeframe: '5m',
      signalUuid: 'abc-5',
      direction: 'short',
      entry: 2,
      stop_loss: 2.1,
      take_profit_1: 1.9,
      take_profit_2: 1.8,
      take_profit_3: 1.7
    });
    await ActiveSignalRegistry.registerActive({
      symbol: 'EURUSD',
      timeframe: '15m',
      signalUuid: 'eur-15',
      direction: 'long',
      entry: 1.1,
      stop_loss: 1.09,
      take_profit_1: 1.11,
      take_profit_2: 1.12,
      take_profit_3: 1.13
    });

    assert.equal(await ActiveSignalRegistry.hasActive('XAUUSD', '15m'), true);
    assert.equal(await ActiveSignalRegistry.hasActive('XAUUSD', '5m'), true);
    assert.equal(await ActiveSignalRegistry.hasActive('EURUSD', '15m'), true);
    assert.equal((await ActiveSignalRegistry.getActive('XAUUSD', '15m')).signalUuid, 'abc-15');
    assert.equal((await ActiveSignalRegistry.getActive('XAUUSD', '5')).signalUuid, 'abc-5');

    // clearActive(symbol, reason, timeframe) — never clears other TF slots.
    await ActiveSignalRegistry.clearActive('XAUUSD', 'tp3', '15m');
    assert.equal(await ActiveSignalRegistry.hasActive('XAUUSD', '15m'), false);
    assert.equal(await ActiveSignalRegistry.hasActive('XAUUSD', '5m'), true);
    assert.equal(await ActiveSignalRegistry.hasActive('EURUSD', '15m'), true);
  });

  it('rejects No Signal / active=false reset webhooks via TradeLifecycleService', () => {
    assert.equal(TradeLifecycleService.isForbiddenResetPayload({ active: false, symbol: 'XAUUSD' }), true);
    assert.equal(
      TradeLifecycleService.isForbiddenResetPayload({ message: 'No Signal', symbol: 'XAUUSD' }),
      true
    );
    assert.equal(TradeLifecycleService.isForbiddenResetPayload({ alertType: 'clear' }), true);
    assert.equal(
      TradeLifecycleService.isForbiddenResetPayload({
        alertType: 'entry',
        active: true,
        symbol: 'XAUUSD',
        entry: 1,
        stop_loss: 0.9,
        take_profit_1: 1.1,
        take_profit_2: 1.2,
        take_profit_3: 1.3
      }),
      false
    );
  });

  it('classifies partial vs terminal alerts', () => {
    assert.equal(isPartialAlert('take_profit_1'), true);
    assert.equal(isTerminalAlert('take_profit_3'), true);
    assert.equal(isTerminalAlert('expired'), true);
    assert.equal(isTerminalAlert('take_profit_1'), false);
  });

  it('buildAnalytics counts TP1/TP2/TP3/SL/Expired/Cancelled distinctly', () => {
    const mk = (outcome, extra = {}) =>
      enrichEntrySignal({
        symbol: 'XAUUSD',
        direction: 'long',
        entry: 100,
        stop_loss: 99,
        take_profit_1: 101,
        take_profit_2: 102,
        take_profit_3: 103,
        alertType: 'entry',
        timeframe: '15m',
        createdAt: new Date('2026-07-01T00:00:00Z'),
        ...extra
      });

    const tp1 = mk('pending');
    applyOutcomeUpdate(tp1, 'take_profit_1');
    applyOutcomeUpdate(tp1, 'expired');

    const tp3 = mk('pending');
    applyOutcomeUpdate(tp3, 'take_profit_3');

    const sl = mk('pending');
    applyOutcomeUpdate(sl, 'stop_loss');

    const expired = mk('pending');
    applyOutcomeUpdate(expired, 'expired');

    const cancelled = mk('pending');
    applyOutcomeUpdate(cancelled, 'cancelled');

    const analytics = buildAnalytics([tp1, tp3, sl, expired, cancelled]);
    assert.equal(analytics.outcomeBreakdown.tp1, 1);
    assert.equal(analytics.outcomeBreakdown.tp3, 1);
    assert.equal(analytics.outcomeBreakdown.sl, 1);
    assert.equal(analytics.outcomeBreakdown.expired, 1);
    assert.equal(analytics.outcomeBreakdown.cancelled, 1);
    assert.equal(analytics.wins, 2); // tp1 + tp3
    assert.equal(analytics.losses, 1);
    assert.notEqual(analytics.wins, analytics.outcomeBreakdown.tp3);
  });

  it('enrichEntrySignal assigns permanent UUID and freezes levels metadata', () => {
    const entry = enrichEntrySignal({
      symbol: 'GBPUSD',
      direction: 'long',
      entry: 1.3,
      stop_loss: 1.29,
      take_profit_1: 1.31,
      take_profit_2: 1.32,
      take_profit_3: 1.33,
      alertType: 'entry',
      timeframe: '15',
      expiryBars: 25
    });
    assert.ok(entry.signalUuid);
    assert.equal(entry.signalUuid, entry.signalGroupId);
    assert.equal(entry.levelsFrozen, true);
    assert.equal(entry.timeframe, '15m');
    assert.equal(entry.expiryBars, 25);
  });
});
