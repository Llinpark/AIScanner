const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  markManualConfirmExpired,
  markManualConfirmIgnored,
  resolveExecutionMode
} = require('../TradeDeliveryService');
const Mt5TradeCopierService = require('../Mt5TradeCopierService');
const { isConfirmExpired, computeConfirmExpiresAt } = require('../../utils/mt5ManualConfirm');

describe('Pro Manual confirm expire / ignore (no queue)', () => {
  it('marks Expired without touching MT5 queue fields as sent', async () => {
    const signal = {
      _id: 'mem_sig_1',
      executionStatus: 'pending',
      mt5ConfirmStatus: 'pending',
      mt5Sent: false,
      tradeStatus: 'open',
      outcome: 'pending'
    };
    const updated = await markManualConfirmExpired(signal);
    assert.equal(updated.executionStatus, 'expired');
    assert.equal(updated.mt5ConfirmStatus, 'expired');
    assert.equal(updated.tradeStatus, 'expired');
    assert.equal(updated.outcome, 'expired');
    assert.equal(updated.mt5Sent, false);
  });

  it('marks Ignored / cancelled and never sets mt5Sent', async () => {
    const signal = {
      _id: 'mem_sig_2',
      executionStatus: 'pending',
      mt5ConfirmStatus: 'pending',
      mt5Sent: false
    };
    const updated = await markManualConfirmIgnored(signal);
    assert.equal(updated.executionStatus, 'ignored');
    assert.equal(updated.mt5ConfirmStatus, 'ignored');
    assert.equal(updated.mt5Sent, false);
  });

  it('treats past confirm window as expired', () => {
    const expires = computeConfirmExpiresAt(new Date(Date.now() - 5 * 60_000), 120);
    assert.equal(isConfirmExpired(expires), true);
  });
});

describe('Execution mode resolution — only two modes', () => {
  it('Pro-like (no mt5AutoExecution) resolves manual', () => {
    const user = {
      subscription: { tier: 'professional', status: 'active' },
      mt5: { executionMode: null }
    };
    const mode = Mt5TradeCopierService.resolveExecutionMode(user);
    assert.equal(mode, 'manual');
  });

  it('explicit manual is never upgraded without tier', () => {
    const user = {
      subscription: { tier: 'professional', status: 'active' },
      mt5: { executionMode: 'manual' }
    };
    assert.equal(Mt5TradeCopierService.resolveExecutionMode(user), 'manual');
    assert.equal(resolveExecutionMode(user), 'manual');
  });

  it('explicit auto without Premium feature collapses to manual', () => {
    const user = {
      subscription: { tier: 'basic', status: 'active' },
      mt5: { executionMode: 'auto' }
    };
    assert.equal(Mt5TradeCopierService.resolveExecutionMode(user), 'manual');
  });

  it('telegramMode does not alter executionMode', () => {
    const user = {
      subscription: { tier: 'professional', status: 'active' },
      mt5: { executionMode: 'manual' },
      telegram: { telegramMode: 'alerts_only' }
    };
    assert.equal(Mt5TradeCopierService.resolveExecutionMode(user), 'manual');
  });
});
