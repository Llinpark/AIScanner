'use strict';

/**
 * USDCAD 2026-09-09 observability contradiction:
 * webhook_intake.category=REJECTED + statusCode=200 while Signal accepted
 * for requestId tvw_mttz2gi1_ea772ac2.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const WebhookIntakeService = require('../../services/WebhookIntakeService');
const TradingViewAlertService = require('../../services/TradingViewAlertService');

describe('webhook_intake accepted/rejected consistency', () => {
  beforeEach(() => WebhookIntakeService.resetForTests());

  it('statusCode 200 + accepted=true → ACCEPTED (incident reproduction)', () => {
    assert.equal(
      WebhookIntakeService.classifyCategory({
        statusCode: 200,
        accepted: true,
        persisted: true,
        outcome: 'accepted',
        deferredFanout: true
      }),
      'ACCEPTED'
    );
  });

  it('statusCode 202 + accepted=true → ACCEPTED', () => {
    assert.equal(
      WebhookIntakeService.classifyCategory({
        statusCode: 202,
        accepted: true,
        outcome: 'accepted'
      }),
      'ACCEPTED'
    );
  });

  it('statusCode 200 alone without accepted/outcome stays REJECTED', () => {
    assert.equal(WebhookIntakeService.classifyCategory({ statusCode: 200 }), 'REJECTED');
  });

  it('recordAsync persists ACCEPTED for the incident shape', () => {
    WebhookIntakeService.recordAsync({
      requestId: 'tvw_mttz2gi1_ea772ac2',
      statusCode: 200,
      accepted: true,
      persisted: true,
      deferredFanout: true,
      outcome: 'accepted',
      symbol: 'USDCAD',
      tf: '3'
    });
    const row = WebhookIntakeService._memory().at(-1);
    assert.equal(row.category, 'ACCEPTED');
    assert.equal(row.accepted, true);
    assert.equal(row.requestId, 'tvw_mttz2gi1_ea772ac2');
  });

  it('buildSignalData persists alertFiredAt from Pine payload', () => {
    const fired = 1788950715000;
    const signal = TradingViewAlertService.buildSignalData({
      symbol: 'USDCAD',
      direction: 'short',
      entry: 1.3782,
      stop_loss: 1.37839,
      take_profit_1: 1.37803,
      take_profit_2: 1.3778,
      take_profit_3: 1.3775,
      alertType: 'entry',
      signalUuid: 'USDCAD-scalping-c3-1788950520000-short',
      signalTime: 1788950520000,
      alertFiredAt: fired,
      barTime: 1788950520000,
      timeframe: '3',
      licenseToken: 'x',
      tradingviewUsername: 'u'
    });
    assert.ok(signal.alertFiredAt instanceof Date);
    assert.equal(signal.alertFiredAt.getTime(), fired);
    assert.equal(Number(signal.eventTimestamp), 1788950520000);
  });
});
