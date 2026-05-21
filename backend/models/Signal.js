const mongoose = require('mongoose');

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
  tradingviewUsername: { type: String, index: true },
  appUsername: { type: String, index: true },
  isBroadcast: { type: Boolean, default: false },
  source: { type: String, default: 'scanner' },
  pattern: { type: String },
  patternLabel: { type: String },
  gapTop: { type: Number },
  gapBottom: { type: Number },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Signal', SignalSchema);
