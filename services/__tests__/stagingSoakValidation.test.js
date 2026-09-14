/**
 * Controlled staging-soak matrix (local in-process webhook + mocked providers).
 * Evidence type: unit/integration â€” not live TradingView/Email/Telegram/staging
 * unless REDIS_URL is actually used by a test below (it is not).
 *
 * Scenarios Aâ€“J from the production-readiness soak brief.
 */
'use strict';

process.env.REDIS_ENABLED = process.env.REDIS_ENABLED || 'false';
process.env.LEARNING_OUTCOME_DEBOUNCE_MS = process.env.LEARNING_OUTCOME_DEBOUNCE_MS || '1';
process.env.LEARNING_RETRAIN_INTERVAL_MS = process.env.LEARNING_RETRAIN_INTERVAL_MS || '0';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { generateLicenseToken } = require('../../utils/webhookSecurity');
const { generateForUser } = require('../PineScriptGeneratorService');
const TradingViewAlertService = require('../TradingViewAlertService');
const TradeDeliveryService = require('../TradeDeliveryService');
const PipelineStatusService = require('../PipelineStatusService');
const ActiveSignalRegistry = require('../../utils/activeSignalRegistry');
const TradeEventDispatcher = require('../../utils/tradeEventDispatcher');
const TradeEventStore = require('../../utils/tradeEventStore');
const deliveryIdempotency = require('../../utils/deliveryIdempotency');
const DurableDelivery = require('../../utils/durableDelivery');
const DeliverySequencer = require('../../utils/deliverySequencer');
const { overlayJobIdentityOnSignal } = require('../../utils/deliveryJobSignalOverlay');

const USER_A = 'soak-user-a';
const TV_USER = 'soaktrader';

function payload(alertType, uuid, overrides = {}) {
  const eventType = {
    entry: 'ENTRY',
    take_profit_1: 'TP1',
    take_profit_2: 'TP2',
    take_profit_3: 'TP3',
    stop_loss: 'SL'
  }[alertType] || 'ENTRY';
  const seq = { ENTRY: 0, TP1: 1, TP2: 2, TP3: 3, SL: 3 }[eventType];
  return {
    symbol: overrides.symbol || 'XAUUSD',
    strategyName: 'Liquidity Sweep + Fair Value Gap (Scalping)',
    timeframe: '3',
    pattern: 'liquidity_sweep_fvg_scalp',
    alertType,
    direction: 'long',
    entry: 2650.5,
    stop_loss: 2648.2,
    stop_loss_1: 2648.2,
    take_profit_1: 2655.1,
    take_profit_2: 2657.4,
    take_profit_3: 2659.7,
    confidence: 0.85,
    signalUuid: uuid,
    signalId: uuid,
    canonicalTradeId: uuid,
    eventId: `XAUUSD|3|${uuid}|${eventType}`,
    eventType,
    eventSequence: seq,
    message: alertType === 'entry' ? 'KACHING BUY' : `KACHING ${alertType}`,
    broadcast: true,
    tradingviewUsername: TV_USER,
    userId: USER_A,
    licenseToken: generateLicenseToken(USER_A, TV_USER),
    isRealtime: true,
    pineClientVersion: '1.3.0',
    signalTime: Date.now(),
    ...overrides,
    signalUuid: uuid,
    signalId: uuid,
    canonicalTradeId: uuid
  };
}

function proSubscriber(id = USER_A, chatId = '90001', overrides = {}) {
  return {
    id,
    email: `${id}@example.com`,
    role: 'user',
    subscription: { tier: 'professional', status: 'active' },
    telegram: { chatId, enabled: true, telegramMode: 'alerts_only' },
    mt5: { executionMode: 'manual', enabled: true, devices: [] },
    preferences: { emailAlerts: true },
    ...overrides
  };
}

