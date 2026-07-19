const mongoose = require('mongoose');

const PaymentTransactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'UserConfig', required: true, index: true },
  tier: { type: String, enum: ['basic', 'professional', 'premium'], required: true },
  provider: { type: String, enum: ['mpesa', 'paypal', 'mock', 'binance', 'sasapay'], required: true },
  amount: { type: Number, required: true },
  currency: { type: String, required: true },
  providerReference: { type: String, index: true },
  merchantRequestId: { type: String },
  status: { type: String, enum: ['pending', 'completed', 'failed', 'cancelled'], default: 'pending' },
  failureReason: { type: String },
  rawPayload: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now },
  completedAt: { type: Date }
});

PaymentTransactionSchema.index({ providerReference: 1, provider: 1 });

module.exports = mongoose.model('PaymentTransaction', PaymentTransactionSchema);
