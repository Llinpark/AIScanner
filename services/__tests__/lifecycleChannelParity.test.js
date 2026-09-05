/**
 * Email/Telegram lifecycle parity matrix.
 * Proves one canonical trade identity, independent channel delivery,
 * overlay-after-rehydrate, duplicate suppression, and reverse recovery.
 */
'use strict';

process.env.REDIS_ENABLED = process.env.REDIS_ENABLED || 'false';
process.env.LEARNING_OUTCOME_DEBOUNCE_MS = process.env.LEARNING_OUTCOME_DEBOUNCE_MS || '1';
process.env.LEARNING_RETRAIN_INTERVAL_MS = process.env.LEARNING_RETRAIN_INTERVAL_MS || '0';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { generateLicenseToken } = require('../../utils/webhookSecurity');
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

const USER_A = 'parity-user-a';
const USER_B = 'parity-user-b';
const TV_USER = 'paritytrader';

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
    pineClientVersion: '1.6.0',
    signalTime: Date.now(),
    ...overrides,
    signalUuid: uuid,
    signalId: uuid,
    canonicalTradeId: uuid
  };
}

function proSubscriber(id, chatId, overrides = {}) {
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
    if (eventType && String(j.eventType).toLowerCase() !== String(eventType).toLowerCase()) return false;
    if (subscriberId && String(j.subscriberId) !== String(subscriberId)) return false;
    return true;
  });
}

const originalFetch = global.fetch;
const originalNodeEnv = process.env.NODE_ENV;
const originalBot = process.env.TELEGRAM_BOT_TOKEN;
const originalSigning = process.env.WEBHOOK_SIGNING_SECRET;
const originalSeqWait = process.env.DELIVERY_SEQ_WAIT_MS;
const originalMax = process.env.DELIVERY_MAX_ATTEMPTS;

