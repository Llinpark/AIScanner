const mongoose = require('mongoose');

const RiskMetricsSchema = new mongoose.Schema(
  {
    pipRisk: Number,
    pipReward1: Number,
    pipReward2: Number,
    pipReward3: Number,
    riskReward1: Number,
    riskReward2: Number,
    riskReward3: Number,
    riskPercent: Number,
    riskAmount: Number,
    suggestedLotSize: Number,
    direction: String
  },
  { _id: false }
);

const SignalSchema = new mongoose.Schema({
  symbol: { type: String, required: true },
  direction: { type: String, required: true },
  entry: { type: Number, required: true },
  stop_loss: { type: Number, required: true },
  stop_loss_1: { type: Number },
  stop_loss_2: { type: Number },
  stop_loss_3: { type: Number },
  take_profit_1: { type: Number, required: true },
  take_profit_2: { type: Number, required: true },
  take_profit_3: { type: Number, required: true },
  confidence: { type: Number, default: 0 },
  notes: { type: String },
  alertType: {
    type: String,
    enum: ['entry', 'stop_loss', 'take_profit_1', 'take_profit_2', 'take_profit_3', 'signal'],
    default: 'signal'
  },
  userId: { type: String, index: true },
  isBroadcast: { type: Boolean, default: false },
  source: { type: String, default: 'scanner' },
  pattern: { type: String },
  patternLabel: { type: String },
  gapTop: { type: Number },
  gapBottom: { type: Number },
  signalGroupId: { type: String, index: true },
  parentSignalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Signal' },
  tradeStatus: {
    type: String,
    enum: ['open', 'won', 'lost', 'partial', 'closed'],
    default: 'open'
  },
  outcome: {
    type: String,
    enum: ['pending', 'tp1', 'tp2', 'tp3', 'sl', 'breakeven'],
    default: 'pending'
  },
  outcomeR: { type: Number },
  closedAt: { type: Date },
  tradeExplanation: { type: String },
  riskMetrics: RiskMetricsSchema,
  createdAt: { type: Date, default: Date.now }
});

SignalSchema.index({ symbol: 1, createdAt: -1 });
SignalSchema.index({ alertType: 1, tradeStatus: 1 });

module.exports = mongoose.model('Signal', SignalSchema);
