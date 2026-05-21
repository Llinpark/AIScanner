function isSubscriptionActive(subscription) {
  if (!subscription) return false;
  if (subscription.status === 'active') {
    if (subscription.current_period_end && new Date(subscription.current_period_end) < new Date()) {
      return false;
    }
    return true;
  }
  if (subscription.status === 'trial') {
    if (subscription.trialEnds && new Date(subscription.trialEnds) < new Date()) {
      return false;
    }
    return true;
  }
  return false;
}

function canAccessTradingViewAlerts(subscription) {
  return isSubscriptionActive(subscription);
}

module.exports = {
  isSubscriptionActive,
  canAccessTradingViewAlerts
};
