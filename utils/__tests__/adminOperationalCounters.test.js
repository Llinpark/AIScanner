/**
 * P0 operational admin counters — user TEST 1–15.
 * Does not weaken existing deliveryAccounting 29/29 tests.
 */
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const {
  overlayChannelDisplay,
  isProviderAttempted,
  emptyChannel,
  resolveHealth,
  computeDeliveryStatistics,
  OPERATIONAL_WINDOW_HOURS,
  WEBHOOK_INTAKE_TTL_DAYS
} = require('../../services/PipelineDeliveryStatsService');
const { mapJobToOutcome, successPct } = require('../deliveryOutcomes');
const { percent } = require('../pipelineObservability');
const DurableDelivery = require('../durableDelivery');
const WebhookIntakeService = require('../../services/WebhookIntakeService');
const Signal = require('../../models/Signal');

function formatChannelPct(pct, attempted) {
  if (pct == null || !Number(attempted)) return '—';
  return `${pct}%`;
}

function bucket(partial = {}) {
  return { ...emptyChannel(), ...partial };
}

function mockMongoReady() {
  const readyDesc = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
  Object.defineProperty(mongoose.connection, 'readyState', {
    configurable: true,
    get: () => 1
  });
  const origAggregate = Signal.aggregate;
  const origCount = Signal.countDocuments;
  Signal.aggregate = async () => [];
  Signal.countDocuments = async () => 0;
  return () => {
    Signal.aggregate = origAggregate;
    Signal.countDocuments = origCount;
    if (readyDesc) Object.defineProperty(mongoose.connection, 'readyState', readyDesc);
  };
}

async function seedChannelJob(spec, { outcome = 'pending', createdAt = Date.now(), sendAttempts = 0, state } = {}) {
  await DurableDelivery.ensureJob(spec);
  if (outcome === 'success') {
    await DurableDelivery.commitDeliveredBySpec(spec, { reason: 'test' });
  } else if (outcome === 'failed') {
    await DurableDelivery.commitFailedTerminalBySpec(spec, { reason: 'test_fail' });
  } else if (outcome === 'skipped') {
    await DurableDelivery.recordChannelSkip(spec, { reason: 'test_skip' });
  } else if (outcome === 'not_eligible') {
    await DurableDelivery.recordChannelSkip(spec, { reason: 'not_eligible', notEligible: true });
  }
  const job = DurableDelivery.listMemoryJobs().find(
    j => j.subscriberId === spec.subscriberId && j.channel === spec.channel
  );
  if (!job) return null;
  job.createdAt = createdAt;
  job.sendAttempts = sendAttempts;
  if (state) job.state = state;
  if (outcome === 'pending' && state === 'sending') {
    job.outcomeStatus = 'pending';
  }
  return job;
}

