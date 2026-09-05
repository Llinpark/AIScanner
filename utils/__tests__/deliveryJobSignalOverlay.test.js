/**
 * Overlay-after-rehydrate: TP/SL jobs must not format as ENTRY when Mongo
 * Signal still represents the original entry document.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveJobAlertType,
  overlayJobIdentityOnSignal,
  overlayFanoutAcceptResult,
  isJobIdentityMismatch
} = require('../deliveryJobSignalOverlay');

describe('deliveryJobSignalOverlay', () => {
  it('maps job event types to webhook alert types without defaulting TP/SL to entry', () => {
    assert.equal(resolveJobAlertType('take_profit_1'), 'take_profit_1');
    assert.equal(resolveJobAlertType('TP1'), 'take_profit_1');
    assert.equal(resolveJobAlertType('TP2'), 'take_profit_2');
    assert.equal(resolveJobAlertType('TP3'), 'take_profit_3');
    assert.equal(resolveJobAlertType('SL'), 'stop_loss');
    assert.equal(resolveJobAlertType('stop_loss'), 'stop_loss');
    assert.equal(resolveJobAlertType('entry'), 'entry');
    assert.equal(resolveJobAlertType('ENTRY'), 'entry');
    assert.equal(resolveJobAlertType(''), '');
  });

  it('CASE 8: overlays TP1 job identity onto Mongo ENTRY signal', () => {
    const mongoEntry = {
      alertType: 'entry',
      eventType: 'ENTRY',
      eventId: 'XAUUSD|3|TRADE-1|ENTRY',
      canonicalTradeId: 'TRADE-1',
      signalUuid: 'TRADE-1',
      symbol: 'XAUUSD',
      direction: 'long',
      entry: 2650.5,
      take_profit_1: 2655.1,
      stop_loss: 2648.2
    };
    const job = {
      eventType: 'take_profit_1',
      eventId: 'XAUUSD|3|TRADE-1|TP1',
      canonicalTradeId: 'TRADE-1',
      signalUuid: 'TRADE-1'
    };
    assert.equal(isJobIdentityMismatch(mongoEntry, job), true);
    const overlaid = overlayJobIdentityOnSignal(mongoEntry, job);
    assert.equal(overlaid.alertType, 'take_profit_1');
    assert.equal(overlaid.eventType, 'TP1');
    assert.equal(overlaid.eventId, 'XAUUSD|3|TRADE-1|TP1');
    assert.equal(overlaid.canonicalTradeId, 'TRADE-1');
    assert.equal(overlaid.signalUuid, 'TRADE-1');
    assert.equal(overlaid.entry, 2650.5);
    assert.equal(overlaid.take_profit_1, 2655.1);
    assert.equal(overlaid.symbol, 'XAUUSD');
    assert.equal(overlaid.direction, 'long');
  });

  it('fan-out acceptResult reconstructed from Mongo ENTRY keeps TP1 identity', () => {
    const accept = overlayFanoutAcceptResult(
      {
        accepted: true,
        signalData: { alertType: 'entry', eventId: 'E|ENTRY', canonicalTradeId: 'T1', symbol: 'EURUSD' },
        saved: { alertType: 'entry', signalUuid: 'T1' }
      },
      { eventType: 'take_profit_1', eventId: 'E|TP1', canonicalTradeId: 'T1', signalUuid: 'T1' }
    );
    assert.equal(accept.signalData.alertType, 'take_profit_1');
    assert.equal(accept.signalData.eventId, 'E|TP1');
    assert.equal(accept.saved.alertType, 'take_profit_1');
  });
});