describe('lifecycle channel parity matrix', () => {
  let mem;
  let io;
  let tg;
  let emails;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token-parity';
    process.env.WEBHOOK_SIGNING_SECRET = 'test-signing-secret-parity';
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
        canonicalTradeId: opts.signal?.canonicalTradeId,
        symbol: opts.signal?.symbol,
        direction: opts.signal?.direction,
        subject: opts.subject || opts.signal?.subject
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
      subscribers: [proSubscriber(USER_A, '80001')]
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
    TradingViewAlertService.resetTestFanoutHooks();
    TradeEventStore.resetForTests();
  });

  it('CASE 1: Email and Telegram both succeed for ENTRY and TP1', async () => {
    const uuid = 'parity-c1';
    await acceptAndProcess(io, payload('entry', uuid), mem);
    await acceptAndProcess(io, payload('take_profit_1', uuid), mem);
    assert.equal(tg.calls, 2);
    assert.equal(emails.length, 2);
    assert.equal(emails[0].alertType, 'entry');
    assert.equal(emails[1].alertType, 'take_profit_1');
    assert.ok(tg.texts[0].includes('KACHING'));
    assert.ok(/TP1 HIT|UPDATE/i.test(tg.texts[1]));
    assert.ok(emails.every(e => e.canonicalTradeId === uuid));
    assert.ok(tg.texts.every(t => /XAUUSD/i.test(t)));
  });

  it('CASE 2 / INCIDENT: Email TP1 ok, Telegram TP1 fails then recovers once; no duplicate ENTRY', async () => {
    const uuid = 'parity-c2';
    await acceptAndProcess(io, payload('entry', uuid), mem);
    assert.equal(tg.calls, 1);
    assert.equal(emails.filter(e => e.alertType === 'entry').length, 1);
    const entryTg = tg.texts[0];
    assert.ok(/BUY|SELL/i.test(entryTg));

    tg.failNext = 1;
    await acceptAndProcess(io, payload('take_profit_1', uuid), mem);
    assert.equal(emails.filter(e => e.alertType === 'take_profit_1').length, 1);
    const tpJobs = jobsBy('telegram', 'take_profit_1', USER_A);
    assert.ok(tpJobs.length >= 1);
    assert.notEqual(tpJobs[0].state, 'delivered');

    tg.failNext = 0;
    const live = (await DurableDelivery.listJobs()).find(j => j.jobId === tpJobs[0].jobId);
    await DurableDelivery.markDueForTests(live.jobId);
    const recovered = await TradeDeliveryService.deliverDurableJob(io, live, { waitMode: 'recovery' });
    assert.equal(recovered.ok, true);
    const tpTexts = tg.texts.filter(t => /TP1 HIT|UPDATE/i.test(t));
    assert.equal(tpTexts.length, 1);
    assert.equal(tg.texts.filter(t => /BUY|SELL/i.test(t) && !/TP1 HIT|UPDATE/i.test(t)).length, 1);
    assert.equal(emails.filter(e => e.alertType === 'take_profit_1').length, 1);
  });

  it('CASE 3 / REVERSE: Telegram TP1 ok, Email fails then recovers independently', async () => {
    const uuid = 'parity-c3';
    const mailer = require('../../utils/mailer');
    await acceptAndProcess(io, payload('entry', uuid), mem);
    mailer.__ddFailEmail = true;
    await acceptAndProcess(io, payload('take_profit_1', uuid), mem);
    assert.ok(tg.texts.some(t => /TP1 HIT|UPDATE/i.test(t)));
    const emailTp = jobsBy('email', 'take_profit_1', USER_A);
    assert.ok(emailTp.length >= 1);
    assert.notEqual(emailTp[0].state, 'delivered');
    mailer.__ddFailEmail = false;
    const live = (await DurableDelivery.listJobs()).find(j => j.jobId === emailTp[0].jobId);
    await DurableDelivery.markDueForTests(live.jobId);
    const recovered = await TradeDeliveryService.deliverDurableJob(io, live, { waitMode: 'recovery' });
    assert.equal(recovered.ok, true);
    assert.equal(emails.filter(e => e.alertType === 'take_profit_1').length, 1);
    assert.equal(tg.texts.filter(t => /TP1 HIT|UPDATE/i.test(t)).length, 1);
  });

  it('CASE 4: both channels fail TP1 then recover independently', async () => {
    const uuid = 'parity-c4';
    const mailer = require('../../utils/mailer');
    await acceptAndProcess(io, payload('entry', uuid), mem);
    const entryTg = tg.texts.filter(t => /BUY|SELL/i.test(t) && !/TP1 HIT|UPDATE/i.test(t)).length;
    const entryEmail = emails.filter(e => e.alertType === 'entry').length;
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
    const recTg = await TradeDeliveryService.deliverDurableJob(io, liveTg, { waitMode: 'recovery' });
    const recEmail = await TradeDeliveryService.deliverDurableJob(io, liveEmail, { waitMode: 'recovery' });
    assert.equal(recTg.ok, true);
    assert.equal(recEmail.ok, true);
    assert.equal(tg.texts.filter(t => /TP1 HIT|UPDATE/i.test(t)).length, 1);
    assert.equal(emails.filter(e => e.alertType === 'take_profit_1').length, 1);
    assert.equal(
      tg.texts.filter(t => /BUY|SELL/i.test(t) && !/TP1 HIT|UPDATE/i.test(t)).length,
      entryTg
    );
    assert.equal(emails.filter(e => e.alertType === 'entry').length, entryEmail);
    assert.ok(tgJob.canonicalTradeId === uuid && emailJob.canonicalTradeId === uuid);
  });

  it('CASE 6: duplicate webhook does not double-send either channel', async () => {
    const uuid = 'parity-c6';
    await acceptAndProcess(io, payload('entry', uuid), mem);
    const tgAfterFirst = tg.calls;
    const emailAfterFirst = emails.length;
    const dup = await acceptAndProcess(io, payload('entry', uuid), mem);
    assert.equal(Boolean(dup.duplicate || dup.skippedFanout), true);
    assert.equal(tg.calls, tgAfterFirst);
    assert.equal(emails.length, emailAfterFirst);
  });

  it('CASE 7+8: recovery after webhook context gone; Mongo ENTRY overlay stays TP1', async () => {
    const uuid = 'parity-c78';
    await acceptAndProcess(io, payload('entry', uuid), mem);
    tg.failNext = 1;
    await acceptAndProcess(io, payload('take_profit_1', uuid), mem);
    const job = jobsBy('telegram', 'take_profit_1', USER_A)[0];
    assert.ok(job);
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
      stop_loss: 2648.2,
      _id: 'mem_entry_only'
    };
    const overlaid = overlayJobIdentityOnSignal(mongoEntry, job);
    assert.equal(overlaid.alertType, 'take_profit_1');
    assert.equal(overlaid.canonicalTradeId, uuid);
    const live = (await DurableDelivery.listJobs()).find(j => j.jobId === job.jobId);
    await DurableDelivery.markDueForTests(live.jobId);
    live.payload = {
      subscriber: proSubscriber(USER_A, '80001'),
      signal: mongoEntry
    };
    const sent = await TradeDeliveryService.deliverDurableJob(io, live, { waitMode: 'recovery' });
    assert.equal(sent.ok, true);
    const last = tg.texts[tg.texts.length - 1];
    assert.ok(/TP1 HIT|UPDATE/i.test(last), `expected TP1 text, got: ${last}`);
    assert.doesNotMatch(last, /KACHING BUY[\s\S]*Entry:/);
  });

  it('CASE 9: sequencer missing ENTRY HASH but ENTRY job delivered unblocks TP1', async () => {
    const uuid = 'parity-c9';
    const entryJob = await DurableDelivery.ensureJob({
      eventId: `XAUUSD|3|${uuid}|ENTRY`,
      canonicalTradeId: uuid,
      subscriberId: USER_A,
      channel: 'telegram',
      eventType: 'entry',
      signalUuid: uuid
    });
    await DurableDelivery.commitDelivered(entryJob.jobId);
    const committedBefore = await TradeEventStore.getCommittedDeliveries(uuid, USER_A, 'telegram');
    assert.equal(committedBefore.has('entry'), false);
    const recovered = await DeliverySequencer.recoverEntryCommitFromDeliveredJob(
      uuid,
      USER_A,
      'telegram',
      { signalUuid: uuid, canonicalTradeId: uuid }
    );
    assert.equal(recovered, true);
    const result = await DeliverySequencer.withChannelSequence({
      signalDoc: payload('take_profit_1', uuid),
      subscriberId: USER_A,
      channel: 'telegram',
      alertType: 'take_profit_1',
      waitMode: 'recovery',
      send: async () => ({ ok: true, kind: 'tp1' })
    });
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'tp1');
  });

  it('CASE 10: two subscribers receive the same trade independently', async () => {
    TradingViewAlertService.setTestFanoutHooks({
      subscribers: [proSubscriber(USER_A, '80001'), proSubscriber(USER_B, '80002')]
    });
    const uuid = 'parity-c10';
    await acceptAndProcess(io, payload('entry', uuid), mem);
    assert.equal(tg.calls, 2);
    const tgJobs = jobsBy('telegram', 'entry');
    assert.equal(tgJobs.filter(j => j.state === 'delivered').length, 2);
    assert.ok(tgJobs.every(j => j.canonicalTradeId === uuid));
  });

  it('CASE 5: one channel terminal failure does not suppress the other', async () => {
    const uuid = 'parity-c5';
    tg.failNext = 99;
    await acceptAndProcess(io, payload('entry', uuid), mem);
    const mailer = require('../../utils/mailer');
    assert.equal(emails.filter(e => e.alertType === 'entry').length, 1);
    const tgJob = jobsBy('telegram', 'entry', USER_A)[0];
    assert.ok(tgJob);
    assert.notEqual(tgJob.state, 'delivered');
    mailer.__ddFailEmail = false;
    await acceptAndProcess(io, payload('take_profit_1', uuid), mem);
    assert.equal(emails.filter(e => e.alertType === 'take_profit_1').length, 1);
  });
});
