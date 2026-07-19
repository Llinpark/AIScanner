const mongoose = require('mongoose');

const LearnedWeightsSchema = new mongoose.Schema({
  kind: {
    type: String,
    enum: ['pipeline', 'ai_factors'],
    required: true,
    index: true
  },
  version: { type: Number, required: true },
  weights: { type: mongoose.Schema.Types.Mixed, required: true },
  previousWeights: { type: mongoose.Schema.Types.Mixed },
  sampleCount: { type: Number, default: 0 },
  factorStats: { type: mongoose.Schema.Types.Mixed },
  learningRate: { type: Number },
  notes: { type: String },
  createdAt: { type: Date, default: Date.now, index: true }
});

LearnedWeightsSchema.index({ kind: 1, version: -1 });

module.exports = mongoose.model('LearnedWeights', LearnedWeightsSchema);
