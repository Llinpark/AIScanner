const mongoose = require('mongoose');

/**
 * Payment = money received (audit trail).
 * Access MUST NEVER be granted by querying this collection — only via User.subscription.status.
 *
 * Conceptual mapping:
 *   planId          → tier
 *   paymentReference → providerReference
 *   paymentMethod   → paymentMethod (preferred) / provider (legacy gateways)
 */
const PaymentTransactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'UserConfig', required: true, index: true },
  tier: { type: String, enum: ['basic', 'professional', 'premium'], required: true },
  /** Legacy gateway id — kept for historical PayPal/Binance/STK rows. */
  provider: {
    type: String,
    enum: [
      'mpesa',
      'paypal',
      'mock',
      'binance',
      'sasapay',
      'paystack',
      'manual_mpesa',
      'daraja',
      'stripe',
      'bank',
      'complimentary'
    ],
    required: true
  },
  /** Canonical payment method for new flows (mirrors provider when unset). */
  paymentMethod: {
    type: String,
    enum: ['manual_mpesa', 'daraja', 'stripe', 'paypal', 'bank', 'complimentary', 'binance', 'mock', 'mpesa'],
    default: undefined
  },
  amount: { type: Number, required: true },
  currency: { type: String, required: true },
  billingCycle: { type: String, enum: ['weekly', 'monthly', 'yearly'], default: 'monthly' },
  /** M-Pesa code / gateway reference — unique per provider when set. */
  providerReference: { type: String, index: true },
  merchantRequestId: { type: String },
  phoneNumber: { type: String, default: null },
  status: {
    type: String,
    enum: ['pending', 'completed', 'rejected', 'failed', 'cancelled'],
    default: 'pending',
    index: true
  },
  failureReason: { type: String },
  notes: { type: String, default: '' },
  /** Optional payment proof (URL or small data-URL). */
  screenshotUrl: { type: String, default: '' },
  activatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'UserConfig', default: null },
  activationDate: { type: Date, default: null },
  rawPayload: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now },
  completedAt: { type: Date },
  updatedAt: { type: Date, default: Date.now }
});

// Legacy gateway lookups (non-unique — historical rows may share refs across retries).
PaymentTransactionSchema.index({ providerReference: 1, provider: 1 });
// Manual M-Pesa codes must be unique (prevents duplicate activations).
PaymentTransactionSchema.index(
  { providerReference: 1 },
  {
    unique: true,
    name: 'manual_mpesa_code_unique',
    partialFilterExpression: {
      provider: 'manual_mpesa',
      providerReference: { $type: 'string' }
    }
  }
);
PaymentTransactionSchema.index({ status: 1, createdAt: -1 });
PaymentTransactionSchema.index({ paymentMethod: 1, status: 1 });

module.exports = mongoose.model('PaymentTransaction', PaymentTransactionSchema);
