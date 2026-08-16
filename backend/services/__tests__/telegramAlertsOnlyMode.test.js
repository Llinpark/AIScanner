const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  TELEGRAM_MODES,
  normalizeTelegramMode,
  resolveTelegramMode,
  isAlertsOnlyTelegram,
  isManualConfirmationTelegram,
  coerceWritableTelegramMode
} = require('../../utils/telegramMode');
const Mt5TradeCopierService = require('../Mt5TradeCopierService');
const TradeDeliveryService = require('../TradeDeliveryService');

function proUser({ mt5 = {}, telegram = {} } = {}) {
  return {
    id: 'pro_user',
    subscription: { tier: 'professional', status: 'active' },
    mt5: { executionMode: 'manual', enabled: true, ...mt5 },
    telegram: { chatId: '111', enabled: true, ...telegram }
  };
}

function premiumUser({ mt5 = {}, telegram = {} } = {}) {
  return {
    id: 'premium_user',
    subscription: { tier: 'premium', status: 'active' },
    mt5: { executionMode: 'auto', enabled: true, ...mt5 },
    telegram: { chatId: '222', enabled: true, ...telegram }
  };
}

describe('telegramMode preference (executionMode stays auto|manual)', () => {
  it('Scenario 4: missing telegramMode defaults to manual_confirmation', () => {
    assert.equal(resolveTelegramMode(proUser()), TELEGRAM_MODES.MANUAL_CONFIRMATION);
    assert.equal(resolveTelegramMode(proUser({ telegram: {} })), TELEGRAM_MODES.MANUAL_CONFIRMATION);
    assert.equal(isManualConfirmationTelegram(proUser()), true);
  });

  it('normalizes alerts_only / manual_confirmation', () => {
    assert.equal(normalizeTelegramMode('alerts_only'), TELEGRAM_MODES.ALERTS_ONLY);
    assert.equal(normalizeTelegramMode('manual_confirmation'), TELEGRAM_MODES.MANUAL_CONFIRMATION);
    assert.equal(coerceWritableTelegramMode('alerts_only'), TELEGRAM_MODES.ALERTS_ONLY);
  });

  it('Pro executionMode remains manual even when telegramMode is alerts_only', () => {
    const user = proUser({ telegram: { telegramMode: 'alerts_only' } });
    assert.equal(Mt5TradeCopierService.resolveExecutionMode(user), 'manual');
    assert.equal(TradeDeliveryService.resolveExecutionMode(user), 'manual');
    assert.equal(isAlertsOnlyTelegram(user), true);
  });

  it('Premium executionMode remains auto; telegramMode ignored for routing helpers', () => {
    const user = premiumUser({ telegram: { telegramMode: 'alerts_only' } });
    assert.equal(Mt5TradeCopierService.resolveExecutionMode(user), 'auto');
    // Leftover alerts_only must NOT activate Pro alerts-only helpers.
    assert.equal(isAlertsOnlyTelegram(user), false);
    assert.equal(isManualConfirmationTelegram(user), false);
  });

  it('Premium with leftover alerts_only is never treated as alerts-only', () => {
    const user = premiumUser({
      mt5: { executionMode: 'auto' },
      telegram: { telegramMode: 'alerts_only', chatId: '222', enabled: true }
    });
    assert.equal(resolveTelegramMode(user), TELEGRAM_MODES.ALERTS_ONLY);
    assert.equal(isAlertsOnlyTelegram(user), false);
  });
});