function mockTelegram(state) {
  global.fetch = async (_url, init) => {
    let text = '';
    try {
      text = JSON.parse(init?.body || '{}').text || '';
    } catch {
      text = String(init?.body || '');
    }
    state.calls += 1;
    if (state.failNext > 0) {
      state.failNext -= 1;
      state.failures += 1;
      return {
        ok: false,
        status: 500,
        async json() {
          return { ok: false, description: 'telegram_boom' };
        }
      };
    }
    state.texts.push(text);
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true, result: { message_id: state.calls } };
      }
    };
  };
}

async function acceptAndProcess(io, body, mem) {
  const accept = await TradingViewAlertService.acceptTradingViewWebhook(io, body, mem);
  if (accept.accepted && !accept.duplicate && !accept.skippedFanout) {
    await TradingViewAlertService.processAcceptedTradingViewSignal(io, accept, mem);
  }
  return accept;
}

function jobsBy(channel, eventType, subscriberId) {
  return DurableDelivery.listMemoryJobs().filter(j => {
    if (j.channel === '_fanout') return false;
    if (channel && j.channel !== channel) return false;
    if (eventType && String(j.eventType).toLowerCase() !== String(eventType).toLowerCase()) {
      return false;
    }
    if (subscriberId && String(j.subscriberId) !== String(subscriberId)) return false;
    return true;
  });
}

function createFakeRedis() {
  const kv = new Map();
  const hashes = new Map();
  return {
    isOpen: true,
    isReady: true,
    async set(key, val, opts = {}) {
      if (opts && opts.NX && kv.has(key)) return null;
      kv.set(key, String(val));
      return 'OK';
    },
    async get(key) {
      return kv.has(key) ? kv.get(key) : null;
    },
    async del(...keys) {
      let n = 0;
      for (const key of keys.flat()) {
        if (kv.delete(key)) n += 1;
        if (hashes.delete(key)) n += 1;
      }
      return n;
    },
    async hSet(key, field, value) {
      if (!hashes.has(key)) hashes.set(key, new Map());
      hashes.get(key).set(String(field), String(value));
      return 1;
    },
    async hGetAll(key) {
      const h = hashes.get(key);
      if (!h) return {};
      return Object.fromEntries(h);
    },
    async expire() {
      return 1;
    },
    async eval(_script, { keys, arguments: args }) {
      const cur = kv.get(keys[0]);
      if (cur === args[0]) {
        kv.delete(keys[0]);
        return 1;
      }
      return 0;
    }
  };
}

const originalFetch = global.fetch;
const originalNodeEnv = process.env.NODE_ENV;
const originalBot = process.env.TELEGRAM_BOT_TOKEN;
const originalSigning = process.env.WEBHOOK_SIGNING_SECRET;
const originalSeqWait = process.env.DELIVERY_SEQ_WAIT_MS;
const originalMax = process.env.DELIVERY_MAX_ATTEMPTS;
const originalSeqMax = process.env.SEQUENCE_WAIT_MAX_MS;

