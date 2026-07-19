const mongoose = require('mongoose');

const UserConfigSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  displayName: { type: String, trim: true },
  phone: { type: String },
  preferences: { type: mongoose.Schema.Types.Mixed, default: {} },
  referralCode: { type: String, unique: true, sparse: true, uppercase: true, trim: true },
  referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'UserConfig', default: null, index: true },
  referredAt: { type: Date, default: null },

  telegram: {
    chatId: { type: String, default: null },
    username: { type: String, default: null },
    linkedAt: { type: Date, default: null },
    enabled: { type: Boolean, default: true },
    linkCode: { type: String, default: null },
    linkCodeExpiresAt: { type: Date, default: null }
  },

  mt5: {
    linkToken: { type: String, default: null },
    enabled: { type: Boolean, default: false },
    accountBalance: { type: Number, default: null },
    accountCurrency: { type: String, default: 'USD' },
    riskPercent: { type: Number, default: 1 },
    symbolSuffix: { type: String, default: '' },
    lastSyncAt: { type: Date, default: null },
    linkedAt: { type: Date, default: null },
    terminalId: { type: String, default: null }
  },

  subscription: {
    tier: { type: String, enum: ['basic', 'professional', 'premium'], default: 'basic' },
    status: { type: String, enum: ['inactive', 'pending', 'active', 'cancelled'], default: 'inactive' },
    provider: { type: String, enum: ['mpesa', 'paypal', 'mock', 'binance', 'sasapay', 'beta'] },
    providerCustomerId: { type: String },
    providerSubscriptionId: { type: String },
    providerOrderId: { type: String },
    current_period_end: { type: Date },
    billingCycle: { type: String, enum: ['weekly', 'monthly'], default: 'monthly' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  emailVerified: { type: Boolean, default: false },
  emailVerificationToken: { type: String, default: null },
  emailVerificationExpiresAt: { type: Date, default: null },
  passwordResetToken: { type: String, default: null },
  passwordResetExpiresAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('UserConfig', UserConfigSchema);
