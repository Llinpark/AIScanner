const mongoose = require('mongoose');

const UserConfigSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  displayName: { type: String, trim: true },
  phone: { type: String },
  preferences: { type: mongoose.Schema.Types.Mixed, default: {} },

  telegram: {
    chatId: { type: String, default: null },
    username: { type: String, default: null },
    linkedAt: { type: Date, default: null },
    enabled: { type: Boolean, default: true },
    linkCode: { type: String, default: null },
    linkCodeExpiresAt: { type: Date, default: null }
  },

  subscription: {
    tier: { type: String, enum: ['basic', 'professional', 'premium'], default: 'basic' },
    status: { type: String, enum: ['inactive', 'pending', 'active', 'cancelled'], default: 'inactive' },
    provider: { type: String, enum: ['mpesa', 'paypal', 'mock'], default: null },
    providerCustomerId: { type: String },
    providerSubscriptionId: { type: String },
    providerOrderId: { type: String },
    current_period_end: { type: Date },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('UserConfig', UserConfigSchema);
