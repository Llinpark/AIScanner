const mongoose = require('mongoose');

const ManagementEventSchema = new mongoose.Schema(
  {
    type: { type: String },
    at: { type: Date },
    price: { type: Number },
    volume: { type: Number },
    remainingVolume: { type: Number },
    note: { type: String },
    /** EA durable-queue event id — used for ack + dedupe */
    eventUuid: { type: String }
  },
  { _id: false }
);

const ManagementStateSchema = new mongoose.Schema(
  {
    phase: {
      type: String,
      default: 'queued'
    },
    tp1Hit: { type: Boolean, default: false },
    tp2Hit: { type: Boolean, default: false },
    tp3Hit: { type: Boolean, default: false },
    breakEvenApplied: { type: Boolean, default: false },
    trailingActive: { type: Boolean, default: false },
    remainingVolume: { type: Number },
    closedVolume: { type: Number, default: 0 },
    partialClosePercent: { type: Number, default: 0 },
    lastEvent: { type: String },
    lastEventAt: { type: Date },
    events: { type: [ManagementEventSchema], default: [] },
    /** Recently acknowledged event UUIDs (dedupe; capped in service). */
    ackedEventUuids: { type: [String], default: [] }
  },
  { _id: false }
);

const TradeExecutionSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  signalId: { type: String, required: true, index: true },
  symbol: { type: String, required: true },
  mt5Symbol: { type: String, required: true },
  direction: { type: String, required: true },
  entry: { type: Number, required: true },
  stopLoss: { type: Number, required: true },
  takeProfit1: { type: Number, required: true },
  takeProfit2: { type: Number },
  takeProfit3: { type: Number },
  lotSize: { type: Number, required: true },
  riskPercent: { type: Number },
  accountBalance: { type: Number },
  trailingStop: { type: Boolean, default: false },
  breakEven: { type: Boolean, default: false },
  /** Trail distance in pips from current price (legacy EA hint; EA v1.20+ manages locally). */
  trailDistancePips: { type: Number },
  /** Minimum improvement in pips before SL is moved again. */
  trailStepPips: { type: Number },
  /** Move SL to break-even when price reaches this multiple of initial R (entry→SL). */
  breakEvenTriggerR: { type: Number, default: 1 },
  /** Extra pips beyond entry when locking break-even (covers spread). */
  breakEvenOffsetPips: { type: Number, default: 2 },
  status: {
    type: String,
    enum: ['pending', 'sent', 'filled', 'failed', 'cancelled', 'closed'],
    default: 'pending',
    index: true
  },
  mt5Ticket: { type: String },
  fillPrice: { type: Number },
  errorMessage: { type: String },
  /** EA-managed lifecycle (TP hits, BE, trail, partials) — additive */
  managementState: { type: ManagementStateSchema, default: () => ({}) },
  /** auto | manual | telegram (legacy) */
  source: { type: String, default: 'auto' },
  /** When status moved to sent (claim). Used for stuck-claim reclaim. */
  claimedAt: { type: Date },
  /** Device that claimed this execution (heartbeat-aware reclaim). */
  claimedByDeviceId: { type: String },
  createdAt: { type: Date, default: Date.now },
  executedAt: { type: Date },
  closedAt: { type: Date }
});

TradeExecutionSchema.index({ userId: 1, signalId: 1 }, { unique: true });
TradeExecutionSchema.index({ userId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('TradeExecution', TradeExecutionSchema);
