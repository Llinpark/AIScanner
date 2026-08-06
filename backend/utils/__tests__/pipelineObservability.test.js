const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

describe('pipeline observability helpers', () => {
  let obs;

  beforeEach(() => {
    delete require.cache[require.resolve('../pipelineObservability')];
    delete process.env.WEBHOOK_AGE_SCALPING_MS;
    delete process.env.WEBHOOK_AGE_DAYTRADING_MS;
    delete process.env.WEBHOOK_AGE_SWING_MS;
    obs = require('../pipelineObservability');
  });

  it('uses default webhook age thresholds', () => {
    const t = obs.getWebhookAgeThresholdsMs();
    assert.equal(t.scalping, 20 * 60 * 1000);
    assert.equal(t.daytrading, 3 * 60 * 60 * 1000);
    assert.equal(t.swing, 12 * 60 * 60 * 1000);
  });

  it('respects env overrides for thresholds', () => {
    process.env.WEBHOOK_AGE_SCALPING_MS = '60000';
    delete require.cache[require.resolve('../pipelineObservability')];
    obs = require('../pipelineObservability');
    assert.equal(obs.getWebhookAgeThresholdMs('scalping'), 60000);
  });

  it('shows waiting message when never received webhook (not 0 signals)', () => {
    const age = obs.evaluateWebhookAge(null, { strategy: 'scalping' });
    assert.equal(age.status, 'waiting');
    assert.equal(age.message, obs.WAITING_FIRST_WEBHOOK);
    assert.equal(age.warning, false);
  });

  it('warns when webhook age exceeds strategy threshold', () => {
    const now = Date.now();
    const last = new Date(now - 25 * 60 * 1000).toISOString();
    const age = obs.evaluateWebhookAge(last, { strategy: 'scalping', now });
    assert.equal(age.status, 'stale');
    assert.equal(age.warning, true);
    assert.match(age.message, /No TradingView activity/);
  });

  it('ok when within daytrading threshold', () => {
    const now = Date.now();
    const last = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    const age = obs.evaluateWebhookAge(last, { strategy: 'daytrading', now });
    assert.equal(age.status, 'ok');
    assert.equal(age.warning, false);
  });

  it('reminds when pine regenerated and never webhooked', () => {
    const pine = new Date().toISOString();
    const reminder = obs.evaluateAlertEngineReminder(pine, null);
    assert.equal(reminder.remind, true);
    assert.equal(reminder.message, obs.ALERT_RECREATE_REMINDER);
    assert.equal(reminder.reason, 'never_received_webhook');
  });

  it('reminds when pine is newer than last webhook', () => {
    const webhook = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const pine = new Date().toISOString();
    const reminder = obs.evaluateAlertEngineReminder(pine, webhook);
    assert.equal(reminder.remind, true);
    assert.equal(reminder.reason, 'pine_newer_than_webhook');
  });

  it('does not remind when webhook arrived after pine', () => {
    const pine = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const webhook = new Date().toISOString();
    const reminder = obs.evaluateAlertEngineReminder(pine, webhook);
    assert.equal(reminder.remind, false);
  });

  it('builds timeline with unknown yellow stages for Pine-side steps', () => {
    const stages = obs.buildPipelineTimeline({
      pineGeneratedAt: new Date().toISOString(),
      lastWebhookAt: null
    });
    assert.ok(stages.length >= 10);
    const entry = stages.find(s => s.id === 'entry_detected');
    assert.equal(entry.tone, 'yellow');
    assert.ok(entry.note);
    const webhook = stages.find(s => s.id === 'webhook_received');
    assert.equal(webhook.status, 'waiting');
    assert.match(webhook.note, /Waiting for first/);
  });
});

