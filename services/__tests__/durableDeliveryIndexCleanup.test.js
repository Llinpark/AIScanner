/**
 * Mongo-primary recovery, djobidx cleanup, overlap/circuit/batch safety.
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

const JOB_PREFIX = 'kaching:trade:djob:';
const INDEX_KEY = 'kaching:trade:djobidx';

function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value == null) delete process.env[key];
  else process.env[key] = String(value);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev == null) delete process.env[key];
      else process.env[key] = prev;
    });
}

function createHashRedis({ index = new Map(), jobs = new Map(), failHdel = false, failHscan = false } = {}) {
  const counters = {
    get: 0,
    hScan: 0,
    hDel: 0,
    hSet: 0,
    hGetAll: 0,
    keys: 0,
    flushAll: 0,
    flushDb: 0,
    deleted: []
  };
  const kv = new Map();
  const leases = new Map();
  const indexKeys = () => [...index.keys()];
  return {
    counters,
    index,
    jobs,
    isOpen: true,
    async set(key, val, opts = {}) {
      if (String(key).includes(':dlease:')) {
        if (opts && opts.NX && leases.has(key)) return null;
        leases.set(key, String(val));
        return 'OK';
      }
      kv.set(key, String(val));
      if (String(key).startsWith(JOB_PREFIX)) {
        jobs.set(String(key).slice(JOB_PREFIX.length), String(val));
      }
      return 'OK';
    },
    async get(key) {
      counters.get += 1;
      if (leases.has(key)) return leases.get(key);
      if (String(key).startsWith(JOB_PREFIX)) {
        const id = String(key).slice(JOB_PREFIX.length);
        if (jobs.has(id)) return jobs.get(id);
      }
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
    async hSet(key, field) {
      counters.hSet += 1;
      if (String(key) === INDEX_KEY) index.set(String(field), '1');
      return 1;
    },
    async hDel(key, field) {
      counters.hDel += 1;
      if (failHdel) throw new Error('hdel_boom');
      const fields = Array.isArray(field) ? field : [field];
      let n = 0;
      for (const f of fields) {
        if (index.delete(String(f))) {
          n += 1;
          counters.deleted.push(String(f));
        }
      }
      return n;
    },
    async hLen() {
      return index.size;
    },
    async hGetAll() {
      counters.hGetAll += 1;
      throw new Error('HGETALL of djobidx is forbidden');
    },
    async keys() {
      counters.keys += 1;
      throw new Error('KEYS is forbidden');
    },
    async flushAll() {
      counters.flushAll += 1;
      throw new Error('FLUSHALL is forbidden');
    },
    async flushDb() {
      counters.flushDb += 1;
      throw new Error('FLUSHDB is forbidden');
    },
    async hScan(key, cursor, opts = {}) {
      counters.hScan += 1;
      if (failHscan) throw new Error('hscan_boom');
      assert.equal(String(key), INDEX_KEY);
      const all = indexKeys();
      const count = Number(opts.COUNT) || 100;
      const start = Number(cursor) || 0;
      if (start >= all.length) return { cursor: 0, tuples: [] };
      const slice = all.slice(start, start + count);
      const next = start + slice.length >= all.length ? 0 : start + slice.length;
      return { cursor: next, tuples: slice.map(field => ({ field, value: '1' })) };
    },
    async expire() {
      return 1;
    }
  };
}

describe('durable delivery redis cost repair', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    DurableDelivery.resetForTests();
    TradeEventStore.resetForTests();
    DurableDelivery.resetRecoveryMetricsForTests();
  });

  afterEach(() => {
    DurableDelivery.stopRecoveryWorker();
    TradeEventStore.resetForTests();
    DurableDelivery.resetForTests();
  });

  it('1. terminal job is removed from Redis index after durable commit', async () => {
    const redis = createHashRedis();
    TradeEventStore.setClientForTests(redis);
    const job = await DurableDelivery.ensureJob({
      eventId: 'term-1',
      canonicalTradeId: 'term-1',
      subscriberId: 'sub-a',
      channel: 'telegram',
      eventType: 'entry'
    });
    assert.equal(redis.index.has(job.jobId), true);
    const committed = await DurableDelivery.commitDelivered(job.jobId);
    assert.equal(committed.status, 'delivered');
    assert.equal((await DurableDelivery.getJob(job.jobId)).state, 'delivered');
    assert.equal(redis.index.has(job.jobId), false);
    assert.ok(redis.counters.hDel >= 1);
    assert.equal(redis.counters.hGetAll, 0);
  });

  it('2. Redis HDEL failure does not revert durable terminal state', async () => {
    const redis = createHashRedis({ failHdel: true });
    TradeEventStore.setClientForTests(redis);
    const job = await DurableDelivery.ensureJob({
      eventId: 'term-hdel-fail',
      canonicalTradeId: 'term-hdel-fail',
      subscriberId: 'sub-a',
      channel: 'telegram',
      eventType: 'entry'
    });
    const committed = await DurableDelivery.commitDelivered(job.jobId);
    assert.equal(committed.status, 'delivered');
    assert.equal(committed.job.state, 'delivered');
    const again = await DurableDelivery.getJob(job.jobId);
    assert.equal(again.state, 'delivered');
    assert.notEqual(again.state, 'pending');
    assert.equal(redis.index.has(job.jobId), true, 'stale index member may remain after HDEL failure');
  });

  it('3–5. cleanup classifies stale, active, and missing Mongo members without HGETALL', async () => {
    const redis = createHashRedis();
    TradeEventStore.setClientForTests(redis);

    const active = await DurableDelivery.ensureJob({
      eventId: 'clean-active',
      canonicalTradeId: 'clean-active',
      subscriberId: 'sub-a',
      channel: 'telegram',
      eventType: 'entry'
    });
    const terminal = await DurableDelivery.ensureJob({
      eventId: 'clean-term',
      canonicalTradeId: 'clean-term',
      subscriberId: 'sub-a',
      channel: 'email',
      eventType: 'entry'
    });
    await DurableDelivery.commitDelivered(terminal.jobId);
    redis.index.set(terminal.jobId, '1');

    const orphanId = 'orphan-missing::c::s::telegram::entry';
    redis.index.set(orphanId, '1');

    const redisOnlyPendingId = 'redis-only-pending::c::s::telegram::entry';
    redis.index.set(redisOnlyPendingId, '1');
    redis.jobs.set(
      redisOnlyPendingId,
      JSON.stringify({
        jobId: redisOnlyPendingId,
        state: 'pending',
        nextAttemptAt: DurableDelivery.now() + 60000,
        leaseUntil: 0
      })
    );

    const report = await DurableDelivery.runIndexCleanupBatch({ execute: false, count: 50 });
    assert.equal(report.mode, 'DRY_RUN');
    assert.equal(report.deleted, 0);
    assert.ok(report.scanned >= 3);
    assert.ok(report.active + report.pending + report.recoverable >= 1, 'active/pending preserved');
    assert.ok(report.terminal >= 1 || report.wouldDelete >= 1);
    assert.ok(report.missingFromMongo >= 1);
    assert.equal(redis.index.has(active.jobId), true);
    assert.equal(redis.counters.hGetAll, 0);
    assert.equal(redis.counters.keys, 0);
    assert.equal(redis.counters.flushAll, 0);
    assert.equal(redis.counters.flushDb, 0);
  });

  it('6. cleanup DRY-RUN performs zero deletions', async () => {
    const redis = createHashRedis();
    TradeEventStore.setClientForTests(redis);
    redis.index.set('stale-a', '1');
    redis.index.set('stale-b', '1');
    const before = redis.index.size;
    const report = await DurableDelivery.runIndexCleanupBatch({ execute: false, count: 20 });
    assert.equal(report.deleted, 0);
    assert.equal(redis.index.size, before);
    assert.equal(redis.counters.hDel, 0);
    assert.ok(report.wouldDelete >= 2);
  });

  it('7. cleanup EXECUTE deletes only verified stale/terminal members', async () => {
    const redis = createHashRedis();
    TradeEventStore.setClientForTests(redis);
    const active = await DurableDelivery.ensureJob({
      eventId: 'exec-active',
      canonicalTradeId: 'exec-active',
      subscriberId: 'sub-a',
      channel: 'telegram',
      eventType: 'entry'
    });
    const terminal = await DurableDelivery.ensureJob({
      eventId: 'exec-term',
      canonicalTradeId: 'exec-term',
      subscriberId: 'sub-a',
      channel: 'email',
      eventType: 'entry'
    });
    await DurableDelivery.commitDelivered(terminal.jobId);
    redis.index.set(terminal.jobId, '1');
    const orphanId = 'exec-orphan::c::s::mt5::entry';
    redis.index.set(orphanId, '1');
    const redisOnlyPendingId = 'exec-redis-pending::c::s::telegram::entry';
    redis.index.set(redisOnlyPendingId, '1');
    redis.jobs.set(
      redisOnlyPendingId,
      JSON.stringify({
        jobId: redisOnlyPendingId,
        state: 'retry_pending',
        nextAttemptAt: DurableDelivery.now() + 120000,
        leaseUntil: 0
      })
    );

    const dry = await DurableDelivery.runIndexCleanupPass({ execute: false, maxBatches: 5, count: 50 });
    assert.equal(dry.deleted, 0);

    const exec = await DurableDelivery.runIndexCleanupPass({ execute: true, maxBatches: 5, count: 50 });
    assert.equal(exec.mode, 'EXECUTE');
    assert.ok(exec.deleted >= 1);
    assert.equal(redis.index.has(active.jobId), true, 'active index member preserved');
    assert.equal(redis.index.has(redisOnlyPendingId), true, 'Redis-only unfinished job preserved');
    assert.equal(redis.index.has(orphanId), false, 'orphan index member removed');
    assert.equal(redis.index.has(terminal.jobId), false, 'historical terminal index member removed');
  });

  it('8. recovery ticks cannot overlap within the same process', async () => {
    await DurableDelivery.ensureJob({
      eventId: 'overlap-2',
      canonicalTradeId: 'overlap-2',
      subscriberId: 'sub-a',
      channel: 'telegram',
      eventType: 'entry'
    });
    let started = 0;
    DurableDelivery.startRecoveryWorker({
      intervalMs: 15,
      handler: async () => {
        started += 1;
        await new Promise(r => setTimeout(r, 70));
        return { ok: true };
      }
    });
    await new Promise(r => setTimeout(r, 45));
    assert.equal(started, 1);
    const m = DurableDelivery.getRecoveryMetricsForTests();
    assert.ok(m.overlapSkips >= 1);
    DurableDelivery.stopRecoveryWorker();
  });

  it('9. recovery respects configured batch limits', async () => {
    await withEnv('DELIVERY_RECOVERY_PROCESS_BUDGET', '2', async () => {
      for (let i = 0; i < 5; i += 1) {
        await DurableDelivery.ensureJob({
          eventId: `budget-${i}`,
          canonicalTradeId: `budget-${i}`,
          subscriberId: 'sub-a',
          channel: 'telegram',
          eventType: 'entry'
        });
      }
      let handled = 0;
      const results = await DurableDelivery.processDueJobs({
        handler: async () => {
          handled += 1;
          return { ok: true, skipped: true };
        }
      });
      assert.ok(results.length <= 2);
      assert.ok(handled <= 2);
      assert.equal(handled, 2);
    });
  });

  it('10. recovery does not repeatedly process terminal jobs', async () => {
    const job = await DurableDelivery.ensureJob({
      eventId: 'term-repeat',
      canonicalTradeId: 'term-repeat',
      subscriberId: 'sub-a',
      channel: 'telegram',
      eventType: 'entry'
    });
    await DurableDelivery.commitDelivered(job.jobId);
    let handled = 0;
    await DurableDelivery.processDueJobs({
      handler: async () => {
        handled += 1;
        return { ok: true };
      }
    });
    await DurableDelivery.processDueJobs({
      handler: async () => {
        handled += 1;
        return { ok: true };
      }
    });
    assert.equal(handled, 0);
  });

  it('11. Mongo/durableDocs recovery finds jobs when the Redis index is missing', async () => {
    const redis = createHashRedis();
    TradeEventStore.setClientForTests(redis);
    const job = await DurableDelivery.ensureJob({
      eventId: 'mongo-primary',
      canonicalTradeId: 'mongo-primary',
      subscriberId: 'sub-a',
      channel: 'telegram',
      eventType: 'entry'
    });
    redis.index.clear();
    let seen = null;
    const results = await DurableDelivery.processDueJobs({
      handler: async found => {
        seen = found.jobId;
        return { ok: true, skipped: true };
      }
    });
    assert.equal(seen, job.jobId);
    assert.ok(results.length >= 1);
    assert.equal(redis.counters.hScan, 0, 'must not need Redis index to recover Mongo/durable jobs');
  });

  it('12. Redis failure does not cause an uncontrolled retry loop', async () => {
    await withEnv('DELIVERY_RECOVERY_REDIS_SCAN', '1', () =>
      withEnv('DELIVERY_RECOVERY_REDIS_FAIL_THRESHOLD', '3', async () => {
        const redis = createHashRedis({ failHscan: true });
        redis.index.set('x', '1');
        TradeEventStore.setClientForTests(redis);
        for (let i = 0; i < 3; i += 1) {
          await DurableDelivery.processDueJobs({ handler: async () => ({ ok: true }) });
        }
        const afterTrip = DurableDelivery.getRecoveryMetricsForTests();
        assert.ok(afterTrip.redisCircuitOpen || afterTrip.redisFailures >= 3);
        const hscanAtTrip = redis.counters.hScan;
        await DurableDelivery.processDueJobs({ handler: async () => ({ ok: true }) });
        await DurableDelivery.processDueJobs({ handler: async () => ({ ok: true }) });
        assert.equal(
          redis.counters.hScan,
          hscanAtTrip,
          'open circuit must not keep HSCAN-ing on every subsequent tick'
        );
        assert.ok(redis.counters.hScan < 20);
      })
    );
  });

  it('opt-in Redis scan stays bounded and still skips terminals', async () => {
    await withEnv('DELIVERY_RECOVERY_REDIS_SCAN', '1', async () => {
      const redis = createHashRedis();
      for (let i = 0; i < 40; i += 1) {
        const id = `synth-${i}::c::s::telegram::entry`;
        redis.index.set(id, '1');
        redis.jobs.set(
          id,
          JSON.stringify({
            jobId: id,
            state: i === 0 ? 'pending' : 'delivered',
            nextAttemptAt: 0,
            leaseUntil: 0,
            payload: { pad: 'x'.repeat(100) }
          })
        );
      }
      TradeEventStore.setClientForTests(redis);
      let handled = 0;
      await DurableDelivery.processDueJobs({
        handler: async () => {
          handled += 1;
          return { ok: true, skipped: true };
        }
      });
      const m = DurableDelivery.getRecoveryMetricsForTests();
      assert.ok(redis.counters.hScan >= 1);
      assert.ok(redis.counters.get <= DurableDelivery.RECOVERY_BOUNDS.HYDRATE_BATCH);
      assert.ok(m.lastTickHydrations <= DurableDelivery.RECOVERY_BOUNDS.HYDRATE_BATCH);
      assert.ok(handled <= DurableDelivery.RECOVERY_BOUNDS.PROCESS_BUDGET);
      assert.equal(handled, 1);
      assert.equal(redis.counters.hGetAll, 0);
    });
  });

  it('default recovery interval is conservative and clamped', async () => {
    assert.equal(DurableDelivery.RECOVERY_BOUNDS.DEFAULT_RECOVERY_INTERVAL_MS, 15000);
    assert.equal(DurableDelivery.RECOVERY_BOUNDS.MIN_RECOVERY_INTERVAL_MS, 5000);
    assert.equal(DurableDelivery.RECOVERY_BOUNDS.REDIS_INDEX_SCAN_DEFAULT, false);
    assert.equal(DurableDelivery.redisIndexScanEnabled(), false);
    assert.equal(DurableDelivery.getRecoveryIntervalMs(), 15000);

    await withEnv('DELIVERY_RECOVERY_INTERVAL_MS', '2000', async () => {
      assert.equal(DurableDelivery.getRecoveryIntervalMs(), 5000);
    });
    await withEnv('DELIVERY_RECOVERY_REDIS_SCAN', 'true', () => {
      assert.equal(DurableDelivery.redisIndexScanEnabled(), true);
    });
    await withEnv('DELIVERY_RECOVERY_REDIS_SCAN', '0', () => {
      assert.equal(DurableDelivery.redisIndexScanEnabled(), false);
    });
  });

  it('production sources do not use HGETALL(djobidx), KEYS, FLUSHALL, or FLUSHDB', () => {
    const dd = fs.readFileSync(path.join(__dirname, '../../utils/durableDelivery.js'), 'utf8');
    const script = fs.readFileSync(path.join(__dirname, '../../scripts/cleanup-djobidx.js'), 'utf8');
    const server = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
    for (const src of [dd, script]) {
      assert.doesNotMatch(src, /hGetAll\(keyIndex\(\)\)/);
      assert.doesNotMatch(src, /[\s.]flushAll\s*\(/);
      assert.doesNotMatch(src, /[\s.]flushDb\s*\(/);
      assert.doesNotMatch(src, /sendCommand\(\s*\[\s*'KEYS'/);
      assert.doesNotMatch(src, /sendCommand\(\s*\[\s*'HGETALL'/);
    }
    assert.doesNotMatch(server, /runIndexCleanupPass|runIndexCleanupBatch/);
    assert.match(server, /Does NOT start djobidx cleanup/);
    assert.match(script, /CONFIRM_DJOBIDX_CLEANUP/);
    assert.match(script, /process\.argv\.includes\('--execute'\)/);
    assert.match(script, /DRY-RUN|DRY_RUN|execute/);
  });
});
