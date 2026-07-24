const mongoose = require('mongoose');

const TradeJournalSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  signalId: { type: String },
  symbol: { type: String, required: true },
  direction: { type: String, required: true },
  entry: { type: Number },
  exit: { type: Number },
  lotSize: { type: Number },
  outcome: { type: String, enum: ['open', 'win', 'loss', 'breakeven'], default: 'open' },
  outcomeR: { type: Number },
  pnl: { type: Number },
  notes: { type: String, default: '' },
  // Extended journal fields (backward compatible; notes remains the primary free-text field).
  userNotes: { type: String, default: '' },
  tradeRating: { type: Number, min: 1, max: 5 },
  emotion: { type: String, default: '' },
  lessonsLearned: { type: String, default: '' },
  screenshotUrl: { type: String, default: '' },
  executionNotes: { type: String, default: '' },
  tags: [{ type: String }],
  openedAt: { type: Date, default: Date.now },
  closedAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

TradeJournalSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('TradeJournal', TradeJournalSchema);
