const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

describe('PipelineStatusService + pipelineLog diagnostics', () => {
  let PipelineStatusService;
  let logPipeline;
  let activeSignalRegistry;

  beforeEach(() => {
    delete require.cache[require.resolve('../../services/PipelineStatusService')];
    delete require.cache[require.resolve('../pipelineLog')];
    delete require.cache[require.resolve('../activeSignalRegistry')];
    PipelineStatusService = require('../../services/PipelineStatusService');
    ({ logPipeline } = require('../pipelineLog'));
    activeSignalRegistry = require('../activeSignalRegistry');
    PipelineStatusService.resetForTests();
    activeSignalRegistry.resetForTests();
  });

  it('records webhook/auth/mongo/delivery stages without throwing', async () => {
    assert.doesNotThrow(() => {
      logPipeline('WebhookReceived', 'PASS', {
        symbol: 'EURUSD',
        timeframe: '5',
        signalUuid: 'sig-1',
        reason: 'ip=1.2.3.4; bytes=120; licenseToken=present'
      });
      logPipeline('Auth', 'PASS', { symbol: 'EURUSD', signalUuid: 'sig-1', reason: 'AUTH_PASSED; mode=license' });
      logPipeline('MongoSave', 'PASS', { symbol: 'EURUSD', signalUuid: 'sig-1', reason: 'Success; id=abc' });
      logPipeline('DeliveryTelegram', 'PASS', { symbol: 'EURUSD', signalUuid: 'sig-1', reason: 'SUCCESS' });
      logPipeline('DeliveryMT5', 'PASS', { symbol: 'EURUSD', signalUuid: 'sig-1', reason: 'SUCCESS; queued' });
      logPipeline('DeliverySocket', 'PASS', { symbol: 'EURUSD', signalUuid: 'sig-1', reason: 'SUCCESS' });
    });

    const status = await PipelineStatusService.getStatus();
    assert.ok(status.lastWebhookReceived?.at);
    assert.equal(status.lastWebhookReceived.symbol, 'EURUSD');
    assert.ok(status.lastAlertFired?.at, 'webhook receive proxies lastAlertFired');
    assert.ok(status.lastAuthPassed?.at);
    assert.ok(status.lastMongoSave?.at);
    assert.ok(status.lastTelegramDelivery?.at);
    assert.ok(status.lastMT5Delivery?.at);
    assert.equal(status.currentOpenTradesCount, 0);
  });

  it('records failure stage/reason on FAIL without breaking callers', async () => {
    logPipeline('Auth', 'FAIL', { symbol: 'XAUUSD', reason: 'invalid_license_token' });
    const status = await PipelineStatusService.getStatus();
    assert.equal(status.lastFailureStage, 'Auth');
    assert.equal(status.lastFailureReason, 'invalid_license_token');
    assert.equal(status.lastAuthPassed, null);
  });

  it('includes current open trades from activeSignalRegistry', async () => {
    await activeSignalRegistry.registerActive({
      symbol: 'GBPUSD',
      timeframe: '5',
      strategy: 'scalping',
      signalUuid: 'open-1',
      direction: 'long'
    });
    const status = await PipelineStatusService.getStatus();
    assert.equal(status.currentOpenTradesCount, 1);
    assert.match(String(status.currentOpenTrades[0].symbol), /GBP/);
    assert.equal(status.currentOpenTrades[0].signalUuid, 'open-1');
  });

  it('logPipeline still returns the formatted line (webhook happy-path contract)', () => {
    const line = logPipeline('Validation', 'PASS', {
      symbol: 'USDJPY',
      timeframe: '15',
      signalUuid: 'sig-2',
      reason: 'entry_levels_ok'
    });
    assert.match(line, /^\[PIPELINE\] \| Validation \|/);
    assert.match(line, /USDJPY/);
    assert.match(line, /PASS/);
  });
});