describe('staging soak validation Aâ€“J', () => {
  let mem;
  let io;
  let tg;
  let emails;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token-soak';
    process.env.WEBHOOK_SIGNING_SECRET = 'test-signing-secret-soak';
    process.env.DELIVERY_SEQ_WAIT_MS = '20';
    process.env.DELIVERY_MAX_ATTEMPTS = '4';
    mem = [];
    io = { emit() {}, to() { return { emit() {} }; } };
    tg = { calls: 0, texts: [], failures: 0, failNext: 0 };
    emails = [];
    mockTelegram(tg);
    const mailer = require('../../utils/mailer');
    mailer.__ddFailEmail = false;
    mailer.sendTradeAlertEmail = async opts => {
      if (mailer.__ddFailEmail) throw new Error('smtp_down');
      emails.push({
        alertType: opts.signal?.alertType || 'entry',
        eventId: opts.signal?.eventId,
        eventType: opts.signal?.eventType,
        canonicalTradeId: opts.signal?.canonicalTradeId,
        symbol: opts.signal?.symbol
      });
      return { ok: true };
    };
    ActiveSignalRegistry.resetForTests();
    PipelineStatusService.resetForTests();
    TradingViewAlertService.resetTestFanoutHooks();
    TradeEventDispatcher.resetForTests();
    deliveryIdempotency.resetForTests();
    TradeEventStore.resetForTests();
    TradingViewAlertService.setTestFanoutHooks({
      subscribers: [proSubscriber()]
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.NODE_ENV = originalNodeEnv;
    process.env.TELEGRAM_BOT_TOKEN = originalBot;
    process.env.WEBHOOK_SIGNING_SECRET = originalSigning;
    if (originalSeqWait == null) delete process.env.DELIVERY_SEQ_WAIT_MS;
    else process.env.DELIVERY_SEQ_WAIT_MS = originalSeqWait;
    if (originalMax == null) delete process.env.DELIVERY_MAX_ATTEMPTS;
    else process.env.DELIVERY_MAX_ATTEMPTS = originalMax;
    if (originalSeqMax == null) delete process.env.SEQUENCE_WAIT_MAX_MS;
    else process.env.SEQUENCE_WAIT_MAX_MS = originalSeqMax;
    TradingViewAlertService.resetTestFanoutHooks();
    TradeEventStore.resetForTests();
  });

  it('A: generated Pine authority matrix (scalp 3 / day 5, one alert gateway)', () => {
    process.env.TRADINGVIEW_WEBHOOK_SECRET =
      process.env.TRADINGVIEW_WEBHOOK_SECRET || 'smoke-test-tv-webhook-secret';
    const scalp = generateForUser(
      {
        _id: '507f1f77bcf86cd799439011',
        email: 'soak-pine@test.com',
        tradingviewUsername: 'demo_trader',
        subscription: { tier: 'professional', status: 'active' }
      },
      { strategy: 'scalping' }
    );
    const day = generateForUser(
      {
        _id: '507f1f77bcf86cd799439011',
        email: 'soak-pine@test.com',
        tradingviewUsername: 'demo_trader',
        subscription: { tier: 'professional', status: 'active' }
      },
      { strategy: 'daytrading' }
    );
    for (const [label, g, baked] of [
      ['scalping', scalp, '3'],
      ['daytrading', day, '5']
    ]) {
      const code = g.script
        .split(/\r?\n/)
        .filter(l => !l.trimStart().startsWith('//'))
        .join('\n');
      assert.equal(g.pineClientVersion, '1.3.2', label);
      assert.equal(g.capabilities.includes('canonical_webhook_authority_v1'), false, label);
      assert.match(g.script, new RegExp(`CANONICAL_SIGNAL_TF = "${baked}"`));
      assert.equal((code.match(/\balert\s*\(/g) || []).length, 1, label);
      assert.match(code, /isCanonicalChart\s*=\s*timeframe\.period\s*==\s*CANONICAL_SIGNAL_TF/);
      assert.match(code, /if barstate\.isrealtime/);
      assert.doesNotMatch(code, /isCanonicalAuthorityChart/);
      assert.match(code, /"alertFiredAt":'\s*\+\s*str\.tostring\(timenow\)/);
      assert.match(code, /alert\.freq_all/);
      assert.doesNotMatch(g.script, /\{\{[A-Z0-9_]+\}\}/);
      assert.doesNotMatch(code, /alert\.freq_once_per_bar/);
    }
  });

  it('B: full lifecycle ENTRYâ†’TP1â†’TP2â†’TP3 is one Email + one Telegram per event', async () => {
    const uuid = 'soak-b-full';
    for (const type of ['entry', 'take_profit_1', 'take_profit_2', 'take_profit_3']) {
      const accept = await acceptAndProcess(io, payload(type, uuid), mem);
      assert.equal(accept.accepted, true, type);
      assert.equal(Boolean(accept.duplicate), false, type);
    }
    assert.equal(emails.length, 4);
    assert.equal(tg.texts.length, 4);
    assert.deepEqual(
      emails.map(e => e.alertType),
      ['entry', 'take_profit_1', 'take_profit_2', 'take_profit_3']
    );
    assert.ok(emails.every(e => e.canonicalTradeId === uuid));
    assert.equal(new Set(emails.map(e => e.eventId)).size, 4);
    assert.ok(/BUY|SELL/i.test(tg.texts[0]));
    assert.ok(/TP1 HIT|UPDATE/i.test(tg.texts[1]));
    const emailJobs = jobsBy('email', null, USER_A).filter(j => j.state === 'delivered');
    const tgJobs = jobsBy('telegram', null, USER_A).filter(j => j.state === 'delivered');
    assert.equal(emailJobs.length, 4);
    assert.equal(tgJobs.length, 4);
    assert.ok(emailJobs.every(j => j.canonicalTradeId === uuid));
    assert.ok(tgJobs.every(j => j.canonicalTradeId === uuid));
  });

  it('B2: ENTRYâ†’SL is one Email + one Telegram; no TP notifications', async () => {
    const uuid = 'soak-b-sl';
    await acceptAndProcess(io, payload('entry', uuid), mem);
    await acceptAndProcess(io, payload('stop_loss', uuid), mem);
    assert.equal(emails.length, 2);
    assert.equal(tg.texts.length, 2);
    assert.equal(emails[1].alertType, 'stop_loss');
    assert.equal(emails.filter(e => /take_profit/.test(e.alertType)).length, 0);
  });

  it('C: Email TP1 fails; Telegram TP1 once; Email recovers as TP1; no dup ENTRY', async () => {
    const uuid = 'soak-c';
    const mailer = require('../../utils/mailer');
    await acceptAndProcess(io, payload('entry', uuid), mem);
    mailer.__ddFailEmail = true;
    await acceptAndProcess(io, payload('take_profit_1', uuid), mem);
    assert.equal(tg.texts.filter(t => /TP1 HIT|UPDATE/i.test(t)).length, 1);
    assert.equal(emails.filter(e => e.alertType === 'take_profit_1').length, 0);
    const emailTp = jobsBy('email', 'take_profit_1', USER_A)[0];
    assert.ok(emailTp);
    assert.notEqual(emailTp.state, 'delivered');
    mailer.__ddFailEmail = false;
    const live = (await DurableDelivery.listJobs()).find(j => j.jobId === emailTp.jobId);
    await DurableDelivery.markDueForTests(live.jobId);
    const recovered = await TradeDeliveryService.deliverDurableJob(io, live, { waitMode: 'recovery' });
    assert.equal(recovered.ok, true);
    assert.equal(emails.filter(e => e.alertType === 'take_profit_1').length, 1);
    assert.equal(emails.filter(e => e.alertType === 'entry').length, 1);
    assert.equal(tg.texts.filter(t => /TP1 HIT|UPDATE/i.test(t)).length, 1);
  });

  it('D: Telegram TP1 fails; Email TP1 once; Telegram recovers as TP1', async () => {
    const uuid = 'soak-d';
    await acceptAndProcess(io, payload('entry', uuid), mem);
    tg.failNext = 1;
    await acceptAndProcess(io, payload('take_profit_1', uuid), mem);
    assert.equal(emails.filter(e => e.alertType === 'take_profit_1').length, 1);
    const tgJob = jobsBy('telegram', 'take_profit_1', USER_A)[0];
    assert.ok(tgJob);
    assert.notEqual(tgJob.state, 'delivered');
    const live = (await DurableDelivery.listJobs()).find(j => j.jobId === tgJob.jobId);
    await DurableDelivery.markDueForTests(live.jobId);
    const recovered = await TradeDeliveryService.deliverDurableJob(io, live, { waitMode: 'recovery' });
    assert.equal(recovered.ok, true);
    assert.equal(tg.texts.filter(t => /TP1 HIT|UPDATE/i.test(t)).length, 1);
    assert.equal(emails.filter(e => e.alertType === 'entry').length, 1);
  });

  it('E: both channels fail TP1 then recover once each', async () => {
    const uuid = 'soak-e';
    const mailer = require('../../utils/mailer');
    await acceptAndProcess(io, payload('entry', uuid), mem);
    tg.failNext = 1;
    mailer.__ddFailEmail = true;
    await acceptAndProcess(io, payload('take_profit_1', uuid), mem);
    const tgJob = jobsBy('telegram', 'take_profit_1', USER_A)[0];
    const emailJob = jobsBy('email', 'take_profit_1', USER_A)[0];
    assert.ok(tgJob && emailJob);
    assert.notEqual(tgJob.state, 'delivered');
    assert.notEqual(emailJob.state, 'delivered');
    tg.failNext = 0;
    mailer.__ddFailEmail = false;
    const liveTg = (await DurableDelivery.listJobs()).find(j => j.jobId === tgJob.jobId);
    const liveEmail = (await DurableDelivery.listJobs()).find(j => j.jobId === emailJob.jobId);
    await DurableDelivery.markDueForTests(liveTg.jobId);
    await DurableDelivery.markDueForTests(liveEmail.jobId);
    assert.equal((await TradeDeliveryService.deliverDurableJob(io, liveTg, { waitMode: 'recovery' })).ok, true);
    assert.equal((await TradeDeliveryService.deliverDurableJob(io, liveEmail, { waitMode: 'recovery' })).ok, true);
    assert.equal(tg.texts.filter(t => /TP1 HIT|UPDATE/i.test(t)).length, 1);
    assert.equal(emails.filter(e => e.alertType === 'take_profit_1').length, 1);
    assert.equal(tgJob.canonicalTradeId, uuid);
    assert.equal(emailJob.canonicalTradeId, uuid);
  });

  it('F: Redis interruption then recovery â€” HASH only from delivered, no TP unlock from skipped', async () => {
    const uuid = 'soak-f';
    const redisA = createFakeRedis();
    TradeEventStore.setClientForTests(redisA);
    await acceptAndProcess(io, payload('entry', uuid), mem);
    assert.equal(emails.filter(e => e.alertType === 'entry').length, 1);
    assert.equal(tg.texts.filter(t => /BUY|SELL/i.test(t) && !/TP1 HIT|UPDATE/i.test(t)).length, 1);

    const skipped = await DurableDelivery.ensureJob({
      eventId: `XAUUSD|3|${uuid}|ENTRY`,
      canonicalTradeId: uuid,
      subscriberId: 'other-sub',
      channel: 'telegram',
      eventType: 'entry',
      signalUuid: uuid
    });
    skipped.state = 'skipped';

    TradeEventStore.setClientForTests(null, { unavailable: true });
    DurableDelivery.simulateRedisRestartForTests();
    TradeEventStore.clearSequenceCommitsForTests();

    const afterLoss = await TradeEventStore.getCommittedDeliveries(uuid, USER_A, 'telegram');
    assert.equal(afterLoss.has('entry'), false);

    const skippedRecover = await DeliverySequencer.recoverEntryCommitFromDeliveredJob(
      uuid,
      'other-sub',
      'telegram',
      { signalUuid: uuid, canonicalTradeId: uuid }
    );
    assert.equal(skippedRecover, false);

    const redisB = createFakeRedis();
    TradeEventStore.setClientForTests(redisB);
    const recoveredHash = await DeliverySequencer.recoverEntryCommitFromDeliveredJob(
      uuid,
      USER_A,
      'telegram',
      { signalUuid: uuid, canonicalTradeId: uuid }
    );
    assert.equal(recoveredHash, true);

    await acceptAndProcess(io, payload('take_profit_1', uuid), mem);
    assert.equal(tg.texts.filter(t => /TP1 HIT|UPDATE/i.test(t)).length, 1);
    assert.equal(emails.filter(e => e.alertType === 'take_profit_1').length, 1);
    assert.equal(emails.filter(e => e.alertType === 'entry').length, 1);
    const tgTp = jobsBy('telegram', 'take_profit_1', USER_A)[0];
    assert.ok(tgTp);
    assert.equal(tgTp.canonicalTradeId, uuid);
    assert.equal(String(tgTp.eventType).toLowerCase().includes('take_profit') || tgTp.eventType === 'TP1', true);
  });

  it('F2: sequence wait is observable then failed_terminal when ENTRY never delivered', async () => {
    process.env.SEQUENCE_WAIT_MAX_MS = '25';
    const uuid = 'soak-f2';
    const parked = await DurableDelivery.ensureJob({
      eventId: `XAUUSD|3|${uuid}|TP1`,
      canonicalTradeId: uuid,
      subscriberId: USER_A,
      channel: 'telegram',
      eventType: 'take_profit_1',
      signalUuid: uuid
    });
    parked.createdAt = Date.now() - 500;
    const result = await DeliverySequencer.withChannelSequence({
      signalDoc: payload('take_profit_1', uuid),
      subscriberId: USER_A,
      channel: 'telegram',
      alertType: 'take_profit_1',
      waitMode: 'recovery',
      send: async () => ({ ok: true })
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.reason === 'delivery_sequence_wait' || result.reason === 'delivery_sequence_wait_expired'
    );
    const expired = await DeliverySequencer.withChannelSequence({
      signalDoc: payload('take_profit_1', uuid),
      subscriberId: USER_A,
      channel: 'telegram',
      alertType: 'take_profit_1',
      waitMode: 'recovery',
      send: async () => ({ ok: true })
    });
    assert.equal(expired.ok, false);
    assert.equal(expired.reason, 'delivery_sequence_wait_expired');
    assert.equal(expired.terminal, true);
    const job = await DurableDelivery.getJob(parked.jobId);
    assert.equal(job.state, 'failed_terminal');
  });

  it('G: durable recovery overlays TP1 onto Mongo ENTRY and does not resend delivered email', async () => {
    const uuid = 'soak-g';
    await acceptAndProcess(io, payload('entry', uuid), mem);
    tg.failNext = 1;
    await acceptAndProcess(io, payload('take_profit_1', uuid), mem);
    assert.equal(emails.filter(e => e.alertType === 'take_profit_1').length, 1);
    const job = jobsBy('telegram', 'take_profit_1', USER_A)[0];
    assert.ok(job);
    await DurableDelivery.simulateCrashForTests(job.jobId);
    const mongoEntry = {
      alertType: 'entry',
      eventType: 'ENTRY',
      eventId: `XAUUSD|3|${uuid}|ENTRY`,
      canonicalTradeId: uuid,
      signalUuid: uuid,
      symbol: 'XAUUSD',
      direction: 'long',
      entry: 2650.5,
      take_profit_1: 2655.1,
      stop_loss: 2648.2
    };
    const overlaid = overlayJobIdentityOnSignal(mongoEntry, job);
    assert.equal(overlaid.alertType, 'take_profit_1');
    assert.equal(overlaid.eventId, `XAUUSD|3|${uuid}|TP1`);
    assert.equal(overlaid.canonicalTradeId, uuid);
    const live = (await DurableDelivery.listJobs()).find(j => j.jobId === job.jobId);
    await DurableDelivery.markDueForTests(live.jobId);
    live.payload = { subscriber: proSubscriber(), signal: mongoEntry };
    const sent = await TradeDeliveryService.deliverDurableJob(io, live, { waitMode: 'recovery' });
    assert.equal(sent.ok, true);
    const last = tg.texts[tg.texts.length - 1];
    assert.ok(/TP1 HIT|UPDATE/i.test(last), last);
    assert.equal(emails.filter(e => e.alertType === 'take_profit_1').length, 1);
    assert.equal(emails.filter(e => e.alertType === 'entry').length, 1);
  });

  it('H: duplicate ENTRY webhook is one trade and no extra notifications', async () => {
    const uuid = 'soak-h';
    const first = await acceptAndProcess(io, payload('entry', uuid), mem);
    assert.equal(first.accepted, true);
    const tgAfter = tg.calls;
    const emailAfter = emails.length;
    const dup = await acceptAndProcess(io, payload('entry', uuid), mem);
    assert.equal(Boolean(dup.duplicate || dup.skippedFanout), true);
    assert.equal(tg.calls, tgAfter);
    assert.equal(emails.length, emailAfter);
    assert.equal(mem.filter(s => s.signalUuid === uuid || s.canonicalTradeId === uuid).length <= 1, true);
  });

  it('I: delayed ENTRY after TP3 is consumed, not revived', async () => {
    const uuid = 'soak-i-tp3';
    await acceptAndProcess(io, payload('entry', uuid), mem);
    await acceptAndProcess(io, payload('take_profit_1', uuid), mem);
    await acceptAndProcess(io, payload('take_profit_2', uuid), mem);
    await acceptAndProcess(io, payload('take_profit_3', uuid), mem);
    const emailCount = emails.length;
    const tgCount = tg.calls;
    const replay = await acceptAndProcess(io, payload('entry', uuid), mem);
    assert.ok(
      replay.skippedFanout ||
        replay.duplicate ||
        replay.reason === 'already_terminal' ||
        replay.accepted === false
    );
    assert.equal(emails.length, emailCount);
    assert.equal(tg.calls, tgCount);
    const entrySignals = mem.filter(s => (s.alertType || 'entry') === 'entry' && (s.signalUuid === uuid || s.canonicalTradeId === uuid));
    assert.ok(entrySignals.length <= 1);
    if (mem[0]) {
      assert.ok(['tp3', 'won', 'closed'].includes(String(mem[0].outcome || mem[0].tradeStatus || 'tp3').toLowerCase()) || mem[0].lifecycleStage);
    }
  });

  it('I2: delayed ENTRY after TP1 (open trade) does not create a second ENTRY delivery', async () => {
    const uuid = 'soak-i-tp1';
    await acceptAndProcess(io, payload('entry', uuid), mem);
    await acceptAndProcess(io, payload('take_profit_1', uuid), mem);
    const emailEntry = emails.filter(e => e.alertType === 'entry').length;
    const replay = await acceptAndProcess(io, payload('entry', uuid), mem);
    assert.ok(replay.skippedFanout || replay.duplicate || replay.accepted === false);
    assert.equal(emails.filter(e => e.alertType === 'entry').length, emailEntry);
  });

  it('J: admin-facing pipeline stages remain distinct (received / accepted / sequence / channels)', () => {
    PipelineStatusService.resetForTests();
    PipelineStatusService.record('WebhookReceived', 'PASS', {
      signalUuid: 'soak-j',
      eventId: 'XAUUSD|3|soak-j|TP1',
      eventType: 'TP1',
      canonicalTradeId: 'soak-j'
    });
    PipelineStatusService.record('Accepted', 'PASS', {
      signalUuid: 'soak-j',
      eventType: 'TP1',
      latencyMs: 8
    });
    PipelineStatusService.record('DeliverySequence', 'PENDING', {
      signalUuid: 'soak-j',
      channel: 'email',
      reason: 'delivery_sequence_wait'
    });
    const events = PipelineStatusService.getLiveEvents(20);
    assert.ok(events.some(e => e.type === 'WebhookReceived' || e.stage === 'WebhookReceived'));
    assert.ok(events.some(e => e.type === 'Accepted' || e.stage === 'Accepted'));
    assert.ok(events.some(e => e.type === 'DeliverySequence' || e.stage === 'DeliverySequence'));
    assert.ok(PipelineStatusService.getLatencySummary());
  });
});
