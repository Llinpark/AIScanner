/**
 * Terminal outcome immutability — once TP3/SL/expired/cancelled (or won/lost), no overwrite.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  applyOutcomeUpdate,
  enrichEntrySignal,
  isTerminalEntry,
  isTerminalTradeStatus
} = require('../signalOutcome');
const ActiveSignalRegistry = require('../activeSignalRegistry');
const TradeLifecycleService = require('../../services/TradeLifecycleService');
const SignalOutcomeService = require('../../services/SignalOutcomeService');

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
    timeframe: '3m',
    signalUuid: 'EURUSD-scalping-c3-1000-long',
    ...overrides
  });
}

describe('terminal outcome lock', () => {
  beforeEach(() => {
    ActiveSignalRegistry.resetForTests?.();
  });

  it('ACTIVE → TP1 → TP2 → TP3', () => {
    const e = openEntry();
    applyOutcomeUpdate(e, 'take_profit_1');
    assert.equal(e.outcome, 'tp1');
    assert.equal(e.tradeStatus, 'partial');
    assert.equal(e._outcomeIgnored, false);

    applyOutcomeUpdate(e, 'take_profit_2');
    assert.equal(e.outcome, 'tp2');
    assert.equal(e.tradeStatus, 'partial');

    applyOutcomeUpdate(e, 'take_profit_3');
    assert.equal(e.outcome, 'tp3');
    assert.equal(e.tradeStatus, 'won');
    assert.ok(isTerminalEntry(e));
  });

  it('ACTIVE → SL', () => {
    const e = openEntry();
    applyOutcomeUpdate(e, 'stop_loss');
    assert.equal(e.outcome, 'sl');
    assert.equal(e.tradeStatus, 'lost');
    assert.ok(isTerminalEntry(e));
  });

  it('ACTIVE → EXPIRED', () => {
    const e = openEntry();
    applyOutcomeUpdate(e, 'expired', 'candle_expiry');
    assert.equal(e.outcome, 'expired');
    assert.equal(e.tradeStatus, 'expired');
    assert.ok(isTerminalEntry(e));
  });

  it('TP3 → later SL = ignored', () => {
    const e = openEntry({ signalUuid: 'lock-tp3-sl' });
    applyOutcomeUpdate(e, 'take_profit_3');
    const closedAt = e.closedAt;
    applyOutcomeUpdate(e, 'stop_loss');
    assert.equal(e._outcomeIgnored, true);
    assert.equal(e._outcomeIgnoreReason, 'already_terminal');
    assert.equal(e.outcome, 'tp3');
    assert.equal(e.tradeStatus, 'won');
    assert.equal(e.closedAt, closedAt);
  });

  it('SL → later TP3 = ignored', () => {
    const e = openEntry({ signalUuid: 'lock-sl-tp3' });
    applyOutcomeUpdate(e, 'stop_loss');
    applyOutcomeUpdate(e, 'take_profit_3');
    assert.equal(e._outcomeIgnored, true);
    assert.equal(e.outcome, 'sl');
    assert.equal(e.tradeStatus, 'lost');
  });

  it('EXPIRED → later SL / TP3 = ignored', () => {
    const e = openEntry({ signalUuid: 'lock-exp' });
    applyOutcomeUpdate(e, 'expired');
    applyOutcomeUpdate(e, 'stop_loss');
    assert.equal(e.outcome, 'expired');
    assert.equal(e._outcomeIgnored, true);
    applyOutcomeUpdate(e, 'take_profit_3');
    assert.equal(e.outcome, 'expired');
    assert.equal(e._outcomeIgnored, true);
  });

  it('TP3 → TP3 = idempotent no-op', () => {
    const e = openEntry({ signalUuid: 'lock-tp3-idem' });
    applyOutcomeUpdate(e, 'take_profit_3');
    applyOutcomeUpdate(e, 'take_profit_3');
    assert.equal(e._outcomeIgnored, true);
    assert.match(String(e._outcomeIgnoreReason), /already_terminal/);
    assert.equal(e.outcome, 'tp3');
  });

  it('SL → SL = idempotent no-op', () => {
    const e = openEntry({ signalUuid: 'lock-sl-idem' });
    applyOutcomeUpdate(e, 'stop_loss');
    applyOutcomeUpdate(e, 'stop_loss');
    assert.equal(e._outcomeIgnored, true);
    assert.equal(e.outcome, 'sl');
  });

  it('TP1 → TP2 remains valid; TP1 → TP1 idempotent', () => {
    const e = openEntry();
    applyOutcomeUpdate(e, 'take_profit_1');
    applyOutcomeUpdate(e, 'take_profit_1');
    assert.equal(e._outcomeIgnored, true);
    assert.equal(e._outcomeIgnoreReason, 'same_stage_replay');
    assert.equal(e.outcome, 'tp1');
    assert.equal(e.tradeStatus, 'partial');

    applyOutcomeUpdate(e, 'take_profit_2');
    assert.equal(e._outcomeIgnored, false);
    assert.equal(e.outcome, 'tp2');
  });

  it('TP2 → TP3 remains valid', () => {
    const e = openEntry();
    applyOutcomeUpdate(e, 'take_profit_1');
    applyOutcomeUpdate(e, 'take_profit_2');
    applyOutcomeUpdate(e, 'take_profit_3');
    assert.equal(e.outcome, 'tp3');
    assert.equal(e.tradeStatus, 'won');
  });

  it('TP2 → TP1 backward transition ignored', () => {
    const e = openEntry();
    applyOutcomeUpdate(e, 'take_profit_1');
    applyOutcomeUpdate(e, 'take_profit_2');
    applyOutcomeUpdate(e, 'take_profit_1');
    assert.equal(e._outcomeIgnored, true);
    assert.equal(e._outcomeIgnoreReason, 'backward_transition');
    assert.equal(e.outcome, 'tp2');
  });

  it('expiry after TP1 stays terminal win; later SL ignored', () => {
    const e = openEntry({ signalUuid: 'lock-exp-tp1' });
    applyOutcomeUpdate(e, 'take_profit_1');
    applyOutcomeUpdate(e, 'expired', 'candle_expiry');
    assert.equal(e.outcome, 'tp1');
    assert.equal(e.tradeStatus, 'won');
    assert.ok(isTerminalEntry(e));
    assert.ok(isTerminalTradeStatus(e.tradeStatus));

    applyOutcomeUpdate(e, 'stop_loss');
    assert.equal(e._outcomeIgnored, true);
    assert.equal(e.outcome, 'tp1');
    assert.equal(e.tradeStatus, 'won');
  });

  it('same UUID from multiple chartTfs cannot flip TP3 to SL', async () => {
    const uuid = 'MULTI-TF-TERM-1';
    const mem = [
      {
        _id: 'entry-1',
        ...openEntry({ signalUuid: uuid, chartTf: '3' }),
        tradeStatus: 'open',
        outcome: 'pending'
      }
    ];
    await SignalOutcomeService.updateEntryOutcome(mem[0], 'take_profit_3', mem, 'tp3');
    assert.equal(mem[0].outcome, 'tp3');
    assert.equal(mem[0].tradeStatus, 'won');

    const before = { ...mem[0] };
    const saved = await SignalOutcomeService.updateEntryOutcome(
      mem[0],
      'stop_loss',
      mem,
      'sl'
    );
    assert.equal(saved.outcome, 'tp3');
    assert.equal(mem[0].outcome, 'tp3');
    assert.equal(mem[0].tradeStatus, 'won');
    assert.equal(mem[0].closedAt, before.closedAt);
  });

  it('applyLocalOutcome logs ignore without mutating terminal', () => {
    const e = openEntry({ signalUuid: 'local-term' });
    TradeLifecycleService.applyLocalOutcome(e, 'take_profit_3');
    TradeLifecycleService.applyLocalOutcome(e, 'stop_loss');
    assert.equal(e.outcome, 'tp3');
    assert.equal(e._outcomeIgnored, true);
  });
});
