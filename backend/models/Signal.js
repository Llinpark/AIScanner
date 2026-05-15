const mongoose = require('mongoose');

const SignalSchema = new mongoose.Schema({
  symbol: { type: String, required: true },
  direction: { type: String, required: true },
  entry: { type: Number, required: true },
  stop_loss: { type: Number, required: true },
  take_profit_1: { type: Number, required: true },
  take_profit_2: { type: Number, required: true },
  take_profit_3: { type: Number, required: true },
  confidence: { type: Number, default: 0 },
  notes: { type: String },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Signal', SignalSchema);
