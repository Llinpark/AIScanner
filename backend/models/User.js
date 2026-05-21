const mongoose = require('mongoose');

const UserConfigSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  tradingviewUsername: { type: String },
  email: { type: String },
  phone: { type: String }, // for M-Pesa
  preferences: { type: mongoose.Schema.Types.Mixed, default: {} },
  
  // TradingView OAuth & Account Linking
  tradingview: {
    userId: { type: String }, // TradingView user ID from OAuth
    oauthToken: { type: String }, // encrypted token for API calls
    linkedAt: { type: Date },
    isOAuthLinked: { type: Boolean, default: false },
    apiAccessLevel: { type: String, enum: ['basic', 'premium'], default: 'basic' } // OAuth tier
  },
  
  subscription: {
    tier: { type: String, enum: ['basic', 'professional', 'premium'], default: 'basic' },
    status: { type: String, enum: ['inactive', 'trial', 'active', 'cancelled'], default: 'inactive' },
    provider: { type: String, enum: ['mpesa', 'paypal', 'mock'], default: null },
    providerCustomerId: { type: String },
    providerSubscriptionId: { type: String },
    providerOrderId: { type: String },
    current_period_end: { type: Date },
    trialEnds: { type: Date },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('UserConfig', UserConfigSchema);
