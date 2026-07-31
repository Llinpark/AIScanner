const mongoose = require('mongoose');

const UserConfigSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  displayName: { type: String, trim: true },
  phone: { type: String },
  /** Normalized TradingView username this subscriber's Pine license is bound to. */
  tradingviewUsername: { type: String, trim: true, lowercase: true, default: null, index: true },
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
    /** Used when autoLotSizing is off (Pro): fixed volume per trade. */
    fixedLotSize: { type: Number, default: 0.01 },
    symbolSuffix: { type: String, default: '' },
    /**
     * Auto: queue MT5 on entry signal (Premium).
     * Manual: notify + Execute button only (Pro default).
     * Undefined = resolve from tier (Premium→auto, Pro→manual).
     */
    executionMode: { type: String, enum: ['auto', 'manual'], required: false },
    lastSyncAt: { type: Date, default: null },
    linkedAt: { type: Date, default: null },
    terminalId: { type: String, default: null }
  },

  /**
   * Subscription = access entitlement.
   * Scanner / alerts / premium gates check status === 'active' only (never PaymentTransaction).
   *
   * Conceptual mapping (spec → stored lowercase for compatibility):
   *   ACTIVE|PENDING|EXPIRED|CANCELLED → active|pending|expired|cancelled
   *   planId → tier
   *   expiryDate → current_period_end
   *   startDate → startDate (also mirrored on activation)
   *   remainingDays → computed at read time
   */
  subscription: {
    tier: { type: String, enum: ['basic', 'professional', 'premium'], default: 'basic' },
    status: {
      type: String,
      enum: ['inactive', 'pending', 'active', 'cancelled', 'expired'],
      default: 'pending'
    },
    provider: {
      type: String,
      enum: [
        'mpesa',
        'paypal',
        'mock',
        'binance',
        'sasapay',
        'paystack',
        'beta',
        'manual_mpesa',
        'daraja',
        'stripe',
        'bank',
        'complimentary',
        'admin'
      ]
    },
    /** Canonical source for how access was granted (uppercase constants). */
    paymentSource: {
      type: String,
      enum: ['MANUAL_MPESA', 'DARAJA', 'STRIPE', 'PAYPAL', 'BANK', 'ADMIN', 'BINANCE', 'MOCK', 'BETA'],
      default: undefined
    },
    providerCustomerId: { type: String },
    providerSubscriptionId: { type: String },
    providerOrderId: { type: String },
    /** Subscription start (activation date). */
    startDate: { type: Date },
    /** Expiry — same as current_period_end (kept for legacy readers). */
    current_period_end: { type: Date },
    activatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'UserConfig', default: null },
    billingCycle: { type: String, enum: ['weekly', 'monthly', 'yearly'], default: 'monthly' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  },
  role: { type: String, enum: ['user', 'admin', 'super_admin'], default: 'user' },
  emailVerified: { type: Boolean, default: false },
  emailVerificationToken: { type: String, default: null },
  emailVerificationExpiresAt: { type: Date, default: null },
  passwordResetToken: { type: String, default: null },
  passwordResetExpiresAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('UserConfig', UserConfigSchema);
