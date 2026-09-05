/**
 * P0 bounded durable recovery — 15 forensics items.
 * Models 41252 × 3.2KB with counters. Does not allocate 132MB.
 */
'use strict';

process.env.REDIS_ENABLED = process.env.REDIS_ENABLED || 'false';
process.env.NODE_ENV = 'test';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DurableDelivery = require('../../utils/durableDelivery');
const TradeEventStore = require('../../utils/tradeEventStore');
const TradingViewAlertService = require('../TradingViewAlertService');
const DeliverySequencer = require('../../utils/deliverySequencer');

const INDEX_SIZE = 41252;
const PAD = 'x'.repeat(3200);
const JOB_PREFIX = 'kaching:trade:djob:';
const INDEX_KEY = 'kaching:trade:djobidx';

function synthId(i) {
  return `synth-${i}::c::s::telegram::entry`;
}

function terminalBody(id) {
  return JSON.stringify({
    jobId: id,
    state: 'delivered',
    channel: 'telegram',
    eventType: 'entry',
    payload: { pad: PAD },
    nextAttemptAt: 0,
    leaseUntil: 0,
    sendAttempts: 0
  });
}

function pendingBody(id) {
  return JSON.stringify({
    jobId: id,
    state: 'pending',
    channel: 'telegram',
    eventType: 'entry',
    payload: { pad: PAD },
    nextAttemptAt: 0,
    leaseUntil: 0,
    sendAttempts: 0
  });
}

function createIndexRedis({ size = INDEX_SIZE, dueIndexes = new Set() } = {}) {
  const counters = {
    get: 0,
    hScan: 0,
    hGetAll: 0,
    hLen: 0,
    parseBytesApprox: 0
  };
  const kv = new Map();
  const leases = new Map();
  return {
    counters,
    isOpen: true,
    async set(key, val, opts = {}) {
      if (String(key).includes(':dlease:')) {
        if (opts && opts.NX && leases.has(key)) return null;
        leases.set(key, String(val));
        return 'OK';
      }
      kv.set(key, String(val));
      return 'OK';
    },
    async get(key) {
      counters.get += 1;
      if (String(key).startsWith(JOB_PREFIX)) {
        const id = String(key).slice(JOB_PREFIX.length);
        const m = /^synth-(\d+)::/.exec(id);
        const idx = m ? Number(m[1]) : -1;
        const body = dueIndexes.has(idx) ? pendingBody(id) : terminalBody(id);
        counters.parseBytesApprox += body.length;
        return body;
      }
      if (leases.has(key)) return leases.get(key);
      return kv.has(key) ? kv.get(key) : null;
    },
    async del(...keys) {
      let n = 0;
      for (const key of keys.flat()) {
        if (kv.delete(key)) n += 1;
        if (leases.delete(key)) n += 1;
      }
      return n;
    },
    async hSet() {
      return 1;
    },
    async hDel() {
      return 1;
    },
    async hLen() {
      counters.hLen += 1;
      return size;
    },
    async hGetAll() {
      counters.hGetAll += 1;
      throw new Error('HGETALL of djobidx is forbidden in bounded recovery');
    },
    async hScan(key, cursor, opts = {}) {
      counters.hScan += 1;
      assert.equal(String(key), INDEX_KEY);
      const count = Number(opts.COUNT) || 100;
      const start = Number(cursor) || 0;
      if (start >= size) return { cursor: 0, tuples: [] };
      const n = Math.min(count, size - start);
      const tuples = [];
      for (let i = 0; i < n; i += 1) {
        tuples.push({ field: synthId(start + i), value: '1' });
      }
      const next = start + n >= size ? 0 : start + n;
      return { cursor: next, tuples };
    },
    async expire() {
      return 1;
    }
  };
}

