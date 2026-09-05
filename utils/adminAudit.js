const mongoose = require('mongoose');
const AdminAuditLog = require('../models/AdminAuditLog');

async function logAdminAction(req, { action, targetType, targetId, summary, metadata } = {}) {
  if (mongoose.connection.readyState !== 1) {
    return null;
  }

  const actorUserId = req.userId || req.user?._id?.toString() || req.user?.id;
  const actorEmail = req.user?.email || 'unknown';

  return AdminAuditLog.create({
    actorUserId,
    actorEmail,
    action,
    targetType,
    targetId,
    summary,
    metadata
  });
}

module.exports = {
  logAdminAction
};
