const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const ActiveSignalRegistry = require('../activeSignalRegistry');
const TradeLifecycleService = require('../../services/TradeLifecycleService');
const { enrichEntrySignal, applyOutcomeUpdate, findEntryBySignalUuid } = require('../signalOutcome');
const { isSupportedScannerSymbol } = require('../../config/symbols');

describe('Issues 5/8/11 — lifecycle, UUID sync, one-active registry', () => {
  beforeEach(() => {
    ActiveSignalRegistry.resetForTests();
  });

  it('keeps permanent signalUuid across entry → TP1 → TP2 → TP3', () => {
    const uuid = 'EURUSD-1710000000000-123';
    const entry = enrichEntrySignal({
      symbol: 'EURUSD',
      direction: 'long',
      entry: 1.1,
      stop_loss: 1.09,
      take_profit_1: 1.11,
      take_profit_2: 1.12,
      take_profit_3: 1.13,
      alertType: 'entry',
      timeframe: '15',
      strategyName: 'Liquidity Sweep + Fair Value Gap (Day Trading)',
      signalUuid: uuid
    });
    assert.equal(entry.signalUuid, uuid);
    assert.equal(entry.signalId, uuid);

    applyOutcomeUpdate(entry, 'take_profit_1');
    assert.equal(entry.signalUuid, uuid);
    assert.equal(entry.lifecycleStage, 'TP1');

    applyOutcomeUpdate(entry, 'take_profit_2');
    assert.equal(entry.lifecycleStage, 'TP2');
    assert.equal(entry.closedAt, null);

    applyOutcomeUpdate(entry, 'take_profit_3');
    assert.equal(entry.lifecycleStage, 'TP3');
    assert.ok(entry.closedAt);
  });

  it('blocks a second entry while active for same symbol+tf', async () => {
    const first = enrichEntrySignal({
      symbol: 'XAU/USD',
      direction: 'long',
      entry: 2650,
      stop_loss: 2640,
      take_profit_1: 2660,
      take_profit_2: 2670,
      take_profit_3: 2680,
      alertType: 'entry',
      timeframe: '15m',
      strategyName: 'Liquidity Sweep + Fair Value Gap (Day Trading)',
      signalUuid: 'gold-1'
    });
    await ActiveSignalRegistry.registerActive(first);

    const gate = await TradeLifecycleService.assertCanOpenEntry({
      symbol: 'XAU/USD',
      timeframe: '15m',
      strategyName: 'Liquidity Sweep + Fair Value Gap (Day Trading)',
      alertType: 'entry',
      signalUuid: 'gold-2'
    });
    assert.equal(gate.allowed, false);
    assert.equal(gate.reason, 'active_trade_exists');
  });

  it('treats duplicate webhook replay of same UUID as non-overwrite reject', async () => {
    const first = enrichEntrySignal({
      symbol: 'EUR/USD',
      direction: 'long',
      entry: 1.1,
      stop_loss: 1.09,
      take_profit_1: 1.11,
      take_profit_2: 1.12,
      take_profit_3: 1.13,
      alertType: 'entry',
      timeframe: '5m',
      strategyName: 'Liquidity Sweep + Fair Value Gap (Scalping)',
      signalUuid: 'replay-1'
    });
    await ActiveSignalRegistry.registerActive(first);

    const gate = await TradeLifecycleService.assertCanOpenEntry({
      symbol: 'EUR/USD',
      timeframe: '5m',
      strategyName: 'Liquidity Sweep + Fair Value Gap (Scalping)',
      alertType: 'entry',
      signalUuid: 'replay-1'
    });
    assert.equal(gate.allowed, false);
    assert.equal(gate.reason, 'duplicate_webhook_replay');
  });

  it('allows concurrent trades on different timeframes', async () => {
    await ActiveSignalRegistry.registerActive({
      symbol: 'EUR/USD',
      timeframe: '15m',
      strategyName: 'Liquidity Sweep + Fair Value Gap (Day Trading)',
      signalUuid: 'a',
      lifecycleStage: 'ACTIVE'
    });
    await ActiveSignalRegistry.registerActive({
      symbol: 'EUR/USD',
      timeframe: '3m',
      strategyName: 'Liquidity Sweep + Fair Value Gap (Scalping)',
      signalUuid: 'b',
      lifecycleStage: 'ACTIVE'
    });
    assert.equal(ActiveSignalRegistry.listActive().length, 2);
  });

  it('finds open entry by permanent UUID for dashboard sync', () => {
    const entry = enrichEntrySignal({
      symbol: 'US30',
      direction: 'short',
      entry: 39000,
      stop_loss: 39100,
      take_profit_1: 38900,
      take_profit_2: 38800,
      take_profit_3: 38700,
      alertType: 'entry',
      timeframe: '15m',
      signalUuid: 'us30-uuid'
    });
    const found = findEntryBySignalUuid([entry], 'us30-uuid');
    assert.equal(found.signalUuid, 'us30-uuid');
  });

  it('accepts any TradingView instrument at platform gate (no hard allowlist)', () => {
    assert.equal(isSupportedScannerSymbol('Volatility 75 Index'), true);
    assert.equal(isSupportedScannerSymbol('JUMP10'), true);
    assert.equal(isSupportedScannerSymbol('BTCUSD'), true);
  });
});
