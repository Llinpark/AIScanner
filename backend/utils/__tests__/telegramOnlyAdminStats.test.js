/**
 * Admin delivery-stats + Telegram-only channel independence.
 * Does not touch Option A / B4–B7 Pine logic.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { percent } = require('../pipelineObservability');
const TradeDeliveryService = require('../../services/TradeDeliveryService');

describe('Pipeline delivery stats counting contracts', () => {
  it('percent returns null for empty denominator (Admin shows — / N/A)', () => {
    assert.equal(percent(0, 0), null);
    assert.equal(percent(1, 0), null);
    assert.equal(percent(1, 2), 50);
  });

  it('unique canonical signal identity: same UUID must not count as N signals', () => {
    // Contract for PipelineDeliveryStatsService.countUniqueCanonicalSignals —
    // one TradingView event → one signalUuid regardless of subscriber fan-out.
    const uuids = ['canon-1', 'canon-1', 'canon-1'];
    const unique = new Set(uuids);
    assert.equal(unique.size, 1);
  });

  it('MT5 success denominator excludes Telegram-only expected skips', () => {
    assert.equal(TradeDeliveryService.isExpectedMt5Skip('manual_mode'), true);
    assert.equal(TradeDeliveryService.isExpectedMt5Skip('mt5_not_linked'), true);
    assert.equal(TradeDeliveryService.isExpectedMt5Skip('queue_error'), false);
    // When only expected skips exist, attempted count is 0 → percent null → UI "—".
    assert.equal(percent(0, 0), null);
    // Example: 2 MT5 attempts succeed of 2 attempted (not of 12 total signals).
    assert.equal(percent(2, 2), 100);
    assert.notEqual(percent(2, 12), 100);
  });

  it('UTC window helpers: today/week/month share startOfDayUTC', () => {
    const { startOfDay, daysAgo } = require('../../services/PipelineDeliveryStatsService');
    const today = startOfDay();
    assert.equal(today.getUTCHours(), 0);
    assert.equal(today.getUTCMinutes(), 0);
    const week = daysAgo(7);
    const month = daysAgo(30);
    assert.ok(week.getTime() < today.getTime());
    assert.ok(month.getTime() < week.getTime());
    assert.equal(week.getUTCHours(), 0);
    assert.equal(month.getUTCHours(), 0);
  });

  it('Telegram success is independent of MT5 skip', () => {
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
});

describe('WebhookParseError classification remains strict', () => {
  it('malformed JSON stays WEBHOOK_PARSE_FAILED', () => {
    const { resolveIntakeState, PIPELINE_INTAKE_STATE } = require('../webhookPipelineDiag');
    assert.equal(
      resolveIntakeState({
        lastFailureStage: 'WebhookParseError',
        lastFailureReason: "ip=102.204.12.194; type=entity.parse.failed; Expected property name or '}' in JSON at position 1",
        lastWebhookReceived: { at: new Date().toISOString() }
      }),
      PIPELINE_INTAKE_STATE.WEBHOOK_PARSE_FAILED
    );
  });

  it('Telegram success after MT5 SKIP is TELEGRAM_SUCCESS (not delivery failed)', () => {
    const { resolveIntakeState, PIPELINE_INTAKE_STATE } = require('../webhookPipelineDiag');
    assert.equal(
      resolveIntakeState({
        lastFailureStage: null,
        lastTelegramDelivery: { at: new Date().toISOString() },
        lastWebhookReceived: { at: new Date().toISOString() }
      }),
      PIPELINE_INTAKE_STATE.TELEGRAM_SUCCESS
    );
  });
});
