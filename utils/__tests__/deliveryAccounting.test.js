'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  resolveDeliveryStatus,
  resolveSignalDeliverySummary,
  mergeSignalDeliveryStatus,
  mergeDeliveryStatusOps,
  successPct,
  OUTCOME
} = require('../deliveryOutcomes');
const TradeDeliveryService = require('../../services/TradeDeliveryService');
const WebhookIntakeService = require('../../services/WebhookIntakeService');
const { emitTvAck } = require('../tvAckLog');
const { percent } = require('../pipelineObservability');

describe('TEST 1–12 delivery accounting / observability', () => {
  beforeEach(() => {
    WebhookIntakeService.resetForTests();
  });

  it('TEST 1: tg SKIP + mt5 SKIP is skipped, never delivered', () => {
    assert.equal(
      resolveDeliveryStatus({
        telegramSent: false,
        mt5Sent: false,
        tgPipelineStatus: 'SKIP',
        mt5PipelineStatus: 'SKIP'
      }),
      'skipped'
    );
    const summary = resolveSignalDeliverySummary([
      { channel: 'telegram', outcome: OUTCOME.SKIPPED },
      { channel: 'mt5', outcome: OUTCOME.SKIPPED }
    ]);
    assert.equal(summary.signalStatus, 'skipped');
    assert.notEqual(summary.signalStatus, 'delivered');
  });

  it('TEST 2: Telegram PASS + MT5 SKIP is delivered (telegram-only OK)', () => {
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

  it('TEST 3: Telegram FAIL + MT5 SKIP is failed, not delivered', () => {
    assert.equal(
      resolveDeliveryStatus({
        telegramSent: false,
        mt5Sent: false,
        tgPipelineStatus: 'FAIL',
        mt5PipelineStatus: 'SKIP'
      }),
      'failed'
    );
  });

  it('TEST 4: one subscriber success cannot overwrite another failure (partial)', () => {
    assert.equal(mergeSignalDeliveryStatus('failed', 'delivered'), 'partial');
    assert.equal(mergeSignalDeliveryStatus('delivered', 'failed'), 'partial');
    const deliveredOps = mergeDeliveryStatusOps('delivered');
    assert.ok(deliveredOps.some(op => op.filter.deliveryStatus === 'failed'));
    const failedOps = mergeDeliveryStatusOps('failed');
    assert.ok(failedOps.some(op => op.filter.deliveryStatus === 'delivered'));
  });

  it('TEST 5: zero telegram attempts → successPct null, never 100%', () => {
    assert.equal(successPct(0, 0), null);
    assert.equal(percent(0, 0), null);
    const empty = resolveSignalDeliverySummary([]);
    assert.equal(empty.telegramSuccessPct, null);
    assert.equal(empty.accounting, 'legacy_unknown');
  });

  it('TEST 6: skipped / not_eligible excluded from telegram success denominator', () => {
    const summary = resolveSignalDeliverySummary([
      { channel: 'telegram', outcome: OUTCOME.SUCCESS },
      { channel: 'telegram', outcome: OUTCOME.SKIPPED },
      { channel: 'telegram', outcome: OUTCOME.NOT_ELIGIBLE },
      { channel: 'telegram', outcome: OUTCOME.FAILED }
    ]);
    assert.equal(summary.telegram.succeeded, 1);
    assert.equal(summary.telegram.failed, 1);
    assert.equal(summary.telegram.skipped, 1);
    assert.equal(summary.telegram.notEligible, 1);
    assert.equal(summary.telegramSuccessPct, 50);
    assert.equal(summary.signalStatus, 'partial');
  });

  it('TEST 7: webhook intake metrics come from durable store, not Redis ring', () => {
    WebhookIntakeService.recordAsync({
      requestId: 'req-intake-1',
      statusCode: 202,
      accepted: true,
      persisted: true,
      deferredFanout: true,
      category: 'ACCEPTED'
    });
    WebhookIntakeService.recordAsync({
      requestId: 'req-intake-2',
      statusCode: 401,
      accepted: false,
      category: 'AUTH_FAILED'
    });
    const mem = WebhookIntakeService._memory();
    assert.equal(mem.length, 2);
    assert.equal(mem[0].category, 'ACCEPTED');
    assert.equal(mem[1].category, 'AUTH_FAILED');
    assert.ok(!JSON.stringify(mem).includes('last-100'));
  });

  it('TEST 8: HTTP 202 path must not await scheduleAcceptedTradingViewSignal', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
    assert.match(src, /TradingViewAlertService\.scheduleAcceptedTradingViewSignal\(/);
    assert.doesNotMatch(
      src,
      /await\s+TradingViewAlertService\.scheduleAcceptedTradingViewSignal/
    );
    const ack = fs.readFileSync(
      path.join(__dirname, '../../services/TradingViewAlertService.js'),
      'utf8'
    );
    assert.match(ack, /function scheduleAcceptedTradingViewSignal\(/);
    assert.doesNotMatch(ack, /async function scheduleAcceptedTradingViewSignal/);
  });

  it('TEST 9: historical Signals without per-recipient rows are LEGACY/UNKNOWN', () => {
    const summary = resolveSignalDeliverySummary([]);
    assert.equal(summary.accounting, 'legacy_unknown');
    assert.equal(summary.signalStatus, 'pending');
  });

  it('TEST 10: health AUTH fail is not HEALTHY; isolated fail is DEGRADED not CRITICAL', () => {
    const { resolveHealth } = require('../../services/PipelineDeliveryStatsService');
    const auth = resolveHealth({
      intake: { rejected: 1, accepted: 0, received: 2, byCategory: { AUTH_FAILED: 1 } },
      channels: {
        telegram: { pending: 1, succeeded: 0, failed: 0 },
        email: { pending: 0, succeeded: 0, failed: 0 },
        mt5: { pending: 0, succeeded: 0, failed: 0 },
        socket: { pending: 0, succeeded: 0, failed: 0 }
      },
      issues: {},
      redisStatus: 'ok',
      recentAuthFailed: true
    });
    assert.notEqual(auth.level, 'HEALTHY');
    assert.equal(auth.level, 'DEGRADED');

    const isolated = resolveHealth({
      intake: { rejected: 0, accepted: 5, received: 5, byCategory: {} },
      channels: {
        telegram: { pending: 0, succeeded: 4, failed: 1 },
        email: { pending: 0, succeeded: 0, failed: 0 },
        mt5: { pending: 0, succeeded: 0, failed: 0 },
        socket: { pending: 0, succeeded: 0, failed: 0 }
      },
      issues: {},
      redisStatus: 'ok',
      recentAuthFailed: false
    });
    assert.equal(isolated.level, 'DEGRADED');
    assert.notEqual(isolated.level, 'CRITICAL');
  });

  it('TEST 11: correlation lookup redacts payload secrets', () => {
    const { lookupCorrelation } = require('../../services/SignalCorrelationService');
    assert.equal(typeof lookupCorrelation, 'function');
    const src = fs.readFileSync(
      path.join(__dirname, '../../services/SignalCorrelationService.js'),
      'utf8'
    );
    assert.match(src, /function redactJob/);
    assert.match(src, /hasSubscriberSnapshot/);
    assert.doesNotMatch(src, /payload\.(token|password|licenseToken|botToken)/);
  });

  it('TEST 12: compact webhook intake is fire-and-forget after ACK (recordAsync + setImmediate)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../services/WebhookIntakeService.js'),
      'utf8'
    );
    assert.match(src, /function recordAsync/);
    assert.match(src, /setImmediate/);
    const logs = [];
    emitTvAck(
      {
        requestId: 'ack-1',
        symbol: 'EURUSD',
        tf: '5',
        status: 202,
        accepted: true,
        persisted: true,
        deferredFanout: true,
        ackMs: 12
      },
      { log: line => logs.push(line) }
    );
    assert.ok(logs.some(l => l.startsWith('[TV_ACK]')));
    assert.ok(WebhookIntakeService._memory().some(d => d.requestId === 'ack-1'));
  });
});