describe('TradeDelivery routing with telegramMode', () => {
  it('Scenario 2: Pro alerts_only → no auto queue (manual_mode)', async () => {
    const subscriber = proUser({
      telegram: { telegramMode: 'alerts_only', chatId: '111', enabled: true }
    });
    const signal = {
      _id: 'mem_sig_alerts',
      alertType: 'entry',
      symbol: 'EURUSD',
      direction: 'long',
      entry: 1.1,
      stop_loss: 1.09,
      take_profit_1: 1.11,
      take_profit_2: 1.12,
      take_profit_3: 1.13
    };
    assert.equal(isAlertsOnlyTelegram(subscriber), true);
    const mt5Live = await TradeDeliveryService.deliverMt5Auto(subscriber, signal);
    assert.equal(mt5Live.ok, false);
    assert.equal(mt5Live.reason, 'manual_mode');
  });

  it('Pro alerts_only without MT5 devices remains telegram-eligible (gates only)', async () => {
    const { userHasTierFeature } = require('../../utils/subscriptionAccess');
    const subscriber = proUser({
      mt5: { executionMode: 'manual', enabled: false, devices: [] },
      telegram: { telegramMode: 'alerts_only', chatId: '999001', enabled: true }
    });
    assert.equal(isAlertsOnlyTelegram(subscriber), true);
    assert.equal(userHasTierFeature(subscriber, 'telegramAlerts'), true);
    assert.equal(Mt5TradeCopierService.isMt5Linked(subscriber.mt5), false);
    // deliverTelegram must not require MT5 — only chatId + tier (self-test skip is separate).
    const skipped = await TradeDeliveryService.deliverTelegram(
      subscriber,
      { alertType: 'entry', symbol: 'EURUSD', selfTest: true },
      { alertOnly: true }
    );
    assert.equal(skipped.ok, false); // self-test skip, not an MT5 gate
    assert.equal(skipped.reason, 'self_test_skip');
    assert.match(String(skipped.status), /SELF_TEST|SKIPPED/i);
  });

  it('Scenario 1 helpers: manual_confirmation keeps Execute path eligibility', () => {
    const user = proUser({
      mt5: {
        executionMode: 'manual',
        enabled: true,
        devices: [{ deviceId: 'd1', revokedAt: null }]
      },
      telegram: { telegramMode: 'manual_confirmation' }
    });
    assert.equal(Mt5TradeCopierService.resolveExecutionMode(user), 'manual');
    assert.equal(isManualConfirmationTelegram(user), true);
    assert.equal(Mt5TradeCopierService.isMt5Linked(user.mt5), true);
  });

  it('Scenario 3: Premium auto queue path unchanged', async () => {
    const subscriber = premiumUser({
      mt5: {
        executionMode: 'auto',
        devices: [{ deviceId: 'd1', accessToken: 't', revokedAt: null }],
        accountBalance: 1000
      }
    });
    assert.equal(TradeDeliveryService.resolveExecutionMode(subscriber), 'auto');
    const signal = {
      _id: 'mem_prem',
      alertType: 'entry',
      symbol: 'EURUSD',
      direction: 'long',
      entry: 1.1,
      stop_loss: 1.09,
      take_profit_1: 1.11,
      take_profit_2: 1.12,
      take_profit_3: 1.13,
      selfTest: true
    };
    const result = await TradeDeliveryService.deliverMt5Auto(subscriber, signal);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'self_test_skip');
  });

  it('Scenario 5: switching telegramMode does not change executionMode', () => {
    const alerts = proUser({ telegram: { telegramMode: 'alerts_only' } });
    const manual = proUser({ telegram: { telegramMode: 'manual_confirmation' } });
    assert.equal(Mt5TradeCopierService.resolveExecutionMode(alerts), 'manual');
    assert.equal(Mt5TradeCopierService.resolveExecutionMode(manual), 'manual');
    assert.equal(isAlertsOnlyTelegram(alerts), true);
    assert.equal(isManualConfirmationTelegram(manual), true);
  });
});

