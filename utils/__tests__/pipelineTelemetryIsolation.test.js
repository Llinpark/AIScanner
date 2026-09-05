/**
 * Production-safety: self-test / NODE_ENV=test must not pollute PipelineStatus Redis.
 * Signal counts remain Mongo-only; Telegram % stays honest when no attempts.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const REDIS_CLIENT_PATH = path.resolve(__dirname, '../redisClient.js');
const STATUS_PATH = path.resolve(__dirname, '../../services/PipelineStatusService.js');
const LOG_PATH = path.resolve(__dirname, '../pipelineLog.js');
const STATS_PATH = path.resolve(__dirname, '../../services/PipelineDeliveryStatsService.js');
const SIGNAL_PATH = path.resolve(__dirname, '../../models/Signal.js');

function installMockRedis() {
  const store = new Map();
  const calls = { setEx: [], del: [], get: [] };
  const mock = {
    async setEx(key, ttl, value) {
      calls.setEx.push({ key, ttl, value });
      store.set(key, value);
      return 'OK';
    },
    async get(key) {
      calls.get.push(key);
      return store.has(key) ? store.get(key) : null;
    },
    async del(key) {
      calls.del.push(key);
      const had = store.delete(key);
      return had ? 1 : 0;
    },
    isOpen: true
  };
  const previous = require.cache[REDIS_CLIENT_PATH];
  require.cache[REDIS_CLIENT_PATH] = {
    id: REDIS_CLIENT_PATH,
    filename: REDIS_CLIENT_PATH,
    loaded: true,
    exports: {
      getRedisClient: async () => mock,
      isRedisEnabled: () => true
    }
  };
  return { store, calls, mock, previous };
}

function restoreRedisModule(previous) {
  if (previous) require.cache[REDIS_CLIENT_PATH] = previous;
  else delete require.cache[REDIS_CLIENT_PATH];
}

function loadStatusService() {
  delete require.cache[STATUS_PATH];
  delete require.cache[LOG_PATH];
  return require('../../services/PipelineStatusService');
}

describe('PipelineStatus Redis isolation (non-production telemetry)', () => {
  let prevNodeEnv;
  let prevAllow;
  let prevSelfTest;
  let PipelineStatusService;
  let mockRedis;

  beforeEach(() => {
    prevNodeEnv = process.env.NODE_ENV;
    prevAllow = process.env.ALLOW_PIPELINE_TEST_REDIS;
    prevSelfTest = process.env.PIPELINE_SELF_TEST_ACTIVE;
    delete process.env.ALLOW_PIPELINE_TEST_REDIS;
    delete process.env.PIPELINE_SELF_TEST_ACTIVE;
    mockRedis = installMockRedis();
    PipelineStatusService = loadStatusService();
    PipelineStatusService.resetForTests();
  });

  afterEach(() => {
    process.env.NODE_ENV = prevNodeEnv;
    if (prevAllow === undefined) delete process.env.ALLOW_PIPELINE_TEST_REDIS;
    else process.env.ALLOW_PIPELINE_TEST_REDIS = prevAllow;
    if (prevSelfTest === undefined) delete process.env.PIPELINE_SELF_TEST_ACTIVE;
    else process.env.PIPELINE_SELF_TEST_ACTIVE = prevSelfTest;
    restoreRedisModule(mockRedis?.previous);
    delete require.cache[STATUS_PATH];
    delete require.cache[LOG_PATH];
  });

  async function flushMicrotasks() {
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
  }

  it('selfTest=true does not persist PipelineStatus to Redis', async () => {
    process.env.NODE_ENV = 'development';
    PipelineStatusService = loadStatusService();
    PipelineStatusService.resetForTests();

    PipelineStatusService.record('WebhookReceived', 'PASS', {
      symbol: 'EURUSD',
      signalUuid: 'real-looking-uuid',
      selfTest: true
    });
    PipelineStatusService.record('MongoSave', 'PASS', {
      symbol: 'EURUSD',
      signalUuid: 'real-looking-uuid',
      selfTest: true,
      reason: 'Success; in_memory_fallback; id=mem_x'
    });
    await flushMicrotasks();

    assert.equal(mockRedis.calls.setEx.length, 0);
    const status = await PipelineStatusService.getStatus();
    assert.equal(status.lastMongoSaveIsSelfTest, true);
    assert.equal(status.lastMongoSaveDurable, false);
    assert.match(String(status.lastMongoSaveNote), /self-test|Non-production/i);
  });

  it('PIPELINE_SELF_TEST_ACTIVE does not persist production telemetry', async () => {
    process.env.NODE_ENV = 'development';
    process.env.PIPELINE_SELF_TEST_ACTIVE = 'true';
    PipelineStatusService = loadStatusService();
    PipelineStatusService.resetForTests();

    PipelineStatusService.record('WebhookReceived', 'PASS', {
      symbol: 'EURUSD',
      signalUuid: 'uuid-1'
    });
    await flushMicrotasks();
    assert.equal(mockRedis.calls.setEx.length, 0);
  });

  it('STEST* symbol does not persist production telemetry', async () => {
    process.env.NODE_ENV = 'development';
    PipelineStatusService = loadStatusService();
    PipelineStatusService.resetForTests();

    PipelineStatusService.record('MongoSave', 'PASS', {
      symbol: 'STEST854548',
      signalUuid: 'uuid-plain',
      reason: 'Success; in_memory_fallback; id=mem_1'
    });
    await flushMicrotasks();
    assert.equal(mockRedis.calls.setEx.length, 0);
    assert.equal(
      PipelineStatusService.isNonProductionPipelineTelemetry({ symbol: 'STEST854548' }),
      true
    );
  });

  it('selftest_* signalUuid does not persist production telemetry', async () => {
    process.env.NODE_ENV = 'development';
    PipelineStatusService = loadStatusService();
    PipelineStatusService.resetForTests();

    PipelineStatusService.record('WebhookReceived', 'PASS', {
      symbol: 'EURUSD',
      signalUuid: 'selftest_dbd8d544-b303-4834-94ac-c5dc017f7bb5'
    });
    await flushMicrotasks();
    assert.equal(mockRedis.calls.setEx.length, 0);
  });

  it('NODE_ENV=test does not persist production telemetry', async () => {
    process.env.NODE_ENV = 'test';
    PipelineStatusService = loadStatusService();
    PipelineStatusService.resetForTests();

    PipelineStatusService.record('WebhookReceived', 'PASS', {
      symbol: 'EURUSD',
      signalUuid: 'genuine-looking'
    });
    PipelineStatusService.record('MongoSave', 'PASS', {
      symbol: 'EURUSD',
      signalUuid: 'genuine-looking',
      reason: 'Success; id=abc'
    });
    await flushMicrotasks();
    assert.equal(mockRedis.calls.setEx.length, 0);
  });

  it('real TradingView-like webhook persists PipelineStatus to Redis', async () => {
    process.env.NODE_ENV = 'development';
    PipelineStatusService = loadStatusService();
    PipelineStatusService.resetForTests();

    PipelineStatusService.record('WebhookReceived', 'PASS', {
      symbol: 'XAUUSD',
      signalUuid: 'tv-uuid-001',
      reason: 'ip=1.2.3.4'
    });
    PipelineStatusService.record('Auth', 'PASS', { symbol: 'XAUUSD', signalUuid: 'tv-uuid-001' });
    PipelineStatusService.record('Validation', 'PASS', {
      symbol: 'XAUUSD',
      signalUuid: 'tv-uuid-001'
    });
    PipelineStatusService.record('MongoSave', 'PASS', {
      symbol: 'XAUUSD',
      signalUuid: 'tv-uuid-001',
      reason: 'Success; id=507f1f77bcf86cd799439011'
    });
    PipelineStatusService.record('DeliveryTelegram', 'PASS', {
      symbol: 'XAUUSD',
      signalUuid: 'tv-uuid-001'
    });
    PipelineStatusService.record('DeliveryMT5', 'SKIP', {
      symbol: 'XAUUSD',
      signalUuid: 'tv-uuid-001',
      reason: 'mt5_not_linked'
    });
    await flushMicrotasks();

    assert.ok(mockRedis.calls.setEx.length >= 1);
    assert.ok(
      mockRedis.calls.setEx.some(c => c.key === PipelineStatusService.REDIS_KEY),
      'status key written'
    );
    const status = await PipelineStatusService.getStatus();
    assert.equal(status.lastMongoSaveDurable, true);
    assert.equal(status.lastMongoSaveIsSelfTest, false);
    assert.equal(status.lastMongoSaveIsInMemoryFallback, false);
    assert.equal(status.lastFailureStage, null);
  });

  it('in_memory_fallback MongoSave is marked non-durable for Admin', async () => {
    process.env.NODE_ENV = 'development';
    PipelineStatusService = loadStatusService();
    PipelineStatusService.resetForTests();

    PipelineStatusService.record('MongoSave', 'PASS', {
      symbol: 'EURUSD',
      signalUuid: 'tv-uuid-mem',
      reason: 'Success; in_memory_fallback; id=mem_1786955856187_wi8i4en'
    });
    await flushMicrotasks();

    // Must not write Redis when lastMongoSave is in_memory_fallback
    assert.equal(
      mockRedis.calls.setEx.filter(c => c.key === PipelineStatusService.REDIS_KEY).length,
      0
    );
    const status = await PipelineStatusService.getStatus();
    assert.equal(status.lastMongoSaveDurable, false);
    assert.equal(status.lastMongoSaveIsInMemoryFallback, true);
    assert.match(String(status.lastMongoSaveNote), /In-memory fallback/i);
  });

  it('ALLOW_PIPELINE_TEST_REDIS=true respects explicit opt-in', async () => {
    process.env.NODE_ENV = 'test';
    process.env.ALLOW_PIPELINE_TEST_REDIS = 'true';
    PipelineStatusService = loadStatusService();
    PipelineStatusService.resetForTests();

    assert.equal(
      PipelineStatusService.isNonProductionPipelineTelemetry({
        symbol: 'STEST1',
        selfTest: true
      }),
      false
    );

    PipelineStatusService.record('WebhookReceived', 'PASS', {
      symbol: 'STEST1',
      signalUuid: 'selftest_abc',
      selfTest: true
    });
    await flushMicrotasks();
    assert.ok(mockRedis.calls.setEx.length >= 1);
  });

  it('clearPipelineStatusRedisKeys deletes only pipeline keys', async () => {
    process.env.NODE_ENV = 'development';
    process.env.ALLOW_PIPELINE_TEST_REDIS = 'true';
    PipelineStatusService = loadStatusService();
    PipelineStatusService.resetForTests();

    await mockRedis.mock.setEx('kaching:pipeline:status', 60, '{}');
    await mockRedis.mock.setEx('kaching:pipeline:events', 60, '[]');
    await mockRedis.mock.setEx('kaching:session:keep', 60, 'x');

    const result = await PipelineStatusService.clearPipelineStatusRedisKeys();
    assert.equal(result.ok, true);
    assert.deepEqual(result.deleted.sort(), [
      PipelineStatusService.REDIS_EVENTS_KEY,
      PipelineStatusService.REDIS_KEY
    ].sort());
    assert.equal(mockRedis.store.has('kaching:session:keep'), true);
    assert.equal(mockRedis.store.has(PipelineStatusService.REDIS_KEY), false);
  });
});

describe('PipelineDeliveryStatsService: Mongo Signal counts only', () => {
  let mongoose;
  let Signal;
  let PipelineDeliveryStatsService;
  let readyDesc;
  let origAggregate;
  let origCount;

  beforeEach(() => {
    mongoose = require('mongoose');
    Signal = require(SIGNAL_PATH);
    delete require.cache[STATS_PATH];
    PipelineDeliveryStatsService = require('../../services/PipelineDeliveryStatsService');
    readyDesc = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
    Object.defineProperty(mongoose.connection, 'readyState', {
      configurable: true,
      get: () => 1
    });
    origAggregate = Signal.aggregate;
    origCount = Signal.countDocuments;
  });

  afterEach(() => {
    Signal.aggregate = origAggregate;
    Signal.countDocuments = origCount;
    if (readyDesc) Object.defineProperty(mongoose.connection, 'readyState', readyDesc);
    else delete mongoose.connection.readyState;
    delete require.cache[STATS_PATH];
  });

  it('genuine unique signalUuid increments Signals today once', async () => {
    const matches = [];
    Signal.aggregate = async pipeline => {
      matches.push(pipeline[0].$match);
      return [{ n: 1 }];
    };
    Signal.countDocuments = async () => 0;

    const stats = await PipelineDeliveryStatsService.computeDeliveryStatistics();
    assert.equal(stats.signalsToday, 1);
    assert.equal(stats.dbConnected, true);
    assert.deepEqual(matches[0].alertType, { $in: ['entry', 'signal'] });
    assert.deepEqual(matches[0].selfTest, { $ne: true });
    assert.ok(matches[0].createdAt?.$gte instanceof Date);
  });

  it('duplicate subscriber copies with same signalUuid do not double-count', async () => {
    // Aggregate $group by signalUuid collapses fan-out → service returns n from $count.
    Signal.aggregate = async pipeline => {
      const group = pipeline.find(p => p.$group);
      assert.ok(group, 'must $group by signalUuid');
      assert.ok(group.$group._id.$ifNull || group.$group._id);
      return [{ n: 1 }];
    };
    Signal.countDocuments = async () => 3;

    const stats = await PipelineDeliveryStatsService.computeDeliveryStatistics();
    assert.equal(stats.signalsToday, 1);
    assert.equal(stats.signalsWeek, 1);
    assert.equal(stats.signalsMonth, 1);
  });

  it('Telegram success is null (Admin —) when no Telegram attempts in window', async () => {
    const DurableDelivery = require('../../utils/durableDelivery');
    DurableDelivery.resetForTests();
    Signal.aggregate = async () => [{ n: 0 }];
    Signal.countDocuments = async () => 0;

    const stats = await PipelineDeliveryStatsService.computeDeliveryStatistics();
    assert.equal(stats.telegramSuccessPct, null);
    assert.equal(stats.mt5SuccessPct, null);
  });

  it('self-test Redis telemetry cannot inflate signalsToday (stats ignore PipelineStatus for counts)', async () => {
    const PipelineStatusService = require('../../services/PipelineStatusService');
    PipelineStatusService.resetForTests?.();
    PipelineStatusService.record('MongoSave', 'PASS', {
      symbol: 'STEST999',
      signalUuid: 'selftest_pollute',
      selfTest: true,
      reason: 'Success; in_memory_fallback; id=mem_x'
    });

    Signal.aggregate = async () => []; // zero Mongo documents
    Signal.countDocuments = async () => 0;

    const stats = await PipelineDeliveryStatsService.computeDeliveryStatistics();
    assert.equal(stats.signalsToday, 0);
    assert.equal(stats.signalsWeek, 0);
    assert.equal(stats.signalsMonth, 0);
  });
});

describe('Telegram-only delivery honesty', () => {
  const TradeDeliveryService = require('../../services/TradeDeliveryService');
  const { percent } = require('../pipelineObservability');

  it('Telegram PASS + MT5 SKIP => delivered; MT5 skip is not a failure', () => {
    assert.equal(
      TradeDeliveryService.resolveDeliveryStatus({
        telegramSent: true,
        mt5Sent: false,
        tgPipelineStatus: 'PASS',
        mt5PipelineStatus: 'SKIP'
      }),
      'delivered'
    );
    assert.equal(TradeDeliveryService.isExpectedMt5Skip('mt5_not_linked'), true);
  });

  it('no Telegram attempt keeps Telegram success as — (null percent)', () => {
    assert.equal(percent(0, 0), null);
  });

  it('MT5 SKIP does not set lastFailureStage on pipeline record', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    delete process.env.ALLOW_PIPELINE_TEST_REDIS;
    delete process.env.PIPELINE_SELF_TEST_ACTIVE;
    const mock = installMockRedis();
    try {
      const PipelineStatusService = loadStatusService();
      PipelineStatusService.resetForTests();

      PipelineStatusService.record('DeliveryTelegram', 'PASS', {
        symbol: 'EURUSD',
        signalUuid: 'tv-1'
      });
      PipelineStatusService.record('DeliveryMT5', 'SKIP', {
        symbol: 'EURUSD',
        signalUuid: 'tv-1',
        reason: 'mt5_not_linked'
      });
      const status = await PipelineStatusService.getStatus();
      assert.equal(status.lastFailureStage, null);
      assert.equal(status.deliveryFailures, 0);
    } finally {
      process.env.NODE_ENV = prev;
      restoreRedisModule(mock.previous);
      delete require.cache[STATUS_PATH];
    }
  });
});
