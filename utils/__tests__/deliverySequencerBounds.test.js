'use strict';

process.env.REDIS_ENABLED = process.env.REDIS_ENABLED || 'false';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DeliverySequencer = require('../deliverySequencer');
const TradeEventStore = require('../tradeEventStore');
const PipelineStatusService = require('../../services/PipelineStatusService');

describe('delivery sequencer bounds + operational latency', () => {
  const prevWait = process.env.DELIVERY_SEQ_WAIT_MS;
  const prevPoll = process.env.DELIVERY_SEQ_POLL_MS;
  const prevSeqMax = process.env.SEQUENCE_WAIT_MAX_MS;

  beforeEach(() => {
    delete process.env.DELIVERY_SEQ_WAIT_MS;
    delete process.env.DELIVERY_SEQ_POLL_MS;
    delete process.env.SEQUENCE_WAIT_MAX_MS;
    TradeEventStore.resetForTests();
    PipelineStatusService.resetForTests();
  });

  afterEach(() => {
    if (prevWait == null) delete process.env.DELIVERY_SEQ_WAIT_MS;
    else process.env.DELIVERY_SEQ_WAIT_MS = prevWait;
    if (prevPoll == null) delete process.env.DELIVERY_SEQ_POLL_MS;
    else process.env.DELIVERY_SEQ_POLL_MS = prevPoll;
    if (prevSeqMax == null) delete process.env.SEQUENCE_WAIT_MAX_MS;
    else process.env.SEQUENCE_WAIT_MAX_MS = prevSeqMax;
    TradeEventStore.resetForTests();
    PipelineStatusService.resetForTests();
  });

  it('live wait default is 3000ms and poll is 50ms', () => {
    const src = fs.readFileSync(path.join(__dirname, '../deliverySequencer.js'), 'utf8');
    assert.match(src, /DEFAULT_DELIVERY_SEQ_WAIT_MS = 3000/);
    assert.match(src, /DEFAULT_DELIVERY_SEQ_POLL_MS = 50/);
    assert.equal(DeliverySequencer.DEFAULT_DELIVERY_SEQ_WAIT_MS, 3000);
    assert.equal(DeliverySequencer.DEFAULT_DELIVERY_SEQ_POLL_MS, 50);
    assert.equal(DeliverySequencer.getDeliverySeqWaitMs(), 3000);
    assert.equal(DeliverySequencer.getDeliverySeqPollMs(), 50);
  });

  it('logs delivery_sequence_wait once then check_once returns without 120s poll', async () => {
    const reasons = [];
    const orig = console.log;
    console.log = (...args) => {
      reasons.push(args.map(String).join(' '));
    };
    try {
      const result = await DeliverySequencer.withChannelSequence({
        signalDoc: { signalUuid: 'seq-once-1', alertType: 'take_profit_3', canonicalTradeId: 'seq-once-1' },
        subscriberId: 'sub-1',
        channel: 'telegram',
        alertType: 'take_profit_3',
        waitMode: 'recovery',
        send: async () => ({ ok: true })
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'delivery_sequence_wait');
      const waits = reasons.filter(r =>
        r.includes('delivery_sequence_wait') && r.includes('predecessor=') && !/timeout/.test(r)
      );
      assert.equal(waits.length, 1);
      assert.match(waits[0], /waitMode=check_once/);
    } finally {
      console.log = orig;
    }
  });

  it('sequence wait expires after SEQUENCE_WAIT_MAX_MS instead of parking forever', async () => {
    process.env.SEQUENCE_WAIT_MAX_MS = '25';
    const DurableDelivery = require('../durableDelivery');
    const parked = await DurableDelivery.ensureJob({
      eventId: 'EURUSD|3|seq-exp-1|TP1',
      canonicalTradeId: 'seq-exp-1',
      subscriberId: 'sub-exp',
      channel: 'telegram',
      eventType: 'take_profit_1',
      signalUuid: 'seq-exp-1'
    });
    parked.createdAt = Date.now() - 500;
    const result = await DeliverySequencer.withChannelSequence({
      signalDoc: {
        signalUuid: 'seq-exp-1',
        alertType: 'take_profit_1',
        canonicalTradeId: 'seq-exp-1',
        eventId: 'EURUSD|3|seq-exp-1|TP1'
      },
      subscriberId: 'sub-exp',
      channel: 'telegram',
      alertType: 'take_profit_1',
      waitMode: 'recovery',
      send: async () => ({ ok: true })
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'delivery_sequence_wait_expired');
    assert.equal(result.terminal, true);
    const job = await DurableDelivery.getJob(parked.jobId);
    assert.equal(job.state, 'failed_terminal');
    assert.match(String(job.lastError || job.outcomeReason || ''), /delivery_sequence_wait_expired/);
  });

  it('stale ENTRY skip does not commit sequencing HASH', async () => {
    assert.equal(
      DeliverySequencer.shouldCommitResult({
        ok: false,
        skipped: true,
        reason: 'terminal_before_entry_delivery'
      }),
      false
    );
    assert.equal(
      DeliverySequencer.shouldCommitResult({
        ok: false,
        skipped: true,
        reason: 'stale_trade_before_delivery'
      }),
      false
    );
    assert.equal(
      DeliverySequencer.shouldCommitResult({
        ok: false,
        skipped: true,
        reason: 'stale_entry_delivery_age'
      }),
      false
    );
    assert.equal(
      DeliverySequencer.shouldCommitResult({ ok: true }),
      true
    );
    assert.equal(
      DeliverySequencer.shouldCommitResult({ ok: false, notEligible: true, skipped: true }),
      true
    );
  });

  it('outcome with no canonical identity is not sent', async () => {
    let sent = false;
    const result = await DeliverySequencer.withChannelSequence({
      signalDoc: { alertType: 'take_profit_3' },
      subscriberId: 'sub-noid',
      channel: 'telegram',
      alertType: 'take_profit_3',
      waitMode: 'check_once',
      send: async () => {
        sent = true;
        return { ok: true };
      }
    });
    assert.equal(sent, false);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing_canonical_id');
  });

  it('ENTRY lock/redis unavailable does not send without committing', async () => {
    const orig = TradeEventStore.acquireLock;
    TradeEventStore.acquireLock = async () => ({
      ok: false,
      reason: 'redis_unavailable',
      backend: 'none'
    });
    let sent = false;
    try {
      const result = await DeliverySequencer.withChannelSequence({
        signalDoc: { signalUuid: 'seq-lock-1', canonicalTradeId: 'seq-lock-1', alertType: 'entry' },
        subscriberId: 'sub-lock',
        channel: 'telegram',
        alertType: 'entry',
        send: async () => {
          sent = true;
          return { ok: true };
        }
      });
      assert.equal(sent, false);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'redis_unavailable');
    } finally {
      TradeEventStore.acquireLock = orig;
    }
  });

  it('skipped ENTRY job does not reconstruct sequencing HASH', async () => {
    const DurableDelivery = require('../durableDelivery');
    const skipped = await DurableDelivery.ensureJob({
      eventId: 'EURUSD|3|seq-skip-1|ENTRY',
      canonicalTradeId: 'seq-skip-1',
      subscriberId: 'sub-skip',
      channel: 'telegram',
      eventType: 'entry',
      signalUuid: 'seq-skip-1'
    });
    skipped.state = 'skipped';
    const recovered = await DeliverySequencer.recoverEntryCommitFromDeliveredJob(
      'seq-skip-1',
      'sub-skip',
      'telegram',
      { signalUuid: 'seq-skip-1', canonicalTradeId: 'seq-skip-1' }
    );
    assert.equal(recovered, false);
    const after = await TradeEventStore.getCommittedDeliveries('seq-skip-1', 'sub-skip', 'telegram');
    assert.equal(after.has('entry'), false);
  });

  it('recoverEntryCommitFromDeliveredJob reconstructs HASH from a delivered ENTRY job', async () => {
    const DurableDelivery = require('../durableDelivery');
    const entry = await DurableDelivery.ensureJob({
      eventId: 'EURUSD|3|seq-rec-1|ENTRY',
      canonicalTradeId: 'seq-rec-1',
      subscriberId: 'sub-rec',
      channel: 'email',
      eventType: 'entry',
      signalUuid: 'seq-rec-1'
    });
    await DurableDelivery.commitDelivered(entry.jobId);
    const before = await TradeEventStore.getCommittedDeliveries('seq-rec-1', 'sub-rec', 'email');
    assert.equal(before.has('entry'), false);
    const recovered = await DeliverySequencer.recoverEntryCommitFromDeliveredJob(
      'seq-rec-1',
      'sub-rec',
      'email',
      { signalUuid: 'seq-rec-1', canonicalTradeId: 'seq-rec-1' }
    );
    assert.equal(recovered, true);
    const after = await TradeEventStore.getCommittedDeliveries('seq-rec-1', 'sub-rec', 'email');
    assert.equal(after.has('entry'), true);
  });

  it('operational pipeline latency uses webhook-to-accepted only (no sequencer mix, no clamp)', () => {
    const prevAllow = process.env.ALLOW_PIPELINE_TEST_REDIS;
    process.env.ALLOW_PIPELINE_TEST_REDIS = 'true';
    try {
      PipelineStatusService.record('WebhookReceived', 'PASS', { signalUuid: 'lat-op-1' });
      PipelineStatusService.record('Accepted', 'PASS', { signalUuid: 'lat-op-1', latencyMs: 42 });
      PipelineStatusService.record('DeliverySequence', 'PENDING', {
        signalUuid: 'lat-op-1',
        latencyMs: 120000,
        reason: 'delivery_sequence_wait'
      });
      const lat = PipelineStatusService.getLatencySummary();
      assert.equal(lat.webhookToAccepted.avgMs, 42);
      assert.equal(lat.pipeline.operationalAvgMs, 42);
      assert.equal(lat.pipeline.avgMs, 42);
      assert.notEqual(lat.pipeline.operationalAvgMs, 120000);
    } finally {
      if (prevAllow == null) delete process.env.ALLOW_PIPELINE_TEST_REDIS;
      else process.env.ALLOW_PIPELINE_TEST_REDIS = prevAllow;
    }
  });
});
