/**
 * Telegram trade-alert delivery regression suite.
 * Covers eligibility gates, alerts_only / Premium Auto isolation from MT5,
 * API error preservation, and /link path stability.
 */
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const TelegramService = require('../TelegramService');
const TradeDeliveryService = require('../TradeDeliveryService');
const { subscriberAllowsSignal } = require('../TradingViewAlertService');

function entrySignal(overrides = {}) {
  return {
    _id: 'sig_tg_1',
    signalUuid: 'uuid-tg-1',
    alertType: 'entry',
    symbol: 'EURUSD',
    direction: 'long',
    timeframe: '15m',
    entry: 1.1,
    stop_loss: 1.09,
    take_profit_1: 1.11,
    take_profit_2: 1.12,
    take_profit_3: 1.13,
    confidence: 0.8,
    ...overrides
  };
}

function proSubscriber(overrides = {}) {
  return {
    id: 'pro_1',
    email: 'pro@example.com',
    subscription: { tier: 'professional', status: 'active' },
    telegram: { chatId: '111001', enabled: true, telegramMode: 'manual_confirmation' },
    mt5: { executionMode: 'manual', enabled: true, devices: [] },
    ...overrides
  };
}

function premiumSubscriber(overrides = {}) {
  return {
    id: 'prem_1',
    email: 'premium@example.com',
    subscription: { tier: 'premium', status: 'active' },
    telegram: { chatId: '222002', enabled: true },
    mt5: {
      executionMode: 'auto',
      enabled: true,
      devices: [{ deviceId: 'd1', accessToken: 't', revokedAt: null }],
      accountBalance: 1000
    },
    ...overrides
  };
}

