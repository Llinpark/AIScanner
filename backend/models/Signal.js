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
  pipelineScore: { type: Number },
  pipelineScoreBreakdown: { type: mongoose.Schema.Types.Mixed },
  signalQuality: { type: String },
  isPremiumSignal: { type: Boolean, default: false },
  notes: { type: String },
  alertType: {
    type: String,
    enum: [
      'entry',
      'stop_loss',
      'take_profit_1',
      'take_profit_2',
      'take_profit_3',
      'expired',
      'cancelled',
      'signal'
    ],
    default: 'signal'
  },
  userId: { type: String, index: true },
  isBroadcast: { type: Boolean, default: false },
  // Legacy field; prefer signalSource. Kept for backward-compatible queries.
  source: { type: String, default: 'tradingview' },
  // Distribution metadata (TradingView webhook is the sole production signal source).
  signalSource: { type: String, default: 'tradingview' },
  /** Permanent trade id from Pine / webhook — never overwritten after confirm. */
  signalUuid: { type: String, index: true },
  /** Alias kept for clients that send signalId. */
  signalId: { type: String, index: true },
  strategyName: { type: String },
  /** Additive Strategy Engine metadata (optional; does not replace pattern/strategyName). */
  strategyId: { type: String },
  strategyVersion: { type: Number },
  timeframe: { type: String },
  /** DETECTED | CONFIRMED | ACTIVE | TP1 | TP2 | TP3 | SL | EXPIRED | CANCELLED */
  lifecycleStage: {
    type: String,
    enum: [
      'DETECTED',
      'CONFIRMED',
      'ACTIVE',
      'TP1',
      'TP2',
      'TP3',
      'SL',
      'EXPIRED',
      'CANCELLED'
    ],
    default: 'ACTIVE'
  },
  /** Highest TP milestone reached while trade was open (pending|tp1|tp2|tp3). */
  highestMilestone: {
    type: String,
    enum: ['pending', 'tp1', 'tp2', 'tp3'],
    default: 'pending'
  },
  /** After confirm, entry/SL/TPs/direction/confidence must not be rewritten by scans. */
  levelsFrozen: { type: Boolean, default: false },
  expiryBars: { type: Number },
  enableTradeExpiry: { type: Boolean, default: true },
  expiresAt: { type: Date },
  closedReason: { type: String },
  deliveryStatus: {
    type: String,
    enum: ['pending', 'delivered', 'partial', 'failed'],
    default: 'pending'
  },
  executionStatus: {
    type: String,
    enum: ['pending', 'sent', 'executed', 'skipped', 'failed'],
    default: 'pending'
  },
  telegramSent: { type: Boolean, default: false },
  mt5Sent: { type: Boolean, default: false },
  emailSent: { type: Boolean, default: false },
  chartSnapshot: { type: String },
  pattern: { type: String },
  patternLabel: { type: String },
  gapTop: { type: Number },
  gapBottom: { type: Number },
  fvgTimeStart: { type: Number },
  fvgTimeEnd: { type: Number },
  orderBlockTop: { type: Number },
  orderBlockBottom: { type: Number },
  orderBlockTimeStart: { type: Number },
  orderBlockTimeEnd: { type: Number },
  liquidityZoneTop: { type: Number },
  liquidityZoneBottom: { type: Number },
  liquidityTimeStart: { type: Number },
  liquidityTimeEnd: { type: Number },
  chartZones: { type: mongoose.Schema.Types.Mixed },
  signalGroupId: { type: String, index: true },
  parentSignalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Signal' },
  tradeStatus: {
    type: String,
    enum: ['open', 'won', 'lost', 'partial', 'closed', 'expired', 'cancelled'],
    default: 'open'
  },
  outcome: {
    type: String,
    enum: ['pending', 'tp1', 'tp2', 'tp3', 'sl', 'breakeven', 'expired', 'cancelled'],
    default: 'pending'
  },
  outcomeR: { type: Number },
  closedAt: { type: Date },
  tradeExplanation: { type: String },
  aiFactors: { type: mongoose.Schema.Types.Mixed },
  riskMetrics: RiskMetricsSchema,
  newsImpact: { type: String },
  newsFilter: { type: mongoose.Schema.Types.Mixed },
  tradeManagement: { type: mongoose.Schema.Types.Mixed },
  partialClose: { type: mongoose.Schema.Types.Mixed },
  breakEven: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now }
});

SignalSchema.index({ symbol: 1, createdAt: -1 });
SignalSchema.index({ alertType: 1, tradeStatus: 1 });

module.exports = mongoose.model('Signal', SignalSchema);
