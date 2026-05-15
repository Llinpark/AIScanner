const mongoose = require('mongoose');

const UserConfigSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  tradingviewUsername: { type: String },
  preferences: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('UserConfig', UserConfigSchema);
