/**
 * TradingView → auth → parse → schema → persist → broadcast → Telegram E2E.
 * Cases A–X from pipeline observability acceptance criteria.
 * Uses in-memory signals + mocked Telegram API. Never hits real Telegram/Mongo/prod.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const originalFetch = global.fetch;
const originalSigning = process.env.WEBHOOK_SIGNING_SECRET;
const originalTvSecret = process.env.TRADINGVIEW_WEBHOOK_SECRET;
const originalBot = process.env.TELEGRAM_BOT_TOKEN;
const originalNodeEnv = process.env.NODE_ENV;

const {
  generateLicenseToken,
  verifyTradingViewWebhook,
  parseWebhookBody,
  normalizeTradingViewUsername
} = require('../webhookSecurity');
const TradingViewAlertService = require('../../services/TradingViewAlertService');
const TradeDeliveryService = require('../../services/TradeDeliveryService');
const TelegramService = require('../../services/TelegramService');
const {
  resolveIntakeState,
  PIPELINE_INTAKE_STATE,
  redactRawPreview,
  redactObject,
  logTvStage,
  classifyWebhookGate,
  createRequestId,
  ensureRequestId
} = require('../webhookPipelineDiag');
const PipelineStatusService = require('../../services/PipelineStatusService');
const {
  resolveCompatibilityMode,
  extractPineClientMeta,
  COMPAT_MODE
} = require('../PineClientVersion');
const devUserStore = require('../devUserStore');

function validEntryPayload(overrides = {}) {
  return {
    symbol: 'EURUSD',
    strategyName: 'Liquidity Sweep + Fair Value Gap (Scalping)',
    timeframe: '15m',
    pattern: 'liquidity_sweep_fvg_scalp',
    alertType: 'entry',
    direction: 'long',
    entry: 1.1,
    stop_loss: 1.09,
    stop_loss_1: 1.09,
    take_profit_1: 1.11,
    take_profit_2: 1.12,
    take_profit_3: 1.13,
    confidence: 0.82,
    signalUuid: overrides.signalUuid || `uuid-${Date.now()}`,
    signalId: overrides.signalUuid || `uuid-${Date.now()}`,
    gapTop: 1.105,
    gapBottom: 1.1,
    message: '🟦 Kaching BUY',
    broadcast: true,
    pineClientVersion: '1.1.0',
    scriptGenerationId: 'gen-test-1',
    ...overrides
  };
}

function mockTelegramOk(messageId = 42) {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { ok: true, result: { message_id: messageId } };
    }
  });
}

function mockTelegramErr(httpStatus, code, description) {
  global.fetch = async () => ({
    ok: false,
    status: httpStatus,
    async json() {
      return { ok: false, error_code: code, description };
    }
  });
}

function captureLogs(fn) {
  const lines = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origErr = console.error;
  console.log = (...args) => {
    lines.push(args.map(String).join(' '));
    origLog(...args);
  };
  console.warn = (...args) => {
    lines.push(args.map(String).join(' '));
    origWarn(...args);
  };
  console.error = (...args) => {
    lines.push(args.map(String).join(' '));
    origErr(...args);
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origErr;
    })
    .then(result => ({ result, lines: lines.join('\n') }));
}

describe('webhook parse hardening (A/B)', () => {
  it('A. empty body → 400 WEBHOOK_PARSE_FAILED empty_body', async () => {
    const body = parseWebhookBody({ body: '   ' });
    assert.equal(body.__parseError, true);
    assert.equal(body.__parseReason, 'empty_body');
    const auth = await verifyTradingViewWebhook({ body: '   ', headers: {} }, async () => null);
    assert.equal(auth.ok, false);
    assert.equal(auth.parseError, true);
    assert.equal(auth.reason, 'empty_body');
    const gate = classifyWebhookGate(auth);
    assert.equal(gate.httpStatus, 400);
    assert.equal(gate.intakeState, PIPELINE_INTAKE_STATE.WEBHOOK_PARSE_FAILED);
    assert.equal(gate.reason, 'empty_body');
  });

  it('B. invalid JSON → 400 WEBHOOK_PARSE_FAILED invalid_json (not silent {})', async () => {
    const body = parseWebhookBody({ body: '{not-json' });
    assert.equal(body.__parseError, true);
    assert.equal(body.__parseReason, 'invalid_json');
    const auth = await verifyTradingViewWebhook({ body: '{not-json', headers: {} }, async () => null);
    assert.equal(auth.ok, false);
    assert.equal(auth.parseError, true);
    assert.equal(auth.reason, 'invalid_json');
    const gate = classifyWebhookGate(auth);
    assert.equal(gate.httpStatus, 400);
    assert.equal(gate.intakeState, PIPELINE_INTAKE_STATE.WEBHOOK_PARSE_FAILED);
    // Must not collapse to unauthorized / empty object auth path.
    assert.notEqual(auth.reason, 'unauthorized');
  });

  it('C. literal {{alert_message}} → unexpanded_tv_placeholder (clear diagnosis)', async () => {
    const raw = '{{alert_message}}';
    const body = parseWebhookBody({ body: raw });
    assert.equal(body.__parseError, true);
    assert.equal(body.__parseReason, 'unexpanded_tv_placeholder');
    assert.equal(body.__parseKind, 'alert_message_placeholder');
    assert.match(String(body.__parseHint || ''), /Any alert\(\) function call/);
    const auth = await verifyTradingViewWebhook({ body: raw, headers: {} }, async () => null);
    assert.equal(auth.ok, false);
    assert.equal(auth.parseError, true);
    assert.equal(auth.reason, 'unexpanded_tv_placeholder');
    const gate = classifyWebhookGate(auth);
    assert.equal(gate.httpStatus, 400);
    assert.equal(gate.intakeState, PIPELINE_INTAKE_STATE.WEBHOOK_PARSE_FAILED);
    assert.equal(gate.reason, 'unexpanded_tv_placeholder');
  });

  it('D. literal {{strategy.order.alert_message}} → unexpanded_tv_placeholder', async () => {
    const raw = '{{strategy.order.alert_message}}';
    const body = parseWebhookBody({ body: raw });
    assert.equal(body.__parseError, true);
    assert.equal(body.__parseReason, 'unexpanded_tv_placeholder');
    assert.equal(body.__parseKind, 'strategy_placeholder');
    assert.match(String(body.__parseHint || ''), /strategy\(\) order fills/);
    const auth = await verifyTradingViewWebhook({ body: raw, headers: {} }, async () => null);
    assert.equal(auth.ok, false);
    assert.equal(auth.reason, 'unexpanded_tv_placeholder');
    const gate = classifyWebhookGate(auth);
    assert.equal(gate.intakeState, PIPELINE_INTAKE_STATE.WEBHOOK_PARSE_FAILED);
  });

  it('E. valid Pine JSON body is not a parse error', async () => {
    const raw = JSON.stringify({
      symbol: 'XAUUSD',
      alertType: 'entry',
      direction: 'long',
      entry: 2400,
      stop_loss: 2390,
      take_profit_1: 2410,
      signalUuid: 'pine-valid-1',
      licenseToken: 'kls_v1.not-a-real-token.signature'
    });
    const body = parseWebhookBody({ body: raw });
    assert.equal(body.__parseError, undefined);
    assert.equal(body.symbol, 'XAUUSD');
    assert.equal(body.signalUuid, 'pine-valid-1');
  });
});

describe('webhook auth gate (C/D/E)', () => {
  const userId = 'e2e-auth-user';
  const tvUser = 'AuthTrader';

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.WEBHOOK_SIGNING_SECRET = 'test-signing-secret-e2e';
    delete process.env.TRADINGVIEW_WEBHOOK_SECRET;
  });

  afterEach(() => {
    process.env.WEBHOOK_SIGNING_SECRET = originalSigning;
    process.env.TRADINGVIEW_WEBHOOK_SECRET = originalTvSecret;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('C. valid JSON missing licenseToken → 401 WEBHOOK_RECEIVED_AUTH_FAILED', async () => {
    const payload = validEntryPayload({
      userId,
      tradingviewUsername: tvUser,
      signalUuid: 'e2e-c'
    });
    delete payload.licenseToken;
    const auth = await verifyTradingViewWebhook({ body: payload, headers: {} }, async () => null);
    assert.equal(auth.ok, false);
    assert.equal(auth.parseError, undefined);
    const gate = classifyWebhookGate(auth);
    assert.equal(gate.httpStatus, 401);
    assert.equal(gate.intakeState, PIPELINE_INTAKE_STATE.WEBHOOK_RECEIVED_AUTH_FAILED);
  });

  it('D. invalid license token → 401', async () => {
    const payload = validEntryPayload({
      userId,
      tradingviewUsername: tvUser,
      licenseToken: 'kls_v1.invalid.token',
      signalUuid: 'e2e-d'
    });
    const auth = await verifyTradingViewWebhook(
      { body: payload, headers: {} },
      async () => ({
        _id: userId,
        tradingviewUsername: tvUser,
        subscription: { tier: 'professional', status: 'active' }
      })
    );
    assert.equal(auth.ok, false);
    assert.equal(auth.reason, 'invalid_license_token');
    assert.equal(classifyWebhookGate(auth).httpStatus, 401);
  });

  it('E. valid authentication → continue beyond auth', async () => {
    const licenseToken = generateLicenseToken(userId, tvUser);
    const payload = validEntryPayload({
      userId,
      tradingviewUsername: tvUser,
      licenseToken,
      signalUuid: 'e2e-e'
    });
    const auth = await verifyTradingViewWebhook(
      { body: payload, headers: {} },
      async () => ({
        _id: userId,
        tradingviewUsername: tvUser,
        subscription: { tier: 'professional', status: 'active' }
      })
    );
    assert.equal(auth.ok, true);
    assert.equal(auth.mode, 'license');
    assert.equal(classifyWebhookGate(auth).stage, 'AUTH_PASS');
  });
});

describe('TradingView → Telegram pipeline E2E (F–Q)', () => {
  const userId = 'e2e-user-1';
  const tvUser = 'e2etrader';
  let inMemorySignals;
  let io;

  beforeEach(() => {
    assert.notEqual(mongoose.connection.readyState, 1);
    process.env.NODE_ENV = 'test';
    process.env.WEBHOOK_SIGNING_SECRET = 'test-signing-secret-e2e';
    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token-e2e';
    delete process.env.TRADINGVIEW_WEBHOOK_SECRET;
    delete process.env.PIPELINE_SELF_TEST_ACTIVE;
    inMemorySignals = [];
    io = { emit() {}, to() { return { emit() {} }; } };
    PipelineStatusService.resetForTests?.();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.WEBHOOK_SIGNING_SECRET = originalSigning;
    process.env.TRADINGVIEW_WEBHOOK_SECRET = originalTvSecret;
    process.env.TELEGRAM_BOT_TOKEN = originalBot;
    process.env.NODE_ENV = originalNodeEnv;
    delete process.env.PIPELINE_SELF_TEST_ACTIVE;
  });

  function authedPayload(overrides = {}) {
    const licenseToken = generateLicenseToken(userId, tvUser);
    return validEntryPayload({
      userId,
      tradingviewUsername: tvUser,
      licenseToken,
      ...overrides
    });
  }

  function proSub(overrides = {}) {
    return {
      id: userId,
      email: 'pro@example.com',
      subscription: { tier: 'professional', status: 'active' },
      telegram: { chatId: '111', enabled: true },
      mt5: { executionMode: 'manual' },
      ...overrides
    };
  }

  it('F. valid auth + malformed schema → WEBHOOK_SCHEMA_FAILED path', async () => {
    const payload = authedPayload({
      signalUuid: 'e2e-f',
      pattern: 'liquidity_sweep_fvg_scalp',
      alertType: 'entry'
    });
    delete payload.stop_loss;
    delete payload.stop_loss_1;
    await assert.rejects(
      () => TradingViewAlertService.processTradingViewWebhook(io, payload, inMemorySignals),
      /Invalid Kaching entry signal|missing/i
    );
    assert.equal(inMemorySignals.length, 0);
    assert.equal(
      resolveIntakeState({
        lastFailureStage: 'Validation',
        lastFailureReason: 'rejected_fields_missing_sl'
      }),
      PIPELINE_INTAKE_STATE.WEBHOOK_SCHEMA_FAILED
    );
  });

  it('G. valid authenticated + valid schema → SIGNAL CREATE/PERSIST', async () => {
    const payload = authedPayload({
      signalUuid: 'e2e-g',
      pipelineRequestId: 'tvw_corr_g'
    });
    const { result, lines } = await captureLogs(() =>
      TradingViewAlertService.processTradingViewWebhook(io, payload, inMemorySignals)
    );
    assert.ok(!result.rejected);
    assert.ok(inMemorySignals.length >= 1);
    assert.match(lines, /\[SIGNAL CREATE START\].*requestId=tvw_corr_g/);
    assert.match(lines, /\[SIGNAL PERSIST SUCCESS\].*requestId=tvw_corr_g/);
  });

  it('H. persistence failure → SIGNAL_PERSIST_FAILED', () => {
    assert.equal(
      resolveIntakeState({
        lastFailureStage: 'MongoSave',
        lastFailureReason: 'persist_failed'
      }),
      PIPELINE_INTAKE_STATE.SIGNAL_PERSIST_FAILED
    );
  });

  it('I. persisted + zero eligible → NO_ELIGIBLE_SUBSCRIBERS', () => {
    assert.equal(
      resolveIntakeState({
        lastWebhookReceived: { at: new Date().toISOString() },
        lastFailureStage: 'Broadcast',
        lastFailureReason: 'NO_ELIGIBLE_SUBSCRIBERS; active=2; skipped=2'
      }),
      PIPELINE_INTAKE_STATE.NO_ELIGIBLE_SUBSCRIBERS
    );
  });

  it('J. eligible Telegram subscriber → TELEGRAM DELIVERY START', async () => {
    mockTelegramOk(9001);
    const signal = {
      ...authedPayload({ signalUuid: 'e2e-j', _id: 'mem-j' }),
      pipelineRequestId: 'tvw_corr_j'
    };
    const { result, lines } = await captureLogs(() =>
      TradeDeliveryService.deliverTelegram(proSub(), signal)
    );
    assert.equal(result.ok, true);
    assert.match(lines, /\[TELEGRAM DELIVERY START\].*requestId=tvw_corr_j/);
    assert.match(lines, /\[TELEGRAM ELIGIBILITY\].*requestId=tvw_corr_j/);
  });

  it('K. Telegram Bot API success → TELEGRAM_SUCCESS', async () => {
    mockTelegramOk(42);
    const tg = await TradeDeliveryService.deliverTelegram(
      proSub(),
      authedPayload({ signalUuid: 'e2e-k', _id: 'mem-k' })
    );
    assert.equal(tg.ok, true);
    assert.equal(tg.status, TelegramService.TELEGRAM_STATUS.SEND_SUCCESS);
    assert.equal(
      resolveIntakeState({
        lastWebhookReceived: { at: new Date().toISOString() },
        lastTelegramDelivery: { at: new Date().toISOString() }
      }),
      PIPELINE_INTAKE_STATE.TELEGRAM_SUCCESS
    );
  });

  it('L. Telegram 400 → TELEGRAM_DELIVERY_FAILED + error details', async () => {
    mockTelegramErr(400, 400, "Bad Request: can't parse entities");
    const tg = await TradeDeliveryService.deliverTelegram(
      proSub(),
      authedPayload({ signalUuid: 'e2e-l', _id: 'mem-l' })
    );
    assert.equal(tg.ok, false);
    assert.equal(tg.httpStatus, 400);
    assert.match(tg.description, /can't parse entities/i);
    assert.equal(
      resolveIntakeState({
        lastFailureStage: 'DeliveryTelegram',
        lastFailureReason: "can't parse entities"
      }),
      PIPELINE_INTAKE_STATE.TELEGRAM_DELIVERY_FAILED
    );
  });

  it('M. Telegram 403 → TELEGRAM_DELIVERY_FAILED + details', async () => {
    mockTelegramErr(403, 403, 'Forbidden: bot was blocked by the user');
    const tg = await TradeDeliveryService.deliverTelegram(
      proSub(),
      authedPayload({ signalUuid: 'e2e-m', _id: 'mem-m' })
    );
    assert.equal(tg.httpStatus, 403);
    assert.match(tg.description, /blocked by the user/i);
  });

  it('N. Telegram 429 → TELEGRAM_DELIVERY_FAILED + details', async () => {
    mockTelegramErr(429, 429, 'Too Many Requests');
    const tg = await TradeDeliveryService.deliverTelegram(
      proSub(),
      authedPayload({ signalUuid: 'e2e-n', _id: 'mem-n' })
    );
    assert.equal(tg.httpStatus, 429);
    assert.match(tg.description, /Too Many Requests/i);
  });

  it('O. network timeout → TELEGRAM_DELIVERY_FAILED, pipeline does not crash', async () => {
    global.fetch = async () => {
      const err = new Error('AbortError: timeout');
      err.name = 'AbortError';
      throw err;
    };
    const tg = await TradeDeliveryService.deliverTelegram(
      proSub(),
      authedPayload({ signalUuid: 'e2e-o', _id: 'mem-o' })
    );
    assert.equal(tg.ok, false);
    assert.equal(tg.status, TelegramService.TELEGRAM_STATUS.SEND_FAILED);
    assert.ok(tg.reason || tg.description);
  });

  it('P. secret redaction — never licenseToken / bot token / full raw body', () => {
    const preview = redactRawPreview(
      '{"licenseToken":"kls_v1.abc.SECRET","symbol":"EURUSD","message":"x".repeat(500)}'.replace(
        '"x".repeat(500)',
        'x'.repeat(500)
      )
    );
    assert.match(preview, /REDACTED/);
    assert.doesNotMatch(preview, /kls_v1\.abc\.SECRET/);
    const safe = redactObject({
      licenseToken: 'kls_v1.should.not.appear',
      token: 'bot-token-secret',
      symbol: 'EURUSD'
    });
    assert.equal(safe.licenseToken, 'present');
    assert.equal(safe.token, 'present');
    assert.equal(safe.symbol, 'EURUSD');
    const { lines } = (() => {
      const buf = [];
      const orig = console.log;
      console.log = (...a) => buf.push(a.join(' '));
      try {
        logTvStage('TV WEBHOOK RECEIVED', {
          requestId: 'r1',
          licenseToken: 'kls_v1.leak.me',
          symbol: 'BTCUSD'
        });
      } finally {
        console.log = orig;
      }
      return { lines: buf.join('\n') };
    })();
    assert.match(lines, /licenseToken=present/);
    assert.doesNotMatch(lines, /kls_v1\.leak\.me/);
    assert.doesNotMatch(lines, /test-bot-token/);

    // Already-safe markers must not be flipped (absent → present was a prod misread).
    const { lines: absentLines } = (() => {
      const buf = [];
      const orig = console.log;
      console.log = (...a) => buf.push(a.join(' '));
      try {
        logTvStage('TV WEBHOOK RECEIVED', {
          requestId: 'r2',
          licenseToken: 'absent',
          symbol: 'EURUSD'
        });
      } finally {
        console.log = orig;
      }
      return { lines: buf.join('\n') };
    })();
    assert.match(absentLines, /licenseToken=absent/);
    assert.doesNotMatch(absentLines, /licenseToken=present/);
  });

  it('Q. correlation ID shared across stages where implemented', async () => {
    const req = {};
    const a = ensureRequestId(req);
    const b = ensureRequestId(req);
    assert.equal(a, b);
    assert.match(a, /^tvw_/);
    assert.ok(createRequestId());

    mockTelegramOk(1);
    const requestId = 'tvw_shared_q';
    const payload = authedPayload({ signalUuid: 'e2e-q', pipelineRequestId: requestId });
    const { lines: persistLines } = await captureLogs(() =>
      TradingViewAlertService.processTradingViewWebhook(io, payload, inMemorySignals)
    );
    assert.match(persistLines, new RegExp(`requestId=${requestId}`));
    const { lines: tgLines } = await captureLogs(() =>
      TradeDeliveryService.deliverTelegram(proSub(), {
        ...inMemorySignals[0],
        pipelineRequestId: requestId
      })
    );
    assert.match(tgLines, new RegExp(`requestId=${requestId}`));
  });

  it('intake state: NO_WEBHOOK_RECEIVED vs auth/parse (never silent empty)', () => {
    assert.equal(resolveIntakeState({}), PIPELINE_INTAKE_STATE.NO_WEBHOOK_RECEIVED);
    assert.equal(
      resolveIntakeState({ lastFailureStage: 'Auth', lastFailureReason: 'invalid_license_token' }),
      PIPELINE_INTAKE_STATE.WEBHOOK_RECEIVED_AUTH_FAILED
    );
    assert.equal(
      resolveIntakeState({
        lastFailureStage: 'WebhookParseError',
        lastFailureReason: 'invalid_json'
      }),
      PIPELINE_INTAKE_STATE.WEBHOOK_PARSE_FAILED
    );
  });

  it('Pro Manual Confirmation HTML does not nest bold inside italic', () => {
    const text = TelegramService.formatSignalMessage(
      validEntryPayload({ signalUuid: 'html-1' }),
      {
        id: 'p',
        subscription: { tier: 'professional', status: 'active' },
        telegram: { chatId: '1', enabled: true },
        mt5: { executionMode: 'manual' }
      },
      { includeExecuteButton: true, confirmSeconds: 180 }
    );
    assert.doesNotMatch(text, /<i>[^<]*<b>/);
    assert.match(text, /Execute Trade/);
  });
});

describe('Pine client compatibility (R–U)', () => {
  it('R. Legacy Pine payload (no version) → LEGACY, accepted', () => {
    const meta = extractPineClientMeta({ symbol: 'EURUSD', alertType: 'entry' });
    assert.equal(meta.mode, COMPAT_MODE.LEGACY);
    assert.equal(meta.pineClientVersion, null);
  });

  it('S. Pine 1.0.0 accepted as CURRENT (same major as stamp 1.2.0)', () => {
    const c = resolveCompatibilityMode('1.0.0');
    assert.equal(c.pineClientVersion, '1.0.0');
    assert.equal(c.mode, COMPAT_MODE.CURRENT);
  });

  it('T. Pine 1.1.0 / 1.2.0 → CURRENT', () => {
    assert.equal(resolveCompatibilityMode('1.1.0').mode, COMPAT_MODE.CURRENT);
    assert.equal(resolveCompatibilityMode('1.2.0').mode, COMPAT_MODE.CURRENT);
    assert.equal(resolveCompatibilityMode('1.2.0').pineClientVersion, '1.2.0');
  });

  it('U. Future Pine version accepted safely (FUTURE, never reject)', () => {
    const c = resolveCompatibilityMode('9.0.0');
    assert.equal(c.mode, COMPAT_MODE.FUTURE);
    assert.equal(c.pineClientVersion, '9.0.0');
    const meta = extractPineClientMeta({
      symbol: 'EURUSD',
      pineClientVersion: '9.0.0',
      capabilities: ['unknown_future_cap', 'v1_payload']
    });
    assert.equal(meta.mode, COMPAT_MODE.FUTURE);
  });
});

describe('Pine license username normalization (V/W)', () => {
  it('V. scalp template normalizes both usernames', () => {
    const scalp = fs.readFileSync(
      path.join(__dirname, '../../templates/kaching-sweep-fvg-scalp.pine.template'),
      'utf8'
    );
    assert.match(scalp, /normalizeTvUser\(string s\)/);
    assert.match(
      scalp,
      /normalizeTvUser\(CONFIRM_TV_USERNAME\)\s*==\s*normalizeTvUser\(LICENSED_TV_USERNAME\)/
    );
    assert.match(scalp, /str\.lower\(str\.replace_all\(str\.trim\(s\),\s*"@",\s*""\)\)/);
  });

  it('W. day-trading template has parity with scalp', () => {
    const day = fs.readFileSync(
      path.join(__dirname, '../../templates/kaching-sweep-fvg-daytrading.pine.template'),
      'utf8'
    );
    assert.match(
      day,
      /normalizeTvUser\(CONFIRM_TV_USERNAME\)\s*==\s*normalizeTvUser\(LICENSED_TV_USERNAME\)/
    );
    // Backend auth also normalizes case/whitespace/@
    assert.equal(normalizeTradingViewUsername('  @E2ETrader '), 'e2etrader');
    assert.equal(normalizeTradingViewUsername('e2etrader'), 'e2etrader');
  });

  it('backend license auth accepts case/whitespace username variants', async () => {
    process.env.NODE_ENV = 'test';
    process.env.WEBHOOK_SIGNING_SECRET = 'test-signing-secret-e2e';
    const userId = 'norm-user';
    const stored = 'NormTrader';
    const licenseToken = generateLicenseToken(userId, stored);
    const auth = await verifyTradingViewWebhook(
      {
        body: validEntryPayload({
          userId,
          tradingviewUsername: '  @NormTrader  ',
          licenseToken,
          signalUuid: 'e2e-norm'
        }),
        headers: {}
      },
      async () => ({
        _id: userId,
        tradingviewUsername: stored,
        subscription: { tier: 'professional', status: 'active' }
      })
    );
    assert.equal(auth.ok, true);
    process.env.WEBHOOK_SIGNING_SECRET = originalSigning;
    process.env.NODE_ENV = originalNodeEnv;
  });
});

describe('X. /link regression', () => {
  const userId = 'e2e-link-user';
  const storePath = path.join(__dirname, '../../dev-users.json');
  const originalStore = fs.existsSync(storePath) ? fs.readFileSync(storePath, 'utf8') : null;

  beforeEach(() => {
    assert.notEqual(mongoose.connection.readyState, 1);
    TelegramService._clearLinkCodeIndex();
    devUserStore.upsertUser(userId, {
      email: 'e2e-link@example.com',
      subscription: {
        status: 'active',
        tier: 'professional',
        current_period_end: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      },
      telegram: {}
    });
  });

  afterEach(() => {
    TelegramService._clearLinkCodeIndex();
    if (originalStore == null) {
      if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
    } else {
      fs.writeFileSync(storePath, originalStore, 'utf8');
    }
  });

  it('createLinkCode + linkByCode remains green', async () => {
    const { code } = await TelegramService.createLinkCode(userId);
    assert.ok(code);
    const result = await TelegramService.linkByCode(code, 'chat-e2e-x', 'e2elinker');
    assert.equal(result.ok, true);
    assert.equal(result.email, 'e2e-link@example.com');
    const user = devUserStore.findById(userId);
    assert.equal(String(user.telegram.chatId), 'chat-e2e-x');
  });
});
