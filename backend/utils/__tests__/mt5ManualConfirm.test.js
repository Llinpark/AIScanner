const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  clampConfirmSeconds,
  resolveConfirmSeconds,
  computeConfirmExpiresAt,
  isConfirmExpired,
  CONFIRM_MIN_SECONDS,
  CONFIRM_MAX_SECONDS,
  CONFIRM_DEFAULT_SECONDS
} = require('../mt5ManualConfirm');
const TradeDeliveryService = require('../../services/TradeDeliveryService');

describe('mt5ManualConfirm TTL', () => {
  it('clamps to 2–5 minutes', () => {
    assert.equal(clampConfirmSeconds(30), CONFIRM_MIN_SECONDS);
    assert.equal(clampConfirmSeconds(9999), CONFIRM_MAX_SECONDS);
    assert.equal(clampConfirmSeconds(180), 180);
  });

  it('defaults to 3 minutes', () => {
    assert.equal(CONFIRM_DEFAULT_SECONDS, 180);
    assert.equal(resolveConfirmSeconds({}), 180);
  });

  it('prefers user setting over env', () => {
    const prev = process.env.MT5_MANUAL_CONFIRM_SECONDS;
    process.env.MT5_MANUAL_CONFIRM_SECONDS = '240';
    try {
      assert.equal(resolveConfirmSeconds({ manualConfirmSeconds: 120 }), 120);
      assert.equal(resolveConfirmSeconds({}), 240);
    } finally {
      if (prev == null) delete process.env.MT5_MANUAL_CONFIRM_SECONDS;
      else process.env.MT5_MANUAL_CONFIRM_SECONDS = prev;
    }
  });

  it('detects expiry correctly', () => {
    const expires = computeConfirmExpiresAt(new Date('2026-08-05T12:00:00.000Z'), 180);
    assert.equal(expires.toISOString(), '2026-08-05T12:03:00.000Z');
    assert.equal(isConfirmExpired(expires, new Date('2026-08-05T12:02:59.000Z')), false);
    assert.equal(isConfirmExpired(expires, new Date('2026-08-05T12:03:00.000Z')), true);
  });
});

describe('Pro/Premium queue gating', () => {
  it('deliverMt5Auto refuses manual mode', async () => {
    const result = await TradeDeliveryService.deliverMt5Auto(
      {
        id: 'u1',
        subscription: { plan: 'professional', status: 'active' },
        mt5: {
          enabled: true,
          executionMode: 'manual',
          devices: [{ deviceId: 'd1', accessToken: 'x', revokedAt: null }]
        }
      },
      { _id: 's1', alertType: 'entry' }
    );
    assert.equal(result.ok, false);
    assert.ok(
      ['manual_mode', 'subscription_required', 'mt5_not_linked'].includes(result.reason),
      result.reason
    );
  });
});
