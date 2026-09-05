const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  RETRY_BACKOFF_SECONDS,
  RECONCILE_SECONDS,
  nextRetryDelaySeconds,
  tradeRetcodeOk,
  applyBrokerOpResult,
  shouldRetryPartial,
  eventQueueAfterPost,
  shouldApplyReportEvent,
  rememberAckedEventUuid,
  shouldReclaimSentClaim,
  reconcileManagedFlags,
  shouldPersistManaged,
  validatePartialAlreadyDone,
  validateBeAlreadyDone,
  validateTrailAlreadyDone,
  decideBrokerOp,
  expectedRemainingAfterTpLevel,
  shouldRunReconcile
} = require('../mt5EaReliability');

describe('mt5EaReliability transactional flags', () => {
  it('does not mark TP complete before broker success', () => {
    const fail = applyBrokerOpResult({ tp1Hit: false }, 'tp1', false);
    assert.equal(fail.tp1Hit, false);
    assert.equal(fail.pendingOp, 'tp1');
    assert.equal(fail.nextRetryDelaySec, 2);

    const ok = applyBrokerOpResult(fail, 'tp1', true);
    assert.equal(ok.tp1Hit, true);
    assert.equal(ok.pendingOp, '');
    assert.equal(ok.dirty, true);
  });

  it('sets breakEvenDone only after broker success', () => {
    const fail = applyBrokerOpResult({ breakEvenDone: false }, 'be', false);
    assert.equal(fail.breakEvenDone, false);
    const ok = applyBrokerOpResult(fail, 'be', true);
    assert.equal(ok.breakEvenDone, true);
  });

  it('uses backoff 2→5→10→20→60', () => {
    assert.deepEqual(RETRY_BACKOFF_SECONDS, [2, 5, 10, 20, 60]);
    assert.equal(nextRetryDelaySeconds(0), 2);
    assert.equal(nextRetryDelaySeconds(1), 5);
    assert.equal(nextRetryDelaySeconds(2), 10);
    assert.equal(nextRetryDelaySeconds(3), 20);
    assert.equal(nextRetryDelaySeconds(4), 60);
    assert.equal(nextRetryDelaySeconds(99), 60);
  });

  it('accepts done retcodes only', () => {
    assert.equal(tradeRetcodeOk(10009), true);
    assert.equal(tradeRetcodeOk(10010), true);
    assert.equal(tradeRetcodeOk(10008), true);
    assert.equal(tradeRetcodeOk(10004), false);
    assert.equal(tradeRetcodeOk(10006), false);
  });

  it('retries partial only while price beyond TP', () => {
    assert.equal(shouldRetryPartial(true, 1.105, 1.1), true);
    assert.equal(shouldRetryPartial(true, 1.09, 1.1), false);
    assert.equal(shouldRetryPartial(false, 1.09, 1.1), true);
  });
});

describe('mt5EaReliability durable event queue', () => {
  it('removes event only on HTTP 200 + acknowledged', () => {
    const q = [{ eventUuid: 'e1' }, { eventUuid: 'e2' }];
    const keep = eventQueueAfterPost(q, 'e1', 500, true);
    assert.equal(keep.removed, false);
    assert.equal(keep.queue.length, 2);

    const keep2 = eventQueueAfterPost(q, 'e1', 200, false);
    assert.equal(keep2.removed, false);

    const gone = eventQueueAfterPost(q, 'e1', 200, true);
    assert.equal(gone.removed, true);
    assert.deepEqual(
      gone.queue.map(e => e.eventUuid),
      ['e2']
    );
  });

  it('dedupes by event UUID', () => {
    assert.equal(shouldApplyReportEvent(['a'], 'a'), false);
    assert.equal(shouldApplyReportEvent(['a'], 'b'), true);
    assert.equal(shouldApplyReportEvent([], null), true);
    const next = rememberAckedEventUuid(['a'], 'b');
    assert.deepEqual(next, ['a', 'b']);
  });
});

