const mongoose = require('mongoose');

const AdminAuditLogSchema = new mongoose.Schema({
  actorUserId: { type: String, required: true, index: true },
  actorEmail: { type: String, required: true },
  action: { type: String, required: true, index: true },
  targetType: { type: String },
  targetId: { type: String },
  summary: { type: String },
  metadata: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now, index: true }
});

module.exports = mongoose.model('AdminAuditLog', AdminAuditLogSchema);
