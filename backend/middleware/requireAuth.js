const mongoose = require('mongoose');
const UserConfig = require('../models/User');
const devUserStore = require('../utils/devUserStore');
const { verifyToken } = require('../utils/auth');
const { extractAuthToken } = require('../utils/sessionCookies');

async function resolveUserById(userId) {
  if (!userId) return null;
  if (mongoose.connection.readyState !== 1) {
    return devUserStore.findById(userId);
  }
  try {
    return await UserConfig.findById(userId);
  } catch {
    return devUserStore.findById(userId);
  }
}

async function requireAuth(req, res, next) {
  try {
    const token = extractAuthToken(req);

    if (!token) {
      return res.status(401).json({ message: 'Authentication required. Please sign in.' });
    }

    const payload = verifyToken(token);
    const user = await resolveUserById(payload.userId);

    if (!user) {
      return res.status(401).json({ message: 'Session expired. Please sign in again.' });
    }

    req.user = user;
    req.userId = user._id?.toString() || user.id;
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired session. Please sign in again.' });
  }
}

module.exports = requireAuth;
module.exports.resolveUserById = resolveUserById;
