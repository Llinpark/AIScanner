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
    linkCodeExpiresAt: { type: Date, default: null },
    /**
     * Pro-only Telegram behaviour while executionMode === 'manual'.
     * manual_confirmation (default) — Execute/Ignore → MT5 queue
     * alerts_only — Telegram alert only; no MT5 queue / buttons
     * Premium (executionMode auto) ignores this field. Missing → manual_confirmation.
     */
    telegramMode: {
      type: String,
      enum: ['manual_confirmation', 'alerts_only'],
      required: false
    }
  },

  mt5: {
    enabled: { type: Boolean, default: false },
    accountBalance: { type: Number, default: null },
    accountCurrency: { type: String, default: 'USD' },
    riskPercent: { type: Number, default: 1 },
    /** Used when autoLotSizing is off (Pro): fixed volume per trade. */
    fixedLotSize: { type: Number, default: 0.01 },
    symbolSuffix: { type: String, default: '' },
    /**
     * Auto: queue MT5 on entry signal (Premium).
     * Manual: Telegram Execute/Ignore with time-limited confirm (Pro default).
     * Only these two modes — Undefined = resolve from tier (Premium→auto, Pro→manual).
     */
    executionMode: { type: String, enum: ['auto', 'manual'], required: false },
    /** Pro Manual confirm window in seconds (clamped 120–300). Null → env/default. */
    manualConfirmSeconds: { type: Number, default: null },
    lastSyncAt: { type: Date, default: null },
    linkedAt: { type: Date, default: null },
    terminalId: { type: String, default: null },
    /** Set when EA completes PairCode flow (never exposed as permanent auth on dashboard). */
    lastPairAt: { type: Date, default: null },
    broker: { type: String, default: null },
    build: { type: String, default: null },
    machineFingerprint: { type: String, default: null },
    accountNumber: { type: String, default: null },
    /**
     * Multi-device authorized EA terminals. Each device has its own access/refresh tokens.
     * Pair codes are NEVER stored here (Redis TTL only). Auth is PairCode → device tokens only.
     */
    devices: [
      {
        deviceId: { type: String, required: true },
        accessToken: { type: String, default: null },
        refreshToken: { type: String, default: null },
        accessExpiresAt: { type: Date, default: null },
        refreshExpiresAt: { type: Date, default: null },
        friendlyName: { type: String, default: 'MT5 Terminal' },
        label: { type: String, default: 'MT5 Terminal' },
        broker: { type: String, default: null },
        accountNumber: { type: String, default: null },
        platform: { type: String, default: 'Windows' },
        terminalBuild: { type: String, default: null },
        eaVersion: { type: String, default: null },
        machineFingerprint: { type: String, default: null },
        terminalId: { type: String, default: null },
        firstPairedAt: { type: Date, default: Date.now },
        lastHeartbeatAt: { type: Date, default: null },
        lastSeenIP: { type: String, default: null },
        createdAt: { type: Date, default: Date.now },
        revokedAt: { type: Date, default: null }
      }
    ]
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

/** Device-token lookups for the MT5 bridge (PairCode auth). */
UserConfigSchema.index({ 'mt5.devices.accessToken': 1 }, { sparse: true });
UserConfigSchema.index({ 'mt5.devices.refreshToken': 1 }, { sparse: true });
UserConfigSchema.index({ 'mt5.devices.deviceId': 1 }, { sparse: true });

module.exports = mongoose.model('UserConfig', UserConfigSchema);
