const UserConfig = require('../models/User');
const { canAccessTradingViewAlerts } = require('../utils/subscriptionAccess');

async function requireTradingViewAccess(req, res, next) {
  try {
    const appUsername = req.body.username || req.query.username || req.params.username;
    if (!appUsername) {
      return res.status(400).json({
        message: 'Active subscription required. Log in with your app username first.'
      });
    }

    const user = await UserConfig.findOne({ username: appUsername });
    if (!user || !canAccessTradingViewAlerts(user.subscription)) {
      return res.status(403).json({
        message: 'Active subscription required to access TradingView live alerts.',
        subscription: user?.subscription || { status: 'inactive', tier: 'basic' }
      });
    }

    req.tvUser = user;
    next();
  } catch (error) {
    return res.status(500).json({ message: 'Unable to verify subscription access', error: error.message });
  }
}

module.exports = requireTradingViewAccess;