describe('mt5EaReliability reclaim + recovery', () => {
  const base = {
    status: 'sent',
    mt5Ticket: null,
    claimedAt: new Date(Date.now() - 130000),
    claimedByDeviceId: 'dev-1',
    nowMs: Date.now(),
    reclaimMs: 120000,
    heartbeatOfflineMs: 90000
  };

  it('does not reclaim healthy slow EA (live heartbeat)', () => {
    const reclaim = shouldReclaimSentClaim({
      ...base,
      devices: [{ deviceId: 'dev-1', lastHeartbeatAt: new Date() }]
    });
    assert.equal(reclaim, false);
  });

  it('reclaims when claimer heartbeat missing', () => {
    const reclaim = shouldReclaimSentClaim({
      ...base,
      devices: [
        {
          deviceId: 'dev-1',
          lastHeartbeatAt: new Date(Date.now() - 120000)
        }
      ]
    });
    assert.equal(reclaim, true);
  });

  it('does not reclaim before 120s window', () => {
    const reclaim = shouldReclaimSentClaim({
      ...base,
      claimedAt: new Date(Date.now() - 30000),
      devices: []
    });
    assert.equal(reclaim, false);
  });

  it('never reclaims ticketed claims', () => {
    const reclaim = shouldReclaimSentClaim({
      ...base,
      mt5Ticket: '12345',
      devices: []
    });
    assert.equal(reclaim, false);
  });

  it('repairs TP flags from volume and clears false positives', () => {
    const repaired = reconcileManagedFlags(
      { initialVolume: 1, tp1Hit: false, tp2Hit: false, breakEvenDone: false, isBuy: true, entry: 1.1, initialSl: 1.09 },
      { volume: 0.6, sl: 1.09 }
    );
    assert.equal(repaired.tp1Hit, true);
    assert.equal(repaired.repaired, true);

    const cleared = reconcileManagedFlags(
      {
        initialVolume: 1,
        tp1Hit: true,
        tp2Hit: true,
        breakEvenDone: false,
        isBuy: true,
        entry: 1.1,
        initialSl: 1.09
      },
      { volume: 1, sl: 1.09 }
    );
    assert.equal(cleared.tp1Hit, false);
    assert.equal(cleared.tp2Hit, false);
  });

  it('repairs BE from SL at/through entry', () => {
    const be = reconcileManagedFlags(
      {
        initialVolume: 1,
        tp1Hit: true,
        breakEvenDone: false,
        isBuy: true,
        entry: 1.1,
        initialSl: 1.09
      },
      { volume: 0.6, sl: 1.102 }
    );
    assert.equal(be.breakEvenDone, true);
  });

  it('persists only on state change', () => {
    const a = { tp1Hit: true, rem: 0.6 };
    assert.equal(shouldPersistManaged(a, a), false);
    assert.equal(shouldPersistManaged(a, { ...a, rem: 0.3 }), true);
  });
});