describe('TEST 1–15 operational admin channel cards', () => {
  it('TEST 1: Telegram 0 attempts → null → "—"', () => {
    const out = overlayChannelDisplay(bucket(), bucket());
    assert.equal(out.successPct, null);
    assert.equal(formatChannelPct(out.successPct, out.attempted), '—');
    assert.equal(out.displayReason, 'no_provider_attempts');
  });

  it('TEST 2: Email 0 attempts → null → "—"', () => {
    const out = overlayChannelDisplay(bucket({ skipped: 0 }), bucket({ skipped: 0 }));
    assert.equal(out.successPct, null);
    assert.equal(formatChannelPct(null, 0), '—');
  });

  it('TEST 3: MT5 0 linked subscribers → null → "—" + no_mt5_subscribers_linked', () => {
    const historical = bucket({ succeeded: 100, failed: 0, eligible: 100, successPct: 100 });
    const out = overlayChannelDisplay(historical, bucket(), {
      forceUnlinkedWhenZeroEligible: true,
      liveEligibleCount: 0,
      unlinkedReason: 'no_mt5_subscribers_linked'
    });
    assert.equal(out.successPct, null);
    assert.equal(out.displayReason, 'no_mt5_subscribers_linked');
    assert.equal(formatChannelPct(out.successPct, out.attempted), '—');
    assert.equal(out.window30d.succeeded, 100);
  });

  it('TEST 4: 100 skipped + 0 attempts → null, NOT 100%', () => {
    const skipped = bucket({ skipped: 100 });
    const out = overlayChannelDisplay(skipped, skipped);
    assert.equal(out.successPct, null);
    assert.notEqual(out.successPct, 100);
    assert.equal(percent(0, 0), null);
  });

  it('TEST 5: 100 not_eligible + 0 attempts → null', () => {
    const ne = bucket({ notEligible: 100 });
    const out = overlayChannelDisplay(ne, ne);
    assert.equal(out.successPct, null);
  });

  it('TEST 6: 1 provider success + 0 failures → 100%', () => {
    const op = bucket({ succeeded: 1, eligible: 1 });
    const out = overlayChannelDisplay(op, op);
    assert.equal(out.successPct, 100);
    assert.equal(formatChannelPct(100, 1), '100%');
  });

  it('TEST 7: 0 success + 1 failure → 0%', () => {
    const op = bucket({ failed: 1, eligible: 1 });
    const out = overlayChannelDisplay(op, op);
    assert.equal(out.successPct, 0);
    assert.equal(formatChannelPct(0, 1), '0%');
  });

  it('TEST 8: 1 success + 1 failure → 50%', () => {
    const op = bucket({ succeeded: 1, failed: 1, eligible: 2 });
    const out = overlayChannelDisplay(op, op);
    assert.equal(out.successPct, 50);
  });

  it('TEST 9: 100 historical successes + 0 current attempts → NOT operational 100%', () => {
    const historical = bucket({ succeeded: 100, failed: 0, eligible: 100, successPct: 100 });
    const out = overlayChannelDisplay(historical, bucket());
    assert.equal(out.successPct, null);
    assert.equal(out.displayReason, 'no_operational_provider_attempts');
    assert.equal(out.window30d.succeeded, 100);
    assert.equal(out.operational.attempted, 0);
    assert.equal(formatChannelPct(out.successPct, out.attempted), '—');
    assert.notEqual(formatChannelPct(100, 0), '100%');
  });

  it('TEST 10: provider_send_started but no provider_accepted → NOT success', () => {
    assert.equal(isProviderAttempted({ state: 'sending', sendAttempts: 0 }), true);
    assert.equal(mapJobToOutcome({ state: 'sending', outcomeStatus: 'pending' }), 'pending');
    const op = bucket({ pending: 1, eligible: 1, providerAttempted: 1 });
    const out = overlayChannelDisplay(op, op);
    assert.equal(out.successPct, null);
    assert.equal(out.operational.succeeded, 0);
  });

  it('TEST 11: job created but never provider attempted → NOT success', () => {
    assert.equal(isProviderAttempted({ state: 'pending', sendAttempts: 0 }), false);
    assert.equal(isProviderAttempted({ state: 'processing', sendAttempts: 0, lastAttemptAt: Date.now() }), false);
    assert.equal(mapJobToOutcome({ state: 'pending', outcomeStatus: 'pending' }), 'pending');
    const out = overlayChannelDisplay(bucket({ pending: 1, eligible: 1 }), bucket({ pending: 1, eligible: 1 }));
    assert.equal(out.successPct, null);
  });

  it('TEST 12: Webhook 202 + Telegram/Email failure stay separate metrics', () => {
    assert.equal(percent(1, 1), 100);
    assert.equal(successPct(0, 1), 0);
    const webhookAcceptance = percent(1, 1);
    const telegram = overlayChannelDisplay(
      bucket({ failed: 1, eligible: 1 }),
      bucket({ failed: 1, eligible: 1 })
    );
    assert.equal(webhookAcceptance, 100);
    assert.equal(telegram.successPct, 0);
    assert.notEqual(webhookAcceptance, telegram.successPct);
  });

  it('TEST 13: AUTH_FAILED remains visible in health', () => {
    const health = resolveHealth({
      intake: { received: 2, accepted: 1, rejected: 1, byCategory: { AUTH_FAILED: 1 } },
      channels: {
        telegram: bucket({ pending: 1, eligible: 1 }),
        email: bucket(),
        mt5: bucket(),
        socket: bucket()
      },
      issues: {},
      redisStatus: 'ok',
      recentAuthFailed: true
    });
    assert.notEqual(health.level, 'HEALTHY');
    assert.ok(health.reasons.some(r => /auth_failed/.test(r)));
  });

  it('TEST 14: DeliveryJob failures stay visible beside Signal-level delivered rollup', () => {
    const telegram = overlayChannelDisplay(
      bucket({ succeeded: 5, failed: 3, eligible: 8 }),
      bucket({ succeeded: 0, failed: 2, eligible: 2 })
    );
    const signalFailed = 0;
    assert.equal(signalFailed, 0);
    assert.equal(telegram.operational.failed, 2);
    assert.equal(telegram.window30d.failed, 3);
    assert.equal(telegram.successPct, 0);
  });

  it('TEST 15: legacy/unknown remains explicit when there are no jobs', () => {
    const { resolveSignalDeliverySummary } = require('../deliveryOutcomes');
    const summary = resolveSignalDeliverySummary([]);
    assert.equal(summary.accounting, 'legacy_unknown');
    assert.equal(summary.telegramSuccessPct, null);
  });
});

