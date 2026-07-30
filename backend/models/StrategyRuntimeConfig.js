const mongoose = require('mongoose');

/**
 * Persisted admin overrides for pluggable Strategy Profiles.
 * Env/defaults remain the baseline; this document wins at runtime after boot load.
 *
 * BC fields: scalping, daytrading, activeStrategy (enum live keys).
 * Additive: profiles (Mixed map for stub/future overrides), version tracking via updatedAt.
 */
const StrategyRuntimeConfigSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    default: 'strategies',
    index: true
  },
  scalping: { type: mongoose.Schema.Types.Mixed, default: {} },
  daytrading: { type: mongoose.Schema.Types.Mixed, default: {} },
  /** Additive map: strategyKey → independent overrides for stubs / future profiles */
  profiles: { type: mongoose.Schema.Types.Mixed, default: {} },
  /** Last strategy tab selected/saved in Admin Scanner Settings (live keys) */
  activeStrategy: {
    type: String,
    enum: ['scalping', 'daytrading'],
    default: 'daytrading'
  },
  /** Independent Market Regime Filter settings (pre-scan gate; not strategy-specific) */
  marketRegime: { type: mongoose.Schema.Types.Mixed, default: {} },
  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: String }
});

module.exports = mongoose.model('StrategyRuntimeConfig', StrategyRuntimeConfigSchema);
