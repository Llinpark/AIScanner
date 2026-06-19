const { hasTierFeature, minimumTierDisplayForFeature } = require('../utils/subscriptionAccess');

function requireTierFeature(featureKey) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required.' });
    }

    if (!hasTierFeature(req.user.subscription, featureKey)) {
      const requiredTier = minimumTierDisplayForFeature(featureKey);
      return res.status(403).json({
        message: `This feature requires the ${requiredTier} plan or higher.`,
        feature: featureKey,
        requiredTier,
        currentTier: req.user.subscription?.tier || 'basic'
      });
    }

    next();
  };
}

module.exports = requireTierFeature;
