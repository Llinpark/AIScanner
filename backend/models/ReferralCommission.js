const mongoose = require('mongoose');

const ReferralCommissionSchema = new mongoose.Schema({
  referrerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'UserConfig', required: true, index: true },
  referredUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'UserConfig', required: true, index: true },
  paymentTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'PaymentTransaction', required: true, unique: true },
  commissionType: { type: String, enum: ['first_subscription', 'renewal'], required: true },
  tier: { type: String, enum: ['basic', 'professional', 'premium'], required: true },
  billingCycle: { type: String, enum: ['weekly', 'monthly'], default: 'monthly' },
  planAmount: { type: Number, required: true },
  currency: { type: String, required: true },
  commissionRate: { type: Number, required: true },
  commissionAmount: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'paid', 'cancelled'], default: 'pending', index: true },
  paidAt: { type: Date, default: null },
  paidByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'UserConfig', default: null },
  payoutReference: { type: String, default: null },
  adminNotes: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

ReferralCommissionSchema.index({ referrerUserId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('ReferralCommission', ReferralCommissionSchema);
