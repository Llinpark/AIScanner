const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  validatePartialPercents,
  resolvePartialPreset,
  partialCloseVolume,
  applyManagementEvent,
  suggestSymbolCandidates,
  PARTIAL_PRESETS,
  DEFAULT_PARTIAL_PERCENTS
} = require('../mt5TradeManagement');

describe('mt5TradeManagement partial percents', () => {
  it('defaults to Balanced 40/30/30', () => {
    assert.deepEqual(DEFAULT_PARTIAL_PERCENTS, { tp1: 40, tp2: 30, tp3: 30 });
    assert.deepEqual(PARTIAL_PRESETS.conservative, { tp1: 25, tp2: 25, tp3: 50 });
    assert.deepEqual(PARTIAL_PRESETS.aggressive, { tp1: 50, tp2: 30, tp3: 20 });
  });

  it('validates percents that sum to 100', () => {
    const ok = validatePartialPercents(40, 30, 30);
    assert.equal(ok.ok, true);
    assert.equal(ok.sum, 100);
  });

  it('rejects percents that do not sum to 100', () => {
    const bad = validatePartialPercents(50, 50, 50);
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'sum_not_100');
  });

  it('resolves presets by name', () => {
    assert.equal(resolvePartialPreset('Aggressive').tp1, 50);
    assert.equal(resolvePartialPreset('unknown').name, 'balanced');
  });

  it('computes partial close volume capped by remaining', () => {
    assert.equal(partialCloseVolume(1, 40, 1), 0.4);
    assert.equal(partialCloseVolume(1, 40, 0.2), 0.2);
    assert.equal(partialCloseVolume(0, 40, 1), 0);
  });
});

describe('mt5TradeManagement report events', () => {
  it('maps opened/filled to filled + open phase', () => {
    const { status, managementState } = applyManagementEvent(
      { status: 'sent', lotSize: 1 },
      { event: 'opened', fillPrice: 1.1, remainingVolume: 1 }
    );
    assert.equal(status, 'filled');
    assert.equal(managementState.phase, 'open');
    assert.equal(managementState.remainingVolume, 1);
  });

  it('tracks TP hits and remaining volume', () => {
    let state = applyManagementEvent({ status: 'filled', lotSize: 1 }, { event: 'opened' });
    state = applyManagementEvent(
      { status: state.status, managementState: state.managementState, lotSize: 1 },
      { event: 'tp1_hit', remainingVolume: 0.6, partialVolume: 0.4, partialClosePercent: 40 }
    );
    assert.equal(state.managementState.tp1Hit, true);
    assert.equal(state.managementState.phase, 'tp1');
    assert.equal(state.managementState.remainingVolume, 0.6);
  });

  it('closes on sl_hit', () => {
    const { status, managementState } = applyManagementEvent(
      { status: 'filled' },
      { event: 'sl_hit' }
    );
    assert.equal(status, 'closed');
    assert.equal(managementState.phase, 'sl_hit');
  });

  it('records eventUuid into ackedEventUuids', () => {
    const { managementState, eventUuid } = applyManagementEvent(
      { status: 'filled', managementState: { ackedEventUuids: [], events: [] } },
      { event: 'break_even', eventUuid: 'uuid-be-1' }
    );
    assert.equal(eventUuid, 'uuid-be-1');
    assert.ok(managementState.ackedEventUuids.includes('uuid-be-1'));
    assert.equal(managementState.events[0].eventUuid, 'uuid-be-1');
  });

  it('keeps legacy filled status without event', () => {
    const { status, managementState } = applyManagementEvent(
      { status: 'sent' },
      { status: 'filled', fillPrice: 2 }
    );
    assert.equal(status, 'filled');
    assert.equal(managementState.phase, 'open');
  });
});

describe('mt5TradeManagement symbol aliases', () => {
  it('suggests GOLD/XAUUSD and DJ30/US30 candidates', () => {
    const gold = suggestSymbolCandidates('XAU/USD');
    assert.ok(gold.some(s => /XAUUSD|GOLD/i.test(s)));
    const us30 = suggestSymbolCandidates('DJ30');
    assert.ok(us30.some(s => /US30|DJ30/i.test(s)));
  });
});