describe('mt5EaReliability idempotent broker ops (v1.22)', () => {
  it('scenario 1: partial already done → sync, no execute', () => {
    const done = validatePartialAlreadyDone({
      initialVolume: 1,
      liveVolume: 0.6,
      level: 1,
      tp1Pct: 40,
      tp2Pct: 30
    });
    assert.equal(done, true);
    assert.equal(expectedRemainingAfterTpLevel({ initialVolume: 1, tp1Pct: 40 }, 1), 0.6);
    const decision = decideBrokerOp(done, 'tp1');
    assert.equal(decision.action, 'sync');

    const need = validatePartialAlreadyDone({
      initialVolume: 1,
      liveVolume: 1,
      level: 1,
      tp1Pct: 40
    });
    assert.equal(need, false);
    assert.equal(decideBrokerOp(need).action, 'execute');
  });

  it('scenario 2: BE already equal/better → sync, skip modify', () => {
    const buyDone = validateBeAlreadyDone({
      isBuy: true,
      brokerSl: 1.102,
      desiredBeSl: 1.102
    });
    assert.equal(buyDone, true);
    assert.equal(decideBrokerOp(buyDone, 'be').action, 'sync');

    const better = validateBeAlreadyDone({
      isBuy: true,
      brokerSl: 1.105,
      desiredBeSl: 1.102
    });
    assert.equal(better, true);

    const need = validateBeAlreadyDone({
      isBuy: true,
      brokerSl: 1.09,
      desiredBeSl: 1.102
    });
    assert.equal(need, false);
    assert.equal(decideBrokerOp(need, 'be').action, 'execute');

    const sellDone = validateBeAlreadyDone({
      isBuy: false,
      brokerSl: 1.098,
      desiredBeSl: 1.1
    });
    assert.equal(sellDone, true);
  });

  it('scenario 3: trail SL already same/better → skip', () => {
    const same = validateTrailAlreadyDone({
      isBuy: true,
      brokerSl: 1.12,
      desiredTrailSl: 1.12
    });
    assert.equal(same, true);
    assert.equal(decideBrokerOp(same, 'trail').action, 'sync');

    const better = validateTrailAlreadyDone({
      isBuy: true,
      brokerSl: 1.125,
      desiredTrailSl: 1.12
    });
    assert.equal(better, true);

    const need = validateTrailAlreadyDone({
      isBuy: true,
      brokerSl: 1.11,
      desiredTrailSl: 1.12
    });
    assert.equal(need, false);
    assert.equal(decideBrokerOp(need, 'trail').action, 'execute');
  });

  it('scenario 4: restart recovery — file incomplete, broker shows TP1+BE → repair', () => {
    const fileState = {
      initialVolume: 1,
      tp1Hit: false,
      tp2Hit: false,
      breakEvenDone: false,
      trailArmed: true,
      trailReported: false,
      isBuy: true,
      entry: 1.1,
      initialSl: 1.09,
      beOffsetPrice: 0.0002,
      pendingOp: 'tp1',
      retryCount: 2
    };
    // Live: volume reduced (TP1) + SL at BE
    const repaired = reconcileManagedFlags(fileState, { volume: 0.6, sl: 1.102 }, {
      closedVolume: 0.4
    });
    assert.equal(repaired.tp1Hit, true);
    assert.equal(repaired.breakEvenDone, true);
    assert.equal(repaired.pendingOp, '');
    assert.equal(repaired.repaired, true);
    assert.ok(repaired.repairs.includes('tp1'));
    assert.ok(repaired.repairs.includes('be'));
    assert.ok(repaired.repairs.includes('clear_pending'));
    // Never file-only: no position → no repair
    const noBroker = reconcileManagedFlags(fileState, null);
    assert.equal(noBroker.repaired, false);
  });

  it('scenario 5: safe retry — pending reject but broker already complete → sync', () => {
    // After rejected partial, broker volume later shows TP1 done (manual/other)
    const already = validatePartialAlreadyDone({
      initialVolume: 1,
      liveVolume: 0.58,
      level: 1,
      tp1Pct: 40,
      historyClosedVolume: 0.42
    });
    assert.equal(already, true);
    const decision = decideBrokerOp(already, 'retry_tp1');
    assert.equal(decision.action, 'sync');

    // Pending BE retry but SL already moved
    const beSync = decideBrokerOp(
      validateBeAlreadyDone({ isBuy: true, brokerSl: 1.1025, desiredBeSl: 1.102 }),
      'retry_be'
    );
    assert.equal(beSync.action, 'sync');

    // Still need execute when broker unchanged
    const stillNeed = decideBrokerOp(
      validatePartialAlreadyDone({
        initialVolume: 1,
        liveVolume: 1,
        level: 1,
        tp1Pct: 40
      }),
      'retry_tp1'
    );
    assert.equal(stillNeed.action, 'execute');
  });

  it('reconcile cadence is 60s and force bypasses', () => {
    assert.equal(RECONCILE_SECONDS, 60);
    const t0 = 1_000_000;
    assert.equal(shouldRunReconcile(t0, t0 + 30_000, false), false);
    assert.equal(shouldRunReconcile(t0, t0 + 60_000, false), true);
    assert.equal(shouldRunReconcile(t0, t0 + 1000, true), true);
  });
});
