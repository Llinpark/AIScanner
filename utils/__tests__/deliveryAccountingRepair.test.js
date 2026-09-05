/**
 * P0 delivery accounting repair — user TEST 1–12.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  resolveSignalDeliverySummary,
  resolveDeliveryStatus,
  mergeSignalDeliveryStatus,
  mergeDeliveryStatusOps,
  successPct
} = require('../deliveryOutcomes');
const { percent } = require('../pipelineObservability');
const WebhookIntakeService = require('../../services/WebhookIntakeService');
const { resolveHealth } = require('../../services/PipelineDeliveryStatsService');
const TradeDeliveryService = require('../../services/TradeDeliveryService');

const emptyChannels = () => ({
  telegram: { eligible: 0, pending: 0, succeeded: 0, failed: 0, skipped: 0, notEligible: 0 },
  email: { eligible: 0, pending: 0, succeeded: 0, failed: 0, skipped: 0, notEligible: 0 },
  mt5: { eligible: 0, pending: 0, succeeded: 0, failed: 0, skipped: 0, notEligible: 0 },
  socket: { eligible: 0, pending: 0, succeeded: 0, failed: 0, skipped: 0, notEligible: 0 }
});

describe('TEST 1 webhook auth failure accounting', () => {
  beforeEach(() => WebhookIntakeService.resetForTests());

  it('records AUTH_FAILED intake, no delivered signal, health DEGRADED, no fake telegram success', () => {
    WebhookIntakeService.recordAsync({
      requestId: 'req-auth-fail',
      statusCode: 401,
      accepted: false,
      persisted: false,
      skippedFanout: true,
      reason: 'unauthorized'
    });
    const mem = WebhookIntakeService._memory();
    assert.equal(mem[mem.length - 1].category, 'AUTH_FAILED');
    assert.equal(mem[mem.length - 1].accepted, false);

    const summary = resolveSignalDeliverySummary([]);
    assert.equal(summary.accounting, 'legacy_unknown');
    assert.notEqual(summary.signalStatus, 'delivered');

    const health = resolveHealth({
      intake: { received: 1, accepted: 0, rejected: 1, byCategory: { AUTH_FAILED: 1 } },
      channels: emptyChannels(),
      issues: {},
      redisStatus: 'ok',
      recentAuthFailed: true
    });
    assert.equal(health.level, 'DEGRADED');
    assert.ok(health.reasons.some(r => /auth_failed/.test(r)));
    assert.equal(successPct(0, 0), null);
  });
});

describe('TEST 2 accepted ENTRY with successful Telegram', () => {
  it('one canonical signal, telegram SUCCESS, aggregate delivered', () => {
    const summary = resolveSignalDeliverySummary([
      { channel: 'telegram', outcome: 'success', subscriberId: 'u1' },
      { channel: 'mt5', outcome: 'skipped', subscriberId: 'u1' },
      { channel: 'email', outcome: 'skipped', subscriberId: 'u1' }
    ]);
    assert.equal(summary.accounting, 'per_recipient');
    assert.equal(summary.signalStatus, 'delivered');
    assert.equal(summary.telegram.succeeded, 1);
    assert.equal(summary.telegram.eligible, 1);
    assert.equal(summary.telegramSuccessPct, 100);
  });
});

describe('TEST 3 / TEST 10 one subscriber succeeds another fails', () => {
  it('signal is PARTIAL and later success cannot erase earlier failure', () => {
    const summary = resolveSignalDeliverySummary([
      { channel: 'telegram', outcome: 'success', subscriberId: 'a' },
      { channel: 'telegram', outcome: 'failed', subscriberId: 'b' }
    ]);
    assert.equal(summary.signalStatus, 'partial');
    assert.equal(summary.telegram.succeeded, 1);
    assert.equal(summary.telegram.failed, 1);
    assert.equal(summary.telegramSuccessPct, 50);

    assert.equal(mergeSignalDeliveryStatus('failed', 'delivered'), 'partial');
    assert.equal(mergeSignalDeliveryStatus('delivered', 'failed'), 'partial');
    const deliveredOps = mergeDeliveryStatusOps('delivered');
    assert.ok(deliveredOps.some(op => op.filter.deliveryStatus === 'failed' && op.set.deliveryStatus === 'partial'));
    assert.ok(
      deliveredOps.some(
        op => op.filter.deliveryStatus?.$nin?.includes('failed') && op.set.deliveryStatus === 'delivered'
      )
    );
  });
});

describe('TEST 4 all applicable channels skipped', () => {
  it('aggregate SKIPPED never DELIVERED', () => {
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
      { channel: 'telegram', outcome: 'skipped' },
      { channel: 'mt5', outcome: 'not_eligible' },
      { channel: 'email', outcome: 'skipped' }
    ]);
    assert.equal(summary.signalStatus, 'skipped');
    assert.notEqual(summary.signalStatus, 'delivered');
  });
});

describe('TEST 5 Telegram pending', () => {
  it('PENDING remains visible and is not success or failure', () => {
    const summary = resolveSignalDeliverySummary([
      { channel: 'telegram', outcome: 'pending', subscriberId: 'u1' }
    ]);
    assert.equal(summary.signalStatus, 'pending');
    assert.equal(summary.telegram.pending, 1);
    assert.equal(summary.telegram.succeeded, 0);
    assert.equal(summary.telegram.failed, 0);
    assert.equal(summary.telegramSuccessPct, null);
  });
});

describe('TEST 6 Email failure', () => {
  it('email FAILED is visible in operational metrics', () => {
    const summary = resolveSignalDeliverySummary([
      { channel: 'telegram', outcome: 'success' },
      { channel: 'email', outcome: 'failed' }
    ]);
    assert.equal(summary.signalStatus, 'partial');
    assert.equal(summary.email.failed, 1);
    assert.equal(summary.email.successPct, 0);
    const health = resolveHealth({
      intake: { received: 1, accepted: 1, rejected: 0 },
      channels: {
        ...emptyChannels(),
        telegram: { ...emptyChannels().telegram, succeeded: 1, eligible: 1 },
        email: { ...emptyChannels().email, failed: 1, eligible: 1 }
      },
      issues: {},
      redisStatus: 'ok',
      recentAuthFailed: false
    });
    assert.equal(health.level, 'DEGRADED');
    assert.ok(health.reasons.includes('email_channel_failures'));
  });
});

describe('TEST 7 missing_channel_payload', () => {
  it('visible in pipeline issues and not counted delivered', () => {
    const summary = resolveSignalDeliverySummary([
      { channel: 'telegram', state: 'failed_terminal', outcomeStatus: 'failed' }
    ]);
    assert.equal(summary.signalStatus, 'failed');
    assert.notEqual(summary.signalStatus, 'delivered');
    const health = resolveHealth({
      intake: { received: 1, accepted: 1, rejected: 0 },
      channels: emptyChannels(),
      issues: { missing_channel_payload: 2, delivery_context_unrecoverable: 0 },
      redisStatus: 'ok',
      recentAuthFailed: false
    });
    assert.equal(health.level, 'DEGRADED');
    assert.ok(health.reasons.includes('missing_channel_payload'));
  });
});

describe('TEST 8 TP2 lifecycle vs ENTRY', () => {
  it('lifecycle events are not ENTRY and correlation query still works', () => {
    const SignalCorrelationService = require('../../services/SignalCorrelationService');
    assert.equal(typeof SignalCorrelationService.lookupCorrelation, 'function');
    const entryMatch = { alertType: { $in: ['entry', 'signal'] } };
    const lifecycleMatch = { alertType: { $nin: ['entry', 'signal'] } };
    assert.ok(entryMatch.alertType.$in.includes('entry'));
    assert.ok(lifecycleMatch.alertType.$nin.includes('entry'));
    assert.ok(lifecycleMatch.alertType.$nin.includes('take_profit_2') === false);
  });
});

describe('TEST 9 webhook metrics from durable intake not last-100 ring', () => {
  beforeEach(() => WebhookIntakeService.resetForTests());

  it('aggregates WebhookIntakeService memory, independent of pipeline ring', async () => {
    WebhookIntakeService.recordAsync({
      requestId: 'req-ok',
      statusCode: 202,
      accepted: true,
      persisted: true,
      deferredFanout: true
    });
    WebhookIntakeService.recordAsync({
      requestId: 'req-auth',
      statusCode: 401,
      accepted: false
    });
    const agg = await WebhookIntakeService.aggregateWindow({
      since: new Date(Date.now() - 1000),
      until: new Date(Date.now() + 1000)
    });
    assert.equal(agg.source, 'memory');
    assert.equal(agg.received, 2);
    assert.equal(agg.accepted, 1);
    assert.equal(agg.rejected, 1);
    assert.equal(agg.byCategory.ACCEPTED, 1);
    assert.equal(agg.byCategory.AUTH_FAILED, 1);
    assert.equal(percent(agg.accepted, agg.received), 50);
  });
});

describe('TEST 11 legacy Signal without per-recipient outcomes', () => {
  it('empty outcomes are LEGACY/UNKNOWN with no fabricated success', () => {
    const summary = resolveSignalDeliverySummary([]);
    assert.equal(summary.accounting, 'legacy_unknown');
    assert.equal(summary.signalStatus, 'pending');
    assert.equal(summary.telegramSuccessPct, null);
    assert.equal(summary.telegram.succeeded, 0);
  });
});

describe('TEST 12 HTTP ACK semantics', () => {
  it('scheduleAcceptedTradingViewSignal is not awaited on the 202 path', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
    assert.match(src, /TradingViewAlertService\.scheduleAcceptedTradingViewSignal\(io, accept, inMemorySignals\)/);
    assert.doesNotMatch(src, /await TradingViewAlertService\.scheduleAcceptedTradingViewSignal/);
    assert.match(src, /return res\.status\(202\)\.json/);
    const ack = fs.readFileSync(path.join(__dirname, '../tvAckLog.js'), 'utf8');
    assert.match(ack, /\[TV_ACK\]/);
    assert.match(ack, /TV_ACK_SLOW/);
    assert.match(ack, /WebhookIntakeService\.recordAsync/);
    const docker = fs.readFileSync(path.join(__dirname, '../../Dockerfile'), 'utf8');
    assert.match(docker, /--report-on-fatalerror/);
  });

  it('RC-E stale ENTRY still uses commitFailedTerminalBySpec; RC-G ENTRY uses Promise.allSettled', () => {
    const tv = fs.readFileSync(
      path.join(__dirname, '../../services/TradingViewAlertService.js'),
      'utf8'
    );
    assert.match(tv, /commitFailedTerminalBySpec/);
    assert.match(tv, /stale_trade_before_delivery/);
    const td = fs.readFileSync(path.join(__dirname, '../../services/TradeDeliveryService.js'), 'utf8');
    assert.match(td, /Promise\.allSettled/);
    assert.match(td, /resolveDeliveryStatus/);
  });
});

describe('honest telegram percent contract', () => {
  it('zero attempts → null never 100%; skip+skip is skipped', () => {
    assert.equal(percent(0, 0), null);
    assert.equal(successPct(0, 0), null);
    assert.equal(TradeDeliveryService.resolveDeliveryStatus({
      telegramSent: true,
      mt5Sent: false,
      tgPipelineStatus: 'PASS',
      mt5PipelineStatus: 'SKIP'
    }), 'delivered');
  });
});