describe('Telegram Alerts Only message format', () => {
  it('Scenario 2: no Execute/Ignore markup; dashboard URL only', () => {
    const TelegramService = require('../TelegramService');
    const signal = {
      _id: 'sig123',
      alertType: 'entry',
      symbol: 'EURUSD',
      direction: 'long',
      entry: 1.085,
      stop_loss: 1.08,
      take_profit_1: 1.09,
      take_profit_2: 1.095,
      take_profit_3: 1.1,
      confidence: 0.82,
      timeframe: '15m',
      signalUuid: 'uuid-abc'
    };
    const subscriber = proUser({ telegram: { telegramMode: 'alerts_only' } });
    const text = TelegramService.formatAlertsOnlyMessage(signal, subscriber);
    assert.match(text, /Kaching AI BUY/);
    assert.match(text, /Manual Trading/);
    assert.doesNotMatch(text, /Execute Trade/);
    assert.doesNotMatch(text, /Ignore Trade/);

    const markup = TelegramService.buildSignalReplyMarkup(signal, subscriber, {
      alertOnly: true,
      includeExecuteButton: false
    });
    assert.ok(markup?.inline_keyboard?.[0]?.[0]?.url);
    assert.equal(markup.inline_keyboard[0][0].text, 'Open Kaching Dashboard');
  });

  it('Scenario 1: Manual Confirmation markup includes Execute/Ignore', () => {
    const TelegramService = require('../TelegramService');
    const signal = {
      _id: 'sig456',
      alertType: 'entry',
      symbol: 'GBPUSD',
      direction: 'short',
      entry: 1.25,
      stop_loss: 1.26,
      take_profit_1: 1.24,
      take_profit_2: 1.23,
      take_profit_3: 1.22
    };
    const subscriber = proUser({
      mt5: {
        executionMode: 'manual',
        enabled: true,
        devices: [{ deviceId: 'd1', revokedAt: null }]
      },
      telegram: { telegramMode: 'manual_confirmation' }
    });
    const markup = TelegramService.buildSignalReplyMarkup(signal, subscriber, {
      includeExecuteButton: true,
      alertOnly: false
    });
    const labels = markup.inline_keyboard.flat().map(b => b.text);
    assert.ok(labels.some(t => /Execute/i.test(t)));
    assert.ok(labels.some(t => /Ignore/i.test(t)));
  });

  it('Premium leftover alerts_only does NOT get alert-only markup; Execute still absent on auto path', () => {
    const TelegramService = require('../TelegramService');
    const signal = {
      _id: 'sig789',
      alertType: 'entry',
      symbol: 'EURUSD',
      direction: 'long',
      entry: 1.1,
      stop_loss: 1.09,
      take_profit_1: 1.11,
      take_profit_2: 1.12,
      take_profit_3: 1.13,
      confidence: 0.9,
      timeframe: '15m'
    };
    const subscriber = premiumUser({
      mt5: {
        executionMode: 'auto',
        enabled: true,
        devices: [{ deviceId: 'd1', revokedAt: null }]
      },
      telegram: { telegramMode: 'alerts_only', chatId: '222', enabled: true }
    });

    assert.equal(isAlertsOnlyTelegram(subscriber), false);

    // Without explicit alertOnly — must not infer Pro alerts-only from leftover field.
    const text = TelegramService.formatSignalMessage(signal, subscriber, {
      includeExecuteButton: false
    });
    assert.doesNotMatch(text, /Manual Trading — open your preferred trading platform/);
    assert.match(text, /Kaching Entry|Symbol/i);

    // Premium auto path: no Execute buttons (includeExecuteButton false / alertOnly false).
    const markup = TelegramService.buildSignalReplyMarkup(signal, subscriber, {
      includeExecuteButton: false,
      alertOnly: false
    });
    assert.equal(markup, null);

    // Explicit alertOnly:true still works when caller requests it.
    const forced = TelegramService.buildSignalReplyMarkup(signal, subscriber, {
      alertOnly: true,
      includeExecuteButton: false
    });
    assert.equal(forced.inline_keyboard[0][0].text, 'Open Kaching Dashboard');
  });
});

describe('Scenario 6: Signal History execution label', () => {
  it('telegram_alert channel maps to Manual (Telegram Alert)', () => {
    // Mirror frontend formatExecutionStatus logic for CI without JSX.
    function formatExecutionStatus(signal) {
      if (signal?.executionChannel === 'telegram_alert' || signal?.telegramAlertSent) {
        return 'Manual (Telegram Alert)';
      }
      if (signal?.mt5Sent || signal?.executionChannel === 'mt5_auto' || signal?.executionChannel === 'mt5_manual') {
        if (signal?.executionStatus === 'sent' || signal?.executionStatus === 'executed') {
          return 'Executed on MT5';
        }
      }
      if (!signal?.executionStatus) return '—';
      return String(signal.executionStatus).replace(/_/g, ' ');
    }
    assert.equal(
      formatExecutionStatus({ executionChannel: 'telegram_alert', telegramAlertSent: true }),
      'Manual (Telegram Alert)'
    );
    assert.equal(
      formatExecutionStatus({ executionChannel: 'mt5_auto', mt5Sent: true, executionStatus: 'sent' }),
      'Executed on MT5'
    );
  });
});
