const mongoose = require('mongoose');

/**
 * Persisted admin overrides for pluggable strategies.
 * Env/defaults remain the baseline; this document wins at runtime after boot load.
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
  legacyEnabled: { type: Boolean, default: true },
  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: String }
});

module.exports = mongoose.model('StrategyRuntimeConfig', StrategyRuntimeConfigSchema);
