/**
 * Subscriber-facing formatter + raw-payload safety.
 * Never hits real Email / Telegram / production users.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const Formatter = require('../SubscriberSignalFormatter');
const { sendTradeAlertEmail } = require('../../utils/mailer');
const TelegramService = require('../TelegramService');
const TradeDeliveryService = require('../TradeDeliveryService');
const { buildSignalData } = require('../TradingViewAlertService');

function eurusdBuy(overrides = {}) {
  return {
    _id: 'sig_fmt_1',
    alertType: 'entry',
    symbol: 'EURUSD',
    direction: 'buy',
    entry: 1.1754,
    stop_loss: 1.1745,
    take_profit_1: 1.1762,
    take_profit_2: 1.177,
    take_profit_3: 1.1782,
    ...overrides
  };
}

function expectedBuyEmail() {
  return [
    'KACHING BUY SIGNAL',
    '',
    'EURUSD',
    '',
    'Entry: 1.17540',
    '',
    'Take Profits',
    'TP1: 1.17620',
    'TP2: 1.17700',
    'TP3: 1.17820',
    '',
    'Stop Loss',
    'SL: 1.17450',
    '',
    'KachingScanner / Your Trading Partner'
  ].join('\n');
}

function expectedSellEmail() {
  return expectedBuyEmail().replace(/BUY/g, 'SELL');
}

function expectedBuyTelegram() {
  return [
    '🟢 KACHING BUY',
    '',
    'EURUSD',
    '',
    '📍 Entry: 1.17540',
    '',
    '🎯 TP1: 1.17620',
    '🎯 TP2: 1.17700',
    '🎯 TP3: 1.17820',
    '',
    '🛑 SL: 1.17450'
  ].join('\n');
}

function expectedSellTelegram() {
  return expectedBuyTelegram().replace('🟢 KACHING BUY', '🔴 KACHING SELL');
}

function rawWebhookJson() {
  return JSON.stringify({
    symbol: 'EURUSD',
    direction: 'buy',
    entry: 1.1754,
    stop_loss: 1.1745,
    take_profit_1: 1.1762,
    take_profit_2: 1.177,
    take_profit_3: 1.1782,
    licenseToken: 'super-secret-license',
    signalUuid: 'uuid-raw-1',
    canonicalSignalKey: 'EURUSD|15m|uuid-raw-1',
    scriptGenerationId: 'gen-raw',
    generatedAt: '2026-08-20T00:00:00.000Z',
    tradingviewUsername: 'tv_trader'
  });
}

function proSubscriber(overrides = {}) {
  return {
    id: 'pro_fmt',
    email: 'pro-fmt@example.com',
    subscription: { tier: 'professional', status: 'active' },
    telegram: { chatId: '111001', enabled: true, telegramMode: 'manual_confirmation' },
    mt5: { executionMode: 'manual', enabled: true, devices: [] },
    ...overrides
  };
}

function premiumSubscriber(overrides = {}) {
  return {
    id: 'prem_fmt',
    email: 'premium-fmt@example.com',
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

describe('1. BUY Email + Telegram format', () => {
  it('matches the subscriber presentation contract', () => {
    const formatted = Formatter.formatPresentation(eurusdBuy());
    assert.equal(formatted.ok, true);
    assert.equal(formatted.subject, 'Kaching BUY — EURUSD');
    assert.equal(formatted.text.trim(), expectedBuyEmail());
    assert.equal(formatted.telegramText.trim(), expectedBuyTelegram());
  });
});

describe('2. SELL Email + Telegram format', () => {
  it('uses SELL copy and red telegram marker', () => {
    const formatted = Formatter.formatPresentation(eurusdBuy({ direction: 'sell' }));
    assert.equal(formatted.ok, true);
    assert.equal(formatted.subject, 'Kaching SELL — EURUSD');
    assert.equal(formatted.text.trim(), expectedSellEmail());
    assert.equal(formatted.telegramText.trim(), expectedSellTelegram());
  });
});

describe('3. Raw payload block', () => {
  it('blocks JSON starting with {"symbol": and sensitive keys', () => {
    const raw = rawWebhookJson();
    const blocked = Formatter.assertSafeSubscriberContent(raw, {
      channel: 'email',
      symbol: 'EURUSD',
      alertType: 'entry',
      safeId: 'hashed'
    });
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.reason, 'blocked_raw_payload');
    assert.equal(Formatter.looksLikeRawPayload(raw), true);
    assert.equal(Formatter.looksLikeRawPayload('{"symbol":"EURUSD","entry":1}'), true);
    assert.equal(Formatter.looksLikeRawPayload(expectedBuyTelegram()), false);
  });

  it('does not put licenseToken / signalUuid into formatted output', () => {
    const formatted = Formatter.formatEmail({
      ...eurusdBuy(),
      licenseToken: 'super-secret-license',
      signalUuid: 'uuid-raw-1',
      canonicalSignalKey: 'key',
      scriptGenerationId: 'gen',
      generatedAt: '2026-08-20T00:00:00.000Z',
      tradingviewUsername: 'tv_trader',
      notes: rawWebhookJson()
    });
    assert.equal(formatted.ok, true);
    assert.doesNotMatch(formatted.text, /licenseToken|signalUuid|canonicalSignalKey|scriptGenerationId|generatedAt|tradingviewUsername/);
    assert.doesNotMatch(formatted.text, /super-secret-license/);
    assert.doesNotMatch(formatted.telegramText, /super-secret-license|uuid-raw-1/);
  });
});

describe('4. Email path uses formatter (mocked Resend, never real users)', () => {
  const originalFetch = global.fetch;
  let captured;

  beforeEach(() => {
    captured = null;
    process.env.RESEND_API_KEY = 'test-not-real';
    delete process.env.SMTP_HOST;
    global.fetch = async (url, init) => {
      assert.match(String(url), /api\.resend\.com\/emails/);
      captured = JSON.parse(init.body);
      return {
        ok: true,
        async json() {
          return { id: 'email_test_1' };
        }
      };
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.RESEND_API_KEY;
  });

  it('sends formatted BUY email, not raw webhook JSON', async () => {
    const result = await sendTradeAlertEmail({
      to: 'fmt-test@example.com',
      signal: { ...eurusdBuy(), notes: rawWebhookJson(), licenseToken: 'secret' }
    });
    assert.equal(result.ok, true);
    assert.equal(captured.subject, 'Kaching BUY — EURUSD');
    assert.equal(String(captured.text).trim(), expectedBuyEmail());
    assert.doesNotMatch(captured.text, /licenseToken|super-secret-license|\{"symbol":/);
    assert.doesNotMatch(captured.html, /licenseToken|\{"symbol":/);
  });

  it('blocked raw presentation does not send JSON body', async () => {
    const result = await sendTradeAlertEmail({
      to: 'fmt-test@example.com',
      signal: eurusdBuy(),
      presentation: {
        ok: true,
        subject: 'Kaching BUY — EURUSD',
        text: rawWebhookJson(),
        html: `<pre>${rawWebhookJson()}</pre>`,
        symbol: 'EURUSD',
        alertType: 'entry',
        safeId: 'x'
      }
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'blocked_raw_payload');
    assert.equal(captured, null);
  });
});

describe('5. Telegram path uses formatter (mocked Bot API)', () => {
  const originalFetch = global.fetch;
  let capturedText;

  beforeEach(() => {
    capturedText = null;
    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token-not-real';
    global.fetch = async (url, init) => {
      assert.match(String(url), /api\.telegram\.org\/bot/);
      const body = JSON.parse(init.body);
      capturedText = body.text;
      return {
        ok: true,
        async json() {
          return { ok: true, result: { message_id: 99 } };
        }
      };
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it('sends formatted BUY telegram, not raw JSON or signalUuid', async () => {
    const result = await TradeDeliveryService.deliverTelegram(
      proSubscriber(),
      { ...eurusdBuy(), notes: rawWebhookJson(), signalUuid: 'uuid-raw-1' }
    );
    assert.equal(result.ok, true);
    assert.equal(capturedText.trim(), expectedBuyTelegram());
    assert.doesNotMatch(capturedText, /licenseToken|signalUuid|\{"symbol":/);
  });
});

describe('6. Missing TP2/TP3 are omitted (never undefined/null/NaN)', () => {
  it('omits absent take-profit lines', () => {
    const formatted = Formatter.formatPresentation(
      eurusdBuy({ take_profit_2: undefined, take_profit_3: null })
    );
    assert.equal(formatted.ok, true);
    assert.match(formatted.text, /TP1: 1\.17620/);
    assert.doesNotMatch(formatted.text, /TP2/);
    assert.doesNotMatch(formatted.text, /TP3/);
    assert.doesNotMatch(formatted.text, /undefined|null|NaN/);
    assert.doesNotMatch(formatted.telegramText, /TP2|TP3|undefined|null|NaN/);
    assert.match(formatted.telegramText, /🎯 TP1: 1\.17620/);
  });
});

describe('7. Stale ENTRY is not sent as a fresh alert', () => {
  it('detects expired / closed / terminal entries', () => {
    assert.equal(
      Formatter.isStaleFreshEntry(
        eurusdBuy({ expiresAt: new Date(Date.now() - 60_000) })
      ),
      true
    );
    assert.equal(
      Formatter.isStaleFreshEntry(eurusdBuy({ tradeStatus: 'expired', outcome: 'expired' })),
      true
    );
    assert.equal(
      Formatter.isStaleFreshEntry(eurusdBuy({ closedAt: new Date(), tradeStatus: 'won' })),
      true
    );
    assert.equal(Formatter.isStaleFreshEntry(eurusdBuy()), false);
    assert.equal(
      Formatter.isStaleFreshEntry({ ...eurusdBuy(), alertType: 'take_profit_1', tradeStatus: 'partial' }),
      false
    );
  });

  it('email and telegram skip stale entries (mocked, no real send)', async () => {
    const stale = eurusdBuy({ tradeStatus: 'expired', outcome: 'expired', closedAt: new Date() });
    const email = await TradeDeliveryService.deliverEmail(proSubscriber(), stale);
    assert.equal(email.ok, false);
    assert.equal(email.reason, 'stale_entry');
    const tg = await TradeDeliveryService.deliverTelegram(proSubscriber(), stale);
    assert.equal(tg.ok, false);
    assert.equal(tg.reason, 'stale_entry');
  });
});

describe('8. Duplicate signal — formatter is presentation-only', () => {
  it('does not persist Mongo Signals or require the Signal model', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../SubscriberSignalFormatter.js'),
      'utf8'
    );
    assert.doesNotMatch(src, /models\/Signal/);
    assert.doesNotMatch(src, /mongoose/);
    const a = Formatter.formatPresentation(eurusdBuy());
    const b = Formatter.formatPresentation(eurusdBuy());
    assert.equal(a.text, b.text);
    assert.equal(a.telegramText, b.telegramText);
  });
});

describe('9. Price precision', () => {
  it('uses forex 5 / JPY 3 / XAU 2 / XAG 3 / indices 2 / crypto 2', () => {
    assert.equal(Formatter.formatSubscriberPrice(1.1754, 'EURUSD'), '1.17540');
    assert.equal(Formatter.formatSubscriberPrice(1.26812, 'GBPUSD'), '1.26812');
    assert.equal(Formatter.formatSubscriberPrice(149.523, 'USDJPY'), '149.523');
    assert.equal(Formatter.formatSubscriberPrice(2650.4, 'XAUUSD'), '2650.40');
    assert.equal(Formatter.formatSubscriberPrice(31.256, 'XAGUSD'), '31.256');
    assert.equal(Formatter.formatSubscriberPrice(39100.5, 'US30'), '39100.50');
    assert.equal(Formatter.formatSubscriberPrice(64012.3, 'BTCUSD'), '64012.30');
  });
});

describe('10. Plan delivery regression (mocked channels)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token-not-real';
    process.env.RESEND_API_KEY = 'test-not-real';
    delete process.env.SMTP_HOST;
    global.fetch = async url => {
      const href = String(url);
      if (href.includes('api.telegram.org')) {
        return {
          ok: true,
          async json() {
            return { ok: true, result: { message_id: 7 } };
          }
        };
      }
      if (href.includes('api.resend.com')) {
        return {
          ok: true,
          async json() {
            return { id: 'mail_7' };
          }
        };
      }
      throw new Error(`unexpected fetch ${href}`);
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.RESEND_API_KEY;
  });

  it('Pro Telegram, Premium Telegram, telegram-only, Email, and Premium MT5 skip isolation', async () => {
    const signal = eurusdBuy();
    const proTg = await TradeDeliveryService.deliverTelegram(proSubscriber(), signal);
    assert.equal(proTg.ok, true, 'Pro Telegram must still send');

    const premTg = await TradeDeliveryService.deliverTelegram(premiumSubscriber(), signal);
    assert.equal(premTg.ok, true, 'Premium Telegram must still send');

    const alertsOnly = await TradeDeliveryService.deliverTelegram(
      proSubscriber({
        telegram: { chatId: '111001', enabled: true, telegramMode: 'alerts_only' }
      }),
      signal,
      { alertOnly: true }
    );
    assert.equal(alertsOnly.ok, true, 'telegram-only must still send');

    const email = await TradeDeliveryService.deliverEmail(proSubscriber(), signal);
    assert.equal(email.ok, true, 'Email must still send formatted alert');

    const mt5 = await TradeDeliveryService.deliverMt5Auto(
      premiumSubscriber(),
      { ...signal, selfTest: true }
    );
    assert.equal(mt5.reason, 'self_test_skip');
  });
});

describe('Ingest notes sanitization', () => {
  it('buildSignalData never stores raw webhook JSON as notes', () => {
    const data = buildSignalData({
      symbol: 'EURUSD',
      direction: 'long',
      alertType: 'entry',
      entry: 1.1754,
      stop_loss: 1.1745,
      take_profit_1: 1.1762,
      take_profit_2: 1.177,
      take_profit_3: 1.1782,
      message: rawWebhookJson()
    });
    assert.doesNotMatch(String(data.notes), /licenseToken|\{"symbol":/);
  });

  it('converts literal backslash-n from Pine message into real newlines', () => {
    const pineBlob = '🟦 Kaching BUY\\nEntry: 4641.695\\nSL: 4639.836\\nTP1: 4644.483\\nTP2: 4645.412\\nTP3: 4647.271';
    const notes = Formatter.sanitizeSubscriberNotes(pineBlob);
    assert.equal(notes.includes('\\n'), false);
    assert.equal(
      notes,
      [
        '🟦 Kaching BUY',
        'Entry: 4641.695',
        'SL: 4639.836',
        'TP1: 4644.483',
        'TP2: 4645.412',
        'TP3: 4647.271'
      ].join('\n')
    );
  });

  it('leaves real newlines unchanged and still blocks raw JSON', () => {
    const alreadyBroken = '🟦 Kaching BUY\nEntry: 1.17\nSL: 1.16';
    assert.equal(Formatter.sanitizeSubscriberNotes(alreadyBroken), alreadyBroken);
    assert.equal(Formatter.sanitizeSubscriberNotes(rawWebhookJson()), 'Kaching Signal');
  });
});

describe('Lifecycle presentation names', () => {
  it('TP1/TP2 use UPDATE, TP3 COMPLETE, SL CLOSED', () => {
    const tp1 = Formatter.formatTelegram({
      ...eurusdBuy(),
      alertType: 'take_profit_1'
    });
    assert.match(tp1.telegramText, /🎯 KACHING UPDATE/);
    assert.match(tp1.telegramText, /TP1 HIT/);
    const tp3 = Formatter.formatTelegram({ ...eurusdBuy(), alertType: 'take_profit_3' });
    assert.match(tp3.telegramText, /🏆 KACHING TRADE COMPLETE/);
    const sl = Formatter.formatTelegram({ ...eurusdBuy(), alertType: 'stop_loss' });
    assert.match(sl.telegramText, /🛑 KACHING TRADE CLOSED/);
  });
});
