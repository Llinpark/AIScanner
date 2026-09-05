/**
 * Admin observability wording — fan-out ≠ all channels delivered.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PipelineStatusService = require('../../services/PipelineStatusService');

describe('admin observability copy + counters', () => {
  it('AdminPipeline distinguishes intake, channels, sequence wait, and fan-out', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../frontend/src/admin/AdminPipeline.jsx'),
      'utf8'
    );
    assert.match(src, /fan-out complete ≠ every channel delivered/);
    assert.match(src, /fanout_complete means/);
    assert.match(src, /not that every channel delivered/);
    assert.match(src, /Email and Telegram are independent/);
    assert.match(src, /delivery_sequence_wait/);
    assert.match(src, /sequence_wait_unhealthy/);
    assert.match(src, /sequence_wait_expired/);
    assert.match(src, /retry_scheduled/);
    assert.match(src, /failed_terminal/);
    assert.match(src, /HTTP 2xx \/ accepted/);
    assert.match(src, /Lifecycle month/);
    assert.match(src, /TP\/SL\/expired — not ENTRY/);
    assert.doesNotMatch(src, /fanout_complete means all channels delivered/i);
  });

  it('pipeline ring records webhook received vs accepted vs sequence wait', () => {
    PipelineStatusService.resetForTests();
    PipelineStatusService.record('WebhookReceived', 'PASS', {
      signalUuid: 'obs-1',
      eventId: 'XAUUSD|3|obs-1|ENTRY',
      eventType: 'ENTRY',
      canonicalTradeId: 'obs-1'
    });
    PipelineStatusService.record('Accepted', 'PASS', {
      signalUuid: 'obs-1',
      eventType: 'ENTRY',
      latencyMs: 12
    });
    PipelineStatusService.record('DeliverySequence', 'PENDING', {
      signalUuid: 'obs-1',
      channel: 'email',
      reason: 'delivery_sequence_wait'
    });
    PipelineStatusService.record('DeliverySequence', 'FAIL', {
      signalUuid: 'obs-1',
      channel: 'email',
      reason: 'delivery_sequence_wait_expired'
    });
    const events = PipelineStatusService.getLiveEvents(20);
    assert.ok(events.some(e => e.type === 'WebhookReceived' || e.stage === 'WebhookReceived'));
    assert.ok(events.some(e => e.type === 'Accepted' || e.stage === 'Accepted'));
    assert.ok(events.some(e => e.type === 'DeliverySequence' || e.stage === 'DeliverySequence'));
    assert.ok(events.some(e => /delivery_sequence_wait/.test(e.reason || '')));
    const lat = PipelineStatusService.getLatencySummary();
    assert.ok(lat && lat.webhookToAccepted);
  });
});