describe('P0 bounded durable recovery', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    DurableDelivery.resetForTests();
    TradeEventStore.resetForTests();
    DurableDelivery.resetRecoveryMetricsForTests();
  });

  afterEach(() => {
    DurableDelivery.stopRecoveryWorker();
    TradeEventStore.resetForTests();
    DurableDelivery.registerProcessHandler(async (job, ctx) =>
      TradingViewAlertService.processDurableJob(job, ctx)
    );
  });

  it('1–7,14: 41252-job index is scanned in bounded batches (counter proof, no 132MB)', async () => {
    const redis = createIndexRedis({ dueIndexes: new Set([0, 1]) });
    TradeEventStore.setClientForTests(redis);
    DurableDelivery.resetRecoveryMetricsForTests();

    const results = await DurableDelivery.processDueJobs({
      handler: async () => ({ ok: true, skipped: true, reason: 'test_noop' })
    });

    const m = DurableDelivery.getRecoveryMetricsForTests();
    const bounds = DurableDelivery.RECOVERY_BOUNDS;
    assert.equal(redis.counters.hGetAll, 0, 'must not HGETALL the index');
    assert.equal(m.hGetAllCount, 0);
    assert.equal(redis.counters.hScan, 0, 'default recovery must not HSCAN the 41k index');
    assert.equal(redis.counters.get, 0, 'default recovery must not GET historical index members');
    assert.equal(m.lastTickHydrations, 0);
    assert.ok(m.memJobs <= bounds.MAX_MEM_JOBS);
    assert.ok(results.length <= bounds.PROCESS_BUDGET);
    assert.equal(results.length, 0, 'Redis-only historical members are not recovered without Mongo/durableDocs');
  });

  it('4,6: terminal hydrations are not retained; memJobs cannot track the 41k index', async () => {
    const redis = createIndexRedis({ dueIndexes: new Set() });
    TradeEventStore.setClientForTests(redis);
    await DurableDelivery.processDueJobs({ handler: async () => ({ ok: true }) });
    const m = DurableDelivery.getRecoveryMetricsForTests();
    assert.ok(m.lastTickHydrations <= DurableDelivery.RECOVERY_BOUNDS.HYDRATE_BATCH);
    assert.ok(m.memJobs <= DurableDelivery.RECOVERY_BOUNDS.MAX_MEM_JOBS);
    assert.equal(m.memJobs, 0, 'all-terminal batch must not retain payloads');
  });

  it('5,7: terminal jobs are not due; isDue is evaluated on the batch', async () => {
    const redis = createIndexRedis({ dueIndexes: new Set() });
    TradeEventStore.setClientForTests(redis);
    let handled = 0;
    await DurableDelivery.processDueJobs({
      handler: async () => {
        handled += 1;
        return { ok: true };
      }
    });
    assert.equal(handled, 0);
  });

  it('8: two owners can still recover via leases (not single-machine)', async () => {
    const job = await DurableDelivery.ensureJob({
      eventId: 'p0-lease',
      canonicalTradeId: 'p0-lease',
      subscriberId: 'sub-a',
      channel: 'telegram',
      eventType: 'entry'
    });
    const a = await DurableDelivery.beginAttempt({ jobId: job.jobId }, { owner: 'machine-A' });
    assert.equal(a.status, 'acquired');
    await DurableDelivery.simulateCrashForTests(job.jobId);
    const b = await DurableDelivery.beginAttempt({ jobId: job.jobId }, { owner: 'machine-B' });
    assert.equal(b.status, 'acquired');
  });

  it('9–10: workerTickInFlight skips overlapping ticks (kept, not the OOM fix)', async () => {
    const src = fs.readFileSync(path.join(__dirname, '../../utils/durableDelivery.js'), 'utf8');
    assert.match(src, /workerTickInFlight/);
    assert.match(src, /if \(workerTickInFlight\)/);
    assert.match(src, /recoveryOverlapSkips/);

    await DurableDelivery.ensureJob({
      eventId: 'p0-overlap',
      canonicalTradeId: 'p0-overlap',
      subscriberId: 'sub-a',
      channel: 'telegram',
      eventType: 'entry'
    });
    let started = 0;
    let finished = 0;
    DurableDelivery.startRecoveryWorker({
      intervalMs: 15,
      handler: async () => {
        started += 1;
        await new Promise(r => setTimeout(r, 70));
        finished += 1;
        return { ok: true };
      }
    });
    await new Promise(r => setTimeout(r, 40));
    assert.equal(started, 1, 'overlapping tick must not start a second processDueJobs');
    DurableDelivery.stopRecoveryWorker();
    await new Promise(r => setTimeout(r, 80));
    assert.equal(finished, 1);
  });

  it('11,13: recovery passes waitMode=check_once; live default stays 3000ms', async () => {
    assert.equal(DeliverySequencer.DEFAULT_DELIVERY_SEQ_WAIT_MS, 3000);
    const srcDd = fs.readFileSync(path.join(__dirname, '../../utils/durableDelivery.js'), 'utf8');
    assert.match(srcDd, /waitMode: 'check_once'/);
    const srcTv = fs.readFileSync(path.join(__dirname, '../TradingViewAlertService.js'), 'utf8');
    assert.match(srcTv, /waitMode: recoveryWait/);
    const srcTd = fs.readFileSync(path.join(__dirname, '../TradeDeliveryService.js'), 'utf8');
    assert.match(srcTd, /waitMode: options\.waitMode/);

    let ctxMode = null;
    await DurableDelivery.ensureJob({
      eventId: 'p0-wait-ctx',
      canonicalTradeId: 'p0-wait-ctx',
      subscriberId: 'sub-a',
      channel: 'email',
      eventType: 'take_profit_3'
    });
    await DurableDelivery.processDueJobs({
      handler: async (_job, ctx) => {
        ctxMode = ctx.waitMode;
        return { ok: true, skipped: true };
      }
    });
    assert.equal(ctxMode, 'check_once');

    const seen = [];
    const orig = DeliverySequencer.withChannelSequence;
    DeliverySequencer.withChannelSequence = async opts => {
      seen.push(opts.waitMode);
      return { ok: false, reason: 'delivery_sequence_wait', deferred: true };
    };
    try {
      const job = await DurableDelivery.ensureJob({
        eventId: 'p0-wait-seq',
        canonicalTradeId: 'p0-wait-seq',
        subscriberId: 'sub-a',
        channel: 'email',
        eventType: 'take_profit_3',
        payload: {
          subscriber: {
            id: 'sub-a',
            email: 'a@example.com',
            subscription: { tier: 'professional', status: 'active' },
            preferences: { emailAlerts: true }
          },
          signal: {
            alertType: 'take_profit_3',
            signalUuid: 'p0-wait-seq',
            canonicalTradeId: 'p0-wait-seq'
          }
        }
      });
      await TradingViewAlertService.processDurableJob(job, {
        io: { emit() {} },
        inMemorySignals: [],
        waitMode: 'check_once'
      });
      assert.ok(seen.includes('check_once'), `sequencer waitMode seen=${JSON.stringify(seen)}`);
    } finally {
      DeliverySequencer.withChannelSequence = orig;
    }
  });

  it('12: blocked_waiting_for_entry keeps ~1s nextAttemptAt and does not bump sendAttempts', async () => {
    DurableDelivery.setNowForTests(1_000_000);
    const job = await DurableDelivery.ensureJob({
      eventId: 'p0-block',
      canonicalTradeId: 'p0-block',
      subscriberId: 'sub-a',
      channel: 'telegram',
      eventType: 'take_profit_3'
    });
    const before = Number(job.sendAttempts || 0);
    const res = await DurableDelivery.scheduleRetry(job.jobId, {
      reason: 'blocked_waiting_for_entry:entry',
      blockedWaitingForEntry: true
    });
    assert.equal(res.status, 'blocked_waiting_for_entry');
    assert.equal(res.job.sendAttempts, before);
    const delay = Number(res.job.nextAttemptAt) - DurableDelivery.now();
    assert.ok(delay > 0 && delay <= 1000, `blocked delay ${delay} must stay ≤1s (no new backoff policy)`);
    DurableDelivery.clearNowForTests();
  });

  it('14: getCounts uses HLEN / memory maps — zero job GETs, not listJobs hydrate', async () => {
    const redis = createIndexRedis();
    TradeEventStore.setClientForTests(redis);
    redis.counters.get = 0;
    const counts = await DurableDelivery.getCounts();
    assert.equal(typeof counts.delivered, 'number');
    assert.equal(typeof counts.pending, 'number');
    assert.equal(typeof counts.blocked_waiting_for_entry, 'number');
    assert.equal(redis.counters.get, 0, 'getCounts must not GET job JSON');
    assert.equal(redis.counters.hGetAll, 0);
    assert.ok(redis.counters.hLen >= 1);
    assert.equal(counts.redisIndexSize, INDEX_SIZE);
    const src = fs.readFileSync(path.join(__dirname, '../../utils/durableDelivery.js'), 'utf8');
    assert.doesNotMatch(src, /getCounts[\s\S]{0,200}listJobs\(/);
    const ps = fs.readFileSync(path.join(__dirname, '../PipelineStatusService.js'), 'utf8');
    assert.match(ps, /DurableDelivery\.getCounts\(\)/);
  });

  it('15: inMemorySignals cap evicts oldest completed and stays in hundreds', async () => {
    assert.equal(TradingViewAlertService.MAX_IN_MEMORY_SIGNALS, 400);
    const arr = [];
    for (let i = 0; i < 500; i += 1) {
      arr.unshift({
        signalUuid: `sig-${i}`,
        alertType: i < 450 ? 'take_profit_3' : 'entry',
        lifecycleStage: i < 450 ? 'closed' : 'open',
        createdAt: new Date(i)
      });
      TradingViewAlertService.capInMemorySignals(arr);
    }
    assert.ok(arr.length <= 400);
    assert.ok(arr.some(s => s.alertType === 'entry'), 'must keep recent active entries');
  });

  it('source: recovery must not HGETALL + full GET; workerTickInFlight kept; Redis scan opt-in', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../utils/durableDelivery.js'), 'utf8');
    assert.match(src, /hScan/);
    assert.match(src, /HYDRATE_BATCH/);
    assert.match(src, /PROCESS_BUDGET/);
    assert.match(src, /workerTickInFlight/);
    assert.match(src, /redisIndexScanEnabled/);
    assert.match(src, /DELIVERY_RECOVERY_REDIS_SCAN/);
    assert.doesNotMatch(src, /hGetAll\(keyIndex\(\)\)/);
    assert.match(src, /cachePolicy === 'recovery'/);
    assert.doesNotMatch(src, /[\s.]flushAll\s*\(/);
    assert.doesNotMatch(src, /[\s.]flushDb\s*\(/);
  });

  it('cursor continues across ticks without loading all IDs when Redis scan is enabled', async () => {
    const prev = process.env.DELIVERY_RECOVERY_REDIS_SCAN;
    process.env.DELIVERY_RECOVERY_REDIS_SCAN = '1';
    try {
      const redis = createIndexRedis({ dueIndexes: new Set() });
      TradeEventStore.setClientForTests(redis);
      await DurableDelivery.processDueJobs({ handler: async () => ({ ok: true }) });
      const first = DurableDelivery.getRecoveryMetricsForTests();
      assert.ok(first.lastTickHydrations <= 32);
      assert.ok(redis.counters.hScan >= 1);
      await DurableDelivery.processDueJobs({ handler: async () => ({ ok: true }) });
      const second = DurableDelivery.getRecoveryMetricsForTests();
      assert.ok(Number(second.scanCursor) > 0 || second.pendingIds >= 0);
      assert.ok(second.hydrateCount > first.hydrateCount);
      assert.ok(second.hydrateCount < INDEX_SIZE);
      assert.ok(redis.counters.get <= DurableDelivery.RECOVERY_BOUNDS.HYDRATE_BATCH * 2 + 8);
    } finally {
      if (prev == null) delete process.env.DELIVERY_RECOVERY_REDIS_SCAN;
      else process.env.DELIVERY_RECOVERY_REDIS_SCAN = prev;
    }
  });
});