describe('operational window vs historical jobs (computeDeliveryStatistics)', () => {
  let restore;

  beforeEach(() => {
    DurableDelivery.resetForTests();
    WebhookIntakeService.resetForTests();
    restore = mockMongoReady();
  });

  afterEach(() => {
    DurableDelivery.resetForTests();
    if (restore) restore();
  });

  it('TEST 9 live: 100 historical telegram successes + 0 current attempts → telegramSuccessPct null', async () => {
    const tenDaysAgo = Date.now() - 10 * 24 * 3600 * 1000;
    for (let i = 0; i < 100; i += 1) {
      await seedChannelJob(
        {
          eventId: `hist-${i}`,
          canonicalTradeId: `hist-t-${i}`,
          subscriberId: `sub-${i}`,
          channel: 'telegram',
          eventType: 'entry'
        },
        { outcome: 'success', createdAt: tenDaysAgo }
      );
    }
    const stats = await computeDeliveryStatistics();
    assert.equal(stats.telegramSuccessPct, null);
    assert.equal(stats.channels.telegram.window30d.succeeded, 100);
    assert.equal(stats.channels.telegram.operational.attempted, 0);
    assert.equal(stats.channels.telegram.displayReason, 'no_operational_provider_attempts');
    assert.equal(OPERATIONAL_WINDOW_HOURS, 24);
  });

  it('current telegram success still yields 100% in the 24h window', async () => {
    await seedChannelJob(
      {
        eventId: 'now-1',
        canonicalTradeId: 'now-t-1',
        subscriberId: 'sub-now',
        channel: 'telegram',
        eventType: 'entry'
      },
      { outcome: 'success', createdAt: Date.now() }
    );
    const stats = await computeDeliveryStatistics();
    assert.equal(stats.telegramSuccessPct, 100);
    assert.equal(stats.channels.telegram.operational.succeeded, 1);
  });

  it('TEST 12 live: webhook acceptance 100% while telegram delivery is 0%', async () => {
    WebhookIntakeService.recordAsync({
      requestId: 'req-ok',
      statusCode: 202,
      accepted: true,
      persisted: true,
      deferredFanout: true
    });
    await seedChannelJob(
      {
        eventId: 'fail-1',
        canonicalTradeId: 'fail-t-1',
        subscriberId: 'sub-fail',
        channel: 'telegram',
        eventType: 'entry'
      },
      { outcome: 'failed', createdAt: Date.now() }
    );
    const stats = await computeDeliveryStatistics();
    assert.equal(stats.webhookSuccessPct, 100);
    assert.equal(stats.webhookMetric, 'acceptance');
    assert.equal(stats.telegramSuccessPct, 0);
    assert.equal(stats.providerFailed24h, 1);
    assert.equal(stats.failedSignals, 0);
  });

  it('TEST 11 live: pending job without send is not success', async () => {
    await seedChannelJob(
      {
        eventId: 'pend-1',
        canonicalTradeId: 'pend-t-1',
        subscriberId: 'sub-pend',
        channel: 'telegram',
        eventType: 'entry'
      },
      { outcome: 'pending', createdAt: Date.now() }
    );
    const stats = await computeDeliveryStatistics();
    assert.equal(stats.telegramSuccessPct, null);
    assert.equal(stats.channels.telegram.operational.pending, 1);
    assert.equal(stats.channels.telegram.operational.succeeded, 0);
  });
});

describe('frontend card contracts', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../frontend/src/admin/AdminPipeline.jsx'),
    'utf8'
  );

  it('never shows Telegram-only is OK on MT5', () => {
    assert.doesNotMatch(src, /Telegram-only is OK/);
    assert.match(src, /No MT5 subscribers linked/);
  });

  it('labels webhook as acceptance not delivery', () => {
    assert.match(src, /Webhook acceptance/);
    assert.match(src, /not subscriber delivery/);
    assert.doesNotMatch(src, /<span className="admin-stat-label">Webhook success<\/span>/);
  });

  it('never renders % when attempted is 0', () => {
    assert.match(src, /function formatChannelPct/);
    assert.match(src, /if \(pct == null \|\| !Number\(attempted\)\) return '—'/)
    assert.equal(formatChannelPct(100, 0), '—');
    assert.equal(formatChannelPct(null, 0), '—');
  });

  it('keeps Last Auth FAIL visible after a later PASS', () => {
    assert.match(src, /Last Auth FAIL remains visible/);
  });

  it('exposes attempted \/ successful \/ failed \/ skipped \/ not eligible \/ pending', () => {
    assert.match(src, /24h attempted/);
    assert.match(src, /Successful/);
    assert.match(src, /Failed/);
    assert.match(src, /Skipped/);
    assert.match(src, /Not eligible/);
    assert.match(src, /Pending/);
  });

  it('documents webhook intake TTL vs 30d delivery window', () => {
    assert.equal(WEBHOOK_INTAKE_TTL_DAYS, 7);
    assert.match(src, /intake TTL/);
  });
});
