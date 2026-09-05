const mongoose = require('mongoose');

/**
 * Durable per-subscriber-channel delivery progress.
 * Mongo is the long-term record that work exists.
 * Redis leases coordinate PROCESSING ownership only.
 * Identity is stable: eventId + canonicalTradeId + subscriberId + channel + eventType.
 * Job existing ≠ DELIVERED.
 */
const DeliveryJobSchema = new mongoose.Schema(
  {
    jobId: { type: String, required: true, unique: true, index: true },
    eventId: { type: String, index: true },
    canonicalTradeId: { type: String, index: true },
    subscriberId: { type: String, index: true },
    channel: { type: String, index: true },
    eventType: { type: String },
    eventSequence: { type: Number },
    signalUuid: { type: String, index: true },
    requestId: { type: String, index: true },
    outcomeStatus: {
      type: String,
      enum: ['pending', 'success', 'failed', 'skipped', 'not_eligible'],
      default: 'pending',
      index: true
    },
    outcomeReason: { type: String },
    correlation: { type: mongoose.Schema.Types.Mixed },
    refs: { type: mongoose.Schema.Types.Mixed },
    deliveryReason: { type: String },
    predecessorEvent: { type: String },
    deliverySequenceKey: { type: String },
    waitMs: { type: Number },
    retryScheduled: { type: Boolean },
    channelDeliveryState: { type: String },
    state: {
      type: String,
      enum: [
        'pending',
        'processing',
        'sending',
        'retry_pending',
        'provider_accepted',
        'delivered',
        'failed_terminal',
        'blocked_waiting_for_entry',
        'skipped',
        'not_eligible'
      ],
      default: 'pending',
      index: true
    },
    owner: { type: String },
    leaseUntil: { type: Number },
    attemptCount: { type: Number, default: 0 },
    sendAttempts: { type: Number, default: 0 },
    lastAttemptAt: { type: Number },
    nextAttemptAt: { type: Number, index: true },
    lastError: { type: String },
    deliveredAt: { type: Number },
    payload: { type: mongoose.Schema.Types.Mixed },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  },
  { collection: 'delivery_jobs' }
);

DeliveryJobSchema.index({ state: 1, nextAttemptAt: 1 });
DeliveryJobSchema.index({ state: 1, leaseUntil: 1 });
DeliveryJobSchema.index({ canonicalTradeId: 1, subscriberId: 1, channel: 1 });
DeliveryJobSchema.index({ signalUuid: 1, channel: 1, createdAt: -1 });
DeliveryJobSchema.index({ channel: 1, outcomeStatus: 1, createdAt: -1 });
DeliveryJobSchema.index({ createdAt: -1 });
DeliveryJobSchema.index({ 'correlation.requestId': 1 });
DeliveryJobSchema.index({ 'refs.signalUuid': 1, channel: 1 });
DeliveryJobSchema.index(
  { eventId: 1, canonicalTradeId: 1, subscriberId: 1, channel: 1, eventType: 1 },
  { name: 'idx_delivery_identity' }
);

module.exports = mongoose.models.DeliveryJob || mongoose.model('DeliveryJob', DeliveryJobSchema);