describe('PipelineStatusService ring buffer + extended status', () => {
  let PipelineStatusService;
  let logPipeline;

  beforeEach(() => {
    delete require.cache[require.resolve('../../services/PipelineStatusService')];
    delete require.cache[require.resolve('../pipelineLog')];
    delete require.cache[require.resolve('../activeSignalRegistry')];
    PipelineStatusService = require('../../services/PipelineStatusService');
    ({ logPipeline } = require('../pipelineLog'));
    PipelineStatusService.resetForTests();
  });

  it('keeps a ring buffer of at most 100 live events', async () => {
    for (let i = 0; i < 120; i += 1) {
      logPipeline('WebhookReceived', 'PASS', {
        symbol: 'EURUSD',
        signalUuid: `sig-${i}`,
        reason: `n=${i}`
      });
    }
    const live = await PipelineStatusService.getLivePipeline(100);
    assert.equal(live.count, 100);
    assert.equal(live.events[0].signalUuid, 'sig-119');
    assert.equal(live.events[99].signalUuid, 'sig-20');
  });

  it('exposes extended pipeline-status shape fields', async () => {
    logPipeline('WebhookReceived', 'PASS', { symbol: 'XAUUSD', signalUuid: 'a' });
    logPipeline('Auth', 'PASS', { symbol: 'XAUUSD', signalUuid: 'a' });
    logPipeline('MongoSave', 'PASS', { symbol: 'XAUUSD', signalUuid: 'a' });
    logPipeline('Publish', 'PASS', { symbol: 'XAUUSD', signalUuid: 'a', latencyMs: 42 });
    logPipeline('DeliveryTelegram', 'PASS', { symbol: 'XAUUSD', signalUuid: 'a' });
    logPipeline('DeliverySocket', 'PASS', { symbol: 'XAUUSD', signalUuid: 'a' });
    logPipeline('DeliveryMT5', 'PASS', { symbol: 'XAUUSD', signalUuid: 'a' });

    const status = await PipelineStatusService.getStatus({
      activeSubscribers: 3,
      waitingSubscribers: 1
    });

    assert.equal(status.pipelineHealthy, true);
    assert.ok(status.lastWebhook?.at);
    assert.ok(status.lastPublishedSignal?.at);
    assert.ok(status.lastMongoSave?.at);
    assert.ok(status.lastTelegram?.at);
    assert.ok(status.lastSocket?.at);
    assert.ok(status.lastMT5?.at);
    assert.equal(typeof status.averagePipelineLatency === 'number' || status.averagePipelineLatency === null, true);
    assert.equal(status.activeSubscribers, 3);
    assert.equal(status.waitingSubscribers, 1);
    assert.equal(typeof status.webhookFailures, 'number');
    assert.equal(typeof status.deliveryFailures, 'number');
    assert.ok(status.currentPipelineStage);
    assert.ok(Array.isArray(status.timeline));
    assert.ok(status.timeline.length >= 10);
  });

  it('counts auth failures toward webhookFailures', async () => {
    logPipeline('Auth', 'FAIL', { reason: 'invalid_license_token' });
    const status = await PipelineStatusService.getStatus();
    assert.ok(status.webhookFailures >= 1);
    assert.equal(status.lastFailureStage, 'Auth');
  });

  it('records pre-route WebhookRateLimited and WebhookParseError into ring + failures', async () => {
    logPipeline('WebhookRateLimited', 'FAIL', {
      reason: 'limiter=webhookLimiter; path=/api/webhook/tradingview; ip=1.2.3.4; status=429'
    });
    logPipeline('WebhookParseError', 'FAIL', {
      reason: 'ip=1.2.3.4; type=entity.parse.failed; Unexpected token'
    });
    const status = await PipelineStatusService.getStatus();
    assert.ok(status.webhookFailures >= 2);
    assert.equal(status.lastFailureStage, 'WebhookParseError');
    const live = await PipelineStatusService.getLivePipeline(10);
    const types = live.events.map(e => e.type);
    assert.ok(types.includes('WebhookParseError'));
    assert.ok(types.includes('WebhookRateLimited'));
  });
});

describe('PipelineSubscriberStatsService', () => {
  let Stats;

  beforeEach(() => {
    delete require.cache[require.resolve('../../services/PipelineSubscriberStatsService')];
    Stats = require('../../services/PipelineSubscriberStatsService');
    Stats.resetForTests();
  });

  it('tracks per-user lastWebhookAt and pine generation', async () => {
    await Stats.recordPineGenerated('user-1', { strategy: 'scalping', scriptId: 'abc' });
    await Stats.recordWebhook('user-1', { symbol: 'EURUSD' });
    const stats = Stats.getStats('user-1');
    assert.ok(stats.lastPineGeneratedAt);
    assert.ok(stats.lastWebhookAt);
    assert.equal(stats.lastPineStrategy, 'scalping');
    assert.equal(stats.webhookCount, 1);
  });
});
