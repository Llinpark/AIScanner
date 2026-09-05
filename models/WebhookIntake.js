'use strict';

const mongoose = require('mongoose');

/**
 * Compact TradingView HTTP POST outcomes.
 * Diagnostic-only. TTL 7 days. Not on the webhook ACK hot path (writers must be async).
 */
const WebhookIntakeSchema = new mongoose.Schema(
  {
    requestId: { type: String, index: true },
    machine: { type: String },
    symbol: { type: String },
    timeframe: { type: String },
    statusCode: { type: Number, index: true },
    outcome: { type: String },
    category: {
      type: String,
      enum: [
        'AUTH_FAILED',
        'RATE_LIMITED',
        'INVALID_PAYLOAD',
        'ACCEPTED',
        'CANDLE_ACK',
        'REJECTED',
        'LOCK_TIMEOUT',
        'SERVER_ERROR'
      ],
      index: true
    },
    accepted: { type: Boolean, default: false },
    persisted: { type: Boolean, default: false },
    deferredFanout: { type: Boolean, default: false },
    skippedFanout: { type: Boolean, default: false },
    reason: { type: String },
    authMs: { type: Number },
    acceptMs: { type: Number },
    ackMs: { type: Number },
    receivedAt: { type: Date, default: Date.now, index: true }
  },
  { collection: 'webhook_intake' }
);

WebhookIntakeSchema.index({ receivedAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });
WebhookIntakeSchema.index({ requestId: 1, receivedAt: -1 });
WebhookIntakeSchema.index({ category: 1, receivedAt: -1 });

module.exports =
  mongoose.models.WebhookIntake || mongoose.model('WebhookIntake', WebhookIntakeSchema);