describe('RC-E / RC-G preservation', () => {
  it('RC-E: stale unsent ENTRY uses commitFailedTerminalBySpec not commitDeliveredBySpec', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../services/TradingViewAlertService.js'),
      'utf8'
    );
    const staleIdx = src.indexOf("reason: 'stale_trade_before_delivery'");
    assert.ok(staleIdx > 0);
    const window = src.slice(Math.max(0, staleIdx - 400), staleIdx + 200);
    assert.match(window, /commitFailedTerminalBySpec/);
    assert.doesNotMatch(window, /commitDeliveredBySpec\(\s*fanoutSpec/);
  });

  it('RC-G: ENTRY fan-out uses Promise.allSettled', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../services/TradeDeliveryService.js'),
      'utf8'
    );
    assert.match(src, /Promise\.allSettled/);
    assert.match(src, /ENTRY: start email \/ telegram \/ MT5 independently/);
  });
});

describe('TV_ACK and fatal-report flags remain', () => {
  it('keeps [TV_ACK]/[TV_ACK_SLOW] emitters', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../utils/tvAckLog.js'), 'utf8');
    assert.match(src, /TV_ACK/);
    assert.match(src, /TV_ACK_SLOW/);
  });

  it('keeps Node --report-on-fatalerror', () => {
    const pkg = fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8');
    assert.match(pkg, /--report-on-fatalerror/);
    const docker = fs.readFileSync(path.join(__dirname, '../../Dockerfile'), 'utf8');
    assert.match(docker, /--report-on-fatalerror/);
  });
});
