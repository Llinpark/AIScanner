const { canAccessLiveAlerts } = require('../utils/subscriptionAccess');

function requireSubscription(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  if (!canAccessLiveAlerts(req.user.subscription)) {
    return res.status(403).json({
      message: 'Active subscription required. Subscribe to access live TradingView alerts.',
      subscription: req.user.subscription || { status: 'inactive', tier: 'basic' }
    });
  }

  next();
}

module.exports = requireSubscription;
