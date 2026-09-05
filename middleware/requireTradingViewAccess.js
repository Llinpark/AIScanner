const mongoose = require('mongoose');
const UserConfig = require('../models/User');
const {
  getEffectiveSubscription,
  userCanAccessTradingViewAlerts,
  withEffectiveAccess
} = require('../utils/subscriptionAccess');
const devUserStore = require('../utils/devUserStore');

async function requireTradingViewAccess(req, res, next) {
  try {
    const appUsername = req.body.username || req.query.username || req.params.username;
    if (!appUsername) {
      return res.status(400).json({
        message: 'Active subscription required. Log in with your app username first.'
      });
    }

    let user = null;
    if (mongoose.connection.readyState !== 1) {
      user = devUserStore.findByUsername(appUsername);
    } else {
      try {
        user = await UserConfig.findOne({ username: appUsername });
      } catch {
        user = devUserStore.findByUsername(appUsername);
      }
    }

    if (!user || !userCanAccessTradingViewAlerts(user)) {
      return res.status(403).json({
        message: 'Active subscription required to access TradingView live alerts.',
        subscription: getEffectiveSubscription(user)
      });
    }

    req.tvUser = withEffectiveAccess(user);
    next();
  } catch (error) {
    return res.status(500).json({ message: 'Unable to verify subscription access', error: error.message });
  }
}

module.exports = requireTradingViewAccess;
