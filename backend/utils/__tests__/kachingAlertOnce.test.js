/**
 * Exactly-once Kaching alerts (Pine 1.3.0) — tests 1–12.
 * Pine: single alert() gateway + eventId. Backend: Redis claim before persist/fan-out.
 */
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { PINE_CLIENT_VERSION } = require('../PineClientVersion');
const {
  resolveLogicalEventId,
  resolveCanonicalTradeId,
  resolveEventTypeToken
} = require('../tradeEventIdentity');
const TradeEventStore = require('../tradeEventStore');

const SNIPPET_DIR = path.join(__dirname, '../../templates/snippets');
const TEMPLATE_DIR = path.join(__dirname, '../../templates');
const ARM = fs.readFileSync(path.join(SNIPPET_DIR, 'kaching-canon-event-arm.pine.snippet'), 'utf8');
const DRAW = fs.readFileSync(path.join(SNIPPET_DIR, 'kaching-trade-drawing.pine.snippet'), 'utf8');
const SCALP = fs.readFileSync(path.join(TEMPLATE_DIR, 'kaching-sweep-fvg-scalp.pine.template'), 'utf8');
const DAY = fs.readFileSync(path.join(TEMPLATE_DIR, 'kaching-sweep-fvg-daytrading.pine.template'), 'utf8');