describe('Telegram trade-alert delivery gates', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token-not-real';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.PIPELINE_SELF_TEST_ACTIVE;
    mock.restoreAll();
  });

  function mockTelegramApi(handler) {
    global.fetch = async (url, init) => {
      assert.match(String(url), /api\.telegram\.org\/bot/);
      return handler(url, init);
    };
  }

  function okSendResponse(messageId = 42) {
    return {
      ok: true,
      async json() {
        return { ok: true, result: { message_id: messageId } };
      }
    };
  }

  function errSendResponse(httpStatus, errorCode, description) {
    return {
      ok: false,
      status: httpStatus,
      async json() {
        return { ok: false, error_code: errorCode, description };
      }
    };
  }

  it('A. Active Pro + linked Telegram + valid signal → delivery attempted/success', async () => {
    mockTelegramApi(async () => okSendResponse(1001));
    const result = await TradeDeliveryService.deliverTelegram(proSubscriber(), entrySignal());
    assert.equal(result.ok, true);
    assert.equal(result.status, TelegramService.TELEGRAM_STATUS.SEND_SUCCESS);
    assert.equal(result.telegramMessageId, 1001);
  });

  it('B. Active Premium + linked Telegram + valid signal → delivery attempted/success', async () => {
    mockTelegramApi(async () => okSendResponse(1002));
    const result = await TradeDeliveryService.deliverTelegram(premiumSubscriber(), entrySignal());
    assert.equal(result.ok, true);
    assert.equal(result.status, TelegramService.TELEGRAM_STATUS.SEND_SUCCESS);
  });

  it('C. Premium Auto → Telegram still occurs (MT5-independent)', async () => {
    mockTelegramApi(async () => okSendResponse(1003));
    const sub = premiumSubscriber({ mt5: { executionMode: 'auto', enabled: true, devices: [] } });
    const result = await TradeDeliveryService.deliverTelegram(sub, entrySignal());
    assert.equal(result.ok, true);
    const mt5 = await TradeDeliveryService.deliverMt5Auto(sub, entrySignal({ selfTest: true }));
    assert.equal(mt5.reason, 'self_test_skip');
  });

  it('D. alerts_only → Telegram still occurs', async () => {
    mockTelegramApi(async () => okSendResponse(1004));
    const sub = proSubscriber({
      telegram: { chatId: '111001', enabled: true, telegramMode: 'alerts_only' }
    });
    const result = await TradeDeliveryService.deliverTelegram(sub, entrySignal(), { alertOnly: true });
    assert.equal(result.ok, true);
    assert.equal(result.status, TelegramService.TELEGRAM_STATUS.SEND_SUCCESS);
  });

  it('E. Telegram enabled → delivery occurs', async () => {
    mockTelegramApi(async () => okSendResponse(1005));
    const result = await TradeDeliveryService.deliverTelegram(
      proSubscriber({ telegram: { chatId: '111', enabled: true } }),
      entrySignal()
    );
    assert.equal(result.ok, true);
  });

  it('F. Telegram disabled → skipped with explicit reason', async () => {
    const result = await TradeDeliveryService.deliverTelegram(
      proSubscriber({ telegram: { chatId: '111', enabled: false } }),
      entrySignal()
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, TelegramService.TELEGRAM_STATUS.SKIPPED_DISABLED);
    assert.equal(result.reason, 'telegram_disabled');
  });

  it('G. Missing chatId → skipped with explicit reason', async () => {
    const result = await TradeDeliveryService.deliverTelegram(
      proSubscriber({ telegram: { chatId: null, enabled: true } }),
      entrySignal()
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, TelegramService.TELEGRAM_STATUS.SKIPPED_NO_CHAT_ID);
    assert.equal(result.reason, 'missing_chat_id');
  });

  it('H. Insufficient tier → skipped with explicit reason', async () => {
    const result = await TradeDeliveryService.deliverTelegram(
      {
        id: 'basic_1',
        email: 'basic@example.com',
        subscription: { tier: 'basic', status: 'active' },
        telegram: { chatId: '999', enabled: true }
      },
      entrySignal()
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, TelegramService.TELEGRAM_STATUS.SKIPPED_TIER);
    assert.equal(result.reason, 'insufficient_tier');
  });

  it('I. Subscriber not active → excluded by live-alert gate helper', () => {
    const { userCanAccessLiveAlerts } = require('../../utils/subscriptionAccess');
    const inactive = {
      subscription: { tier: 'professional', status: 'expired', current_period_end: new Date(0) }
    };
    assert.equal(userCanAccessLiveAlerts(inactive), false);
  });

  it('J. Symbol not allowed → subscriberAllowsSignal excludes', () => {
    const sub = {
      subscription: { tier: 'professional', status: 'active' }
    };
    assert.equal(subscriberAllowsSignal(sub, { symbol: '', timeframe: '15m' }), false);
    assert.equal(subscriberAllowsSignal(sub, { symbol: 'EURUSD', timeframe: '15m' }), true);
  });

  it('M. Telegram API success → recorded', async () => {
    mockTelegramApi(async () => okSendResponse(777));
    const result = await TelegramService.notifySubscriber(proSubscriber(), entrySignal());
    assert.equal(result.ok, true);
    assert.equal(result.status, TelegramService.TELEGRAM_STATUS.SEND_SUCCESS);
    assert.equal(result.telegramMessageId, 777);
  });

  it('N. Telegram API 400 → failure preserves actual error', async () => {
    mockTelegramApi(async () =>
      errSendResponse(400, 400, "Bad Request: can't parse entities")
    );
    const result = await TradeDeliveryService.deliverTelegram(proSubscriber(), entrySignal());
    assert.equal(result.ok, false);
    assert.equal(result.status, TelegramService.TELEGRAM_STATUS.SEND_FAILED);
    assert.equal(result.httpStatus, 400);
    assert.equal(result.telegramErrorCode, 400);
    assert.match(result.description, /can't parse entities/i);
  });

  it('O. Telegram API 403 → failure preserves actual error', async () => {
    mockTelegramApi(async () =>
      errSendResponse(403, 403, 'Forbidden: bot was blocked by the user')
    );
    const result = await TradeDeliveryService.deliverTelegram(proSubscriber(), entrySignal());
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 403);
    assert.equal(result.telegramErrorCode, 403);
    assert.match(result.description, /blocked by the user/i);
  });

  it('P. Telegram API 429 → failure preserves actual error', async () => {
    mockTelegramApi(async () => errSendResponse(429, 429, 'Too Many Requests'));
    const result = await TradeDeliveryService.deliverTelegram(proSubscriber(), entrySignal());
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 429);
    assert.match(result.description, /Too Many Requests/i);
  });

  it('Q. Telegram API timeout/network error → captured without throwing', async () => {
    global.fetch = async () => {
      throw new Error('network timeout');
    };
    const result = await TradeDeliveryService.deliverTelegram(proSubscriber(), entrySignal());
    assert.equal(result.ok, false);
    assert.equal(result.status, TelegramService.TELEGRAM_STATUS.SEND_FAILED);
    assert.match(result.description || result.reason, /network timeout/i);
  });

  it('Pro Manual Confirmation message does not nest <b> inside <i>', () => {
    const text = TelegramService.formatSignalMessage(entrySignal(), proSubscriber(), {
      includeExecuteButton: true,
      confirmSeconds: 180
    });
    assert.doesNotMatch(text, /<i>[^<]*<b>/);
    assert.match(text, /Execute Trade/);
  });

  it('one subscriber Telegram failure does not imply boolean crash; channel isolation', async () => {
    mockTelegramApi(async () =>
      errSendResponse(403, 403, 'Forbidden: bot was blocked by the user')
    );
    const failed = await TradeDeliveryService.deliverTelegram(proSubscriber(), entrySignal());
    assert.equal(failed.ok, false);

    mockTelegramApi(async () => okSendResponse(55));
    const other = await TradeDeliveryService.deliverTelegram(
      premiumSubscriber({ email: 'other@example.com', telegram: { chatId: '333', enabled: true } }),
      entrySignal({ signalUuid: 'uuid-other' })
    );
    assert.equal(other.ok, true);
  });

  it('Telegram-only: Pro without MT5 linked still delivers Telegram; MT5 is expected skip', async () => {
    mockTelegramApi(async () => okSendResponse(7001));
    const sub = proSubscriber({
      mt5: { executionMode: 'manual', enabled: false, devices: [] }
    });
    const tg = await TradeDeliveryService.deliverTelegram(sub, entrySignal());
    assert.equal(tg.ok, true);

    const mt5 = await TradeDeliveryService.deliverMt5Auto(sub, entrySignal());
    assert.equal(mt5.ok, false);
    assert.equal(mt5.reason, 'manual_mode');
    assert.equal(TradeDeliveryService.isExpectedMt5Skip(mt5.reason), true);
    assert.equal(
      TradeDeliveryService.resolveDeliveryStatus({
        telegramSent: true,
        mt5Sent: false,
        tgPipelineStatus: 'PASS',
        mt5PipelineStatus: 'SKIP'
      }),
      'delivered'
    );
  });

  it('MT5 unavailable does not mark successful Telegram as overall failure', () => {
    assert.equal(
      TradeDeliveryService.resolveDeliveryStatus({
        telegramSent: true,
        mt5Sent: false,
        tgPipelineStatus: 'PASS',
        mt5PipelineStatus: 'SKIP'
      }),
      'delivered'
    );
    assert.equal(
      TradeDeliveryService.resolveDeliveryStatus({
        telegramSent: true,
        mt5Sent: false,
        tgPipelineStatus: 'PASS',
        mt5PipelineStatus: 'FAIL'
      }),
      'partial'
    );
    assert.equal(
      TradeDeliveryService.resolveDeliveryStatus({
        telegramSent: false,
        mt5Sent: false,
        tgPipelineStatus: 'FAIL',
        mt5PipelineStatus: 'SKIP'
      }),
      'failed'
    );
    assert.equal(TradeDeliveryService.isExpectedMt5Skip('mt5_not_linked'), true);
    assert.equal(TradeDeliveryService.isExpectedMt5Skip('queue_error'), false);
  });

  it('genuine Telegram failure with MT5 skip records overall failed (not delivered)', () => {
    assert.equal(
      TradeDeliveryService.resolveDeliveryStatus({
        telegramSent: false,
        mt5Sent: false,
        tgPipelineStatus: 'FAIL',
        mt5PipelineStatus: 'SKIP'
      }),
      'failed'
    );
  });

  it('genuine MT5 failure when attempted with Telegram PASS is partial', () => {
    assert.equal(
      TradeDeliveryService.resolveDeliveryStatus({
        telegramSent: true,
        mt5Sent: false,
        tgPipelineStatus: 'PASS',
        mt5PipelineStatus: 'FAIL'
      }),
      'partial'
    );
  });

  it('deliverToSubscriber: Telegram PASS + MT5 SKIP does not set lastFailureStage', async () => {
    const PipelineStatusService = require('../PipelineStatusService');
    PipelineStatusService.resetForTests?.();
    mockTelegramApi(async () => okSendResponse(8002));

    const io = { to: () => ({ emit() {} }), emit() {} };
    const sub = proSubscriber({
      mt5: { executionMode: 'manual', enabled: true, devices: [] }
    });
    await TradeDeliveryService.deliverToSubscriber(
      io,
      entrySignal({ _id: 'mem_tg_only_1', signalUuid: 'uuid-tg-only-1' }),
      sub
    );

    const status = await PipelineStatusService.getStatus();
    assert.ok(status.lastTelegram?.at || status.lastTelegramDelivery?.at);
    assert.notEqual(status.lastFailureStage, 'DeliveryMT5');
    const live = await PipelineStatusService.getLivePipeline(20);
    const mt5Events = (live.events || []).filter(e => e.type === 'DeliveryMT5');
    assert.ok(mt5Events.length >= 1);
    assert.equal(mt5Events[0].status, 'SKIP');
    const tgEvents = (live.events || []).filter(e => e.type === 'DeliveryTelegram');
    assert.ok(tgEvents.some(e => e.status === 'PASS'));
  });
});

describe('Telegram /link path regression', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it('R. /link sendMessage still returns Telegram result object (not status envelope)', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token-not-real';
    global.fetch = async () => ({
      ok: true,
      async json() {
        return { ok: true, result: { message_id: 9, text: 'linked' } };
      }
    });
    const result = await TelegramService.sendMessage('12345', '✅ Linked');
    assert.equal(result.message_id, 9);
    assert.equal(result.ok, undefined);
  });
});

describe('Telegram HTML / markup path differences', () => {
  it('alerts_only markup has dashboard URL only (no Execute)', () => {
    const markup = TelegramService.buildSignalReplyMarkup(
      entrySignal(),
      proSubscriber({ telegram: { chatId: '1', enabled: true, telegramMode: 'alerts_only' } }),
      { alertOnly: true, includeExecuteButton: false }
    );
    assert.equal(markup.inline_keyboard[0][0].text, 'Open Kaching Dashboard');
  });

  it('Premium auto path has no Execute markup', () => {
    const markup = TelegramService.buildSignalReplyMarkup(entrySignal(), premiumSubscriber(), {
      includeExecuteButton: false,
      alertOnly: false
    });
    assert.equal(markup, null);
  });
});
