const mongoose = require('mongoose');

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
  status: {
    type: String,
    enum: ['pending', 'sent', 'filled', 'failed', 'cancelled'],
    default: 'pending',
    index: true
  },
  mt5Ticket: { type: String },
  fillPrice: { type: Number },
  errorMessage: { type: String },
  source: { type: String, default: 'telegram' },
  createdAt: { type: Date, default: Date.now },
  executedAt: { type: Date }
});

TradeExecutionSchema.index({ userId: 1, signalId: 1 }, { unique: true });
TradeExecutionSchema.index({ userId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('TradeExecution', TradeExecutionSchema);