function codeOnly(src) {
  return src
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

describe('Kaching exactly-once alerts 1–12', () => {
  it('M. stamps 1.3.0 (drawing cleanup + duplicate-fix; not 1.2.2)', () => {
    assert.equal(PINE_CLIENT_VERSION, '1.3.0');
    assert.notEqual(PINE_CLIENT_VERSION, '1.2.2');
  });

  it('1/A. every alert() in templates/snippets is inside emitKachingEvent', () => {
    const armCode = codeOnly(ARM);
    const drawCode = codeOnly(DRAW);
    const scalpCode = codeOnly(SCALP);
    const dayCode = codeOnly(DAY);
    assert.equal((armCode.match(/\balert\s*\(/g) || []).length, 1);
    assert.equal((drawCode.match(/\balert\s*\(/g) || []).length, 0);
    assert.equal((scalpCode.match(/\balert\s*\(/g) || []).length, 0);
    assert.equal((dayCode.match(/\balert\s*\(/g) || []).length, 0);
    const alertAt = armCode.indexOf('alert(payload, alert.freq_all)');
    const fnAt = armCode.indexOf('emitKachingEvent(');
    assert.ok(fnAt >= 0 && alertAt > fnAt);
  });

  it('2/B. emitKachingEvent is the only gateway; no emitLiveAlert leftover', () => {
    assert.match(ARM, /emitKachingEvent\(/);
    assert.doesNotMatch(ARM, /emitLiveAlert/);
    assert.doesNotMatch(DRAW, /emitLiveAlert/);
    assert.match(ARM, /varip array<string> kachingEmitIds/);
  });

  it('3/C. payload carries eventId, canonicalTradeId, eventType, eventSequence', () => {
    for (const [label, src] of [
      ['scalp', SCALP],
      ['day', DAY]
    ]) {
      assert.match(src, /"eventId":"/, label);
      assert.match(src, /"canonicalTradeId":"/, label);
      assert.match(src, /"eventType":"/, label);
      assert.match(src, /"eventSequence":/, label);
      assert.match(src, /makeKachingEventId\(/, label);
    }
  });

  it('4/D. Pine marks eventId then alert(); does not rely on freq_once_per_bar', () => {
    const fn = ARM.slice(ARM.indexOf('emitKachingEvent('));
    const pushIdx = fn.indexOf('array.push(ids, eventId)');
    const alertIdx = fn.indexOf('alert(payload, alert.freq_all)');
    assert.ok(pushIdx >= 0 && alertIdx > pushIdx, 'mark then alert');
    assert.doesNotMatch(ARM, /alert\.freq_once_per_bar/);
    assert.match(ARM, /kachingIdEmitted\(/);
  });

  it('5/E. one-way machine; TP3 and SL mutually exclusive; terminal blocks further', () => {
    assert.match(ARM, /sameTrade and terminal == 1/);
    assert.match(ARM, /isTp3 and hitSl == 1/);
    assert.match(ARM, /isSl and hitTp3 == 1/);
    assert.match(ARM, /evSeq < maxSeq/);
  });

  it('6/H. drawing cleanup does not reset emission flags', () => {
    assert.doesNotMatch(DRAW, /kachingEmitIds|kachingEmitTrade|kachingEmitMachine/);
    assert.match(ARM, /cleanupActiveTradeDrawings\(\) MUST NOT receive or reset these/);
  });

  it('7/F. both ENTRY paths call emitKachingEvent; already-emitted skips re-arm', () => {
    const entryCalls = ARM.match(/emitKachingEvent\("entry"/g) || [];
    assert.equal(entryCalls.length, 2);
    assert.match(ARM, /kachingIdEmitted\(kachingEmitIds, makeKachingEventId\(sigId, "ENTRY"\)\)/);
    assert.match(ARM, /kachingIdEmitted\(kachingEmitIds, makeKachingEventId\(sigId2, "ENTRY"\)\)/);
  });

  it('8/G. barstate.isrealtime still required inside the gateway', () => {
    assert.match(ARM, /if barstate\.isrealtime/);
    assert.match(ARM, /alert\(payload, alert\.freq_all\)/);
  });
});

describe('Kaching exactly-once — generated Pine + identity', () => {
  it('9. generated scripts: one alert(), eventId fields, version 1.3.0', () => {
    process.env.TRADINGVIEW_WEBHOOK_SECRET =
      process.env.TRADINGVIEW_WEBHOOK_SECRET || 'smoke-test-tv-webhook-secret';
    process.env.WEBHOOK_SIGNING_SECRET =
      process.env.WEBHOOK_SIGNING_SECRET || 'smoke-test-license-signing-secret';
    const { generateForUser } = require('../../services/PineScriptGeneratorService');
    const user = {
      _id: '507f1f77bcf86cd799439011',
      email: 't@test.com',
      tradingviewUsername: 'demo_trader',
      subscription: { tier: 'professional', status: 'active' }
    };
    for (const strategy of ['scalping', 'daytrading']) {
      const g = generateForUser(user, { strategy });
      assert.equal(g.pineClientVersion, '1.3.0');
      const code = codeOnly(g.script);
      assert.equal((code.match(/\balert\s*\(/g) || []).length, 1, strategy);
      assert.match(g.script, /"eventId":"/);
      assert.match(g.script, /emitKachingEvent\(/);
      assert.doesNotMatch(g.script, /emitLiveAlert/);
      assert.match(g.instructions.join('\n'), /DELETE ALL old TradingView alerts/i);
    }
  });

  it('10. resolveLogicalEventId prefers explicit eventId over uuid', () => {
    const a = resolveLogicalEventId({
      eventId: 'JUMP_10_INDEX|5|uuid-a|ENTRY',
      signalUuid: 'uuid-a',
      symbol: 'JUMP_10_INDEX',
      timeframe: '5',
      alertType: 'entry'
    });
    const b = resolveLogicalEventId({
      eventId: 'JUMP_10_INDEX|5|uuid-a|ENTRY',
      signalUuid: 'uuid-B-different',
      symbol: 'JUMP_10_INDEX',
      timeframe: '5',
      alertType: 'entry'
    });
    assert.equal(a, b);
    assert.equal(resolveEventTypeToken('take_profit_3'), 'TP3');
    assert.equal(resolveCanonicalTradeId({ canonicalTradeId: 'ct-1', signalUuid: 'other' }), 'ct-1');
  });
});

describe('Kaching exactly-once — Redis claims 10–12', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  beforeEach(() => {
    TradeEventStore.resetForTests();
  });
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    TradeEventStore.resetForTests();
  });

  it('10. claimEventId is NX: first wins, retries lose', async () => {
    const id = 'JUMP_10_INDEX|5|trade-1|ENTRY';
    assert.equal(await TradeEventStore.claimEventId(id), true);
    assert.equal(await TradeEventStore.claimEventId(id), false);
    assert.equal(await TradeEventStore.hasEventId(id), true);
  });

  it('11. same eventId with different signalUuids is one claim', async () => {
    const eventId = 'JUMP_10_INDEX|5|canon-x|ENTRY';
    assert.equal(await TradeEventStore.claimEventId(eventId), true);
    assert.equal(await TradeEventStore.claimEventId(eventId), false);
  });

  it('12. 100 HTTP retries of the same eventId = one owner', async () => {
    const eventId = 'JUMP_10_INDEX|5|retry-trade|ENTRY';
    let wins = 0;
    for (let i = 0; i < 100; i += 1) {
      if (await TradeEventStore.claimEventId(eventId)) wins += 1;
    }
    assert.equal(wins, 1);
  });

  it('12b. accept path: duplicate eventId skips persist/fan-out (HTTP 202 contract)', async () => {
    process.env.WEBHOOK_SIGNING_SECRET =
      process.env.WEBHOOK_SIGNING_SECRET || 'smoke-test-license-signing-secret';
    const TradingViewAlertService = require('../../services/TradingViewAlertService');
    const { generateLicenseToken } = require('../webhookSecurity');
    const io = { emit() {} };
    const mem = [];
    const eventId = 'AZDUP|15|canon-dup|ENTRY';
    const body = (uuid) => ({
      symbol: 'AZDUP',
      timeframe: '15m',
      canonicalSignalTf: '15',
      alertType: 'entry',
      direction: 'long',
      entry: 1.17,
      stop_loss: 1.16,
      take_profit_1: 1.18,
      take_profit_2: 1.19,
      take_profit_3: 1.2,
      confidence: 0.8,
      signalUuid: uuid,
      signalId: uuid,
      canonicalTradeId: 'canon-dup',
      eventId,
      eventType: 'ENTRY',
      eventSequence: 0,
      isRealtime: true,
      message: 'KACHING BUY',
      broadcast: true,
      tradingviewUsername: 'once-tv',
      userId: 'once-user',
      licenseToken: generateLicenseToken('once-user', 'once-tv'),
      pineClientVersion: '1.3.0'
    });
    const first = await TradingViewAlertService.acceptTradingViewWebhook(io, body('uuid-1'), mem);
    const second = await TradingViewAlertService.acceptTradingViewWebhook(io, body('uuid-2'), mem);
    assert.equal(first.accepted, true);
    assert.equal(first.duplicate, false);
    assert.equal(second.accepted, true);
    assert.equal(second.duplicate, true);
    assert.equal(second.reason, 'duplicate_event_id');
    assert.equal(second.skippedFanout, true);
    assert.equal(mem.length, 1);
  });

  it('13. eventId uses CANONICAL_SIGNAL_TF, not chart timeframe.period', () => {
    assert.match(SCALP, /syminfo\.ticker \+ "\|" \+ CANONICAL_SIGNAL_TF \+ "\|" \+ canonicalTradeId \+ "\|" \+ evType/);
    assert.match(DAY, /syminfo\.ticker \+ "\|" \+ CANONICAL_SIGNAL_TF \+ "\|" \+ canonicalTradeId \+ "\|" \+ evType/);
    const makeFn = SCALP.slice(SCALP.indexOf('makeKachingEventId('), SCALP.indexOf('buildPayload('));
    assert.doesNotMatch(makeFn, /timeframe\.period/);
  });

  it('14. production Redis down refuses process-local claimEventId', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    TradeEventStore.resetForTests();
    TradeEventStore.setClientForTests(null, { unavailable: true });
    assert.equal(TradeEventStore.allowMemoryFallback(), false);
    await assert.rejects(
      () => TradeEventStore.claimEventId('JUMP_10_INDEX|5|prod-trade|ENTRY'),
      err => err && err.code === 'REDIS_UNAVAILABLE' && err.reason === 'redis_unavailable'
    );
    process.env.NODE_ENV = prev;
    TradeEventStore.resetForTests();
  });

  it('15. production Redis down: webhook is 503 redis_unavailable, not a local claim', async () => {
    process.env.WEBHOOK_SIGNING_SECRET =
      process.env.WEBHOOK_SIGNING_SECRET || 'smoke-test-license-signing-secret';
    const TradingViewAlertService = require('../../services/TradingViewAlertService');
    const { generateLicenseToken } = require('../webhookSecurity');
    const licenseToken = generateLicenseToken('once-user', 'once-tv');
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    TradeEventStore.resetForTests();
    TradeEventStore.setClientForTests(null, { unavailable: true });
    const body = {
      symbol: 'AZREDIS',
      timeframe: '15m',
      canonicalSignalTf: '15',
      alertType: 'entry',
      direction: 'long',
      entry: 1.17,
      stop_loss: 1.16,
      take_profit_1: 1.18,
      take_profit_2: 1.19,
      take_profit_3: 1.2,
      confidence: 0.8,
      signalUuid: 'canon-redis',
      signalId: 'canon-redis',
      canonicalTradeId: 'canon-redis',
      eventId: 'AZREDIS|15|canon-redis|ENTRY',
      eventType: 'ENTRY',
      eventSequence: 0,
      isRealtime: true,
      message: 'KACHING BUY',
      broadcast: true,
      tradingviewUsername: 'once-tv',
      userId: 'once-user',
      licenseToken,
      pineClientVersion: '1.3.0'
    };
    const mem = [];
    const result = await TradingViewAlertService.acceptTradingViewWebhook({ emit() {} }, body, mem);
    assert.equal(result.rejected, true);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'redis_unavailable');
    assert.equal(result.httpStatus, 503);
    assert.equal(mem.length, 0);
    assert.equal(TradingViewAlertService.rejectedWebhookHttpStatus('redis_unavailable'), 503);
    process.env.NODE_ENV = prev;
    TradeEventStore.resetForTests();
  });
});
